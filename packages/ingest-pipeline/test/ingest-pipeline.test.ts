import { describe, expect, it, vi } from "vitest";
import { IngestPipeline } from "../src/index";

describe("ingest pipeline", () => {
  it("redacts and appends events", async () => {
    const appendEvent = vi.fn(async () => ({ segment: "x", offset: 1, checksum: "abc" }));
    const appendRawLine = vi.fn(async () => {});

    const pipeline = new IngestPipeline({ appendEvent, appendRawLine });
    const event = await pipeline.ingest(
      "item.completed",
      { token: "sk-12345678901234567890", item: { type: "reasoning", text: "done" } },
      {
        source: "codex_sdk",
        repoId: "r",
        sessionId: "s",
        threadId: "t",
        sequence: 1,
      },
    );

    expect(event.reasoningAvailability).toBe("full");
    expect(JSON.stringify(event.payload)).toContain("[REDACTED]");
    expect(appendEvent).toHaveBeenCalledTimes(1);
  });

  it("skips memory writes for deduplicated events", async () => {
    const appendEvent = vi.fn(async () => ({ segment: "x", offset: 1, checksum: "abc", deduplicated: true }));
    const appendRawLine = vi.fn(async () => {});
    const writeEvent = vi.fn(async () => ({ accepted: true }));

    const pipeline = new IngestPipeline(
      { appendEvent, appendRawLine },
      {
        memoryEngine: {
          writeEvent,
          writeRunState: async () => {},
        },
      },
    );

    await pipeline.ingest(
      "item.completed",
      { item: { type: "message", text: "ok" } },
      {
        source: "codex_sdk",
        repoId: "r",
        sessionId: "s",
        threadId: "t",
        sequence: 1,
      },
    );

    expect(writeEvent).toHaveBeenCalledTimes(0);
  });

  it("opens memory circuit after repeated write failures", async () => {
    const appendEvent = vi.fn(async () => ({ segment: "x", offset: 1, checksum: "abc", deduplicated: false }));
    const appendRawLine = vi.fn(async () => {});
    const writeEvent = vi.fn(async () => {
      throw new Error("mubit write failed");
    });

    const pipeline = new IngestPipeline(
      { appendEvent, appendRawLine },
      {
        memoryEngine: {
          writeEvent,
          writeRunState: async () => {},
        },
        memoryMaxConsecutiveErrors: 2,
      },
    );

    const base = {
      source: "codex_sdk" as const,
      repoId: "r",
      sessionId: "s",
      threadId: "t",
    };

    await pipeline.ingest("item.completed", { item: { type: "message", text: "1" } }, { ...base, sequence: 1 });
    await pipeline.ingest("item.completed", { item: { type: "message", text: "2" } }, { ...base, sequence: 2 });
    await pipeline.ingest("item.completed", { item: { type: "message", text: "3" } }, { ...base, sequence: 3 });

    expect(writeEvent).toHaveBeenCalledTimes(2);
  });
});
