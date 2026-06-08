import { describe, expect, it } from "vitest";
import {
  attributeContextCost,
  aggregateAttributions,
  toolResultContentToText,
  toolTarget,
} from "../src/lib/token-attribution";
import type { ContextAttribution, ContextCostDriver } from "../src/lib/token-attribution";
import type { PriceTable } from "../src/lib/token-accounting";

// Deterministic prices: cache-write 10/M, cache-read 1/M (others 0). "test"
// matches "test-model" via the substring rule in resolveModelPrice.
const PRICE: PriceTable = { test: { input: 0, cacheWrite: 10, cacheRead: 1, output: 0 } };

function transcript(): string {
  const lines = [
    // Turn 1: issues a Read (offloadable) and an Edit (not offloadable).
    {
      type: "assistant",
      message: {
        model: "test-model",
        usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
        content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } },
          { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/b.ts" } },
        ],
      },
    },
    // tool results: t1 = 400 chars (100 tok), t2 = 40 chars in a text block (10 tok).
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "x".repeat(400) },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "y".repeat(40) }] },
        ],
      },
    },
    // Turn 2: a Grep whose result never arrives (should be skipped).
    {
      type: "assistant",
      message: {
        model: "test-model",
        usage: { cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo" } }],
      },
    },
    // Turn 3.
    {
      type: "assistant",
      message: {
        model: "test-model",
        usage: { cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "done" }],
      },
    },
  ];
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("toolResultContentToText", () => {
  it("handles strings, text-block arrays, and other shapes", () => {
    expect(toolResultContentToText("hello")).toBe("hello");
    expect(toolResultContentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolResultContentToText(null)).toBe("");
    expect(toolResultContentToText([{ type: "tool_reference", name: "X" }])).toContain("X");
  });
});

describe("toolTarget", () => {
  it("labels calls by tool", () => {
    expect(toolTarget("Read", { file_path: "src/x.ts" })).toBe("src/x.ts");
    expect(toolTarget("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(toolTarget("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    expect(toolTarget("WebFetch", { url: "https://x.y" })).toBe("https://x.y");
    expect(toolTarget("Bash", { command: "ls" })).toBe("ls");
  });
});

describe("attributeContextCost", () => {
  it("returns null when there are no assistant turns", () => {
    expect(attributeContextCost("")).toBeNull();
    expect(attributeContextCost('{"type":"user","message":{"content":[]}}')).toBeNull();
  });

  it("attributes compounding cache-read tax to tool results", () => {
    const a = attributeContextCost(transcript(), PRICE);
    expect(a).not.toBeNull();
    if (!a) return;

    expect(a.model).toBe("test-model");
    expect(a.unpriced).toBe(false);
    expect(a.assistantTurns).toBe(3);
    expect(a.toolResults).toBe(2); // Grep had no result → excluded
    expect(a.totalResultTokens).toBe(110);

    // Read result: 100 tok, issued turn 1, re-read by turns 2..3 (2), written once + read once.
    const read = a.drivers.find((d) => d.toolName === "Read");
    expect(read?.resultTokens).toBe(100);
    expect(read?.turnIssued).toBe(1);
    expect(read?.rereadTurns).toBe(2);
    expect(read?.offloadable).toBe(true);
    expect(read?.cacheWriteUsd).toBeCloseTo(100 * 10 / 1_000_000, 12); // 0.001
    expect(read?.cacheReadUsd).toBeCloseTo(100 * 1 * 1 / 1_000_000, 12); // 0.0001
    expect(read?.totalUsd).toBeCloseTo(0.0011, 12);

    // Edit is a real action, not offloadable.
    const edit = a.drivers.find((d) => d.toolName === "Edit");
    expect(edit?.offloadable).toBe(false);
    expect(edit?.resultTokens).toBe(10);

    expect(a.drivers[0]?.toolName).toBe("Read"); // sorted desc by totalUsd
    expect(a.offloadableUsd).toBeCloseTo(0.0011, 12); // only the Read
    expect(a.attributableUsd).toBeCloseTo(0.0011 + 0.00011, 12);

    // Actuals from usage: read (0+200+300)=500 tok, write 100 tok.
    expect(a.cacheReadUsdActual).toBeCloseTo(500 / 1_000_000, 12);
    expect(a.cacheWriteUsdActual).toBeCloseTo(100 * 10 / 1_000_000, 12);
  });

  it("marks USD as 0 / unpriced for an unknown model", () => {
    const t = '{"type":"assistant","message":{"model":"mystery","usage":{"cache_read_input_tokens":10},"content":[]}}';
    const a = attributeContextCost(t, PRICE);
    expect(a?.unpriced).toBe(true);
    expect(a?.cacheReadUsdActual).toBe(0);
  });
});

// --- aggregation helpers -----------------------------------------------------

function driver(p: { toolName: string; target: string | null; resultTokens?: number; totalUsd?: number; offloadable?: boolean }): ContextCostDriver {
  return {
    toolName: p.toolName,
    target: p.target,
    toolUseId: "id",
    turnIssued: 1,
    resultTokens: p.resultTokens ?? 0,
    rereadTurns: 0,
    cacheWriteUsd: 0,
    cacheReadUsd: 0,
    totalUsd: p.totalUsd ?? 0,
    offloadable: p.offloadable ?? false,
  };
}

function attribution(drivers: ContextCostDriver[], extra: Partial<ContextAttribution> = {}): ContextAttribution {
  return {
    model: "test-model",
    assistantTurns: extra.assistantTurns ?? 1,
    toolResults: drivers.length,
    totalResultTokens: drivers.reduce((s, d) => s + d.resultTokens, 0),
    attributableUsd: drivers.reduce((s, d) => s + d.totalUsd, 0),
    offloadableUsd: drivers.reduce((s, d) => s + (d.offloadable ? d.totalUsd : 0), 0),
    cacheReadUsdActual: extra.cacheReadUsdActual ?? 0,
    cacheWriteUsdActual: extra.cacheWriteUsdActual ?? 0,
    drivers,
    unpriced: extra.unpriced ?? false,
  };
}

describe("aggregateAttributions", () => {
  it("returns empty totals for no sessions", () => {
    const agg = aggregateAttributions([]);
    expect(agg.sessions).toBe(0);
    expect(agg.targets).toEqual([]);
    expect(agg.attributableUsd).toBe(0);
    expect(agg.unpriced).toBe(false);
  });

  it("ranks recurring (tool,target) pairs by total tax and counts sessions vs occurrences", () => {
    const sessionA = attribution(
      [
        driver({ toolName: "Read", target: "src/config.ts", resultTokens: 100, totalUsd: 0.001, offloadable: true }),
        driver({ toolName: "Read", target: "src/config.ts", resultTokens: 50, totalUsd: 0.0005, offloadable: true }),
        driver({ toolName: "Edit", target: "src/x.ts", resultTokens: 5, totalUsd: 0.00001, offloadable: false }),
      ],
      { assistantTurns: 4, cacheReadUsdActual: 0.01, cacheWriteUsdActual: 0.002 },
    );
    const sessionB = attribution(
      [
        driver({ toolName: "Read", target: "src/config.ts", resultTokens: 80, totalUsd: 0.0008, offloadable: true }),
        driver({ toolName: "Grep", target: "foo", resultTokens: 200, totalUsd: 0.002, offloadable: true }),
      ],
      { assistantTurns: 3, cacheReadUsdActual: 0.02, cacheWriteUsdActual: 0.003 },
    );

    const agg = aggregateAttributions([sessionA, sessionB]);

    expect(agg.sessions).toBe(2);
    expect(agg.assistantTurns).toBe(7);
    expect(agg.toolResults).toBe(5);
    expect(agg.cacheReadUsdActual).toBeCloseTo(0.03, 12);
    expect(agg.cacheWriteUsdActual).toBeCloseTo(0.005, 12);

    // config.ts appeared in 2 sessions, 3 calls total, with the most tax → ranks first.
    const config = agg.targets[0];
    expect(config?.toolName).toBe("Read");
    expect(config?.target).toBe("src/config.ts");
    expect(config?.sessions).toBe(2);
    expect(config?.occurrences).toBe(3);
    expect(config?.resultTokens).toBe(230);
    expect(config?.totalUsd).toBeCloseTo(0.0023, 12);
    expect(config?.offloadable).toBe(true);

    // grep (0.002) ranks above the non-offloadable edit (0.00001).
    expect(agg.targets[1]?.toolName).toBe("Grep");
    expect(agg.targets[2]?.toolName).toBe("Edit");
    expect(agg.targets[2]?.offloadable).toBe(false);
  });

  it("propagates unpriced when any session is unpriced", () => {
    const priced = attribution([driver({ toolName: "Read", target: "a", totalUsd: 0.1, offloadable: true })]);
    const unpriced = attribution([driver({ toolName: "Read", target: "b" })], { unpriced: true });
    expect(aggregateAttributions([priced, unpriced]).unpriced).toBe(true);
    expect(aggregateAttributions([priced]).unpriced).toBe(false);
  });
});
