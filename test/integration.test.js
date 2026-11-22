// End-to-end: start the demo gRPC server and the station's HTTP API on
// ephemeral ports, then exercise discovery, schema resolution, a unary call, a
// successful stream, a mid-stream failure, and a user cancellation.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { startDemoServer } from "../demo/server.js";
import { createApp } from "../server/app.js";

let demo;
let http;
let base;

test.before(async () => {
  demo = await startDemoServer({ host: "127.0.0.1", port: 0 });
  http = createServer(createApp());
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  base = `http://127.0.0.1:${http.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => demo.server.tryShutdown(resolve));
  http.close();
});

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

async function readSse(response) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join("\n")) });
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

test("reflection discovery lists the demo service", async () => {
  const response = await post("/api/services", { target: `127.0.0.1:${demo.port}` });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, "v1");
  assert.ok(body.services.includes("demo.collector.CollectorService"));
});

test("schema resolution pulls in imported types", async () => {
  const response = await post("/api/schema", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
  });
  assert.equal(response.status, 200);
  const schema = await response.json();
  assert.ok(schema.messages["demo.common.Address"]);
  assert.ok(schema.enums["demo.common.Flavor"]);
  const collector = schema.files.find((file) => file.name === "demo/collector.proto");
  assert.match(collector.protoText, /optional int32 explicit_count = 2;/);
});

test("unary call round-trips presence, big integers and bytes", async () => {
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
    method: "Collect",
    request: {
      implicit_count: 0,
      explicit_count: { set: true, value: "0" },
      explicit_note: { set: true, value: "" },
      big_signed: "-9223372036854775808",
      big_unsigned: "18446744073709551615",
      payload: { encoding: "hex", value: "000102ff" },
      cash: { set: true, value: { amount_cents: "500", currency: "EUR" } },
    },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "ok");
  assert.equal(result.message.presence.explicit_count_present, true);
  assert.equal(result.message.presence.explicit_note_present, true);
  assert.equal(result.message.presence.active_payment, "cash");
  assert.equal(result.message.echoed_big_signed, "-9223372036854775808");
  assert.equal(result.message.echoed_big_unsigned, "18446744073709551615");
  assert.equal(result.message.echoed_payload, "AAEC/w==");
  assert.equal(result.sentFields.explicit_count.set, true);
  assert.equal(result.sentFields.implicit_count.set, false);
});

test("unary call reports a server error distinctly", async () => {
  // An unknown enum number is rejected by the form before the call.
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
    method: "Collect",
    request: { explicit_flavor: { set: true, value: "NOT_A_FLAVOR" } },
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /not a value of demo.common.Flavor/);
});

test("server stream succeeds and every message is kept", async () => {
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
    method: "Watch",
    request: { count: 3, interval_ms: 10, label: "ok" },
  });
  assert.equal(response.status, 200);
  const events = await readSse(response);
  const kinds = events.map((event) => event.event);
  assert.deepEqual(kinds, ["start", "message", "message", "message", "end"]);

  const end = events.at(-1).data;
  assert.equal(end.status, "ok");
  assert.equal(end.partial, false);
  assert.equal(end.messageCount, 3);
  assert.deepEqual(
    end.messages.map((message) => message.json.seq),
    [1, 2, 3],
  );
  // 2^53 + n must be intact in the JSON.
  assert.equal(end.messages[0].json.sequence_big, "9007199254740994");
  const start = events[0].data;
  assert.equal(typeof start.callId, "string");
  assert.equal(start.sentFields.count.kind, "implicit");
});

test("a stream that fails mid-flight keeps partial results and reports the error", async () => {
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
    method: "WatchWithFailure",
    request: { count: 10, interval_ms: 10, fail_after: 3, label: "fault" },
  });
  const events = await readSse(response);
  const end = events.at(-1).data;
  assert.equal(end.status, "error");
  assert.equal(end.partial, true);
  assert.equal(end.messageCount, 3);
  assert.equal(end.error.status, "INTERNAL");
  assert.match(end.error.details, /sensor fault/);
  assert.deepEqual(
    end.messages.map((message) => message.json.seq),
    [1, 2, 3],
  );
});

test("cancelling a stream keeps what arrived", async () => {
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "demo.collector.CollectorService",
    method: "Watch",
    request: { count: 50, interval_ms: 50, label: "stop" },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let callId = null;
  const events = [];

  const consume = () => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) {
        const payload = JSON.parse(data.join("\n"));
        if (event === "start") callId = payload.callId;
        events.push({ event, data: payload });
      }
      boundary = buffer.indexOf("\n\n");
    }
  };

  // Wait for the start event and at least one message before cancelling.
  while (!callId || events.filter((event) => event.event === "message").length === 0) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    consume();
  }
  assert.ok(callId, "stream start event should carry a callId");
  const receivedBeforeStop = events.filter((event) => event.event === "message").length;
  assert.ok(receivedBeforeStop >= 1);

  const stopResponse = await post("/api/call/stop", { callId });
  assert.equal(stopResponse.status, 200);

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    consume();
  }

  const end = events.at(-1);
  assert.equal(end.event, "end");
  assert.equal(end.data.status, "cancelled");
  assert.equal(end.data.partial, true);
  assert.equal(end.data.error.userCancelled, true);
  assert.equal(end.data.messages.length, end.data.messageCount);
  assert.equal(end.data.messages.length, receivedBeforeStop);
  assert.ok(end.data.messages.every((message) => message.json.seq >= 1));
});

test("bidirectional methods are rejected with a clear status", async () => {
  const response = await post("/api/call", {
    target: `127.0.0.1:${demo.port}`,
    service: "grpc.reflection.v1.ServerReflection",
    method: "ServerReflectionInfo",
    request: {},
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /out of scope/);
});
