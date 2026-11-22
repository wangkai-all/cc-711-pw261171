// Executes calls against a remote gRPC server using descriptors obtained
// through reflection.
//
// The station keeps each call's outcome explicit:
//   * unary        -> { outcome: "unary", status: "ok" | "error" }
//   * server stream-> { outcome: "stream",
//                       status: "ok" | "error" | "cancelled",
//                       messages: [...], partial: bool }
//
// "cancelled" means the user pressed Stop; messages received before that are
// kept and flagged as partial. "error" means the server or transport failed;
// messages received before the failure are also kept and flagged as partial.
import * as grpc from "@grpc/grpc-js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

const STATUS_TEXT = new Map(
  Object.entries(grpc.status)
    .filter(([name]) => Number.isNaN(Number(name)))
    .map(([name, code]) => [code, name]),
);

function statusName(code) {
  return STATUS_TEXT.get(code) ?? `STATUS_${code}`;
}

function metadataToJson(metadata) {
  if (!metadata) return {};
  // grpc-js Metadata#getMap() returns a plain { key: value | value[] }
  // object; Buffer values are made printable.
  const map =
    typeof metadata.getMap === "function" ? metadata.getMap() : metadata;
  const out = {};
  for (const [key, values] of Object.entries(map)) {
    const list = Array.isArray(values) ? values : [values];
    out[key] = list.map((value) =>
      Buffer.isBuffer(value) ? value.toString("base64") : String(value),
    );
  }
  return out;
}

function buildMetadata(raw) {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!key.trim()) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) metadata.add(key.toLowerCase(), String(item));
  }
  return metadata;
}

/**
 * Run a unary call.
 * @returns {Promise<object>} a JSON-able result record
 */
export function runUnary({ target, method, request, metadata, deadlineMs, tls = false }) {
  const { input, output } = method;
  const client = new grpc.Client(
    target,
    tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  );
  const startedAt = Date.now();
  const requestBytes = Buffer.from(toBinary(input, request));
  let responseMetadata = {};

  const finish = (record) => {
    client.close();
    return record;
  };

  return new Promise((resolve) => {
    const call = client.makeUnaryRequest(
      method.path ?? method,
      (value) => Buffer.from(toBinary(input, value)),
      (bytes) => fromBinary(output, bytes),
      request,
      buildMetadata(metadata),
      deadlineMs ? { deadline: Date.now() + deadlineMs } : {},
      (error, response) => {
        if (error) {
          resolve(
            finish({
              kind: "unary",
              status: "error",
              durationMs: Date.now() - startedAt,
              error: {
                code: error.code ?? grpc.status.UNKNOWN,
                status: statusName(error.code ?? grpc.status.UNKNOWN),
                details: error.details ?? error.message,
                metadata: metadataToJson(error.metadata),
              },
              requestBytes,
              responseMetadata,
            }),
          );
          return;
        }
        resolve(
          finish({
            kind: "unary",
            status: "ok",
            durationMs: Date.now() - startedAt,
            message: response,
            responseBytes: Buffer.from(toBinary(output, response)),
            requestBytes,
            responseMetadata,
          }),
        );
      },
    );
    call.on("metadata", (metadata) => {
      responseMetadata = metadataToJson(metadata);
    });
  });
}

/**
 * Run a server-streaming call. The returned object is a handle:
 *   { cancel(), done: Promise<record>, onMessage(cb) }
 */
export function runServerStream({
  target,
  method,
  request,
  metadata,
  deadlineMs,
  tls = false,
  onMessage,
}) {
  const { input, output } = method;
  const client = new grpc.Client(
    target,
    tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(),
  );
  const startedAt = Date.now();
  const messages = [];
  const requestBytes = Buffer.from(toBinary(input, request));
  let initialMetadata = {};
  let cancelledByUser = false;
  let settled = false;
  let call;

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const finish = (record) => {
    if (settled) return;
    settled = true;
    client.close();
    resolveDone(record);
  };

  const recordBase = () => ({
    kind: "stream",
    method: method.path ?? String(method),
    // Every message is kept, including those received before an error or a
    // user cancel, so the UI can show partial results.
    messages,
    partial: false,
    requestBytes,
    metadata: initialMetadata,
  });

  try {
    call = client.makeServerStreamRequest(
      method.path ?? method,
      (value) => Buffer.from(toBinary(input, value)),
      (bytes) => fromBinary(output, bytes),
      request,
      buildMetadata(metadata),
      deadlineMs ? { deadline: Date.now() + deadlineMs } : {},
    );
  } catch (error) {
    return {
      cancel() {},
      done: Promise.resolve({
        ...recordBase(),
        status: "error",
        durationMs: Date.now() - startedAt,
        error: { code: grpc.status.UNKNOWN, status: "UNKNOWN", details: error.message },
      }),
    };
  }

  call.on("metadata", (metadata) => {
    initialMetadata = metadataToJson(metadata);
  });

  call.on("data", (message) => {
    const bytes = Buffer.from(toBinary(output, message));
    const entry = {
      index: messages.length,
      receivedAt: Date.now() - startedAt,
      message,
      bytes,
    };
    messages.push(entry);
    onMessage?.(entry);
  });

  call.on("status", (status) => {
    if (cancelledByUser) {
      finish({
        ...recordBase(),
        status: "cancelled",
        durationMs: Date.now() - startedAt,
        partial: true,
        cancelledAt: Date.now() - startedAt,
        error: {
          code: grpc.status.CANCELLED,
          status: "CANCELLED",
          details: "cancelled by user",
          userCancelled: true,
        },
      });
      return;
    }
    if (status.code !== grpc.status.OK) {
      finish({
        ...recordBase(),
        status: "error",
        durationMs: Date.now() - startedAt,
        partial: messages.length > 0,
        error: {
          code: status.code,
          status: statusName(status.code),
          details: status.details,
          metadata: metadataToJson(status.metadata),
        },
      });
      return;
    }
    // A clean OK end. A stream that produced nothing is a successful empty
    // result - distinct from a stream that failed before producing anything.
    finish({
      ...recordBase(),
      status: "ok",
      durationMs: Date.now() - startedAt,
      partial: false,
      error: null,
    });
  });

  call.on("error", (error) => {
    // "status" is emitted after "error"; let that handler do the bookkeeping.
    if (!settled && error?.code === grpc.status.CANCELLED && !cancelledByUser) {
      // Server-side cancellation, not a user action.
    }
  });

  return {
    cancel() {
      if (settled) return;
      cancelledByUser = true;
      try {
        call.cancel();
      } catch {
        /* already gone */
      }
    },
    done,
    get cancelled() {
      return cancelledByUser;
    },
  };
}

export { statusName, metadataToJson, buildMetadata };
