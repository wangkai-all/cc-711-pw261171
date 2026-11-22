#!/usr/bin/env node
// Compile the demo protos into a FileDescriptorSet (a single binary file).
//
// We deliberately do NOT hand the .proto source to proto-loader at runtime:
// the server's own reflection should expose descriptors that are bit-for-bit
// what a normal protoc build produces, including `proto3_optional` and
// synthetic oneofs. proto-loader's descriptor regeneration loses that detail.
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "demo/descriptors.bin");

const candidates = [
  resolve(root, "node_modules/@bufbuild/buf-linux-x64/bin/buf"),
  resolve(root, "node_modules/.bin/buf"),
];

const buf = candidates.find((p) => existsSync(p));
if (!buf) {
  console.error("buf binary not found; run `npm install` first");
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(
  buf,
  ["build", resolve(root, "proto"), "--as-file-descriptor-set", "-o", output],
  { encoding: "utf8", stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`wrote ${output}`);
