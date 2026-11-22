// Descriptor assembly helpers shared by the reflection client and demo server.
import { create, createFileRegistry } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import * as wkt from "@bufbuild/protobuf/wkt";

/**
 * protobuf-es resolves a file's imports while adding it to the registry, so a
 * FileDescriptorSet must list dependencies before dependents. Reflection
 * responses are not ordered, and the well-known types are alphabetical, so we
 * sort explicitly.
 */
export function topologicallySortFiles(files) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const ordered = [];
  const state = new Map(); // name -> "visiting" | "done"

  const visit = (file) => {
    const status = state.get(file.name);
    if (status === "done") return;
    if (status === "visiting") {
      // Import cycles are illegal in protobuf; ignore rather than loop.
      return;
    }
    state.set(file.name, "visiting");
    for (const dep of file.dependency) {
      const dependency = byName.get(dep);
      if (dependency) visit(dependency);
    }
    state.set(file.name, "done");
    ordered.push(file);
  };

  for (const file of files) visit(file);
  return ordered;
}

/** All well-known type files shipped with protobuf-es, by proto file name. */
export function wellKnownFiles() {
  const out = new Map();
  for (const exported of Object.values(wkt)) {
    if (!exported || exported.kind !== "file") continue;
    out.set(exported.proto.name, exported.proto);
  }
  return out;
}

/**
 * Build a FileRegistry from the given files, filling in any google/protobuf/*
 * imports the server did not send. Returns the registry and the final sorted
 * list of file names.
 */
export function buildRegistry(files) {
  const byName = new Map(files.map((file) => [file.name, file]));
  const known = wellKnownFiles();
  const missing = [...byName.values()].flatMap((file) => file.dependency);
  const pending = [...missing];
  const seen = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (byName.has(name) || seen.has(name)) continue;
    seen.add(name);
    const wktFile = known.get(name);
    if (!wktFile) continue;
    byName.set(name, wktFile);
    pending.push(...wktFile.dependency);
  }

  const sorted = topologicallySortFiles([...byName.values()]);
  const set = create(FileDescriptorSetSchema);
  set.file.push(...sorted);
  const registry = createFileRegistry(set);
  return { registry, files: sorted };
}

/** Type names referenced by fields, methods and extensions of a file. */
export function stripLeadingDot(name) {
  return name.startsWith(".") ? name.slice(1) : name;
}

export function referencedTypeNames(file) {
  const names = new Set();
  const declared = new Set();
  const collect = (message, scope) => {
    const name = `${scope}${message.name}`;
    declared.add(name);
    for (const nested of message.nestedType) collect(nested, `${name}.`);
  };
  const pkg = file.package || "";
  const prefix = pkg ? `${pkg}.` : "";
  for (const message of file.messageType) collect(message, prefix);
  const visitMessage = (message) => {
    for (const field of message.field) {
      if (field.typeName) names.add(stripLeadingDot(field.typeName));
    }
    for (const nested of message.nestedType) visitMessage(nested);
  };
  for (const message of file.messageType) visitMessage(message);
  for (const service of file.service) {
    for (const method of service.method) {
      if (method.inputType) names.add(stripLeadingDot(method.inputType));
      if (method.outputType) names.add(stripLeadingDot(method.outputType));
    }
  }
  for (const extension of file.extension) {
    if (extension.typeName) names.add(stripLeadingDot(extension.typeName));
    if (extension.extendee) names.add(stripLeadingDot(extension.extendee));
  }
  // Map entry messages are nested in the descriptor but absent from the
  // registry's type index (protobuf-es folds them into map fields). They are
  // internal, so do not treat them as unresolved.
  for (const name of [...names]) {
    if (declared.has(name) && /\.\w+Entry$/.test(name)) names.delete(name);
  }
  return names;
}

/** Every fully-qualified symbol declared by a file (for diagnostics). */
export function declaredSymbols(file) {
  const pkg = file.package || "";
  const prefix = pkg ? `${pkg}.` : "";
  const symbols = new Set();
  const visit = (message, scope) => {
    const name = `${scope}${message.name}`;
    symbols.add(`${prefix}${name}`);
    for (const field of message.field) symbols.add(`${prefix}${name}.${field.name}`);
    for (const nested of message.nestedType) visit(nested, `${name}.`);
    for (const e of message.enumType) symbols.add(`${prefix}${name}.${e.name}`);
    for (const o of message.oneofDecl) symbols.add(`${prefix}${name}.${o.name}`);
  };
  for (const message of file.messageType) visit(message, "");
  for (const e of file.enumType) {
    symbols.add(`${prefix}${e.name}`);
    for (const v of e.value) symbols.add(`${prefix}${e.name}.${v.name}`);
  }
  for (const service of file.service) {
    symbols.add(`${prefix}${service.name}`);
    for (const method of service.method) {
      symbols.add(`${prefix}${service.name}.${method.name}`);
    }
  }
  return symbols;
}
