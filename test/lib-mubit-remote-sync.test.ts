import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncMubitRemoteActivity } from "../src/mubit-remote-sync";
import { readMubitRemoteSyncState } from "../src/mubit-remote-sync-state";
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

  it("requests refreshed snapshots by default", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const mirror = {
      async appendEvent(): Promise<MirrorAppendResult> {
        return { segment: "seg", offset: 1, checksum: "sum", deduplicated: true };
      },
      async appendRawLine(): Promise<void> {},
    };

    const memory = {
      async fetchContextSnapshot(payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
        calls.push(payload);
        return { timeline: [] };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
    });

    expect(summary.refresh).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.refresh).toBe(true);
  });

  it("tracks repeated snapshots and flags suspected snapshot caps", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-remote-sync-"));
    const statePath = join(root, "mubit-remote-sync-state.json");
    const timeline = Array.from({ length: 200 }, (_, i) => ({
      id: `tl-${i + 1}`,
      created_at: `2026-02-23T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      payload: JSON.stringify({
        schema: "codaph_event.v2",
        event: {
          eventId: `evt-${i + 1}`,
          source: "codex_exec",
          repoId: "repo-x",
          actorId: "friend",
          sessionId: "sess-1",
          threadId: "thread-1",
          ts: `2026-02-23T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
          eventType: "item.completed",
          payload: {},
          reasoningAvailability: "unavailable",
        },
      }),
    }));

    const mirror = {
      async appendEvent(): Promise<MirrorAppendResult> {
        return { segment: "seg", offset: 1, checksum: "sum", deduplicated: true };
      },
      async appendRawLine(): Promise<void> {},
    };

    const memory = {
      async fetchContextSnapshot(): Promise<Record<string, unknown>> {
        return { timeline };
      },
    } as unknown as MubitMemoryEngine;

    let summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
      timelineLimit: 1200,
      statePath,
    });
    expect(summary.noRemoteChangesDetected).toBe(false);
    expect(summary.suspectedServerCap).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      summary = await syncMubitRemoteActivity({
        mirror,
        memory,
        runId: "codaph:repo-x",
        repoId: "repo-x",
        timelineLimit: 1200,
        statePath,
      });
    }

    expect(summary.noRemoteChangesDetected).toBe(true);
    expect(summary.consecutiveSameSnapshotCount).toBeGreaterThanOrEqual(3);
    expect(summary.suspectedServerCap).toBe(true);
    expect(summary.diagnosticNote).toContain("appears capped");

    const persisted = await readMubitRemoteSyncState(statePath);
    expect(persisted.receivedTimelineCount).toBe(200);
    expect(persisted.suspectedServerCap).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it("replays prompt activities from the compact prompt stream", async () => {
    const mainTimeline = [
      {
        id: "main-1",
        created_at: "2026-02-23T10:00:00.000Z",
        payload: JSON.stringify({
          schema: "codaph_event.v2",
          event: {
            eventId: "evt-thought-1",
            source: "codex_exec",
            repoId: "repo-x",
            actorId: "friend",
            sessionId: "sess-1",
            threadId: "thread-1",
            ts: "2026-02-23T10:00:00.000Z",
            eventType: "item.completed",
            payload: { item: { type: "reasoning", text: "thinking" } },
            reasoningAvailability: "full",
          },
        }),
      },
    ];
    const promptTimeline = [
      {
        id: "prompt-1",
        created_at: "2026-02-23T10:00:01.000Z",
        payload: JSON.stringify({
          type: "codaph_prompt",
          input_ref: "sess-1",
          output_ref: "evt-prompt-1",
          payload: JSON.stringify({
            schema: "codaph_prompt.v1",
            event: {
              eventId: "evt-prompt-1",
              source: "codex_exec",
              repoId: "repo-x",
              actorId: "anil",
              sessionId: "sess-1",
              threadId: "thread-1",
              ts: "2026-02-23T10:00:01.000Z",
              eventType: "prompt.submitted",
              payload: { prompt: "shared prompt via compact stream" },
              reasoningAvailability: "unavailable",
            },
          }),
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

    const calls: string[] = [];
    const memory = {
      async fetchContextSnapshot(payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
        calls.push(String(payload?.runId ?? payload?.run_id ?? ""));
        const runId = String(payload?.runId ?? payload?.run_id ?? "");
        if (runId.includes("prompts")) {
          return { timeline: promptTimeline };
        }
        return { timeline: mainTimeline };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      promptRunId: "codaph-prompts:repo-x",
      repoId: "repo-x",
    });

    expect(calls).toContain("codaph:repo-x");
    expect(calls).toContain("codaph-prompts:repo-x");
    expect(summary.promptTimelineEvents).toBe(1);
    expect(summary.timelineEvents).toBe(2);
    expect(appended.map((event) => event.eventType)).toContain("prompt.submitted");
    expect(appended.find((event) => event.eventType === "prompt.submitted")?.payload.prompt).toBe(
      "shared prompt via compact stream",
    );
  });
});
