import type { TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * Strip ANSI escape sequences (CSI, OSC) from terminal text.
 * Same pattern used in claude-local adapter quota.ts.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Pull the reasoning text out of a `reasoning.available` event payload.
 * The exact field name is defined by the external Hermes gateway, so this
 * checks the plausible field names (mirroring the fallback chain used by
 * extractOutput() in gateway/server/execute.ts) and recurses one level into
 * nested `data` / `payload` records.
 */
function extractDirectReasoningText(data: Record<string, unknown>): string {
  return (
    asString(data.reasoning).trim() ||
    asString(data.reasoning_text).trim() ||
    asString(data.thinking).trim() ||
    asString(data.text).trim() ||
    asString(data.summary).trim() ||
    asString(data.content).trim()
  );
}

function extractReasoningText(data: Record<string, unknown> | null): string {
  if (!data) return "";
  const direct = extractDirectReasoningText(data);
  if (direct) return stripAnsi(direct);
  const nested = asRecord(data.data) ?? asRecord(data.payload);
  const nestedDirect = nested ? extractDirectReasoningText(nested) : "";
  return nestedDirect ? stripAnsi(nestedDirect) : "";
}

const EVENT_MARKER = "[hermes-gateway:event]";
const EVENT_LINE = /^\[hermes-gateway:event\]\s+run=([^\s]+)\s+event=([^\s]+)\s+data=(.*)$/s;
const PREVIEW_MAX_CHARS = 1_200;

function truncatePreview(text: string): string {
  return text.length <= PREVIEW_MAX_CHARS
    ? text
    : `${text.slice(0, PREVIEW_MAX_CHARS)}… [${text.length - PREVIEW_MAX_CHARS} more chars not shown]`;
}

type HermesGatewayParserState = {
  runCreated: boolean;
  /** Tool calls that started and did not complete yet, per tool name, oldest first. */
  pendingTools: Map<string, string[]>;
  /** Assistant text streamed since the last non-delta event; used to drop the echo Hermes sends as reasoning. */
  streamedText: string;
};

function createState(): HermesGatewayParserState {
  return { runCreated: false, pendingTools: new Map(), streamedText: "" };
}

function toolUseId(runId: string, name: string, data: Record<string, unknown> | null, ts: string): string {
  return `${runId}:${typeof data?.seq === "number" ? data.seq : `${name}:${ts}`}`;
}

function parseEvent(
  runId: string,
  eventName: string,
  data: Record<string, unknown> | null,
  ts: string,
  state: HermesGatewayParserState | null,
): TranscriptEntry[] {
  if (eventName === "message.delta") {
    const delta = asString(data?.delta) || asString(data?.text_delta);
    if (!delta) return [];
    if (state) state.streamedText += delta;
    return [{ kind: "assistant", ts, text: stripAnsi(delta), delta: true }];
  }

  const streamed = state ? state.streamedText : "";
  if (state) state.streamedText = "";

  if (eventName === "run.failed" || eventName === "run.error") {
    const message = asString(data?.error) || asString(data?.message) || "Hermes run failed";
    return [{ kind: "stderr", ts, text: message }];
  }
  if (eventName === "reasoning.available") {
    const reasoning = extractReasoningText(data);
    // Hermes repeats the text it just streamed as message.delta; show it once.
    // Compare a normalized prefix: long texts are cut off in the log line.
    if (state && reasoning && streamed) {
      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      if (normalize(streamed).startsWith(normalize(reasoning).slice(0, 200))) return [];
    }
    return [{ kind: "thinking", ts, text: reasoning || "Hermes reasoning available" }];
  }
  if (eventName === "message.interim") {
    const text = asString(data?.text).trim();
    if (!text || data?.already_streamed === true) return [];
    return [{ kind: "assistant", ts, text: stripAnsi(text) }];
  }
  if (eventName === "tool.started") {
    const name = asString(data?.tool) || asString(data?.tool_name) || "tool";
    const id = toolUseId(runId, name, data, ts);
    if (state) {
      const queue = state.pendingTools.get(name) ?? [];
      queue.push(id);
      state.pendingTools.set(name, queue);
    }
    return [{ kind: "tool_call", ts, name, toolUseId: id, input: { preview: truncatePreview(stripAnsi(asString(data?.preview))) } }];
  }
  if (eventName === "tool.completed") {
    const name = asString(data?.tool) || asString(data?.tool_name) || "tool";
    const id = state?.pendingTools.get(name)?.shift() ?? toolUseId(runId, name, data, ts);
    const duration = asNumber(data?.duration);
    const suffix = duration > 0 ? `\n(${duration.toFixed(1)}s)` : "";
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: id,
        toolName: name,
        content: `${truncatePreview(stripAnsi(asString(data?.preview)))}${suffix}`,
        isError: data?.error === true,
      },
    ];
  }
  if (eventName === "run.completed") {
    // The final text was already streamed as message.delta, and Hermes sends no
    // cost; a "result" entry would repeat the text and show a cost of $0.
    const usage = asRecord(data?.usage);
    if (!usage) return [{ kind: "system", ts, text: "Hermes run completed" }];
    const format = (value: unknown) => asNumber(value).toLocaleString("en-US");
    const cached = asNumber(usage.cache_read_tokens);
    return [
      {
        kind: "system",
        ts,
        text:
          `Hermes run ${data?.interrupted === true ? "interrupted" : "completed"}: ` +
          `${format(usage.input_tokens)} input tokens${cached > 0 ? ` (${format(cached)} from cache)` : ""}, ` +
          `${format(usage.output_tokens)} output tokens`,
      },
    ];
  }
  return [{ kind: "system", ts, text: `Hermes event: ${eventName}` }];
}

function parseLine(line: string, ts: string, state: HermesGatewayParserState | null): TranscriptEntry[] {
  const cleaned = stripAnsi(line);
  const trimmed = cleaned.trim();
  if (!trimmed) return [];

  // The server writes every message.delta twice: as an event line and as the
  // raw text without a line break. The raw text therefore lands in front of
  // the next event line; the event itself already carries it.
  const markerIndex = trimmed.indexOf(EVENT_MARKER);
  const eventMatch = (markerIndex > 0 ? trimmed.slice(markerIndex) : trimmed).match(EVENT_LINE);
  if (eventMatch) {
    return parseEvent(eventMatch[1], eventMatch[2], asRecord(safeJsonParse(eventMatch[3])), ts, state);
  }

  if (trimmed.startsWith("[hermes-gateway]")) {
    const text = trimmed.replace(/^\[hermes-gateway\]\s*/, "");
    if (state && text.startsWith("run created")) state.runCreated = true;
    return [{ kind: "system", ts, text }];
  }

  // After the run exists, the only unprefixed stdout is the raw delta echo.
  if (state?.runCreated && !trimmed.startsWith("[paperclip]")) return [];

  return [{ kind: "stdout", ts, text: cleaned }];
}

export function parseHermesGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLine(line, ts, null);
}

/** Stateful parser for one transcript build: pairs tool results with their calls and drops delta echoes. */
export function createHermesGatewayStdoutParser(): {
  parseLine: (line: string, ts: string) => TranscriptEntry[];
  reset: () => void;
} {
  let state = createState();
  return {
    parseLine: (line, ts) => parseLine(line, ts, state),
    reset: () => {
      state = createState();
    },
  };
}
