import type { FieldModel, FieldState, FormNode, FormPath } from "../formModel";
import {
  addListItem,
  addMapEntry,
  createNode,
  elementFieldModel,
  patchFieldState,
  pathKey,
  removeListItem,
  removeMapEntry,
  replaceFieldState,
  selectOneof,
  setMapKey,
} from "../formModel";
import type { EnumValue, MessageModel, SchemaPayload } from "../types";

interface RootProps {
  schema: SchemaPayload;
  /** Type of the form's outermost message, used for all mutations. */
  rootTypeName: string;
  /** The single editable tree; every component below points at a node in it. */
  root: FormNode;
  onRootChange(next: FormNode): void;
}

interface NodeProps extends RootProps {
  /** Message type of the node being displayed. */
  typeName: string;
  /** The node being displayed (a reference inside `root`). */
  node: FormNode;
  /** Absolute path from `root` to this node. */
  path: FormPath;
  depth: number;
}

function refLabel(ref: FieldModel["type"]): string {
  if (!ref) return "?";
  if (ref.kind === "message" || ref.kind === "enum") return shortName(ref.typeName ?? "");
  return ref.scalar ?? "?";
}

function shortName(typeName: string): string {
  const dot = typeName.lastIndexOf(".");
  return dot === -1 ? typeName : typeName.slice(dot + 1);
}

function typeLabel(field: FieldModel): string {
  if (field.kind === "map") {
    return `map<${field.mapKey ?? "?"}, ${refLabel(field.valueType)}>`;
  }
  if (field.kind === "list") return `repeated ${refLabel(field.type)}`;
  return refLabel(field.type);
}

function presenceBadge(field: FieldModel): { text: string; title: string; tone: string } {
  switch (field.presence) {
    case "implicit":
      return {
        text: "implicit",
        tone: "implicit",
        title:
          "proto3 implicit presence: the wire cannot distinguish an unset field from one set to the default. Sending 0 / \"\" is byte-identical to omitting it.",
      };
    case "oneof":
      return { text: "oneof", tone: "oneof", title: `Member of oneof ${field.oneofName}` };
    case "repeated":
      return {
        text: "repeated",
        tone: "repeated",
        title:
          "Lists and maps have no 'present but empty' state; an empty collection is what an absent one decodes to.",
      };
    default:
      return {
        text: "optional",
        tone: "explicit",
        title: "Explicit presence: unset and set-to-default are different on the wire.",
      };
  }
}

/** Display the fields of one message node, editing the tree through props.root. */
export function SchemaForm(props: NodeProps) {
  const { schema, typeName, node, depth } = props;
  const model = schema.messages[typeName];
  if (!model) return <p className="muted">Unknown message type {typeName}</p>;

  const groups = model.oneofs.map((group) => ({
    ...group,
    active: node.oneofs[group.name] ?? null,
  }));
  const grouped = new Set(groups.flatMap((g) => g.fields));

  return (
    <div className={depth > 0 ? "message-body nested" : "message-body"}>
      {model.fields.length === 0 && <p className="muted">This message has no fields.</p>}
      {model.fields.map((field) => {
        if (grouped.has(field.name)) return null;
        const state = node.fields[field.name];
        if (!state) return null;
        return <FieldRow key={field.name} {...props} field={field} state={state} />;
      })}
      {groups.map((group) => (
        <OneofGroup
          key={group.name}
          {...props}
          model={model}
          groupName={group.name}
          members={group.fields}
          active={group.active}
        />
      ))}
    </div>
  );
}

function FieldRow(
  props: NodeProps & { field: FieldModel; state: FieldState },
) {
  const { schema, field, state, path, root, rootTypeName, onRootChange } = props;
  const fieldPath: FormPath = [...path, { field: field.name }];
  const badge = presenceBadge(field);

  if (field.kind === "list") {
    return (
      <div className={`field field-list ${field.presence}`} id={`field-${pathKey(fieldPath)}`}>
        <FieldHeader field={field} badge={badge} />
        <div className="collection">
          {state.items.length === 0 && (
            <p className="muted small">
              Empty. A list with zero elements is exactly what an absent list decodes to; the
              protocol does not encode “present but empty”.
            </p>
          )}
          {state.items.map((item, index) => (
            <div key={item.id} className="collection-row">
              <span className="row-index">[{index}]</span>
              <div className="row-content">
                <ValueEditor
                  {...props}
                  field={elementFieldModel(field)}
                  state={item.state}
                  path={[...fieldPath, { item: index }]}
                />
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove element ${index}`}
                onClick={() =>
                  onRootChange(removeListItem(root, schema, rootTypeName, fieldPath, index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="add-button"
            onClick={() => onRootChange(addListItem(root, schema, rootTypeName, fieldPath))}
          >
            + Add element
          </button>
        </div>
      </div>
    );
  }

  if (field.kind === "map") {
    return (
      <div className={`field field-map ${field.presence}`} id={`field-${pathKey(fieldPath)}`}>
        <FieldHeader field={field} badge={badge} />
        <div className="collection">
          {state.entries.length === 0 && (
            <p className="muted small">
              Empty map. Zero entries is exactly what an absent map decodes to.
            </p>
          )}
          {state.entries.map((entry, index) => (
            <div key={entry.id} className="collection-row map-row">
              <input
                className={`key-input ${field.bigintKey ? "mono" : ""}`}
                value={entry.key}
                inputMode={field.bigintKey ? "numeric" : "text"}
                placeholder={`${field.mapKey ?? "key"}`}
                aria-label={`Map key ${index}`}
                onChange={(event) =>
                  onRootChange(
                    setMapKey(root, schema, rootTypeName, fieldPath, index, event.target.value),
                  )
                }
              />
              <span className="muted">→</span>
              <div className="row-content">
                <ValueEditor
                  {...props}
                  field={elementFieldModel(field)}
                  state={entry.state}
                  path={[...fieldPath, { entry: index }]}
                />
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove map entry ${index}`}
                onClick={() =>
                  onRootChange(removeMapEntry(root, schema, rootTypeName, fieldPath, index))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="add-button"
            onClick={() => onRootChange(addMapEntry(root, schema, rootTypeName, fieldPath))}
          >
            + Add entry
          </button>
        </div>
      </div>
    );
  }

  if (field.presence === "implicit") {
    return (
      <div className="field field-singular implicit" id={`field-${pathKey(fieldPath)}`}>
        <FieldHeader field={field} badge={badge} />
        <div className="implicit-note">
          No presence switch here on purpose: the wire cannot tell “unset” from “set to the
          default”. Sending <code>{defaultHint(field)}</code> produces the same bytes as omitting
          the field.
        </div>
        <ValueEditor {...props} field={field} state={state} path={fieldPath} />
      </div>
    );
  }

  return (
    <div
      className={`field field-singular ${field.presence} ${state.active ? "active" : "inactive"}`}
      id={`field-${pathKey(fieldPath)}`}
    >
      <div className="field-head">
        <label className="toggle">
          <input
            type="checkbox"
            checked={state.active}
            onChange={(event) =>
              onRootChange(
                patchFieldState(root, schema, rootTypeName, fieldPath, {
                  active: event.target.checked,
                }),
              )
            }
          />
          <span className="toggle-text">{state.active ? "set" : "unset"}</span>
        </label>
        <FieldHeader field={field} badge={badge} />
      </div>
      {state.active ? (
        <div className="field-value">
          <ValueEditor {...props} field={field} state={state} path={fieldPath} />
          {field.type?.kind !== "message" && isDefaultText(field, state) && (
            <p className="small success">
              Set to the default value. Because this field has explicit presence, that is still
              encoded and the remote side can tell it apart from “unset”.
            </p>
          )}
        </div>
      ) : (
        <p className="muted small">Not set: the field will be absent from the request bytes.</p>
      )}
    </div>
  );
}

function OneofGroup(
  props: NodeProps & {
    model: MessageModel;
    groupName: string;
    members: string[];
    active: string | null;
  },
) {
  const { schema, root, rootTypeName, onRootChange, node, path, groupName, members, active } = props;
  const activeField = props.model.fields.find((f) => f.name === active) ?? null;
  const activeState = activeField ? node.fields[activeField.name] : undefined;

  const choose = (member: string | null) => {
    if (member === active) return;
    if (active !== null) {
      const cleared = members.filter((name) => name !== member);
      const message =
        cleared.length > 0
          ? `Switch oneof "${groupName}" from "${active}" to "${member ?? "none"}"?\n\n` +
            `This clears the previous branch and resets these fields:\n  ${cleared.join("\n  ")}`
          : `Switch oneof "${groupName}"?`;
      if (!window.confirm(message)) return;
    }
    onRootChange(selectOneof(root, schema, rootTypeName, path, groupName, member));
  };

  return (
    <div className="oneof">
      <div className="oneof-head">
        <span className="oneof-name">oneof {groupName}</span>
        <span className="muted small">at most one branch may be set</span>
      </div>
      <div className="oneof-branches" role="radiogroup" aria-label={`oneof ${groupName}`}>
        <label className={`branch ${active === null ? "selected" : ""}`}>
          <input
            type="radio"
            name={`oneof-${groupName}-${pathKey(path)}`}
            checked={active === null}
            onChange={() => choose(null)}
          />
          <span>none</span>
        </label>
        {members.map((name) => {
          const field = props.model.fields.find((f) => f.name === name);
          if (!field) return null;
          return (
            <label key={name} className={`branch ${active === name ? "selected" : ""}`}>
              <input
                type="radio"
                name={`oneof-${groupName}-${pathKey(path)}`}
                checked={active === name}
                onChange={() => choose(name)}
              />
              <code>{name}</code>
              <span className="muted small">{typeLabel(field)}</span>
            </label>
          );
        })}
      </div>
      {activeField && activeState && (
        <div className="oneof-active">
          <div className="oneof-clear-note">
            Only <code>{groupName}.{activeField.name}</code> is on the wire.
            {members.length > 1 && (
              <>
                {" "}Switching branch clears{" "}
                <strong>{members.filter((m) => m !== activeField.name).join(", ")}</strong>.
              </>
            )}
          </div>
          <ValueEditor {...props} field={activeField} state={activeState} path={[...path, { field: activeField.name }]} />
        </div>
      )}
    </div>
  );
}

function FieldHeader({
  field,
  badge,
}: {
  field: FieldModel;
  badge: { text: string; title: string; tone: string };
}) {
  return (
    <div className="field-title">
      <code className="field-name">{field.name}</code>
      <span className="field-number">#{field.number}</span>
      <span className="field-type">{typeLabel(field)}</span>
      <span className={`badge ${badge.tone}`} title={badge.title}>
        {badge.text}
      </span>
      {field.deprecated && <span className="badge deprecated">deprecated</span>}
    </div>
  );
}

function defaultHint(field: FieldModel): string {
  if (field.type?.kind === "enum") return field.enumValues?.[0]?.name ?? "0";
  switch (field.type?.scalar) {
    case "string":
      return '""';
    case "bytes":
      return "empty bytes";
    case "bool":
      return "false";
    default:
      return "0";
  }
}

function isDefaultText(field: FieldModel, state: FieldState): boolean {
  if (field.type?.kind === "enum") {
    const first = field.enumValues?.[0]?.name;
    return first !== undefined && state.text === first;
  }
  switch (field.type?.scalar) {
    case "string":
    case "bytes":
      return state.text === "";
    case "bool":
      return state.text === "false";
    default:
      return state.text === "0" || state.text === "0.0" || state.text === "";
  }
}

function ValueEditor(
  props: NodeProps & { field: FieldModel; state: FieldState; path: FormPath },
) {
  const { schema, field, state, path, root, rootTypeName, onRootChange } = props;

  // Every edit replaces the field state at `path` inside the root tree.
  const replace = (next: FieldState) =>
    onRootChange(replaceFieldState(root, schema, rootTypeName, path, next));

  if (field.type?.kind === "message") {
    const childType = field.type.typeName ?? "";
    const child = state.child ?? createNode(schema, childType);
    return (
      <div className="nested-message">
        <div className="nested-head">
          <code>{childType}</code>
        </div>
        <SchemaForm
          {...props}
          typeName={childType}
          node={child}
          path={[...path, { child: true }]}
          depth={props.depth + 1}
        />
      </div>
    );
  }

  if (field.type?.kind === "enum") {
    const values: EnumValue[] = field.enumValues ?? [];
    return (
      <select
        className="value-input mono"
        value={state.text}
        onChange={(event) => replace({ ...state, text: event.target.value })}
      >
        {values.map((value) => (
          <option key={value.name} value={value.name}>
            {value.name} = {value.number}
          </option>
        ))}
      </select>
    );
  }

  if (field.type?.scalar === "bool") {
    return (
      <label className="inline">
        <input
          type="checkbox"
          checked={state.text === "true"}
          onChange={(event) =>
            replace({ ...state, text: event.target.checked ? "true" : "false" })
          }
        />
        <span className="mono">{state.text}</span>
      </label>
    );
  }

  if (field.type?.scalar === "bytes") {
    return (
      <div className="bytes-editor">
        <select
          className="encoding-select"
          value={state.encoding}
          aria-label="Bytes encoding"
          onChange={(event) =>
            replace({ ...state, encoding: event.target.value as FieldState["encoding"] })
          }
        >
          <option value="base64">base64</option>
          <option value="hex">hex</option>
          <option value="utf8">utf-8 text</option>
        </select>
        <input
          className="value-input mono"
          value={state.text}
          placeholder={
            state.encoding === "base64"
              ? "e.g. AAEC/w=="
              : state.encoding === "hex"
                ? "e.g. 000102ff"
                : "text"
          }
          onChange={(event) => replace({ ...state, text: event.target.value })}
        />
        <span className="muted small">encoding is sent along with the value</span>
      </div>
    );
  }

  const numeric = field.type?.scalar !== undefined && field.type.scalar !== "string";
  // A plain text input (inputMode="numeric" only hints at a keypad): native
  // number inputs would round 64-bit values through a double.
  return (
    <input
      className={`value-input ${numeric ? "mono" : ""}`}
      value={state.text}
      inputMode={numeric ? "numeric" : undefined}
      placeholder={field.type?.scalar === "string" ? "text" : undefined}
      onChange={(event) => replace({ ...state, text: event.target.value })}
    />
  );
}
