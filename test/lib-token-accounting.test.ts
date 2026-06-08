import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  estimateTranscriptCost,
  parseTranscriptUsage,
  parseCodexTranscriptUsage,
  parseGeminiTranscriptUsage,
  parseTranscriptUsageForProvider,
  resolveModelPrice,
  totalTokens,
} from "../src/lib/token-accounting";

// Mirrors the real Claude Code transcript shape: each assistant line carries
// message.usage with input/cache_creation/cache_read/output token counts.
function assistantLine(model: string, usage: Record<string, number>, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "sess-1",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: ts,
    message: { model, role: "assistant", usage },
  });
}

describe("parseTranscriptUsage", () => {
  it("sums usage per model and overall, capturing session metadata", () => {
    const content = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-06-01T00:00:00Z" }),
      assistantLine(
        "claude-opus-4-8[1m]",
        { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 200 },
        "2026-06-01T00:00:01Z",
      ),
      assistantLine(
        "claude-opus-4-8[1m]",
        { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 80 },
        "2026-06-01T00:00:05Z",
      ),
      assistantLine(
        "claude-haiku-4-5-20251001",
        { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 12 },
        "2026-06-01T00:00:03Z",
      ),
    ].join("\n");

    const usage = parseTranscriptUsage(content);

    expect(usage.totals).toEqual({ input: 115, cacheCreate: 50, cacheRead: 3030, output: 292, messages: 3 });
    expect(usage.byModel["claude-opus-4-8[1m]"]).toEqual({
      input: 110,
      cacheCreate: 50,
      cacheRead: 3000,
      output: 280,
      messages: 2,
    });
    expect(usage.sessionId).toBe("sess-1");
    expect(usage.gitBranch).toBe("main");
    expect(usage.cwd).toBe("/repo");
    // lastTimestamp is the max across lines, not the file order.
    expect(usage.lastTimestamp).toBe("2026-06-01T00:00:05Z");
    expect(totalTokens(usage.totals)).toBe(115 + 50 + 3030 + 292);
  });

  it("tolerates malformed and irrelevant lines", () => {
    const content = [
      "not json at all",
      "",
      "{ broken json",
      JSON.stringify({ type: "summary", summary: "x" }),
      assistantLine("claude-sonnet-4-6", { input_tokens: 7, output_tokens: 3 }, "2026-06-01T00:00:00Z"),
      JSON.stringify({ type: "assistant", message: { role: "assistant" } }), // assistant without usage
    ].join("\n");

    const usage = parseTranscriptUsage(content);
    expect(usage.totals).toEqual({ input: 7, cacheCreate: 0, cacheRead: 0, output: 3, messages: 1 });
  });

  it("returns zeroed usage for empty content", () => {
    const usage = parseTranscriptUsage("");
    expect(usage.totals).toEqual({ input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 });
    expect(usage.byModel).toEqual({});
  });
});

describe("resolveModelPrice", () => {
  it("matches by substring so versioned model ids resolve", () => {
    expect(resolveModelPrice("claude-opus-4-8[1m]")).toBe(DEFAULT_PRICE_TABLE.opus);
    expect(resolveModelPrice("claude-sonnet-4-6")).toBe(DEFAULT_PRICE_TABLE.sonnet);
    expect(resolveModelPrice("claude-haiku-4-5-20251001")).toBe(DEFAULT_PRICE_TABLE.haiku);
    expect(resolveModelPrice("some-unknown-model")).toBeNull();
  });
});

describe("estimateTranscriptCost", () => {
  it("prices each model and sums, flagging unpriced models", () => {
    const content = [
      assistantLine(
        "claude-opus-4-8",
        { input_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
        "2026-06-01T00:00:00Z",
      ),
      assistantLine(
        "mystery-model",
        { input_tokens: 1_000_000, output_tokens: 0 },
        "2026-06-01T00:00:01Z",
      ),
    ].join("\n");

    const usage = parseTranscriptUsage(content);
    const cost = estimateTranscriptCost(usage);

    // 1M input tokens at the opus input rate = exactly the per-Mtok price.
    expect(cost.byModelUsd["claude-opus-4-8"]).toBeCloseTo(DEFAULT_PRICE_TABLE.opus.input, 6);
    expect(cost.byModelUsd["mystery-model"]).toBe(0);
    expect(cost.unpricedModels).toEqual(["mystery-model"]);
    expect(cost.totalUsd).toBeCloseTo(DEFAULT_PRICE_TABLE.opus.input, 6);
  });
});

describe("parseCodexTranscriptUsage", () => {
  it("takes the final cumulative total and splits cached from fresh input", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-05-19T10:05:08.077Z", type: "turn_context", payload: { cwd: "/repo", model: "gpt-5.5" } }),
      // first token_count: cumulative so far
      JSON.stringify({
        timestamp: "2026-05-19T10:05:10Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 30, total_tokens: 1100 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100 } } },
      }),
      // later token_count: cumulative grows — this final one is the session total
      JSON.stringify({
        timestamp: "2026-05-19T10:06:00Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 400, reasoning_output_tokens: 120, total_tokens: 5400 }, last_token_usage: { input_tokens: 4000, cached_input_tokens: 3400, output_tokens: 300 } } },
      }),
      // token_count with null info is ignored (no usage yet)
      JSON.stringify({ timestamp: "2026-05-19T10:04:00Z", type: "event_msg", payload: { type: "token_count", info: null } }),
    ];
    const usage = parseCodexTranscriptUsage(lines.join("\n"));
    expect(usage.totals.cacheRead).toBe(4000); // cached_input_tokens
    expect(usage.totals.input).toBe(1000); // 5000 - 4000 fresh input
    expect(usage.totals.output).toBe(400); // includes reasoning already
    expect(usage.totals.cacheCreate).toBe(0);
    expect(usage.totals.messages).toBe(2); // two token_count events with last_token_usage
    expect(usage.cwd).toBe("/repo");
    expect(usage.byModel["gpt-5.5"]?.cacheRead).toBe(4000);
    expect(usage.lastTimestamp).toBe("2026-05-19T10:06:00Z");
  });

  it("returns empty usage for a transcript with no token_count info", () => {
    const usage = parseCodexTranscriptUsage('{"type":"event_msg","payload":{"type":"token_count","info":null}}');
    expect(totalTokens(usage.totals)).toBe(0);
    expect(usage.byModel).toEqual({});
  });
});

describe("parseGeminiTranscriptUsage", () => {
  it("sums per-response usageMetadata across a JSONL log", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-05-01T00:00:00Z", model: "gemini-2.5-pro", role: "model", usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 50, thoughtsTokenCount: 10 } }),
      JSON.stringify({ timestamp: "2026-05-01T00:01:00Z", role: "model", usageMetadata: { promptTokenCount: 2000, cachedContentTokenCount: 1500, candidatesTokenCount: 80, thoughtsTokenCount: 20 } }),
    ];
    const usage = parseGeminiTranscriptUsage(lines.join("\n"));
    expect(usage.totals.cacheRead).toBe(1700); // 200 + 1500
    expect(usage.totals.input).toBe(1300); // (1000-200) + (2000-1500)
    expect(usage.totals.output).toBe(160); // 50+10 + 80+20
    expect(usage.totals.messages).toBe(2);
    expect(usage.byModel["gemini-2.5-pro"]?.cacheRead).toBe(1700);
  });

  it("walks a single nested JSON document and finds snake_case usage", () => {
    const doc = JSON.stringify({ messages: [{ role: "model", response: { usage_metadata: { promptTokenCount: 500, cachedContentTokenCount: 0, candidatesTokenCount: 25 } } }] });
    const usage = parseGeminiTranscriptUsage(doc);
    expect(usage.totals.input).toBe(500);
    expect(usage.totals.output).toBe(25);
    expect(usage.totals.messages).toBe(1);
  });
});

describe("parseTranscriptUsageForProvider", () => {
  it("dispatches to the right parser per provider", () => {
    const claude = JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", usage: { input_tokens: 5, output_tokens: 7 } } });
    expect(parseTranscriptUsageForProvider(claude, "claude").totals.input).toBe(5);
    const codex = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 }, last_token_usage: {} } } });
    expect(parseTranscriptUsageForProvider(codex, "codex").totals.cacheRead).toBe(4);
    const gemini = JSON.stringify({ usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 } });
    expect(parseTranscriptUsageForProvider(gemini, "gemini").totals.input).toBe(9);
  });
});
