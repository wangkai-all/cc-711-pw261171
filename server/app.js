// The station's HTTP API. The browser never sees binary proto; it posts JSON
// that mirrors the proto field names and gets JSON back, with streamed
// messages delivered over Server-Sent Events so each message is visible the
// moment it arrives.
import express from "express";
import { toBinary } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { ReflectionClient, ReflectionError } from "./reflection.js";
import { schemaPayload } from "./schema.js";
import { fillMessage, messageToJson, presenceJson, FormError } from "./convert.js";
import { runUnary, runServerStream, statusName } from "./calls.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// Our payloads never contain BigInt (64-bit values are decimal strings), but a
// stray one must be visible rather than crash a response or an SSE write.
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function jsonStringify(value) {
  return JSON.stringify(value, jsonReplacer);
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // callId -> cancel() for server streams that are still running.
  const activeStreams = new Map();

  app.set("json replacer", jsonReplacer);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ---- discovery ----------------------------------------------------------

  app.post("/api/services", async (req, res) => {
    const { target } = req.body ?? {};
    if (!target || typeof target !== "string") {
      res.status(400).json({ error: "target is required" });
      return;
    }
    const client = new ReflectionClient(target);
    try {
      const { version, services } = await client.listServices();
      res.json({ target, version, services });
    } catch (error) {
      respondError(res, error);
    } finally {
      client.close();
    }
  });

  app.post("/api/schema", async (req, res) => {
    const { target, service: serviceName } = req.body ?? {};
    if (!target || !serviceName) {
      res.status(400).json({ error: "target and service are required" });
      return;
    }
    const client = new ReflectionClient(target);
    try {
      const resolved = await client.resolveSymbol(serviceName);
      if (!resolved.service) {
        throw new ReflectionError(5, `${serviceName} is not a service`);
      }
      res.json(
        schemaPayload({
          target,
          version: resolved.version,
          registry: resolved.registry,
          service: resolved.service,
          files: resolved.files,
        }),
      );
    } catch (error) {
      respondError(res, error);
    } finally {
      client.close();
    }
  });

  // ---- calls --------------------------------------------------------------

  app.post("/api/call", async (req, res) => {
    const { target, service: serviceName, method: methodName, request, metadata, deadlineMs, tls } =
      req.body ?? {};
    if (!target || !serviceName || !methodName) {
      res.status(400).json({ error: "target, service and method are required" });
      return;
    }

    let resolved;
    const client = new ReflectionClient(target);
    try {
      resolved = await client.resolveSymbol(serviceName);
    } catch (error) {
      client.close();
      respondError(res, error);
      return;
    }
    client.close();

    const service = resolved.service;
    const descriptorMethod = service?.methods.find((m) => m.name === methodName);
    if (!descriptorMethod) {
      res.status(404).json({ error: `method ${methodName} not found on ${serviceName}` });
      return;
    }
    if (
      descriptorMethod.methodKind === "client_streaming" ||
      descriptorMethod.methodKind === "bidi_streaming"
    ) {
      res.status(400).json({ error: "client-streaming and bidirectional calls are out of scope" });
      return;
    }
    const method = {
      input: descriptorMethod.input,
      output: descriptorMethod.output,
      path: `/${descriptorMethod.parent.typeName}/${descriptorMethod.name}`,
      responseStream: descriptorMethod.methodKind === "server_streaming",
    };

    let requestMessage;
    const started = Date.now();
    try {
      requestMessage = fillMessage(method.input, request ?? {});
    } catch (error) {
      if (error instanceof FormError) {
        res.status(422).json({ error: error.message, field: error.path });
        return;
      }
      throw error;
    }

    let requestBytes;
    try {
      requestBytes = Buffer.from(toBinary(method.input, requestMessage));
    } catch (error) {
      res.status(422).json({ error: `could not encode request: ${error.message}` });
      return;
    }

    // What the form asked for, and what was actually encoded. Both are shown
    // in the UI so presence decisions are auditable.
    const requestJson = messageToJson(method.input, requestMessage);
    const sentFields = presenceJson(method.input, requestMessage);

    if (!method.responseStream) {
      try {
        const record = await runUnary({
          target,
          method,
          request: requestMessage,
          metadata,
          deadlineMs,
          tls: Boolean(tls),
        });
        res.json(summarizeUnary({ record, method, requestJson, requestBytes, sentFields, started }));
      } catch (error) {
        respondError(res, error);
      }
      return;
    }

    // Server stream over SSE.
    //
    // The user can stop a stream by POSTing /api/call/stop with the returned
    // callId, or simply by closing the EventSource. The callId route is the
    // reliable one: it works even if the browser keeps the connection open.
    const callId = randomUUID();
    activeStreams.set(callId, () => handle?.cancel());

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${jsonStringify(data)}\n\n`);
    };

    let closed = false;
    res.on("close", () => {
      closed = true;
      handle?.cancel();
    });

    let handle;
    send("start", {
      callId,
      method: method.path,
      outputType: method.output.typeName,
      responseStream: true,
      requestJson,
      sentFields,
      requestBytesBase64: requestBytes.toString("base64"),
      requestBytesHex: requestBytes.toString("hex"),
      startedAt: new Date().toISOString(),
    });

    handle = runServerStream({
      target,
      method,
      request: requestMessage,
      metadata,
      deadlineMs,
      tls: Boolean(tls),
      onMessage: (entry) => {
        if (closed) return;
        send("message", {
          index: entry.index,
          receivedAt: entry.receivedAt,
          json: messageToJson(method.output, entry.message),
          presence: presenceJson(method.output, entry.message),
          bytesBase64: entry.bytes.toString("base64"),
          bytesHex: entry.bytes.toString("hex"),
          size: entry.bytes.length,
        });
      },
    });

    const record = await handle.done;
    try {
      activeStreams.delete(callId);
    } catch {
      /* ignore */
    }
    if (closed) return;
    const messages = record.messages.map((entry) => ({
      index: entry.index,
      receivedAt: entry.receivedAt,
      json: messageToJson(method.output, entry.message),
      presence: presenceJson(method.output, entry.message),
      bytesBase64: entry.bytes.toString("base64"),
      bytesHex: entry.bytes.toString("hex"),
      size: entry.bytes.length,
    }));
    send("end", {
      callId,
      kind: "stream",
      status: record.status, // ok | error | cancelled
      partial: record.partial,
      durationMs: Date.now() - started,
      error: record.error ?? null,
      messageCount: messages.length,
      messages,
      outputType: method.output.typeName,
      // Initial response metadata (may be empty; status trailers are on the
      // error when the call failed).
      metadata: record.metadata ?? {},
    });
    res.end();
  });

  app.post("/api/call/stop", (req, res) => {
    const callId = req.body?.callId;
    if (typeof callId !== "string" || !callId) {
      res.status(400).json({ error: "callId is required" });
      return;
    }
    const cancel = activeStreams.get(callId);
    if (!cancel) {
      res.status(404).json({ error: "no active stream with that callId" });
      return;
    }
    cancel();
    res.json({ callId, stopping: true });
  });

  // ---- static frontend (production build) ---------------------------------
  const dist = resolve(root, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(dist, "index.html"));
    });
  }

  // ---- error handling -----------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error instanceof FormError) {
      res.status(422).json({ error: error.message, field: error.path });
      return;
    }
    console.error(error);
    res.status(500).json({ error: error.message ?? "internal error" });
  });

  return app;
}

function respondError(res, error) {
  const code = typeof error?.code === "number" ? error.code : undefined;
  const status =
    error instanceof ReflectionError || code === 5 || code === 12
      ? 502
      : error?.name === "ReflectionError"
        ? 502
        : 500;
  res.status(status).json({
    error: error?.message ?? String(error),
    grpcStatus: code !== undefined && code !== 12 ? statusName(code) : undefined,
    grpcCode: code !== undefined && code !== 12 ? code : undefined,
  });
}

function summarizeUnary({ record, method, requestJson, requestBytes, sentFields, started }) {
  if (record.status === "error") {
    return {
      kind: "unary",
      status: "error",
      method: method.path,
      durationMs: Date.now() - started,
      error: record.error,
      requestJson,
      sentFields,
      requestBytesBase64: requestBytes.toString("base64"),
      requestBytesHex: requestBytes.toString("hex"),
      outputType: method.output.typeName,
      metadata: record.responseMetadata ?? {},
    };
  }
  return {
    kind: "unary",
    status: "ok",
    method: method.path,
    durationMs: Date.now() - started,
    error: null,
    requestJson,
    sentFields,
    requestBytesBase64: requestBytes.toString("base64"),
    requestBytesHex: requestBytes.toString("hex"),
    message: messageToJson(method.output, record.message),
    presence: presenceJson(method.output, record.message),
    messageBytesBase64: record.responseBytes.toString("base64"),
    messageBytesHex: record.responseBytes.toString("hex"),
    outputType: method.output.typeName,
    metadata: record.responseMetadata ?? {},
  };
}

