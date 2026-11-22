// Client for the station's HTTP API. Server streams are consumed as SSE from a
// fetch() body so that the UI can (a) see each message as it arrives and
// (b) stop the call through POST /api/call/stop even if the response body is
// still open.
import type {
  CallResult,
  CollectedMessage,
  SchemaPayload,
  ServicesResponse,
  StreamEndEvent,
  StreamStartEvent,
} from "./types";

async function readError(response: Response): Promise<Error> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body?.error) detail = body.error;
    const error = new Error(detail) as Error & { field?: string; status?: number };
    error.field = body?.field;
    error.status = response.status;
    return error;
  } catch {
    return new Error(detail);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as T;
}

export function listServices(target: string): Promise<ServicesResponse> {
  return postJson<ServicesResponse>("/api/services", { target });
}

export function fetchSchema(target: string, service: string): Promise<SchemaPayload> {
  return postJson<SchemaPayload>("/api/schema", { target, service });
}

export function runUnary(args: {
  target: string;
  service: string;
  method: string;
  request: unknown;
  metadata?: Record<string, string>;
  deadlineMs?: number;
}): Promise<CallResult> {
  return postJson<CallResult>("/api/call", args);
}

export function stopStream(callId: string): Promise<{ callId: string; stopping: boolean }> {
  return postJson("/api/call/stop", { callId });
}

export interface StreamHandlers {
  onStart(event: StreamStartEvent): void;
  onMessage(message: CollectedMessage): void;
  onEnd(event: StreamEndEvent): void;
  onTransportError(error: Error): void;
}

export interface StreamHandle {
  /** Ask the server to cancel; the SSE `end` event still arrives. */
  stop(): void;
  /** Abort the HTTP connection without waiting for `end`. */
  abort(): void;
}

/**
 * Start a server-streaming call and feed its SSE events to the handlers.
 * The promise resolves when the response body closes.
 */
export async function runStream(
  args: {
    target: string;
    service: string;
    method: string;
    request: unknown;
    metadata?: Record<string, string>;
    deadlineMs?: number;
  },
  handlers: StreamHandlers,
): Promise<void> {
  const controller = new AbortController();
  let callId: string | null = null;
  let stopRequested = false;
  let finished = false;

  const handle: StreamHandle = {
    stop() {
      if (finished) return;
      stopRequested = true;
      if (callId) {
        void stopStream(callId).catch(() => {
          // Fall back to dropping the connection if the stop call fails.
          controller.abort();
        });
      } else {
        controller.abort();
      }
    },
    abort() {
      if (finished) return;
      stopRequested = true;
      controller.abort();
    },
  };
  activeHandle = handle;
  onStreamHandle?.(handle);

  let response: Response;
  try {
    response = await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch (error) {
    finished = true;
    if (activeHandle === handle) {
      activeHandle = null;
      onStreamHandle?.(null);
    }
    if (!stopRequested) handlers.onTransportError(asError(error));
    return;
  }
  if (!response.ok || !response.body) {
    finished = true;
    if (activeHandle === handle) {
      activeHandle = null;
      onStreamHandle?.(null);
    }
    handlers.onTransportError(await readError(response));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        handleFrame(frame);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!stopRequested) handlers.onTransportError(asError(error));
  } finally {
    finished = true;
    if (activeHandle === handle) {
      activeHandle = null;
      onStreamHandle?.(null);
    }
  }

  function handleFrame(frame: string) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    switch (event) {
      case "start": {
        callId = (payload as StreamStartEvent).callId;
        handlers.onStart(payload as StreamStartEvent);
        break;
      }
      case "message":
        handlers.onMessage(payload as CollectedMessage);
        break;
      case "end":
        handlers.onEnd(payload as StreamEndEvent);
        break;
      default:
        break;
    }
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

// A module-level hook so App can render a Stop button for the live call.
let onStreamHandle: ((handle: StreamHandle | null) => void) | null = null;
// The stream currently owned by this module. A newer run replaces it, so a
// late cleanup from an old stream must not clear the new one's handle.
let activeHandle: StreamHandle | null = null;

export function setStreamHandleListener(listener: ((handle: StreamHandle | null) => void) | null) {
  onStreamHandle = listener;
  if (listener && activeHandle) listener(activeHandle);
}
