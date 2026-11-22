// Editable form state for one message type.
//
// The tree mirrors the protobuf schema but keeps UI-level state: whether an
// explicit field is "set", the text the user typed, the chosen encoding for
// bytes, list rows and map rows. It is converted to the server's request JSON
// by buildRequestJson().
//
// Key presence rules enforced here:
//   * explicit singular fields (optional scalars, message fields, oneof
//     members) carry a set/unset switch;
//   * implicit proto3 scalars do not - the wire cannot represent the
//     difference, so the UI never offers it;
//   * repeated/map fields have no "present but empty" state.
import type { FieldModel, MessageModel, SchemaPayload } from "./types";

export type { FieldModel } from "./types";

export type BytesEncoding = "base64" | "hex" | "utf8";

export interface FormNode {
  fields: Record<string, FieldState>;
  /** oneof group name -> active member field name, or null for "none". */
  oneofs: Record<string, string | null>;
}

export interface FieldState {
  /** Explicit present / message present / oneof member chosen. */
  active: boolean;
  text: string;
  encoding: BytesEncoding;
  child: FormNode | null;
  items: ListItem[];
  entries: MapEntry[];
}

export interface ListItem {
  id: string;
  state: FieldState;
}

export interface MapEntry {
  id: string;
  key: string;
  state: FieldState;
}

export type PathStep =
  | { field: string }
  | { item: number }
  | { entry: number }
  | { child: true };

export type FormPath = PathStep[];

/** Stable string form of a path, for DOM ids and radio group names. */
export function pathKey(path: FormPath): string {
  return path
    .map((step) => {
      if ("field" in step) return step.field;
      if ("child" in step) return ">";
      if ("item" in step) return `[${step.item}]`;
      return `{${step.entry}}`;
    })
    .join("/");
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function defaultText(field: FieldModel): string {
  const ref = field.kind === "map" ? field.valueType : field.type;
  if (ref?.kind === "enum") {
    const values = field.kind === "map" ? field.valueEnumValues : field.enumValues;
    return values?.[0]?.name ?? "0";
  }
  if (ref?.kind === "scalar") {
    switch (ref.scalar) {
      case "bool":
        return "false";
      case "string":
      case "bytes":
        return "";
      default:
        return "0";
    }
  }
  return "";
}

/** A synthetic singular field model for one list element / map value. */
export function elementFieldModel(field: FieldModel): FieldModel {
  if (field.kind === "list") {
    return { ...field, kind: "singular", presence: "explicit" };
  }
  if (field.kind === "map") {
    return {
      ...field,
      kind: "singular",
      presence: "explicit",
      type: field.valueType,
      enumValues: field.valueEnumValues,
    };
  }
  return field;
}

export function createFieldState(field: FieldModel): FieldState {
  return {
    active: false,
    text: defaultText(field),
    encoding: "base64",
    child: null,
    items: [],
    entries: [],
  };
}

export function createNode(schema: SchemaPayload, typeName: string): FormNode {
  const model = schema.messages[typeName];
  const fields: Record<string, FieldState> = {};
  const oneofs: Record<string, string | null> = {};
  if (model) {
    for (const field of model.fields) fields[field.name] = createFieldState(field);
    for (const group of model.oneofs) oneofs[group.name] = null;
  }
  return { fields, oneofs };
}

/** A fresh state for one list element or map entry. */
function createValueState(field: FieldModel): FieldState {
  const element = elementFieldModel(field);
  const state = createFieldState(element);
  return state;
}

// ---------------------------------------------------------------------------
// Locating a field state by path
// ---------------------------------------------------------------------------

interface Located {
  owner: FieldState | null;
  fieldModel: FieldModel | null;
}

/**
 * Follow `path` through a *cloned* tree, creating nested nodes as needed, and
 * return the FieldState addressed by the final step.
 *
 * Path grammar (from the root node):
 *   {field}  -> node.fields[field]
 *   {item}   -> holder.items[i].state        (holder must be a list field)
 *   {entry}  -> holder.entries[i].state      (holder must be a map field)
 *   {child}  -> holder.child (a FormNode)
 */
function locate(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
): Located {
  let node: FormNode = root;
  let holder: FieldState | null = null;
  let holderModel: FieldModel | null = null;
  let messageModel: MessageModel | undefined = schema.messages[typeName];

  for (const step of path) {
    if ("field" in step) {
      if (!messageModel) throw new Error(`no message model for ${typeName}`);
      holderModel = messageModel.fields.find((f) => f.name === step.field) ?? null;
      if (!holderModel) throw new Error(`unknown field ${step.field}`);
      holder = node.fields[step.field] ?? null;
      if (!holder) throw new Error(`missing form state for ${step.field}`);
      if (!holder.child) {
        const childType: string | null =
          holderModel.type?.kind === "message" ? (holderModel.type.typeName ?? null) : null;
        if (childType) holder.child = createNode(schema, childType);
      }
    } else if ("item" in step) {
      if (!holder || !holderModel) throw new Error("item step outside a list field");
      holder = holder.items[step.item]?.state ?? null;
      holderModel = elementFieldModel(holderModel);
      if (!holder) throw new Error(`no list item ${step.item}`);
    } else if ("entry" in step) {
      if (!holder || !holderModel) throw new Error("entry step outside a map field");
      holder = holder.entries[step.entry]?.state ?? null;
      holderModel = elementFieldModel(holderModel);
      if (!holder) throw new Error(`no map entry ${step.entry}`);
    } else {
      if (!holder || !holderModel) throw new Error("child step outside a message field");
      const childType: string | null =
        holderModel.type?.kind === "message" ? (holderModel.type.typeName ?? null) : null;
      if (!childType) throw new Error("child step on a non-message field");
      if (!holder.child) holder.child = createNode(schema, childType);
      node = holder.child;
      holder = null;
      holderModel = null;
      messageModel = schema.messages[childType];
    }
  }

  return { owner: holder, fieldModel: holderModel };
}

function withClone(root: FormNode, mutate: (clone: FormNode) => void): FormNode {
  const clone = structuredClone(root);
  mutate(clone);
  return clone;
}

// ---------------------------------------------------------------------------
// Mutations (all return a new root tree)
// ---------------------------------------------------------------------------

export function patchFieldState(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  patch: Partial<Pick<FieldState, "active" | "text" | "encoding">>,
): FormNode {
  return withClone(root, (clone) => {
    const { owner, fieldModel } = locate(clone, schema, typeName, path);
    if (!owner || !fieldModel) return;
    Object.assign(owner, patch);
    if (patch.active === true && fieldModel.type?.kind === "message" && !owner.child) {
      owner.child = createNode(schema, fieldModel.type.typeName ?? "");
    }
  });
}

export function replaceFieldState(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  next: FieldState,
): FormNode {
  return withClone(root, (clone) => {
    const { owner } = locate(clone, schema, typeName, path);
    if (!owner) return;
    // Mutate in place so the parent keeps pointing at the same object.
    owner.active = next.active;
    owner.text = next.text;
    owner.encoding = next.encoding;
    owner.child = next.child;
    owner.items = next.items;
    owner.entries = next.entries;
  });
}

/**
 * Resolve a *node* path ([] for the root; any mix of {field}, {item}, {entry},
 * {child} steps) to the node and its message model, creating child nodes
 * lazily. Used by oneof selection, which may happen inside a nested message,
 * a list element or a map value.
 */
function resolveNodePath(
  root: FormNode,
  schema: SchemaPayload,
  rootTypeName: string,
  path: FormPath,
): { node: FormNode; model: MessageModel } | null {
  let node: FormNode = root;
  let model: MessageModel | undefined = schema.messages[rootTypeName];
  let holder: FieldState | null = null;
  let holderModel: FieldModel | null = null;

  const ensureChild = (state: FieldState, field: FieldModel | null): string | null => {
    const childType =
      field?.type?.kind === "message" ? (field.type.typeName ?? null) : null;
    if (!childType) return null;
    if (!state.child) state.child = createNode(schema, childType);
    return childType;
  };

  for (const step of path) {
    if ("field" in step) {
      if (!model) return null;
      const field = model.fields.find((f) => f.name === step.field);
      const state = node.fields[step.field];
      if (!field || !state) return null;
      holder = state;
      holderModel = field;
      ensureChild(state, field);
      continue;
    }
    if ("item" in step || "entry" in step) {
      if (!holder || !holderModel) return null;
      const list: FieldState | undefined =
        "item" in step ? holder.items[step.item]?.state : holder.entries[step.entry]?.state;
      if (!list) return null;
      holder = list;
      holderModel = elementFieldModel(holderModel);
      ensureChild(list, holderModel);
      continue;
    }
    // {child}: descend into the message value of the current field/element.
    if (!holder || !holderModel) return null;
    const childType = ensureChild(holder, holderModel);
    if (!childType || !holder.child) return null;
    node = holder.child;
    const childModel: MessageModel | undefined = schema.messages[childType];
    if (!childModel) return null;
    model = childModel;
    holder = null;
    holderModel = null;
  }

  return model ? { node, model } : null;
}

/**
 * Select one oneof branch (or null for none). Selecting a different branch
 * clears the previous member's value; the UI confirms this with the user
 * before calling.
 */
export function selectOneof(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  group: string,
  member: string | null,
): FormNode {
  return withClone(root, (clone) => {
    const resolved = resolveNodePath(clone, schema, typeName, path);
    if (!resolved) return;
    const { node, model } = resolved;
    const previous = node.oneofs[group] ?? null;
    node.oneofs[group] = member;
    if (previous && previous !== member) {
      const previousField = model.fields.find((f) => f.name === previous);
      if (previousField) node.fields[previous] = createFieldState(previousField);
    }
    if (member) {
      const field = model.fields.find((f) => f.name === member);
      const state = node.fields[member];
      if (field && state) {
        state.active = true;
        if (field.type?.kind === "message" && !state.child) {
          state.child = createNode(schema, field.type.typeName ?? "");
        }
      }
    }
  });
}

export function addListItem(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
): FormNode {
  return withClone(root, (clone) => {
    const { owner, fieldModel } = locate(clone, schema, typeName, path);
    if (!owner || !fieldModel) return;
    const state = createValueState(fieldModel);
    if (fieldModel.type?.kind === "message") {
      state.child = createNode(schema, fieldModel.type.typeName ?? "");
    }
    owner.items.push({ id: nextId("item"), state });
  });
}

export function removeListItem(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  index: number,
): FormNode {
  return withClone(root, (clone) => {
    const { owner } = locate(clone, schema, typeName, path);
    owner?.items.splice(index, 1);
  });
}

export function addMapEntry(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
): FormNode {
  return withClone(root, (clone) => {
    const { owner, fieldModel } = locate(clone, schema, typeName, path);
    if (!owner || !fieldModel) return;
    const state = createValueState(fieldModel);
    if (fieldModel.valueType?.kind === "message") {
      state.child = createNode(schema, fieldModel.valueType.typeName ?? "");
    }
    owner.entries.push({ id: nextId("entry"), key: suggestMapKey(owner), state });
  });
}

export function removeMapEntry(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  index: number,
): FormNode {
  return withClone(root, (clone) => {
    const { owner } = locate(clone, schema, typeName, path);
    owner?.entries.splice(index, 1);
  });
}

export function setMapKey(
  root: FormNode,
  schema: SchemaPayload,
  typeName: string,
  path: FormPath,
  index: number,
  key: string,
): FormNode {
  return withClone(root, (clone) => {
    const { owner } = locate(clone, schema, typeName, path);
    if (owner?.entries[index]) owner.entries[index].key = key;
  });
}

function suggestMapKey(owner: FieldState): string {
  const used = new Set(owner.entries.map((e) => e.key));
  if (!used.has("")) return "";
  let n = 1;
  while (used.has(String(n))) n += 1;
  return String(n);
}

// ---------------------------------------------------------------------------
// Form state -> request JSON
// ---------------------------------------------------------------------------

export class FormBuildError extends Error {
  constructor(
    public readonly fieldPath: string,
    message: string,
  ) {
    super(`${fieldPath}: ${message}`);
    this.name = "FormBuildError";
  }
}

const INTEGER_RE = /^-?\d+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

const ENCODINGS = ["base64", "hex", "utf8"] as const;

function valueJson(
  schema: SchemaPayload,
  field: FieldModel,
  state: FieldState,
  path: string,
): unknown {
  if (field.type?.kind === "message") {
    const typeName = field.type.typeName ?? "";
    return buildNode(schema, typeName, state.child ?? createNode(schema, typeName), path);
  }
  if (field.type?.kind === "enum") {
    if (!state.text) throw new FormBuildError(path, "choose an enum value");
    return state.text;
  }
  switch (field.type?.scalar) {
    case "bool":
      return state.text === "true";
    case "bytes": {
      if (!ENCODINGS.includes(state.encoding)) {
        throw new FormBuildError(path, `unsupported bytes encoding ${state.encoding}`);
      }
      const text = state.encoding === "hex" ? state.text.replace(/^0x/i, "").trim() : state.text;
      if (state.encoding === "base64" && !BASE64_RE.test(text.trim())) {
        throw new FormBuildError(path, "invalid base64");
      }
      if (state.encoding === "hex" && !HEX_RE.test(text)) {
        throw new FormBuildError(path, "invalid hex (needs whole bytes)");
      }
      return { encoding: state.encoding, value: text };
    }
    case "string":
      return state.text;
    case "double":
    case "float":
      if (state.text === "NaN" || state.text === "Infinity" || state.text === "-Infinity") {
        return state.text;
      }
      return state.text.trim();
    case "int64":
    case "uint64":
    case "sint64":
    case "fixed64":
    case "sfixed64":
      // Kept as a string so no precision is lost between the input box and the
      // wire; the server validates the range.
      if (!INTEGER_RE.test(state.text.trim())) {
        throw new FormBuildError(path, "expected a decimal integer string");
      }
      return state.text.trim();
    case "int32":
    case "uint32":
    case "sint32":
    case "fixed32":
    case "sfixed32": {
      if (!INTEGER_RE.test(state.text.trim())) {
        throw new FormBuildError(path, "expected a decimal integer string");
      }
      const n = Number(state.text);
      if (!Number.isSafeInteger(n)) throw new FormBuildError(path, "integer out of range");
      return n;
    }
    default:
      return state.text;
  }
}

function buildNode(
  schema: SchemaPayload,
  typeName: string,
  node: FormNode,
  prefix: string,
): Record<string, unknown> {
  const model = schema.messages[typeName];
  if (!model) {
    throw new FormBuildError(prefix || typeName, `unknown message type ${typeName}`);
  }
  const out: Record<string, unknown> = {};

  for (const field of model.fields) {
    const state = node.fields[field.name];
    if (!state) continue;
    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if (field.presence === "oneof") {
      if (node.oneofs[field.oneofName ?? ""] !== field.name) continue;
      out[field.name] = { set: true, value: valueJson(schema, field, state, path) };
      continue;
    }

    if (field.kind === "list") {
      out[field.name] = state.items.map((item, i) =>
        valueJson(schema, elementFieldModel(field), item.state, `${path}[${i}]`),
      );
      continue;
    }

    if (field.kind === "map") {
      const entries: Record<string, unknown> = {};
      const seen = new Set<string>();
      state.entries.forEach((entry, i) => {
        if (entry.key === "") throw new FormBuildError(`${path}[${i}]`, "map key is empty");
        if (seen.has(entry.key)) {
          throw new FormBuildError(`${path}[${i}]`, `duplicate map key ${entry.key}`);
        }
        seen.add(entry.key);
        const value = valueJson(schema, elementFieldModel(field), entry.state, `${path}[${entry.key}]`);
        Object.defineProperty(entries, entry.key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      });
      out[field.name] = entries;
      continue;
    }

    if (field.presence === "implicit") {
      // Sent as a plain value; the default encodes to nothing, exactly like an
      // omitted field. Within a nested message this only runs when the parent
      // message field is itself set, which is the correct presence boundary.
      out[field.name] = valueJson(schema, field, state, path);
      continue;
    }

    if (!state.active) continue;
    out[field.name] = { set: true, value: valueJson(schema, field, state, path) };
  }

  return out;
}

export function buildRequestJson(
  schema: SchemaPayload,
  typeName: string,
  node: FormNode,
): Record<string, unknown> {
  return buildNode(schema, typeName, node, "");
}

// ---------------------------------------------------------------------------
// Export selection
// ---------------------------------------------------------------------------

export type Selection = true | { [field: string]: Selection };

export function selectMessageJson(
  schema: SchemaPayload,
  typeName: string,
  json: unknown,
  selection: Record<string, Selection>,
): unknown {
  const model = schema.messages[typeName];
  if (!model || json === null || typeof json !== "object") return json;
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    const choice = selection[field.name];
    if (choice === undefined) continue;
    const value = (json as Record<string, unknown>)[field.name];
    if (value === undefined) continue;
    if (choice === true) {
      out[field.name] = value;
      continue;
    }
    const childType = field.kind === "map" ? field.valueType : field.type;
    if (childType?.kind !== "message" || !childType.typeName) {
      out[field.name] = value;
      continue;
    }
    if (field.kind === "list" && Array.isArray(value)) {
      out[field.name] = value.map((item) =>
        selectMessageJson(schema, childType.typeName!, item, choice),
      );
    } else if (field.kind === "map" && typeof value === "object") {
      const converted: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        Object.defineProperty(converted, key, {
          value: selectMessageJson(schema, childType.typeName!, item, choice),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      out[field.name] = converted;
    } else {
      out[field.name] = selectMessageJson(schema, childType.typeName, value, choice);
    }
  }
  return out;
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

