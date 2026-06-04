import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICE_TABLE,
  estimateTranscriptCost,
  parseTranscriptUsage,
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
