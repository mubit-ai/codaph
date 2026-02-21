import { describe, expect, it } from "vitest";
import { createEventId, createCapturedEvent, repoIdFromPath } from "../src/index";

describe("core-types", () => {
  it("creates deterministic event ids", () => {
    const a = createEventId({
      source: "codex_sdk",
      threadId: "t1",
      sequence: 10,
      eventType: "item.completed",
      ts: "2026-02-21T20:10:05Z",
    });

    const b = createEventId({
      source: "codex_sdk",
      threadId: "t1",
      sequence: 10,
      eventType: "item.completed",
      ts: "2026-02-21T20:10:05Z",
    });

    expect(a).toBe(b);
    expect(a.length).toBe(24);
  });

  it("creates complete captured event envelope", () => {
    const ev = createCapturedEvent({
      source: "codex_exec",
      repoId: "abc",
      sessionId: "s1",
      threadId: null,
      ts: "2026-02-21T20:10:05Z",
      sequence: 1,
      eventType: "turn.started",
      payload: { ok: true },
    });

    expect(ev.source).toBe("codex_exec");
    expect(ev.reasoningAvailability).toBe("unavailable");
    expect(ev.eventId).toHaveLength(24);
  });

  it("derives stable repo ids from path", () => {
    const a = repoIdFromPath("/tmp/repo-a");
    const b = repoIdFromPath("/tmp/repo-a");
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });
});
