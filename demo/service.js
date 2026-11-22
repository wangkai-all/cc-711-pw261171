// Demo gRPC server: a small "collector" service whose only purpose is to give
// the station something real to poke at. It is registered from the compiled
// descriptor set so that
//   * the server's reflection output is byte-identical to a protoc build, and
//   * `proto3_optional` survives (it is what drives the presence comparison).
import { create, fromBinary, toBinary, isFieldSet } from "@bufbuild/protobuf";
import * as grpc from "@grpc/grpc-js";
import { loadDemoDescriptorSet, getMessage } from "../server/registry.js";

const { registry } = loadDemoDescriptorSet();

function serializersFor(desc) {
  return {
    serialize: (message) => Buffer.from(toBinary(desc, message)),
    deserialize: (bytes) => fromBinary(desc, bytes),
  };
}

/** Build the grpc-js service definition from the descriptor. */
export function collectorServiceDefinition() {
  const service = registry.getService("demo.collector.CollectorService");
  const definition = {};
  for (const method of service.methods) {
    const req = serializersFor(method.input);
    const res = serializersFor(method.output);
    definition[method.name] = {
      path: method.parent.typeName.startsWith("/")
        ? method.parent.typeName
        : `/${method.parent.typeName}/${method.name}`,
      requestStream: method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming",
      responseStream: method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming",
      requestSerialize: req.serialize,
      requestDeserialize: req.deserialize,
      responseSerialize: res.serialize,
      responseDeserialize: res.deserialize,
      originalName: method.name,
    };
  }
  return definition;
}

const CollectRequest = getMessage("demo.collector.CollectRequest");
const CollectResponse = getMessage("demo.collector.CollectResponse");
const PresenceReport = getMessage("demo.collector.PresenceReport");
const WatchRequest = getMessage("demo.collector.WatchRequest");
const WatchEvent = getMessage("demo.collector.WatchEvent");
const WatchWarning = getMessage("demo.collector.WatchWarning");
const Address = getMessage("demo.common.Address");
const Cash = getMessage("demo.collector.Cash");

function presenceReportOf(request) {
  const payment = request.payment.case ?? "";
  const report = create(PresenceReport, {
    // Explicit-presence fields are the only ones where this question is even
    // meaningful. isFieldSet() is true for "explicitly set to 0".
    explicitCountPresent: isFieldSet(request, CollectRequest.field.explicitCount),
    explicitNotePresent: isFieldSet(request, CollectRequest.field.explicitNote),
    explicitFlavorPresent: isFieldSet(request, CollectRequest.field.explicitFlavor),
    pickupPresent: isFieldSet(request, CollectRequest.field.pickup),
    observedImplicitCount: request.implicitCount,
    observedImplicitNote: request.implicitNote,
    observedImplicitFlavor: request.implicitFlavor,
    activePayment: payment,
    countersEntries: Object.keys(request.counters).length,
  });
  return report;
}

function settle(request, response) {
  switch (request.payment.case) {
    case "cardToken":
      response.settlement = {
        case: "settledViaCard",
        value: `card:${request.payment.value.slice(0, 6)}…`,
      };
      break;
    case "iban":
      response.settlement = {
        case: "settledViaIban",
        value: `iban:***${request.payment.value.slice(-4)}`,
      };
      break;
    case "cash":
      response.settlement = {
        case: "settledCash",
        value: create(Cash, {
          amountCents: request.payment.value.amountCents,
          currency: request.payment.value.currency || "EUR",
        }),
      };
      break;
    default:
      response.settlement = {
        case: "settledViaCard",
        value: "no payment method supplied",
      };
      break;
  }
}

function collect(call, callback) {
  const request = call.request;
  const response = create(CollectResponse, {
    requestId: `req-${Date.now().toString(36)}`,
    presence: presenceReportOf(request),
    delivery:
      request.delivery === undefined ? undefined : create(Address, { ...request.delivery }),
    counters: { ...request.counters },
    echoedBigSigned: request.bigSigned,
    echoedBigUnsigned: request.bigUnsigned,
    echoedPayload: request.payload,
    waypoints: request.waypoints.map((address) => create(Address, { ...address })),
  });
  settle(request, response);
  callback(null, response);
}

function streamEvents(config, call, { failAfter = false } = {}) {
  const { intervalMs, label, drop } = config;
  let seq = 0;
  let timer = null;
  let closed = false;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    closed = true;
  };

  call.on("cancelled", cleanup);
  call.on("close", cleanup);
  call.on("error", cleanup);

  const emit = () => {
    if (closed) return;
    seq += 1;
    const event = create(WatchEvent, {
      seq,
      // Deliberately beyond 2^53 so clients that use JS numbers corrupt it.
      sequenceBig: 9007199254740993n + BigInt(seq),
      label: label || "tick",
      drop:
        drop === undefined
          ? create(Address, { street: `drop-${seq}`, city: "station", country: "demo" })
          : create(Address, { ...drop }),
      droppedAtUnixMs: BigInt(Date.now()),
      chunk: Uint8Array.from([seq & 0xff, 0xa5, 0x5a]),
      tally: { [`lane-${seq % 2}`]: BigInt(seq) * 1000n },
    });
    if (seq === 2) {
      event.status = {
        case: "warning",
        value: create(WatchWarning, {
          code: "SLOW_LANE",
          detail: "lane 1 is falling behind",
        }),
      };
    } else {
      event.status = { case: "ok", value: "delivered" };
    }
    call.write(event);

    if (failAfter && seq >= config.failAfter) {
      cleanup();
      // Application-level failure in the middle of a stream. The client must
      // keep messages 1..seq as partial results and show this as an error.
      const error = new Error("simulated sensor fault after partial delivery");
      error.code = grpc.status.INTERNAL;
      error.details = "simulated sensor fault after partial delivery";
      call.emit("error", error);
      call.end();
      return;
    }
    if (seq >= config.count) {
      cleanup();
      call.end();
      return;
    }
    timer = setTimeout(emit, intervalMs);
  };

  timer = setTimeout(emit, Math.min(intervalMs, 250));
}

function watchConfig(raw) {
  return {
    count: raw.count > 0 ? Math.min(raw.count, 200) : 5,
    intervalMs: raw.intervalMs > 0 ? Math.min(raw.intervalMs, 5000) : 400,
    failAfter: raw.failAfter > 0 ? Math.min(raw.failAfter, 200) : 3,
    label: raw.label,
    drop: raw.drop === undefined ? undefined : create(Address, { ...raw.drop }),
  };
}

function watch(call) {
  const config = watchConfig(call.request);
  streamEvents(config, call);
}

function watchWithFailure(call) {
  const config = watchConfig(call.request);
  streamEvents(config, call, { failAfter: true });
}

export function buildCollectorImplementation() {
  return {
    Collect: collect,
    Watch: watch,
    WatchWithFailure: watchWithFailure,
  };
}

export { serializersFor };
