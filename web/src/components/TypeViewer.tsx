import { useState } from "react";
import type { SchemaPayload } from "../types";

/**
 * Browse the resolved type definitions: the reconstructed .proto text of every
 * file in the closure (imports included), plus message/field tables and enums.
 */
export function TypeViewer({ schema }: { schema: SchemaPayload }) {
  const [tab, setTab] = useState<"files" | "messages" | "enums">("files");
  const [openFile, setOpenFile] = useState<string | null>(
    schema.files.find((f) => !f.external)?.name ?? schema.files[0]?.name ?? null,
  );
  const [openMessage, setOpenMessage] = useState<string | null>(
    schema.service.methods[0]?.inputType ?? null,
  );

  const file = schema.files.find((f) => f.name === openFile) ?? schema.files[0];
  const messageNames = Object.keys(schema.messages).sort();

  return (
    <div className="type-viewer">
      <div className="tabs">
        <button type="button" className={tab === "files" ? "tab active" : "tab"} onClick={() => setTab("files")}>
          Files ({schema.files.length})
        </button>
        <button
          type="button"
          className={tab === "messages" ? "tab active" : "tab"}
          onClick={() => setTab("messages")}
        >
          Messages ({messageNames.length})
        </button>
        <button
          type="button"
          className={tab === "enums" ? "tab active" : "tab"}
          onClick={() => setTab("enums")}
        >
          Enums ({Object.keys(schema.enums).length})
        </button>
      </div>

      {tab === "files" && (
        <div className="file-browser">
          <ul className="file-list">
            {schema.files.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={entry.name === openFile ? "file-button active" : "file-button"}
                  onClick={() => setOpenFile(entry.name)}
                >
                  <span className="mono small">{entry.name}</span>
                  {entry.external && <span className="badge external">external</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="file-content">
            {file && (
              <>
                <div className="file-meta">
                  <span className="mono">{file.name}</span>
                  <span className="muted small">
                    syntax {file.syntax}
                    {file.package ? ` · package ${file.package}` : ""}
                  </span>
                  {file.dependencies.length > 0 && (
                    <span className="muted small">imports {file.dependencies.join(", ")}</span>
                  )}
                </div>
                <pre className="code-block proto">{file.protoText}</pre>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "messages" && (
        <div className="file-browser">
          <ul className="file-list">
            {messageNames.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className={name === openMessage ? "file-button active" : "file-button"}
                  onClick={() => setOpenMessage(name)}
                >
                  <span className="mono small">{name}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="file-content">
            {openMessage && schema.messages[openMessage] && (
              <MessageTable schema={schema} typeName={openMessage} />
            )}
          </div>
        </div>
      )}

      {tab === "enums" && (
        <div className="enum-grid">
          {Object.values(schema.enums).map((entry) => (
            <div key={entry.typeName} className="enum-card">
              <div className="mono small">{entry.typeName}</div>
              <table className="structure-table">
                <tbody>
                  {entry.values.map((value) => (
                    <tr key={value.name}>
                      <td className="mono">{value.name}</td>
                      <td className="muted">{value.number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageTable({ schema, typeName }: { schema: SchemaPayload; typeName: string }) {
  const model = schema.messages[typeName];
  return (
    <div className="message-doc">
      <h3 className="mono">{typeName}</h3>
      <p className="muted small">
        {model.fields.length} fields · {model.oneofs.length} oneofs · file {model.file}
      </p>
      <table className="structure-table">
        <thead>
          <tr>
            <th>#</th>
            <th>field</th>
            <th>type</th>
            <th>presence</th>
          </tr>
        </thead>
        <tbody>
          {model.fields.map((field) => (
            <tr key={field.name}>
              <td className="muted">{field.number}</td>
              <td className="mono">{field.name}</td>
              <td className="mono small">
                {field.kind === "map"
                  ? `map<${field.mapKey}, ${field.valueType?.typeName ?? field.valueType?.scalar}>`
                  : field.kind === "list"
                    ? `repeated ${field.type?.typeName ?? field.type?.scalar}`
                    : field.type?.typeName ?? field.type?.scalar}
              </td>
              <td>
                <span className={`badge ${field.presence}`}>{field.presence}</span>
                {field.oneofName && <span className="muted small"> {field.oneofName}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {model.oneofs.length > 0 && (
        <div className="oneof-summary">
          {model.oneofs.map((group) => (
            <div key={group.name} className="mono small">
              oneof {group.name} = {"{"} {group.fields.join(" | ")} {"}"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
