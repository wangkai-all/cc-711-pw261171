// Shapes returned by the station's HTTP API. Kept in sync with server/schema.js.

export type ScalarKind =
  | "double"
  | "float"
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "bool"
  | "string"
  | "bytes";

export interface TypeRef {
  kind: "scalar" | "enum" | "message";
  scalar?: ScalarKind;
  typeName?: string;
}

export interface EnumValue {
  name: string;
  number: number;
}

export interface FieldModel {
  name: string;
  jsonName: string;
  localName: string;
  number: number;
  kind: "singular" | "list" | "map";
  presence: "explicit" | "implicit" | "oneof" | "repeated";
  oneofName: string | null;
  deprecated: boolean;
  explicit: boolean;
  type?: TypeRef;
  enumValues?: EnumValue[];
  bigint?: boolean;
  bytes?: boolean;
  mapKey?: ScalarKind;
  bigintKey?: boolean;
  valueType?: TypeRef;
  valueEnum?: EnumModel;
  valueEnumValues?: EnumValue[];
  bigintValue?: boolean;
  bytesValue?: boolean;
}

export interface OneofModel {
  name: string;
  localName: string;
  fields: string[];
}

export interface MessageModel {
  typeName: string;
  name: string;
  file: string;
  deprecated: boolean;
  fields: FieldModel[];
  oneofs: OneofModel[];
  nestedMessages: string[];
  nestedEnums: string[];
}

export interface EnumModel {
  typeName: string;
  name: string;
  file: string;
  open: boolean;
  values: EnumValue[];
}

export interface MethodModel {
  name: string;
  localName: string;
  path: string;
  methodKind: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
  inputType: string;
  outputType: string;
  requestStream: boolean;
  responseStream: boolean;
  deprecated: boolean;
}

export interface ServiceModel {
  typeName: string;
  name: string;
  file: string;
  methods: MethodModel[];
}

export interface FileModel {
  name: string;
  package: string;
  syntax: string;
  edition: number;
  external: boolean;
  dependencies: string[];
  protoText: string;
}

export interface SchemaPayload {
  target: string;
  version: string;
  service: ServiceModel;
  files: FileModel[];
  messages: Record<string, MessageModel>;
  enums: Record<string, EnumModel>;
}

export interface ServicesResponse {
  target: string;
  version: string;
  services: string[];
}

/** Per-field presence metadata returned next to every collected message. */
export interface PresenceEntry {
  kind: "explicit" | "implicit" | "oneof" | "repeated";
  set: boolean;
  count?: number;
  group?: string;
  indistinguishable?: boolean;
}

export interface CollectedMessage {
  index: number;
  receivedAt?: number;
  json: Record<string, unknown>;
  presence?: Record<string, PresenceEntry>;
  bytesBase64: string;
  bytesHex: string;
  size: number;
}

export interface StreamStartEvent {
  callId: string;
  method: string;
  outputType?: string;
  responseStream?: boolean;
  requestJson: Record<string, unknown>;
  sentFields: Record<string, PresenceEntry>;
  requestBytesBase64: string;
  requestBytesHex: string;
  startedAt: string;
}

export interface StreamEndEvent {
  callId: string;
  kind: "stream";
  status: "ok" | "error" | "cancelled";
  partial: boolean;
  durationMs: number;
  messageCount: number;
  messages: CollectedMessage[];
  outputType: string;
  error: CallError | null;
  /** Initial response metadata, when the server sent any. */
  metadata?: Record<string, string[]>;
}

export interface CallError {
  code: number;
  status: string;
  details: string;
  metadata?: Record<string, string[]>;
  userCancelled?: boolean;
}

export interface UnaryResult {
  kind: "unary";
  status: "ok" | "error";
  method: string;
  durationMs: number;
  error: CallError | null;
  requestJson: Record<string, unknown>;
  sentFields: Record<string, PresenceEntry>;
  requestBytesBase64: string;
  requestBytesHex: string;
  outputType: string;
  message?: Record<string, unknown>;
  presence?: Record<string, PresenceEntry>;
  messageBytesBase64?: string;
  messageBytesHex?: string;
  /** Initial response metadata, when the server sent any. */
  metadata?: Record<string, string[]>;
}

export type CallResult = UnaryResult | StreamEndEvent;

export function isUnary(result: CallResult): result is UnaryResult {
  return result.kind === "unary";
}

export function isStream(result: CallResult): result is StreamEndEvent {
  return result.kind === "stream";
}
