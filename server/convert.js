// Conversion between wire-level messages and the browser's JSON form.
//
// Request JSON mirrors the proto field names (snake_case) and states presence
// exactly where the protocol allows it:
//
//   explicit scalar/enum/bytes/message -> { "set": true, "value": <v> }
//   oneof member                       -> the same wrapper; at most one member
//                                         of a group may be set
//   implicit proto3 scalar             -> a bare value, because the wire CANNOT
//                                         distinguish "unset" from "set to the
//                                         default"; no wrapper is accepted
//   repeated / map                     -> a bare array/object, because the wire
//                                         cannot distinguish absent from empty
//
// 64-bit integers are decimal strings in both directions and bytes are base64,
// so nothing is ever rounded through a JS number.
//
// Output JSON is plain values (strings for 64-bit, base64 for bytes).
// Presence is reported separately by presenceJson() so that a view can show
// "absent" vs "explicitly set" without wrapping every value.
import { create, isFieldSet, ScalarType } from "@bufbuild/protobuf";
import { fromBinary, toBinary } from "@bufbuild/protobuf";

const INT64_TYPES = new Set([
  ScalarType.INT64,
  ScalarType.UINT64,
  ScalarType.SINT64,
  ScalarType.FIXED64,
  ScalarType.SFIXED64,
]);

const UINT64_TYPES = new Set([ScalarType.UINT64, ScalarType.FIXED64]);

export class FormError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "FormError";
    this.path = path;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

function decodeBase64(text, path) {
  const compact = text.replace(/\s+/g, "");
  if (!BASE64_RE.test(compact) || compact.length % 4 === 1) {
    throw new FormError(path, "not valid base64");
  }
  return Uint8Array.from(Buffer.from(compact, "base64"));
}

/**
 * Decode a bytes value. The form may send either a base64 string or an
 * explicit { encoding, value } pair (base64 | hex | utf8 | ascii) so the
 * chosen encoding is never guessed.
 */
function decodeBytesInput(raw, path) {
  let encoding = "base64";
  let text = raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    if (typeof raw.encoding !== "string" || typeof raw.value !== "string") {
      throw new FormError(path, "bytes objects need string `encoding` and `value`");
    }
    encoding = raw.encoding.toLowerCase();
    text = raw.value;
  }
  if (typeof text !== "string") {
    throw new FormError(path, "bytes must be a base64 string or {encoding, value}");
  }
  switch (encoding) {
    case "base64":
      return decodeBase64(text, path);
    case "hex": {
      const compact = text.replace(/\s+/g, "").replace(/^0x/i, "");
      if (!HEX_RE.test(compact)) throw new FormError(path, "not valid hex");
      return Uint8Array.from(Buffer.from(compact, "hex"));
    }
    case "utf8":
    case "utf-8":
      return Uint8Array.from(Buffer.from(text, "utf8"));
    case "ascii":
      return Uint8Array.from(Buffer.from(text, "ascii"));
    default:
      throw new FormError(path, `unsupported bytes encoding ${JSON.stringify(encoding)}`);
  }
}

function parseBigInt(text, path, { unsigned }) {
  const trimmed = String(text).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new FormError(path, "expected a decimal integer string");
  }
  const value = BigInt(trimmed);
  if (unsigned && value < 0n) {
    throw new FormError(path, "unsigned field cannot be negative");
  }
  const min = unsigned ? 0n : -(2n ** 63n);
  const max = unsigned ? 2n ** 64n - 1n : 2n ** 63n - 1n;
  if (value < min || value > max) {
    throw new FormError(path, `out of range for a ${unsigned ? "u" : ""}int64`);
  }
  return value;
}

function parseScalarValue(scalar, raw, path) {
  if (INT64_TYPES.has(scalar)) {
    if (typeof raw !== "string") {
      throw new FormError(path, "64-bit integers must be sent as decimal strings");
    }
    return parseBigInt(raw, path, { unsigned: UINT64_TYPES.has(scalar) });
  }
  switch (scalar) {
    case ScalarType.BYTES:
      return decodeBytesInput(raw, path);
    case ScalarType.STRING:
      if (typeof raw !== "string") throw new FormError(path, "expected a string");
      return raw;
    case ScalarType.BOOL:
      if (typeof raw !== "boolean") throw new FormError(path, "expected true or false");
      return raw;
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32: {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
        throw new FormError(path, "expected a 32-bit signed integer");
      }
      return n;
    }
    case ScalarType.UINT32:
    case ScalarType.FIXED32: {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
        throw new FormError(path, "expected a 32-bit unsigned integer");
      }
      return n;
    }
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT: {
      if (raw === "NaN" || raw === "Infinity" || raw === "-Infinity") {
        return Number(raw);
      }
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || Number.isNaN(n)) {
        throw new FormError(path, "expected a number (or NaN/Infinity/-Infinity)");
      }
      return n;
    }
    default:
      throw new FormError(path, `unsupported scalar ${scalar}`);
  }
}

function parseEnum(field, raw, path) {
  const values = field.enum.values;
  if (typeof raw === "number") {
    if (values.some((v) => v.number === raw)) return raw;
    // Open enums accept unknown numeric values; closed enums do not.
    if (field.enum.open) return raw;
    throw new FormError(path, `${raw} is not a value of ${field.enum.typeName}`);
  }
  if (typeof raw === "string") {
    if (raw === "") throw new FormError(path, "choose an enum value");
    const byName = values.find((v) => v.name === raw);
    if (byName) return byName.number;
    if (/^-?\d+$/.test(raw)) return parseEnum(field, Number(raw), path);
    throw new FormError(path, `${raw} is not a value of ${field.enum.typeName}`);
  }
  throw new FormError(path, "expected an enum name or number");
}

function isWrapper(raw) {
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.prototype.hasOwnProperty.call(raw, "set")
  );
}

/**
 * Classify a raw form value:
 *   {set:false}                 -> absent (explicit presence only)
 *   {set:true, value}           -> present with value
 *   {encoding, value} (bytes)   -> present with an explicitly encoded value
 *   anything else               -> a bare value
 */
function unwrap(raw) {
  if (isWrapper(raw)) return { set: Boolean(raw.set), value: raw.value };
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof raw.encoding === "string" &&
    typeof raw.value === "string"
  ) {
    return { set: true, value: raw };
  }
  return { set: true, value: raw };
}

function convertValue(field, raw, path) {
  switch (field.fieldKind) {
    case "scalar":
      return parseScalarValue(field.scalar, raw, path);
    case "enum":
      return parseEnum(field, raw, path);
    case "message":
      if (raw === null || raw === undefined) return create(field.message);
      return fillMessage(field.message, raw, path);
    default:
      throw new FormError(path, `unsupported field kind ${field.fieldKind}`);
  }
}

function fillSingular(target, field, raw, path) {
  if (field.oneof) {
    const { set, value } = unwrap(raw);
    if (!set) return;
    target[field.oneof.localName] = {
      case: field.localName,
      value: convertValue(field, value, path),
    };
    return;
  }
  if (field.fieldKind === "message") {
    const { set, value } = unwrap(raw);
    if (!set || value === null || value === undefined) return;
    target[field.localName] = fillMessage(field.message, value, path);
    return;
  }
  if (field.presence === 2) {
    // Implicit presence: a {set,...} wrapper would pretend the wire can carry
    // that distinction. It cannot, so refuse it instead of silently dropping
    // the intent.
    if (isWrapper(raw)) {
      throw new FormError(
        path,
        "implicit-presence field cannot express set/unset; send the value directly (the wire cannot distinguish a default value from an absent field)",
      );
    }
    if (raw === null || raw === undefined) return;
    target[field.localName] = convertValue(field, raw, path);
    return;
  }
  const { set, value } = unwrap(raw);
  if (!set) return;
  target[field.localName] = convertValue(field, value, path);
}

function convertListValue(field, item, path) {
  if (field.listKind === "message") {
    return item === null || item === undefined
      ? create(field.message)
      : fillMessage(field.message, item, path);
  }
  if (field.listKind === "enum") return parseEnum(field, item, path);
  return parseScalarValue(field.scalar, item, path);
}

function convertList(field, raw, path) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new FormError(path, "expected an array");
  return raw.map((item, i) => convertListValue(field, item, `${path}[${i}]`));
}

const INT32_TYPES = new Set([
  ScalarType.INT32,
  ScalarType.SINT32,
  ScalarType.SFIXED32,
  ScalarType.UINT32,
  ScalarType.FIXED32,
]);

function defineKey(object, key, value) {
  // defineProperty keeps keys such as "__proto__" from mutating the object.
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function convertMap(field, raw, path) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FormError(path, "expected an object with string keys");
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (INT64_TYPES.has(field.mapKey)) {
      // BigInt is not a valid object key; the decimal string is exactly how
      // protobuf-es represents 64-bit map keys.
      parseBigInt(key, `${path}[${key}]`, {
        unsigned: UINT64_TYPES.has(field.mapKey),
      });
    } else if (INT32_TYPES.has(field.mapKey)) {
      if (!/^-?\d+$/.test(key)) {
        throw new FormError(path, `map key ${JSON.stringify(key)} is not an integer`);
      }
    } else if (field.mapKey === ScalarType.BOOL) {
      if (key !== "true" && key !== "false") {
        throw new FormError(path, `map key ${JSON.stringify(key)} is not a bool`);
      }
    }
    const itemPath = `${path}[${JSON.stringify(key)}]`;
    let converted;
    switch (field.mapKind) {
      case "message":
        converted =
          value === null || value === undefined
            ? create(field.message)
            : fillMessage(field.message, value, itemPath);
        break;
      case "enum":
        converted = parseEnum(field, value, itemPath);
        break;
      default:
        converted = parseScalarValue(field.scalar, value, itemPath);
    }
    defineKey(out, key, converted);
  }
  return out;
}

/**
 * Build a runtime message from form JSON.
 * @param desc message descriptor
 * @param raw  plain JSON object using proto field names
 */
export function fillMessage(desc, raw, path = desc.typeName) {
  if (raw === null || raw === undefined) return create(desc);
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FormError(path, "expected an object");
  }
  const known = new Set(desc.fields.map((f) => f.name));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new FormError(path, `unknown field ${JSON.stringify(key)}`);
    }
  }

  // A oneof may have at most one active member. Reject conflicting input
  // rather than silently picking one.
  const oneofActive = new Map();
  for (const field of desc.fields) {
    if (!field.oneof || !(field.name in raw)) continue;
    if (!unwrap(raw[field.name]).set) continue;
    const active = oneofActive.get(field.oneof.name);
    if (active) {
      throw new FormError(
        `${path}.${field.oneof.name}`,
        `only one member may be set, got both ${active} and ${field.name}`,
      );
    }
    oneofActive.set(field.oneof.name, field.name);
  }

  const target = create(desc);
  for (const field of desc.fields) {
    if (!(field.name in raw)) continue;
    const value = raw[field.name];
    const fieldPath = `${path}.${field.name}`;
    if (field.fieldKind === "list") {
      target[field.localName] = convertList(field, value, fieldPath);
    } else if (field.fieldKind === "map") {
      target[field.localName] = convertMap(field, value, fieldPath);
    } else {
      fillSingular(target, field, value, fieldPath);
    }
  }
  return target;
}

// ---------------------------------------------------------------------------
// Runtime message -> plain JSON
// ---------------------------------------------------------------------------

function scalarJson(scalar, value) {
  if (INT64_TYPES.has(scalar)) return value.toString();
  if (scalar === ScalarType.BYTES) return Buffer.from(value).toString("base64");
  if (scalar === ScalarType.DOUBLE || scalar === ScalarType.FLOAT) {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
  }
  return value;
}

function enumJson(field, value) {
  const known = field.enum.values.find((v) => v.number === value);
  return known ? known.name : value;
}

function elementJson(field, value) {
  switch (field.fieldKind) {
    case "message":
      return value === undefined ? undefined : messageToJson(field.message, value);
    case "enum":
      return enumJson(field, value);
    case "scalar":
      return scalarJson(field.scalar, value);
    default:
      throw new Error(`unexpected field kind ${field.fieldKind}`);
  }
}

/** Plain JSON for one message: values only, no presence annotations. */
export function messageToJson(desc, message) {
  if (message === undefined) return undefined;
  const out = {};
  for (const field of desc.fields) {
    if (field.fieldKind === "list") {
      out[field.name] = message[field.localName].map((item) =>
        elementJson(
          { fieldKind: field.listKind, message: field.message, enum: field.enum, scalar: field.scalar },
          item,
        ),
      );
      continue;
    }
    if (field.fieldKind === "map") {
      const converted = {};
      const valueDescriptor = {
        fieldKind: field.mapKind,
        message: field.message,
        enum: field.enum,
        scalar: field.scalar,
      };
      for (const [key, value] of Object.entries(message[field.localName])) {
        defineKey(converted, key, elementJson(valueDescriptor, value));
      }
      out[field.name] = converted;
      continue;
    }
    if (field.oneof) {
      const group = message[field.oneof.localName];
      if (group.case === field.localName) {
        out[field.name] = elementJson(field, group.value);
      }
      continue;
    }
    if (field.fieldKind === "message") {
      const value = message[field.localName];
      if (value !== undefined) out[field.name] = messageToJson(field.message, value);
      continue;
    }
    if (field.presence === 2) {
      // Implicit presence: the decoded value is always readable, but a default
      // here is also what an absent field decodes to. presenceJson() says so.
      out[field.name] = elementJson(field, message[field.localName]);
      continue;
    }
    // Explicit presence: omit the field entirely when it was not set, so the
    // JSON never invents a value for an unset field. "Set to the default" is
    // still present and therefore still included.
    if (isFieldSet(message, field)) {
      out[field.name] = elementJson(field, message[field.localName]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presence metadata
// ---------------------------------------------------------------------------

function isDefaultValue(field, value) {
  switch (field.fieldKind) {
    case "enum":
      return value === 0;
    case "scalar":
      switch (field.scalar) {
        case ScalarType.STRING:
          return value === "";
        case ScalarType.BOOL:
          return value === false;
        case ScalarType.BYTES:
          return value.length === 0;
        case ScalarType.DOUBLE:
        case ScalarType.FLOAT:
          return value === 0;
        default:
          return value === 0 || value === 0n;
      }
    default:
      return false;
  }
}

/**
 * Presence for every field of one message:
 *
 *   explicit singular  -> {kind:"explicit", set:bool}
 *   implicit scalar    -> {kind:"implicit", set:bool, indistinguishable:true}
 *                         set is false for the default value, because the
 *                         encoder emits nothing for it; the wire cannot say
 *                         whether the caller meant 0 or nothing.
 *   oneof member       -> {kind:"oneof", group, set:bool}
 *                         `set` marks the active branch; the other members of
 *                         the same group are reported with set:false, so a view
 *                         can say "not active" instead of "absent".
 *   list / map         -> {kind:"repeated", count, set:bool}
 *                         "absent" and "empty" are the same bytes; no
 *                         distinction is invented.
 */
export function presenceJson(desc, message) {
  const out = {};
  for (const field of desc.fields) {
    if (field.oneof) {
      out[field.name] = {
        kind: "oneof",
        group: field.oneof.name,
        set: message[field.oneof.localName].case === field.localName,
      };
      continue;
    }
    if (field.fieldKind === "list") {
      const count = message[field.localName].length;
      out[field.name] = { kind: "repeated", count, set: count > 0 };
      continue;
    }
    if (field.fieldKind === "map") {
      const count = Object.keys(message[field.localName]).length;
      out[field.name] = { kind: "repeated", count, set: count > 0 };
      continue;
    }
    if (field.fieldKind === "message") {
      out[field.name] = {
        kind: "explicit",
        set: message[field.localName] !== undefined,
      };
      continue;
    }
    if (field.presence === 2) {
      out[field.name] = {
        kind: "implicit",
        set: !isDefaultValue(field, message[field.localName]),
        indistinguishable: true,
      };
      continue;
    }
    out[field.name] = { kind: "explicit", set: isFieldSet(message, field) };
  }
  return out;
}

export { fromBinary, toBinary, isFieldSet };
