// Descriptor plumbing shared by the demo server and the station server.
//
// We keep a single protobuf-es FileRegistry built from the descriptor set on
// disk. The reflection service is fed the same descriptor bytes, so the
// descriptor the client receives is the same one we use to encode.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileRegistry, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema, FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";

const here = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = resolve(here, "..", "demo", "descriptors.bin");

let cached;

export function loadDemoDescriptorSet() {
  if (!cached) {
    const raw = readFileSync(DESCRIPTOR_PATH);
    const set = fromBinary(FileDescriptorSetSchema, raw);
    cached = {
      raw: Uint8Array.from(raw),
      set,
      registry: createFileRegistry(set),
      fileBytes: new Map(
        set.file.map((file) => [
          file.name,
          Uint8Array.from(toBinary(FileDescriptorProtoSchema, file)),
        ]),
      ),
    };
  }
  return cached;
}

export function getMessage(typeName) {
  const desc = loadDemoDescriptorSet().registry.getMessage(typeName);
  if (!desc) throw new Error(`message type not found: ${typeName}`);
  return desc;
}

export function getService(typeName) {
  const desc = loadDemoDescriptorSet().registry.getService(typeName);
  if (!desc) throw new Error(`service not found: ${typeName}`);
  return desc;
}
