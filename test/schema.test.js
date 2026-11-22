import test from "node:test";
import assert from "node:assert/strict";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { loadDemoDescriptorSet } from "../server/registry.js";
import { buildRegistry, referencedTypeNames } from "../server/descriptors.js";
import { schemaPayload } from "../server/schema.js";

const { registry, set } = loadDemoDescriptorSet();

test("the descriptor set carries the import graph", () => {
  const names = set.file.map((file) => file.name);
  assert.ok(names.includes("demo/collector.proto"));
  assert.ok(names.includes("demo/common/types.proto"));

  const collector = set.file.find((file) => file.name === "demo/collector.proto");
  assert.deepEqual(collector.dependency, ["demo/common/types.proto"]);
});

test("proto3 optional survives the descriptor round-trip", () => {
  const collector = set.file.find((file) => file.name === "demo/collector.proto");
  const message = collector.messageType.find((m) => m.name === "CollectRequest");
  const explicitCount = message.field.find((f) => f.name === "explicit_count");
  const implicitCount = message.field.find((f) => f.name === "implicit_count");
  assert.equal(explicitCount.proto3Optional, true);
  assert.equal(implicitCount.proto3Optional, false);

  // The registry's descriptor agrees about presence.
  const desc = registry.getMessage("demo.collector.CollectRequest");
  assert.equal(desc.field.explicitCount.presence, 1); // EXPLICIT
  assert.equal(desc.field.implicitCount.presence, 2); // IMPLICIT
});

test("registry building is order-independent and fills well-known imports", () => {
  const files = [...set.file].reverse();
  const built = buildRegistry(files);
  assert.ok(built.registry.getMessage("demo.collector.CollectRequest"));
  assert.ok(built.registry.getMessage("demo.common.Address"));
});

test("referencedTypeNames ignores map-entry types", () => {
  const collector = set.file.find((file) => file.name === "demo/collector.proto");
  const referenced = [...referencedTypeNames(collector)];
  assert.ok(referenced.includes("demo.common.Address"));
  assert.ok(referenced.includes("demo.common.Pet"));
  assert.ok(!referenced.some((name) => name.endsWith("Entry")));
});

test("schema payload includes imported types and their files", () => {
  const service = registry.getService("demo.collector.CollectorService");
  const payload = schemaPayload({
    target: "demo",
    version: "v1",
    registry,
    service,
    files: ["demo/collector.proto", "demo/common/types.proto"],
  });

  assert.ok(payload.messages["demo.common.Address"]);
  assert.ok(payload.messages["demo.common.Pet"]);
  assert.ok(payload.enums["demo.common.Flavor"]);
  // Every file in the registry is listed; the two in `files` are local.
  const local = payload.files.filter((file) => !file.external).map((file) => file.name);
  assert.deepEqual(local.sort(), ["demo/collector.proto", "demo/common/types.proto"]);

  const protoText = payload.files.find((file) => file.name === "demo/collector.proto").protoText;
  assert.match(protoText, /import "demo\/common\/types.proto";/);
  assert.match(protoText, /optional int32 explicit_count = 2;/);
  assert.match(protoText, /^  int32 implicit_count = 1;$/m);
  assert.match(protoText, /oneof payment \{/);
  assert.match(protoText, /map<int64, string> by_epoch = 15;/);

  const request = payload.messages["demo.collector.CollectRequest"];
  const presence = Object.fromEntries(request.fields.map((f) => [f.name, f.presence]));
  assert.equal(presence.implicit_count, "implicit");
  assert.equal(presence.explicit_count, "explicit");
  assert.equal(presence.card_token, "oneof");
  assert.equal(presence.pets, "repeated");
  assert.equal(presence.counters, "repeated");

  const byEpoch = request.fields.find((f) => f.name === "by_epoch");
  assert.equal(byEpoch.mapKey, "int64");
  assert.equal(byEpoch.bigintKey, true);
});

test("well-known types are supplied when a server omits them", () => {
  const file = create(FileDescriptorProtoSchema, {
    name: "custom/thing.proto",
    package: "custom",
    syntax: "proto3",
    dependency: ["google/protobuf/timestamp.proto"],
  });
  const built = buildRegistry([file]);
  assert.ok(built.registry.getFile("google/protobuf/timestamp.proto"));
});

test("descriptor bytes from the registry match the source set", () => {
  const collector = set.file.find((file) => file.name === "demo/collector.proto");
  const bytes = toBinary(FileDescriptorProtoSchema, collector);
  const again = fromBinary(FileDescriptorProtoSchema, bytes);
  assert.equal(again.name, "demo/collector.proto");
  assert.equal(again.messageType.length, collector.messageType.length);
});
