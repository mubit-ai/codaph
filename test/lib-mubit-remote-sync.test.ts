import { describe, expect, it } from "vitest";
import { syncMubitRemoteActivity } from "../src/mubit-remote-sync";
import type { CapturedEventEnvelope, MirrorAppendResult } from "../src/lib/core-types";
import type { MubitMemoryEngine } from "../src/lib/memory-mubit";

describe("mubit-remote-sync", () => {
  it("replays both legacy and compact codaph activity payloads", async () => {
    const timeline = [
      {
        id: "tl-1",
        created_at: "2026-02-23T10:00:00.000Z",
        payload: JSON.stringify({
          type: "codaph_event",
          input_ref: "sess-1",
          output_ref: "evt-legacy",
          payload: JSON.stringify({
            eventId: "evt-legacy",
            source: "codex_exec",
            repoId: "repo-x",
            actorId: "anil",
            sessionId: "sess-1",
            threadId: "thread-1",
            ts: "2026-02-23T10:00:00.000Z",
            eventType: "prompt.submitted",
            payload: {
              prompt: "legacy prompt",
            },
            reasoningAvailability: "unavailable",
          }),
        }),
      },
      {
        id: "tl-2",
        created_at: "2026-02-23T10:00:01.000Z",
        payload: JSON.stringify({
          schema: "codaph_event.v2",
          event: {
            eventId: "evt-compact",
            source: "codex_exec",
            repoId: "repo-x",
            actorId: "friend",
            sessionId: "sess-1",
            threadId: "thread-1",
            ts: "2026-02-23T10:00:01.000Z",
            eventType: "item.completed",
            payload: {
              item: {
                type: "reasoning",
                text: "compact thought",
              },
            },
            reasoningAvailability: "full",
          },
        }),
      },
    ];

    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg-1",
          offset: appended.length,
          checksum: `sum-${appended.length}`,
          deduplicated: false,
        };
      },
      async appendRawLine(): Promise<void> {},
    };

    const memory = {
      async fetchContextSnapshot(): Promise<Record<string, unknown>> {
        return { timeline };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
      fallbackActorId: "fallback-user",
      timelineLimit: 50,
    });

    expect(summary.timelineEvents).toBe(2);
    expect(summary.imported).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(appended).toHaveLength(2);
    expect(appended[0].eventType).toBe("prompt.submitted");
    expect(appended[0].payload.prompt).toBe("legacy prompt");
    expect(appended[1].eventType).toBe("item.completed");
    expect((appended[1].payload.item as Record<string, unknown>).type).toBe("reasoning");
  });
});
