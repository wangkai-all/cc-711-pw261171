import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSchema,
  listServices,
  runStream,
  runUnary,
  setStreamHandleListener,
  type StreamHandle,
} from "./api";
import { SchemaForm } from "./components/FormEditor";
import { ExportPanel } from "./components/ExportPanel";
import { MessageView } from "./components/MessageView";
import { ResponseMetadata, SentView, StatusBanner, StreamStartView } from "./components/ResultView";
import { TypeViewer } from "./components/TypeViewer";
import {
  buildRequestJson,
  createNode,
  FormBuildError,
  type FormNode,
} from "./formModel";
import type {
  CallResult,
  CollectedMessage,
  MethodModel,
  SchemaPayload,
  StreamStartEvent,
  UnaryResult,
} from "./types";

const DEFAULT_TARGET = "127.0.0.1:50051";

type Phase = "idle" | "discovering" | "loading-schema" | "running" | "done";

export function App() {
  const [target, setTarget] = useState(DEFAULT_TARGET);
  // target actually used by the resolved schema; the input above may have
  // been edited since, so calls must not silently follow it.
  const [resolvedTarget, setResolvedTarget] = useState(DEFAULT_TARGET);
  const [services, setServices] = useState<string[]>([]);
  const [serviceName, setServiceName] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaPayload | null>(null);
  const [methodName, setMethodName] = useState<string | null>(null);
  const [form, setForm] = useState<FormNode | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const [start, setStart] = useState<StreamStartEvent | null>(null);
  const [streamed, setStreamed] = useState<CollectedMessage[]>([]);
  const [result, setResult] = useState<CallResult | null>(null);
  const [live, setLive] = useState(false);
  const [rightTab, setRightTab] = useState<"result" | "sent" | "types">("result");

  const streamHandle = useRef<StreamHandle | null>(null);
  const streamedRef = useRef<CollectedMessage[]>([]);
  // Bumped whenever the current call is superseded (new call, method switch,
  // reset), so late events from an old stream cannot overwrite fresh state.
  const runToken = useRef(0);

  const cancelActive = useCallback(() => {
    runToken.current += 1;
    streamHandle.current?.abort();
    streamHandle.current = null;
    setLive(false);
  }, []);

  useEffect(() => {
    setStreamHandleListener((handle) => {
      streamHandle.current = handle;
      setLive(Boolean(handle));
    });
    return () => setStreamHandleListener(null);
  }, []);

  const method: MethodModel | null = useMemo(() => {
    if (!schema || !methodName) return null;
    return schema.service.methods.find((m) => m.name === methodName) ?? null;
  }, [schema, methodName]);

  const inputType = method?.inputType ?? null;

  // ---- discovery ----------------------------------------------------------

  const discover = useCallback(async () => {
    cancelActive();
    setPhase("discovering");
    setError(null);
    setSchema(null);
    setServiceName(null);
    setMethodName(null);
    setForm(null);
    setResult(null);
    setStart(null);
    setStreamed([]);
    streamedRef.current = [];
    try {
      const response = await listServices(target.trim());
      setResolvedTarget(response.target);
      setServices(response.services);
      const first = response.services.find((s) => !s.startsWith("grpc.reflection."));
      if (first) setServiceName(first);
      setPhase("idle");
    } catch (err) {
      setError((err as Error).message);
      setPhase("idle");
    }
  }, [target, cancelActive]);

  const loadSchema = useCallback(
    async (service: string) => {
      cancelActive();
      setPhase("loading-schema");
      setError(null);
      setSchema(null);
      setMethodName(null);
      setForm(null);
      setResult(null);
      setStart(null);
      setStreamed([]);
      streamedRef.current = [];
      try {
        const payload = await fetchSchema(target.trim(), service);
        setResolvedTarget(payload.target);
        setSchema(payload);
        const first = payload.service.methods.find((m) => !m.requestStream) ?? payload.service.methods[0];
        setMethodName(first?.name ?? null);
        setPhase("idle");
      } catch (err) {
        setError((err as Error).message);
        setPhase("idle");
      }
    },
    [target, cancelActive],
  );

  // Rebuild the form whenever the selected method's input type changes.
  useEffect(() => {
    if (!schema || !inputType) {
      setForm(null);
      return;
    }
    setForm(createNode(schema, inputType));
  }, [schema, inputType]);

  // ---- calls --------------------------------------------------------------

  const requestPreview = useMemo(() => {
    if (!schema || !inputType || !form) return null;
    try {
      return { json: buildRequestJson(schema, inputType, form), error: null as string | null };
    } catch (err) {
      if (err instanceof FormBuildError) return { json: null, error: err.message };
      return { json: null, error: (err as Error).message };
    }
  }, [schema, inputType, form]);

  const run = useCallback(async () => {
    if (!schema || !method || !form) return;
    let request: Record<string, unknown>;
    try {
      request = buildRequestJson(schema, method.inputType, form);
    } catch (err) {
      setFieldError(
        err instanceof FormBuildError ? err.message : (err as Error).message,
      );
      return;
    }
    setFieldError(null);
    cancelActive();
    const token = runToken.current;
    setResult(null);
    setStart(null);
    setStreamed([]);
    streamedRef.current = [];
    setError(null);

    if (!method.responseStream) {
      setPhase("running");
      try {
        const response = await runUnary({
          target: resolvedTarget,
          service: schema.service.typeName,
          method: method.name,
          request,
        });
        if (runToken.current !== token) return;
        setResult(response);
      } catch (err) {
        if (runToken.current !== token) return;
        setError((err as Error).message);
      } finally {
        if (runToken.current === token) setPhase("done");
      }
      return;
    }

    setPhase("running");
    await runStream(
      {
        target: resolvedTarget,
        service: schema.service.typeName,
        method: method.name,
        request,
      },
      {
        onStart(event) {
          if (runToken.current === token) setStart(event);
        },
        onMessage(message) {
          if (runToken.current !== token) return;
          streamedRef.current = [...streamedRef.current, message];
          setStreamed(streamedRef.current);
        },
        onEnd(event) {
          if (runToken.current !== token) return;
          setResult(event);
          setPhase("done");
        },
        onTransportError(err) {
          if (runToken.current !== token) return;
          setError(err.message);
          setPhase("done");
        },
      },
    );
  }, [schema, method, form, resolvedTarget, cancelActive]);

  const stop = useCallback(() => {
    streamHandle.current?.stop();
  }, []);

  const reset = useCallback(() => {
    cancelActive();
    setResult(null);
    setStart(null);
    setStreamed([]);
    streamedRef.current = [];
    setError(null);
    setFieldError(null);
    setPhase("idle");
  }, [cancelActive]);

  const outputType = method?.outputType ?? null;

  // Messages to display: during a live stream show what has arrived so far;
  // after the end event use the final record (partial results included).
  const shownMessages: CollectedMessage[] =
    result && result.kind === "stream" ? result.messages : streamed;
  const shownResult: CallResult | null = result;
  // A unary reply is a single collected message too, so it can be exported
  // with the same field selector as streamed messages.
  const exportMessages: Record<string, unknown>[] =
    shownResult?.kind === "unary" && shownResult.status === "ok" && shownResult.message
      ? [shownResult.message as Record<string, unknown>]
      : shownMessages.map((message) => message.json);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <div>
            <h1>gRPC data trial-collection station</h1>
            <p className="muted small">
              Discovered through server reflection · presence-aware request forms · unary and server
              streams
            </p>
          </div>
        </div>
        <div className="target-bar">
          <label htmlFor="target" className="muted small">
            target
          </label>
          <input
            id="target"
            className="target-input mono"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            spellCheck={false}
          />
          <button type="button" className="primary" onClick={() => void discover()} disabled={phase === "discovering"}>
            {phase === "discovering" ? "Discovering…" : "Discover"}
          </button>
        </div>
      </header>

      {error && (
        <div className="alert error">
          <strong>Error</strong>
          <span>{error}</span>
          <button type="button" className="ghost small-button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <h2>Services</h2>
            {services.length === 0 ? (
              <p className="muted small">
                Enter a gRPC target and press Discover. The station lists services through server
                reflection (v1, falling back to v1alpha).
              </p>
            ) : (
              <ul className="service-list">
                {services.map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      className={name === serviceName ? "service-button active" : "service-button"}
                      onClick={() => {
                        setServiceName(name);
                        void loadSchema(name);
                      }}
                    >
                      <span className={name.startsWith("grpc.reflection.") ? "mono small muted" : "mono small"}>
                        {name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {schema && (
              <p className="muted small">
                reflection {schema.version} · {schema.files.length} file
                {schema.files.length === 1 ? "" : "s"} in the resolved closure
              </p>
            )}
          </section>

          {schema && (
            <section className="panel">
              <h2>Methods</h2>
              <ul className="method-list">
                {schema.service.methods.map((entry) => {
                  const unsupported = entry.requestStream;
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        className={entry.name === methodName ? "method-button active" : "method-button"}
                        onClick={() => {
                          setMethodName(entry.name);
                          reset();
                        }}
                        disabled={unsupported}
                        title={unsupported ? "Client/bidirectional streaming is out of scope" : entry.path}
                      >
                        <span className="method-name mono">{entry.name}</span>
                        <span className={`badge ${entry.responseStream ? "stream" : "unary"}`}>
                          {entry.requestStream
                            ? entry.responseStream
                              ? "bidi"
                              : "client stream"
                            : entry.responseStream
                              ? "server stream"
                              : "unary"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </aside>

        <main className="main">
          {!schema && phase !== "loading-schema" && (
            <section className="panel welcome">
              <h2>How this works</h2>
              <ol>
                <li>Discover services through server reflection.</li>
                <li>Pick a service and the station resolves every imported type before building the form.</li>
                <li>Fill the request; presence controls match what the protocol can actually express.</li>
                <li>Collect a unary response or a server stream, then inspect and export fields.</li>
              </ol>
              <p className="muted small">
                The demo service at <code>{DEFAULT_TARGET}</code> includes imported types, an
                explicit-vs-implicit presence pair, a stream that fails mid-flight, and 64-bit
                integers beyond IEEE-754 precision.
              </p>
            </section>
          )}

          {phase === "loading-schema" && <p className="muted">Resolving descriptors…</p>}

          {schema && method && (
            <section className="panel">
              <div className="method-header">
                <div>
                  <h2 className="mono">{method.name}</h2>
                  <p className="muted small mono">{method.path}</p>
                </div>
                <div className="method-signature mono small">
                  {method.requestStream ? "stream " : ""}
                  {method.inputType} → {method.responseStream ? "stream " : ""}
                  {method.outputType}
                </div>
              </div>

              {form && inputType ? (
                <SchemaForm
                  schema={schema}
                  rootTypeName={inputType}
                  root={form}
                  onRootChange={setForm}
                  typeName={inputType}
                  node={form}
                  path={[]}
                  depth={0}
                />
              ) : (
                <p className="muted">No request type.</p>
              )}

              <div className="request-actions">
                <button
                  type="button"
                  className="primary big"
                  onClick={() => void run()}
                  disabled={phase === "running"}
                >
                  {phase === "running"
                    ? "Calling…"
                    : method.responseStream
                      ? "Start stream"
                      : "Call"}
                </button>
                {method.responseStream && (
                  <button
                    type="button"
                    className="danger"
                    onClick={stop}
                    disabled={!live}
                    title="Stop the stream; received messages are kept"
                  >
                    Stop stream
                  </button>
                )}
                <button type="button" className="ghost" onClick={reset} disabled={phase === "running"}>
                  Clear result
                </button>
                {fieldError && <span className="field-error small">{fieldError}</span>}
              </div>

              {requestPreview && (
                <details className="request-preview">
                  <summary>
                    Request JSON that will be sent
                    {requestPreview.error && <span className="field-error small"> · {requestPreview.error}</span>}
                  </summary>
                  <pre className="code-block json-block">
                    {requestPreview.json
                      ? JSON.stringify(requestPreview.json, null, 2)
                      : requestPreview.error}
                  </pre>
                </details>
              )}
            </section>
          )}

          {(shownResult || start || error) && method && schema && (
            <section className="panel result-panel">
              <div className="result-head">
                <h2>Collection</h2>
                <div className="tabs">
                  <button
                    type="button"
                    className={rightTab === "result" ? "tab active" : "tab"}
                    onClick={() => setRightTab("result")}
                  >
                    Result
                    {shownMessages.length > 0 && <span className="tab-meta">{shownMessages.length}</span>}
                  </button>
                  <button
                    type="button"
                    className={rightTab === "sent" ? "tab active" : "tab"}
                    onClick={() => setRightTab("sent")}
                  >
                    Sent
                  </button>
                  <button
                    type="button"
                    className={rightTab === "types" ? "tab active" : "tab"}
                    onClick={() => setRightTab("types")}
                  >
                    Types
                  </button>
                </div>
              </div>

              {rightTab === "result" && (
                <div className="result-body">
                  {shownResult && <StatusBanner result={shownResult} messages={shownMessages} />}
                  {shownResult && <ResponseMetadata metadata={shownResult.metadata} />}
                  {method.responseStream && start && <StreamStartView start={start} />}
                  {method.responseStream && !shownResult && (
                    <p className="muted small">
                      {live
                        ? `Streaming… ${shownMessages.length} message${shownMessages.length === 1 ? "" : "s"} received so far. Press Stop to cancel; received messages stay.`
                        : `${shownMessages.length} message${shownMessages.length === 1 ? "" : "s"} received.`}
                    </p>
                  )}

                  {method.responseStream ? (
                    <div className="message-list">
                      {shownMessages.map((message) => (
                        <details key={message.index} className="message-card" open={shownMessages.length <= 2}>
                          <summary>
                            <span className="mono">#{message.index + 1}</span>
                            <span className="muted small">
                              {message.size} B
                              {message.receivedAt !== undefined ? ` · +${message.receivedAt} ms` : ""}
                            </span>
                          </summary>
                          <MessageView
                            schema={schema}
                            typeName={outputType ?? ""}
                            message={message}
                          />
                        </details>
                      ))}
                      {shownMessages.length === 0 && phase !== "running" && (
                        <p className="muted small">No messages arrived.</p>
                      )}
                    </div>
                  ) : (
                    shownResult &&
                    shownResult.kind === "unary" &&
                    shownResult.status === "ok" &&
                    shownResult.message && (
                      <div className="unary-result">
                        <div className="subhead">
                          Response <span className="muted small mono">{shownResult.outputType}</span>
                        </div>
                        <MessageView
                          schema={schema}
                          typeName={outputType ?? ""}
                          message={{
                            json: shownResult.message,
                            presence: shownResult.presence,
                            bytesBase64: shownResult.messageBytesBase64,
                            bytesHex: shownResult.messageBytesHex,
                            size: shownResult.messageBytesHex
                              ? shownResult.messageBytesHex.length / 2
                              : undefined,
                          }}
                        />
                      </div>
                    )
                  )}

                  {outputType && exportMessages.length > 0 && (
                    <details className="export-section" open={Boolean(shownResult)}>
                      <summary>Export selected fields</summary>
                      <ExportPanel
                        key={outputType}
                        schema={schema}
                        typeName={outputType}
                        messages={exportMessages}
                      />
                    </details>
                  )}
                </div>
              )}

              {rightTab === "sent" && shownResult?.kind === "unary" && (
                <SentView
                  requestJson={(shownResult as UnaryResult).requestJson}
                  sentFields={shownResult.sentFields}
                  requestBytesBase64={shownResult.requestBytesBase64}
                  requestBytesHex={shownResult.requestBytesHex}
                  schemaType={method.inputType}
                />
              )}
              {/* A stream's request is described by its start event, which stays
                  valid after the stream ends (the end event has no request data). */}
              {rightTab === "sent" && shownResult?.kind !== "unary" && start && (
                <SentView
                  requestJson={start.requestJson}
                  sentFields={start.sentFields}
                  requestBytesBase64={start.requestBytesBase64}
                  requestBytesHex={start.requestBytesHex}
                  schemaType={method.inputType}
                  inFlight={!shownResult}
                />
              )}

              {rightTab === "types" && <TypeViewer schema={schema} />}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
