import { useState } from "react";
import type { CollectedMessage, PresenceEntry, SchemaPayload } from "../types";

/**
 * One collected message: JSON view with presence annotations, a row-by-row
 * structure view (field numbers, types, presence), and the exact wire bytes in
 * base64 and hex.
 */
export function MessageView({
  schema,
  typeName,
  message,
  defaultTab = "json",
}: {
  schema: SchemaPayload;
  typeName: string;
  message: CollectedMessage | { json: Record<string, unknown>; presence?: Record<string, PresenceEntry>; bytesBase64?: string; bytesHex?: string; size?: number };
  defaultTab?: "json" | "structure" | "bytes";
}) {
  const [tab, setTab] = useState<"json" | "structure" | "bytes">(defaultTab);
  const presence = message.presence ?? {};

  return (
    <div className="message-view">
      <div className="tabs small-tabs">
        <button type="button" className={tab === "json" ? "tab active" : "tab"} onClick={() => setTab("json")}>
          JSON
        </button>
        <button
          type="button"
          className={tab === "structure" ? "tab active" : "tab"}
          onClick={() => setTab("structure")}
        >
          Structure
        </button>
        <button
          type="button"
          className={tab === "bytes" ? "tab active" : "tab"}
          onClick={() => setTab("bytes")}
          disabled={!message.bytesHex}
        >
          Raw bytes
          {message.size !== undefined && <span className="tab-meta">{message.size} B</span>}
        </button>
      </div>

      {tab === "json" && (
        <pre className="code-block json-block">{JSON.stringify(message.json, null, 2)}</pre>
      )}

      {tab === "structure" && (
        <StructureTable schema={schema} typeName={typeName} json={message.json} presence={presence} />
      )}

      {tab === "bytes" && (
        <div className="bytes-view">
          <div className="subhead">base64</div>
          <pre className="code-block wrap">{message.bytesBase64}</pre>
          <div className="subhead">hex</div>
          <pre className="code-block wrap">{message.bytesHex}</pre>
        </div>
      )}
    </div>
  );
}

function StructureTable({
  schema,
  typeName,
  json,
  presence,
  depth = 0,
}: {
  schema: SchemaPayload;
  typeName: string;
  json: Record<string, unknown>;
  presence: Record<string, PresenceEntry>;
  depth?: number;
}) {
  const model = schema.messages[typeName];
  if (!model) return <pre className="code-block">{JSON.stringify(json, null, 2)}</pre>;
  return (
    <table className={`structure-table depth-${Math.min(depth, 3)}`}>
      <thead>
        <tr>
          <th>field</th>
          <th>#</th>
          <th>type</th>
          <th>presence</th>
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {model.fields.map((field) => {
          const meta = presence[field.name];
          const value = json[field.name];
          const present = value !== undefined;
          const child =
            field.kind === "map" ? field.valueType : field.type;
          const childType = child?.kind === "message" ? child.typeName : undefined;
          const isNested = present && childType !== undefined;
          return (
            <tr key={field.name} className={present ? "" : "absent"}>
              <td className="mono">{field.name}</td>
              <td className="muted">{field.number}</td>
              <td className="mono small">
                {field.kind === "map"
                  ? `map<${field.mapKey}, ${child?.kind === "scalar" ? child.scalar : child?.typeName}>`
                  : field.kind === "list"
                    ? `repeated ${child?.kind === "scalar" ? child.scalar : child?.typeName}`
                    : child?.kind === "scalar"
                      ? child.scalar
                      : child?.typeName}
              </td>
              <td>
                <PresenceCell meta={meta} present={present} />
              </td>
              <td className="value-cell">
                {isNested ? (
                  field.kind === "map" && typeof value === "object" ? (
                    <div className="nested-values">
                      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
                        <details key={key} open={depth < 1}>
                          <summary>
                            <span className="mono">{key}</span>
                          </summary>
                          <StructureTable
                            schema={schema}
                            typeName={childType!}
                            json={item as Record<string, unknown>}
                            presence={{}}
                            depth={depth + 1}
                          />
                        </details>
                      ))}
                    </div>
                  ) : field.kind === "list" && Array.isArray(value) ? (
                    <div className="nested-values">
                      {(value as Record<string, unknown>[]).map((item, index) => (
                        <details key={index}>
                          <summary>[{index}]</summary>
                          <StructureTable
                            schema={schema}
                            typeName={childType!}
                            json={item}
                            presence={{}}
                            depth={depth + 1}
                          />
                        </details>
                      ))}
                    </div>
                  ) : (
                    <StructureTable
                      schema={schema}
                      typeName={childType!}
                      json={value as Record<string, unknown>}
                      presence={{}}
                      depth={depth + 1}
                    />
                  )
                ) : (
                  <span className="mono small">{compactValue(value)}</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PresenceCell({
  meta,
  present,
}: {
  meta: PresenceEntry | undefined;
  present: boolean;
}) {
  if (!present) {
    // An inactive oneof member is absent because another branch is active (or
    // none is); saying so avoids implying the field simply vanished.
    if (meta?.kind === "oneof") {
      return <span className="presence absent">not active ({meta.group})</span>;
    }
    return <span className="presence absent">not present</span>;
  }
  if (!meta) {
    return <span className="presence unknown">—</span>;
  }
  switch (meta.kind) {
    case "implicit":
      return (
        <span
          className="presence implicit"
          title="Implicit presence: the wire cannot distinguish this value from an absent field."
        >
          implicit value
        </span>
      );
    case "oneof":
      return <span className="presence oneof">active: {meta.group}</span>;
    case "repeated":
      return <span className="presence repeated">{meta.count} entries</span>;
    default:
      return <span className="presence explicit">set</span>;
  }
}

function compactValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
