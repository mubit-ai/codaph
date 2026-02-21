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
});
