import type {
  CallError,
  CollectedMessage,
  PresenceEntry,
  StreamEndEvent,
  StreamStartEvent,
  UnaryResult,
} from "../types";

export function SentView({
  requestJson,
  sentFields,
  requestBytesBase64,
  requestBytesHex,
  schemaType,
  inFlight,
}: {
  requestJson: Record<string, unknown>;
  sentFields: Record<string, PresenceEntry>;
  requestBytesBase64: string;
  requestBytesHex: string;
  schemaType?: string;
  /** Live-stream start event: the call is running, the wire report is not final yet. */
  inFlight?: boolean;
}) {
  return (
    <div className="sent-view">
      <div className="subhead">What the form encoded (decoded from the request bytes)</div>
      {inFlight && (
        <p className="muted small">The call is still running; this is the encoded request, not a reply.</p>
      )}
      <pre className="code-block json-block">{JSON.stringify(requestJson, null, 2)}</pre>

      <div className="subhead">Field presence at the wire level</div>
      <table className="structure-table">
        <thead>
          <tr>
            <th>field</th>
            <th>kind</th>
            <th>on the wire</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(sentFields).map(([name, entry]) => (
            <tr key={name} className={entry.set ? "" : "absent"}>
              <td className="mono">{name}</td>
              <td>
                <span className={`badge ${entry.kind}`}>{entry.kind}</span>
              </td>
              <td>
                <PresenceText entry={entry} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="subhead">Exact request bytes</div>
      <div className="bytes-view">
        <div>
          <div className="muted small">base64 · {requestBytesBase64.length} chars</div>
          <pre className="code-block wrap">{requestBytesBase64 || "(empty)"}</pre>
        </div>
        <div>
          <div className="muted small">hex · {requestBytesHex.length / 2} bytes</div>
          <pre className="code-block wrap">{requestBytesHex || "(empty)"}</pre>
        </div>
      </div>
      {schemaType && <p className="muted small">Request type: {schemaType}</p>}
    </div>
  );
}

/** Initial response metadata, when the server sent any. */
export function ResponseMetadata({
  metadata,
}: {
  metadata: Record<string, string[]> | undefined;
}) {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return null;
  return (
    <details className="response-metadata">
      <summary className="muted small">Response metadata ({entries.length})</summary>
      <pre className="code-block small-block">{JSON.stringify(metadata, null, 2)}</pre>
    </details>
  );
}

function PresenceText({ entry }: { entry: PresenceEntry }) {
  switch (entry.kind) {
    case "implicit":
      return (
        <span className="small">
          {entry.set ? "non-default value encoded" : "default value: encoded as nothing (same as absent)"}
        </span>
      );
    case "explicit":
      return <span className="small">{entry.set ? "set" : "not set"}</span>;
    case "oneof":
      return <span className="small">{entry.set ? "this branch is active" : "inactive"}</span>;
    case "repeated":
      return <span className="small">{entry.count} entries</span>;
    default:
      return null;
  }
}

export function StatusBanner({
  result,
  messages,
}: {
  result: UnaryResult | StreamEndEvent;
  messages: CollectedMessage[];
}) {
  if (result.kind === "unary") {
    if (result.status === "ok") {
      return (
        <div className="status-banner ok">
          <strong>Unary response received</strong>
          <span className="muted small">{result.durationMs} ms</span>
        </div>
      );
    }
    return <ErrorBanner error={result.error} title="Unary call failed" />;
  }

  switch (result.status) {
    case "ok":
      return (
        <div className="status-banner ok">
          <strong>Stream ended successfully</strong>
          <span className="muted small">
            {result.messageCount} message{result.messageCount === 1 ? "" : "s"} · {result.durationMs} ms
          </span>
        </div>
      );
    case "cancelled":
      return (
        <div className="status-banner cancelled">
          <strong>Stopped by you</strong>
          <span className="muted small">
            {messages.length} message{messages.length === 1 ? "" : "s"} received before cancellation are kept
            {result.durationMs !== undefined ? ` · ${result.durationMs} ms` : ""}
          </span>
        </div>
      );
    default:
      return (
        <div className="status-banner error">
          <strong>Stream failed{result.partial ? " mid-flight" : ""}</strong>
          <span className="muted small">
            {messages.length} message{messages.length === 1 ? "" : "s"} received before the error are kept
          </span>
          <ErrorDetails error={result.error} />
        </div>
      );
  }
}

export function ErrorBanner({ error, title }: { error: CallError | null; title: string }) {
  return (
    <div className="status-banner error">
      <strong>{title}</strong>
      <ErrorDetails error={error} />
    </div>
  );
}

function ErrorDetails({ error }: { error: CallError | null }) {
  if (!error) return null;
  return (
    <div className="error-details">
      <div>
        <span className="badge error">{error.status}</span>
        <span className="muted small"> code {error.code}</span>
      </div>
      <div className="mono small">{error.details}</div>
      {error.metadata && Object.keys(error.metadata).length > 0 && (
        <pre className="code-block small-block">{JSON.stringify(error.metadata, null, 2)}</pre>
      )}
    </div>
  );
}

export function StreamStartView({ start }: { start: StreamStartEvent }) {
  return (
    <div className="stream-start">
      <div className="muted small">
        Started {start.startedAt} · callId <code>{start.callId}</code>
      </div>
    </div>
  );
}
