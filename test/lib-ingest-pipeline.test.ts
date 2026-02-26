import { describe, expect, it, vi } from "vitest";
import { IngestPipeline } from "../src/lib/ingest-pipeline";

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

  it("can retry memory writes for deduplicated local events when enabled", async () => {
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
        retryMemoryWriteOnLocalDedup: true,
      },
    );

    await pipeline.ingest(
      "prompt.submitted",
      { prompt: "retry cloud publish" },
      {
        source: "codex_exec",
        repoId: "r",
        sessionId: "s",
        threadId: "t",
        sequence: 1,
      },
    );

    expect(writeEvent).toHaveBeenCalledTimes(1);
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

  it("uses batched memory writes when supported", async () => {
    const appendEvent = vi.fn(async () => ({ segment: "x", offset: 1, checksum: "abc", deduplicated: false }));
    const appendRawLine = vi.fn(async () => {});
    const writeEventsBatch = vi.fn(async () => {});
    const writeEvent = vi.fn(async () => ({ accepted: true }));

    const pipeline = new IngestPipeline(
      { appendEvent, appendRawLine },
      {
        memoryEngine: {
          writeEvent,
          writeEventsBatch,
        },
        memoryBatchSize: 2,
      },
    );

    const base = {
      source: "codex_exec" as const,
      repoId: "r",
      sessionId: "s",
      threadId: "t",
    };

    await pipeline.ingest("prompt.submitted", { prompt: "a" }, { ...base, sequence: 1 });
    await pipeline.ingest("item.completed", { item: { type: "message", text: "b" } }, { ...base, sequence: 2 });
    await pipeline.flush();

    expect(writeEventsBatch).toHaveBeenCalledTimes(1);
    expect(writeEvent).toHaveBeenCalledTimes(0);
    const firstCallArgs = (writeEventsBatch.mock.calls[0] ?? []) as unknown[];
    const batchArg = (firstCallArgs[0] ?? []) as Array<{ eventId: string }>;
    expect(batchArg.length).toBe(2);
  });

  it("redacts raw transcript lines before writing to the local mirror", async () => {
    const appendEvent = vi.fn(async () => ({ segment: "x", offset: 1, checksum: "abc" }));
    const appendRawLine = vi.fn(async () => {});
    const pipeline = new IngestPipeline({ appendEvent, appendRawLine });

    await pipeline.ingestRawLine(
      "s1",
      '{"type":"user","apiKey":"sk-123456789012345678901234567890","tokenEstimate":"24k"}',
    );

    expect(appendRawLine).toHaveBeenCalledTimes(1);
    const firstCall = (appendRawLine.mock.calls[0] ?? []) as unknown[];
    const line = String(firstCall[1] ?? "");
    expect(line).not.toContain("sk-1234567890");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain('"tokenEstimate":"24k"');
  });
});
