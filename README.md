# gRPC 数据试收站 / gRPC Data Trial-Collection Station

Discover a gRPC server through **server reflection**, pick an RPC, fill in a
request built from the real descriptors, then collect a unary reply or a
server stream. Everything the page shows — the form, the sent bytes, the
received messages, the presence report — comes from the server's own
descriptors; no local copy of the target's protos is needed.

The station never fabricates presence information:

| Field kind | On the wire | What the UI does |
| --- | --- | --- |
| `optional` scalar / message / oneof member | present vs absent is distinguishable | set/unset toggle; "set to default" is shown as explicitly present |
| plain proto3 scalar | **not** distinguishable (default encodes to nothing) | no toggle at all; a note says so; the API rejects `{set, value}` wrappers |
| `repeated` / `map` | absent and empty encode identically | plain list/object; no "present but empty" state |
| `int64`/`uint64`/`sint64`/`fixed64`/`sfixed64` | 64 bits | decimal **strings** end to end; never routed through a JS number |
| `bytes` | arbitrary octets | each value carries an explicit encoding (base64 / hex / utf-8) and is displayed as base64 |

## Requirements

- Node.js ≥ 20 (uses the built-in test runner and `fetch`).

## Quick start

```bash
npm install
npm run build:proto     # compile proto/ -> demo/descriptors.bin (needs the buf binary from node_modules)
npm run build           # build the web UI into web/dist
npm start               # station on http://127.0.0.1:7070 (serves web/dist)
npm run start:demo      # demo gRPC server on 127.0.0.1:50051, in a second terminal
```

Open <http://127.0.0.1:7070>, enter `127.0.0.1:50051` as the target, press
**Discover**, choose `demo.collector.CollectorService`, then a method.

### Development mode

```bash
npm run dev
```

This runs three processes together: the demo gRPC server (`:50051`), the
station API (`:7070`), and Vite with hot reload (`:5173`). Use the Vite URL;
`/api` is proxied to the station. Override ports with `DEMO_PORT` and
`STATION_PORT`:

```bash
DEMO_PORT=50151 STATION_PORT=7170 npm run dev
```

To refresh the descriptors after editing a `.proto`, run `npm run build:proto`.
The demo server reads the binary set produced by `buf build`, not the `.proto`
source, so `proto3_optional` and synthetic oneofs survive the round-trip
exactly as `protoc` would emit them.

### Tests

```bash
npm test                 # all unit + integration tests (23)
npm run test:integration # spin up demo + station on ephemeral ports
```

## What the demo service covers

`proto/demo/collector.proto` (with imported types from
`proto/demo/common/types.proto`) deliberately contains:

- **Dependent types**: `CollectRequest` imports `demo.common.Address`, `Pet`,
  and `Flavor` from another file; the schema resolves the whole import closure
  before rendering the form.
- **Explicit vs implicit presence**: `optional int32 explicit_count` next to
  `int32 implicit_count`, and the same contrast for strings and enums. The
  server echoes a `PresenceReport` so you can see what actually arrived.
- **Nested messages, oneof (`payment`), maps** (`map<string,int32>`,
  `map<string,Address>`, `map<int64,string>`), **enums, bytes, repeated
  messages**. `WatchEvent.status` is a second oneof, inside every streamed
  message.
- **64-bit values beyond 2^53** (`big_signed`, `big_unsigned`, `big_fixed`,
  `big_zigzag`, `big_list`, and `sequence_big = 9007199254740993 + seq` on the
  stream).
- **Streams**: `Watch` ends successfully after N messages; `WatchWithFailure`
  delivers `fail_after` messages and then fails with `INTERNAL`.
- Client-streaming and bidirectional RPCs are intentionally **out of scope**;
  the API rejects them with HTTP 400 and the UI disables them.

## HTTP API

All endpoints are `POST` with JSON. 64-bit integers are decimal strings.

### Discovery

```bash
curl -s localhost:7070/api/services -H 'content-type: application/json' \
  -d '{"target":"127.0.0.1:50051"}'
# {"target":"...","version":"v1","services":["demo.collector.CollectorService", ...]}

curl -s localhost:7070/api/schema -H 'content-type: application/json' \
  -d '{"target":"127.0.0.1:50051","service":"demo.collector.CollectorService"}'
```

`/api/schema` returns the selected service, every reachable message/enum model,
every file needed to resolve it (with reconstructed proto text), and local vs
external file markers.

### Calls (unary and server stream)

```bash
curl -s localhost:7070/api/call -H 'content-type: application/json' -d '{
  "target": "127.0.0.1:50051",
  "service": "demo.collector.CollectorService",
  "method": "Collect",
  "metadata": {"x-trace-id": "abc"},
  "deadlineMs": 5000,
  "request": {
    "implicit_count": 0,
    "explicit_count": {"set": true, "value": 0},
    "explicit_note": {"set": true, "value": ""},
    "pickup": {"set": true, "value": {}},
    "big_signed": "-9223372036854775808",
    "big_unsigned": "18446744073709551615",
    "payload": {"encoding": "hex", "value": "000102ff"},
    "cash": {"set": true, "value": {"amount_cents": "500", "currency": "EUR"}}
  }
}'
```

Optional call fields: `metadata` (object of string or string[] values) and
`deadlineMs`. The response contains `message` (decoded JSON), `presence`
(per-field presence report from the received message), `sentFields` (what the
station actually wrote for each request field), `metadata` (initial response
metadata), and the exact request/response bytes as base64 and hex.

#### Request shape

- **Explicit-presence fields** (proto3 `optional`, message fields, oneof
  members): `{"set": true, "value": ...}` or `{"set": false}`. Omitted means
  unset.
- **Implicit-presence scalars**: a bare value, always. Wrapping one in
  `{set, value}` returns HTTP 422, because the wire cannot represent the
  distinction the wrapper implies.
- **Repeated fields**: a JSON array; **maps**: a JSON object. Both are always
  treated as plain collections (absent and empty are the same on the wire).
- **Oneofs**: send at most one member, by name. Two members → 422. A member
  set to its default still counts as the active branch.
- **64-bit ints**: decimal string, e.g. `"9007199254740993"`; sending a JS
  number or an out-of-range value is a 422.
- **bytes**: `{"encoding": "base64" | "hex" | "utf8", "value": "..."}`; a bare
  string means base64.
- **Enums**: value name; unknown names are rejected.

### Server stream (SSE)

`POST /api/call` with a server-streaming method answers with
`text/event-stream`:

| Event | Meaning |
| --- | --- |
| `start` | carries `callId`, the encoded request bytes, and `sentFields` |
| `message` | one decoded message, its presence report, and raw bytes |
| `end` | `status` (`ok` / `error` / `cancelled`), `partial`, every message received, duration, and the gRPC error if any |

```bash
curl -N -s localhost:7070/api/call -H 'content-type: application/json' -d '{
  "target": "127.0.0.1:50051",
  "service": "demo.collector.CollectorService",
  "method": "Watch",
  "request": {"count": 5, "interval_ms": 200, "label": "demo"}
}'
```

To stop a stream, POST the `callId` from the `start` event:

```bash
curl -s localhost:7070/api/call/stop -H 'content-type: application/json' \
  -d '{"callId":"<id>"}'
```

Closing the SSE connection also cancels the underlying call. Either way,
messages received before the stop are kept and the `end` event reports
`status: "cancelled"`, `partial: true`, and `error.userCancelled: true`.
A mid-stream server failure likewise keeps the messages and reports
`status: "error"` with the gRPC status; a clean end reports `status: "ok"` and
`partial: false`.

## Project layout

```
proto/                 demo + reflection .proto sources
demo/                  demo gRPC server, service logic, compiled descriptors.bin
server/                reflection client, descriptor registry, schema model,
                       JSON<->protobuf conversion, call execution, HTTP API
web/                   React + Vite UI
  src/formModel.ts     form state, presence-aware build/export (the core rules)
  src/components/      schema form, sent/result viewer, type viewer, export panel
test/                  presence/convert unit tests + end-to-end integration tests
scripts/               dev runner and descriptor build
```

Without `web/dist` the station serves only the API; with it, the same port
serves the UI. `web/dist` is generated by `npm run build`.
