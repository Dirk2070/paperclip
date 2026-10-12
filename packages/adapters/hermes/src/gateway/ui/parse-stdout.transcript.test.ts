import { describe, expect, it } from "vitest";
import { createHermesGatewayStdoutParser, parseHermesGatewayStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-08T12:00:00.000Z";
const RUN = "run_abc";

function eventLine(eventName: string, data: Record<string, unknown>): string {
  return `[hermes-gateway:event] run=${RUN} event=${eventName} data=${JSON.stringify({ event: eventName, run_id: RUN, ...data })}`;
}

describe("parseHermesGatewayStdoutLine — tool steps", () => {
  it("renders tool.started as a tool call with the argument preview", () => {
    const [entry] = parseHermesGatewayStdoutLine(eventLine("tool.started", { tool: "terminal", preview: "ls -la /srv/app", seq: 0 }), TS);
    expect(entry).toEqual({ kind: "tool_call", ts: TS, name: "terminal", toolUseId: `${RUN}:0`, input: { preview: "ls -la /srv/app" } });
  });

  it("pairs tool.completed with the call that started it when two calls overlap", () => {
    const parser = createHermesGatewayStdoutParser();
    parser.parseLine("[hermes-gateway] run created: run_abc", TS);
    const a = parser.parseLine(eventLine("tool.started", { tool: "read_file", preview: "a.md", seq: 3 }), TS)[0];
    const b = parser.parseLine(eventLine("tool.started", { tool: "read_file", preview: "b.md", seq: 4 }), TS)[0];
    const doneA = parser.parseLine(eventLine("tool.completed", { tool: "read_file", preview: "content a", duration: 1.26, error: false, seq: 5 }), TS)[0];
    const doneB = parser.parseLine(eventLine("tool.completed", { tool: "read_file", preview: "content b", duration: 0, error: true, seq: 6 }), TS)[0];
    expect(a).toMatchObject({ kind: "tool_call", toolUseId: `${RUN}:3` });
    expect(b).toMatchObject({ kind: "tool_call", toolUseId: `${RUN}:4` });
    expect(doneA).toEqual({ kind: "tool_result", ts: TS, toolUseId: `${RUN}:3`, toolName: "read_file", content: "content a\n(1.3s)", isError: false });
    expect(doneB).toEqual({ kind: "tool_result", ts: TS, toolUseId: `${RUN}:4`, toolName: "read_file", content: "content b", isError: true });
  });

  it("shortens long result previews", () => {
    const [entry] = parseHermesGatewayStdoutLine(eventLine("tool.completed", { tool: "terminal", preview: "x".repeat(5000), seq: 9 }), TS);
    expect(entry.kind).toBe("tool_result");
    expect((entry as { content: string }).content.length).toBeLessThan(1300);
    expect((entry as { content: string }).content).toContain("3800 more chars not shown");
  });

  it("reports token usage from run.completed without repeating the final text", () => {
    const entries = parseHermesGatewayStdoutLine(
      eventLine("run.completed", { output: "Done.", usage: { input_tokens: 698389, output_tokens: 5417, cache_read_tokens: 257024 } }),
      TS,
    );
    expect(entries).toEqual([
      { kind: "system", ts: TS, text: "Hermes run completed: 698,389 input tokens (257,024 from cache), 5,417 output tokens" },
    ]);
  });

  it("still closes the run when the run.completed payload was cut off in the log", () => {
    const line = `[hermes-gateway:event] run=${RUN} event=run.completed data={"event":"run.completed","output":"Don... [truncated 377 chars]`;
    expect(parseHermesGatewayStdoutLine(line, TS)).toEqual([{ kind: "system", ts: TS, text: "Hermes run completed" }]);
  });

  it("keeps the generic system entry for events it does not know", () => {
    expect(parseHermesGatewayStdoutLine(eventLine("approval.request", { seq: 1 }), TS)).toEqual([
      { kind: "system", ts: TS, text: "Hermes event: approval.request" },
    ]);
  });
});

describe("parseHermesGatewayStdoutLine — message.delta echo", () => {
  it("reads an event line that has raw delta text in front of it", () => {
    const line = `Now${eventLine("message.delta", { delta: " let me check", seq: 13 })}`;
    expect(parseHermesGatewayStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: " let me check", delta: true }]);
  });

  it("drops unprefixed echo lines after the run exists and keeps output before that", () => {
    const parser = createHermesGatewayStdoutParser();
    expect(parser.parseLine("early plain line", TS)).toEqual([{ kind: "stdout", ts: TS, text: "early plain line" }]);
    parser.parseLine("[hermes-gateway] run created: run_abc", TS);
    expect(parser.parseLine("Now let me check", TS)).toEqual([]);
    expect(parser.parseLine("[paperclip] workspace note", TS)).toHaveLength(1);
  });

  it("shows text once when Hermes repeats streamed text as reasoning and as interim message", () => {
    const parser = createHermesGatewayStdoutParser();
    parser.parseLine("[hermes-gateway] run created: run_abc", TS);
    const shown = [
      ...parser.parseLine(eventLine("message.delta", { delta: "Now let me", seq: 1 }), TS),
      ...parser.parseLine(eventLine("message.delta", { delta: " check.", seq: 2 }), TS),
      ...parser.parseLine(eventLine("reasoning.available", { text: "Now let me check.", seq: 3 }), TS),
      ...parser.parseLine(eventLine("message.interim", { text: "Now let me check.", already_streamed: true, seq: 4 }), TS),
    ];
    expect(shown.map((entry) => entry.kind)).toEqual(["assistant", "assistant"]);
  });

  it("keeps reasoning that was not streamed before", () => {
    const parser = createHermesGatewayStdoutParser();
    const shown = parser.parseLine(eventLine("reasoning.available", { text: "Weighing two options.", seq: 3 }), TS);
    expect(shown).toEqual([{ kind: "thinking", ts: TS, text: "Weighing two options." }]);
  });

  it("starts from a clean state after reset", () => {
    const parser = createHermesGatewayStdoutParser();
    parser.parseLine("[hermes-gateway] run created: run_abc", TS);
    parser.reset();
    expect(parser.parseLine("plain line", TS)).toEqual([{ kind: "stdout", ts: TS, text: "plain line" }]);
  });
});
