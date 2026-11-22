import { useMemo, useState } from "react";
import type { MessageModel, SchemaPayload } from "../types";
import {
  prettyJson,
  selectMessageJson,
  type Selection as Sel,
} from "../formModel";

interface ExportPanelProps {
  schema: SchemaPayload;
  typeName: string;
  messages: Record<string, unknown>[];
  disabled?: boolean;
}

/**
 * Let the user pick a subset of fields from the collected messages and export
 * them as JSON. The tree mirrors the output message; nested messages recurse.
 */
export function ExportPanel({ schema, typeName, messages, disabled }: ExportPanelProps) {
  const model = schema.messages[typeName];
  const [selection, setSelection] = useState<Record<string, Sel>>(() =>
    model ? allSelected(schema, typeName) : {},
  );
  const [copied, setCopied] = useState(false);

  const exported = useMemo(() => {
    if (!model) return [];
    return messages.map((json) => selectMessageJson(schema, typeName, json, selection));
  }, [schema, typeName, messages, selection, model]);

  const text = prettyJson(exported);

  const toggle = (field: string, value: Sel | undefined) => {
    setSelection((current) => {
      const next = { ...current };
      if (value === undefined) delete next[field];
      else next[field] = value;
      return next;
    });
  };

  if (!model) return <p className="muted">No output type.</p>;
  if (disabled || messages.length === 0) {
    return <p className="muted">Collect at least one message to choose export fields.</p>;
  }

  return (
    <div className="export-panel">
      <div className="export-tools">
        <button type="button" className="ghost" onClick={() => setSelection(allSelected(schema, typeName))}>
          Select all
        </button>
        <button type="button" className="ghost" onClick={() => setSelection({})}>
          Select none
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button
          type="button"
          onClick={() => {
            const blob = new Blob([text], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${typeName.replace(/\./g, "_")}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download JSON
        </button>
      </div>
      <SelectionTree
        schema={schema}
        model={model}
        selection={selection}
        onChange={toggle}
        prefix={[]}
      />
      <div className="export-preview">
        <div className="subhead">
          Export preview <span className="muted small">({exported.length} message{exported.length === 1 ? "" : "s"})</span>
        </div>
        <pre className="code-block">{text}</pre>
      </div>
    </div>
  );
}

function allSelected(schema: SchemaPayload, typeName: string): Record<string, Sel> {
  const model = schema.messages[typeName];
  const out: Record<string, Sel> = {};
  if (!model) return out;
  for (const field of model.fields) {
    const child =
      field.kind === "map"
        ? field.valueType
        : field.type;
    if (child?.kind === "message" && child.typeName && schema.messages[child.typeName]) {
      out[field.name] = allSelected(schema, child.typeName);
    } else {
      out[field.name] = true;
    }
  }
  return out;
}

function childKindLabel(child: { kind: string; scalar?: string; typeName?: string } | undefined): string {
  if (!child) return "?";
  if (child.kind === "scalar") return child.scalar ?? "?";
  return child.typeName ?? "?";
}

function SelectionTree({
  schema,
  model,
  selection,
  onChange,
  prefix,
}: {
  schema: SchemaPayload;
  model: MessageModel;
  selection: Record<string, Sel>;
  onChange(field: string, value: Sel | undefined): void;
  prefix: string[];
}) {
  return (
    <ul className="selection-tree">
      {model.fields.map((field) => {
        const child =
          field.kind === "map" ? field.valueType : field.type;
        const childModel =
          child?.kind === "message" && child.typeName ? schema.messages[child.typeName] : undefined;
        const current = selection[field.name];
        const on = current !== undefined;
        return (
          <li key={field.name}>
            <label className="selection-row">
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => {
                  if (!event.target.checked) {
                    onChange(field.name, undefined);
                  } else if (childModel && child?.typeName) {
                    onChange(field.name, allSelected(schema, child.typeName));
                  } else {
                    onChange(field.name, true);
                  }
                }}
              />
              <span className="mono">{prefix.concat(field.name).join(".")}</span>
              <span className="muted small">
                {field.kind === "map"
                  ? `map<${field.mapKey}, ${childKindLabel(child)}>`
                  : field.kind === "list"
                    ? `repeated ${childKindLabel(child)}`
                    : childKindLabel(child)}
              </span>
            </label>
            {on && childModel && typeof current === "object" && (
              <div className="selection-children">
                <SelectionTree
                  schema={schema}
                  model={childModel}
                  selection={current as Record<string, Sel>}
                  onChange={(name, value) => {
                    const next: Record<string, Sel> = { ...(current as Record<string, Sel>) };
                    if (value === undefined) delete next[name];
                    else next[name] = value;
                    onChange(field.name, next);
                  }}
                  prefix={prefix.concat(field.name)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
