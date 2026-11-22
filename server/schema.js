// Convert protobuf-es descriptors into a small, JSON-friendly schema model
// that the browser can render as a form.
//
// The important part of this file is presence. The model records, per field:
//   - kind: singular | list | map
//   - presence: "explicit" | "implicit" | "oneof" | "repeated"
//     * explicit  -> wire format distinguishes unset from the default value
//     * implicit  -> proto3 scalar without `optional`; wire format CANNOT
//                    distinguish unset from the default value
//     * oneof     -> exactly one member may be set; a member set to its
//                    default still counts as present
//     * repeated  -> a list/map is either absent or has entries; proto3 does
//                    not encode "present but empty", so we never invent that
import { ScalarType } from "@bufbuild/protobuf";

const PRESENCE = { EXPLICIT: 1, IMPLICIT: 2, LEGACY_REQUIRED: 3 };

const SCALAR_NAMES = new Map(
  Object.entries(ScalarType)
    .filter(([k]) => Number.isNaN(Number(k)))
    .map(([name, value]) => [value, name.toLowerCase()]),
);

/** 64-bit integral types must never be routed through JS numbers. */
export const BIGINT_SCALARS = new Set([
  "int64",
  "uint64",
  "sint64",
  "fixed64",
  "sfixed64",
]);

export function scalarName(scalar) {
  return SCALAR_NAMES.get(scalar) ?? `scalar_${scalar}`;
}

function fieldPresence(field) {
  if (field.oneof) return "oneof";
  if (field.fieldKind === "list" || field.fieldKind === "map") return "repeated";
  if (field.presence === PRESENCE.IMPLICIT) return "implicit";
  return "explicit";
}

function fieldKind(field) {
  if (field.fieldKind === "list") return "list";
  if (field.fieldKind === "map") return "map";
  return "singular";
}

function enumModel(descEnum) {
  return {
    typeName: descEnum.typeName,
    name: descEnum.name,
    file: descEnum.file.name,
    open: descEnum.open,
    values: descEnum.values.map((v) => ({ name: v.name, number: v.number })),
  };
}

function fieldModel(field) {
  const kind = fieldKind(field);
  const model = {
    name: field.name,
    jsonName: field.jsonName,
    localName: field.localName,
    number: field.number,
    kind,
    presence: fieldPresence(field),
    oneofName: field.oneof?.name ?? null,
    deprecated: field.deprecated,
    explicit: field.presence !== PRESENCE.IMPLICIT,
  };

  if (kind === "map") {
    model.mapKey = scalarName(field.mapKey);
    model.bigintKey = BIGINT_SCALARS.has(model.mapKey);
    if (field.mapKind === "message") {
      model.valueType = { kind: "message", typeName: field.message.typeName };
    } else if (field.mapKind === "enum") {
      model.valueType = { kind: "enum", typeName: field.enum.typeName };
      model.valueEnum = enumModel(field.enum);
      model.valueEnumValues = model.valueEnum.values;
    } else {
      model.valueType = { kind: "scalar", scalar: scalarName(field.scalar) };
      model.bigintValue = BIGINT_SCALARS.has(model.valueType.scalar);
      model.bytesValue = model.valueType.scalar === "bytes";
    }
    return model;
  }

  const elementKind = kind === "list" ? field.listKind : field.fieldKind;
  if (elementKind === "message") {
    model.type = { kind: "message", typeName: field.message.typeName };
  } else if (elementKind === "enum") {
    model.type = { kind: "enum", typeName: field.enum.typeName };
    model.enumValues = enumModel(field.enum).values;
  } else {
    model.type = { kind: "scalar", scalar: scalarName(field.scalar) };
    model.bigint = BIGINT_SCALARS.has(model.type.scalar);
    model.bytes = model.type.scalar === "bytes";
  }
  return model;
}

/** Flat model of one message; references to other messages are by typeName. */
export function messageModel(desc) {
  return {
    typeName: desc.typeName,
    name: desc.name,
    file: desc.file.name,
    deprecated: desc.deprecated,
    fields: desc.fields.map(fieldModel),
    oneofs: desc.oneofs.map((o) => ({
      name: o.name,
      localName: o.localName,
      fields: o.fields.map((f) => f.name),
    })),
    nestedMessages: desc.nestedMessages.map((m) => m.typeName),
    nestedEnums: desc.nestedEnums.map((e) => e.typeName),
  };
}

export function fieldSignature(field) {
  const typeText = (t) => {
    if (!t) return "?";
    if (t.kind === "message" || t.kind === "enum") return t.typeName;
    return t.scalar;
  };
  let type;
  switch (field.kind) {
    case "map":
      type = `map<${field.mapKey}, ${typeText(field.valueType)}>`;
      break;
    case "list":
      type = `repeated ${typeText(field.type)}`;
      break;
    default:
      type = typeText(field.type);
  }
  const label =
    field.kind === "singular" && field.presence === "explicit" ? "optional " : "";
  return `${label}${type} ${field.name} = ${field.number};`;
}

export function serviceModel(desc) {
  return {
    typeName: desc.typeName,
    name: desc.name,
    file: desc.file.name,
    methods: desc.methods.map((m) => ({
      name: m.name,
      localName: m.localName,
      path: `/${desc.typeName}/${m.name}`,
      methodKind: m.methodKind,
      inputType: m.input.typeName,
      outputType: m.output.typeName,
      requestStream: m.methodKind === "client_streaming" || m.methodKind === "bidi_streaming",
      responseStream: m.methodKind === "server_streaming" || m.methodKind === "bidi_streaming",
      deprecated: m.deprecated,
    })),
  };
}

/**
 * Build the full schema payload for one service: service/method models plus
 * every message and enum in the resolved descriptor closure.
 */
export function schemaPayload({ target, version, registry, service, files }) {
  const messages = {};
  const enums = {};
  const fileModels = [];
  for (const file of registry.files) {
    const included = files.includes(file.proto.name);
    fileModels.push({
      name: file.proto.name,
      package: file.proto.package,
      syntax: file.proto.syntax || (file.edition === 998 ? "proto2" : "proto3"),
      edition: file.edition,
      external: !included,
      dependencies: file.proto.dependency,
      protoText: renderFileProto(file),
    });
    if (!included) continue;
    for (const message of file.messages) messages[message.typeName] = messageModel(message);
    for (const enumType of file.enums) enums[enumType.typeName] = enumModel(enumType);
  }
  return {
    target,
    version,
    service: serviceModel(service),
    files: fileModels,
    messages,
    enums,
  };
}

// ---------------------------------------------------------------------------
// Human-readable proto reconstruction. Descriptors from reflection do not
// include source comments, but the declarations, labels, oneof grouping and
// field numbers are exact.
// ---------------------------------------------------------------------------

function scalarProtoName(field) {
  if (field.fieldKind === "map") {
    const key = scalarName(field.mapKey);
    const value =
      field.mapKind === "message"
        ? field.message.typeName
        : field.mapKind === "enum"
          ? field.enum.typeName
          : scalarName(field.scalar);
    return `map<${key}, ${value}>`;
  }
  if (field.fieldKind === "list") {
    const inner =
      field.listKind === "message"
        ? field.message.typeName
        : field.listKind === "enum"
          ? field.enum.typeName
          : scalarName(field.scalar);
    return `repeated ${inner}`;
  }
  return field.message?.typeName ?? field.enum?.typeName ?? scalarName(field.scalar);
}

function renderField(field, indent, { inOneof = false } = {}) {
  const pad = "  ".repeat(indent);
  // Message fields and oneof members already have explicit presence; writing
  // `optional` there would be redundant (and misleading in a oneof).
  const label =
    inOneof ||
    field.fieldKind === "list" ||
    field.fieldKind === "map" ||
    field.fieldKind === "message" ||
    field.presence === PRESENCE.IMPLICIT
      ? ""
      : "optional ";
  return `${pad}${label}${scalarProtoName(field)} ${field.name} = ${field.number};`;
}

function renderMessage(message, indent) {
  const pad = "  ".repeat(indent);
  const lines = [`${pad}message ${message.name} {`];
  const oneofByLocal = new Map(message.oneofs.map((o) => [o.localName, o]));
  const renderedOneofs = new Set();
  for (const member of message.members) {
    if (member.kind === "oneof") {
      renderedOneofs.add(member.localName);
      lines.push(`${pad}  oneof ${member.name} {`);
      for (const field of member.fields) {
        lines.push(renderField(field, indent + 2, { inOneof: true }));
      }
      lines.push(`${pad}  }`);
      continue;
    }
    // Map entries and synthetic oneofs are not rendered: map fields render as
    // map<K,V> and `optional` already marks explicit presence.
    if (member.fieldKind === "map") {
      lines.push(`${pad}  map<${scalarName(member.mapKey)}, ${scalarProtoName(member).replace(/^map<[^,]+, /, "").replace(/>$/, "")}> ${member.name} = ${member.number};`);
      continue;
    }
    if (member.oneof) continue; // handled by the group above
    lines.push(renderField(member, indent + 1));
  }
  for (const nested of message.nestedMessages) {
    lines.push(...renderMessage(nested, indent + 1));
  }
  for (const enumType of message.nestedEnums) {
    lines.push(...renderEnum(enumType, indent + 1));
  }
  lines.push(`${pad}}`);
  return lines;
}

function renderEnum(enumType, indent) {
  const pad = "  ".repeat(indent);
  const lines = [`${pad}enum ${enumType.name} {`];
  for (const value of enumType.values) {
    lines.push(`${pad}  ${value.name} = ${value.number};`);
  }
  lines.push(`${pad}}`);
  return lines;
}

function renderService(service, indent) {
  const pad = "  ".repeat(indent);
  const lines = [`${pad}service ${service.name} {`];
  for (const method of service.methods) {
    const request = method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming"
      ? `stream ${method.input.typeName}`
      : method.input.typeName;
    const response = method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming"
      ? `stream ${method.output.typeName}`
      : method.output.typeName;
    lines.push(`${pad}  rpc ${method.name} (${request}) returns (${response});`);
  }
  lines.push(`${pad}}`);
  return lines;
}

export function renderFileProto(file) {
  const lines = [];
  const syntax = file.proto.syntax || (file.edition === 998 ? "proto2" : "proto3");
  lines.push(`// ${file.proto.name}`);
  lines.push(`syntax = "${syntax}";`);
  if (file.proto.package) lines.push(`package ${file.proto.package};`);
  for (const dep of file.proto.dependency) lines.push(`import "${dep}";`);
  lines.push("");
  for (const enumType of file.enums) lines.push(...renderEnum(enumType, 0));
  for (const message of file.messages) lines.push(...renderMessage(message, 0));
  for (const service of file.services) lines.push(...renderService(service, 0));
  return `${lines.join("\n").trimEnd()}\n`;
}
