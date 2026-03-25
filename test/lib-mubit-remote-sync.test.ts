import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncMubitRemoteActivity } from "../src/mubit-remote-sync";
import { readMubitRemoteSyncState, writeMubitRemoteSyncState } from "../src/mubit-remote-sync-state";
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

  it("tracks repeated snapshot windows when prior pulls prove the remote history is larger than the snapshot", async () => {
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

    await writeMubitRemoteSyncState(statePath, {
      lastRunAt: "2026-02-23T09:59:00.000Z",
      lastSuccessAt: "2026-02-23T09:59:00.000Z",
      lastTriggerSource: "manual",
      requestedTimelineLimit: 1200,
      receivedTimelineCount: 200,
      observedUniqueEvents: 450,
      observedUniqueTimelineEvents: 450,
      observedUniquePromptTimelineEvents: 0,
      observedUniqueSessionSummaryTimelineEvents: 0,
      observedUniqueDiffTimelineEvents: 0,
      lastImported: 0,
      lastDeduplicated: 200,
      lastSkipped: 0,
      lastMaxTs: "2026-02-23T10:03:19.000Z",
      lastSnapshotFingerprint: null,
      consecutiveSameSnapshotCount: 0,
      suspectedServerCap: false,
      lastError: null,
      pendingTrigger: {
        pending: false,
        source: null,
        ts: null,
      },
    });

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
    expect(summary.diagnosticNote).toContain("window appears limited");

    const persisted = await readMubitRemoteSyncState(statePath);
    expect(persisted.receivedTimelineCount).toBe(200);
    expect(persisted.observedUniqueEvents).toBe(450);
    expect(persisted.observedUniqueTimelineEvents).toBe(450);
    expect(persisted.suspectedServerCap).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it("does not flag a snapshot window when the known remote history is not larger than the returned timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-remote-sync-known-window-"));
    const statePath = join(root, "mubit-remote-sync-state.json");
    const timeline = Array.from({ length: 200 }, (_, i) => ({
      id: `tl-known-${i + 1}`,
      created_at: `2026-02-23T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
      payload: JSON.stringify({
        schema: "codaph_event.v2",
        event: {
          eventId: `evt-known-${i + 1}`,
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
    expect(summary.suspectedServerCap).toBe(false);
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

  it("preserves provider history sources when replaying compact events", async () => {
    const timeline = [
      {
        id: "claude-1",
        created_at: "2026-02-23T10:00:00.000Z",
        payload: JSON.stringify({
          schema: "codaph_event.v2",
          event: {
            eventId: "evt-claude-1",
            source: "claude_code_history",
            repoId: "repo-x",
            actorId: "friend",
            sessionId: "sess-claude-1",
            threadId: "thread-claude-1",
            ts: "2026-02-23T10:00:00.000Z",
            eventType: "item.completed",
            payload: { item: { type: "agent_message", text: "hello from claude" } },
            reasoningAvailability: "unavailable",
          },
        }),
      },
    ];

    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg",
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
    });

    expect(summary.imported).toBe(1);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.source).toBe("claude_code_history");
  });

  it("preserves null thread ids from remote activities", async () => {
    const timeline = [
      {
        id: "null-thread-1",
        created_at: "2026-02-23T10:00:00.000Z",
        payload: JSON.stringify({
          schema: "codaph_event.v2",
          event: {
            eventId: "evt-null-thread-1",
            source: "codex_exec",
            repoId: "repo-x",
            actorId: "friend",
            sessionId: "sess-1",
            threadId: null,
            ts: "2026-02-23T10:00:00.000Z",
            eventType: "codaph.session.summary",
            payload: { item: { type: "codaph_session_summary" } },
            reasoningAvailability: "unavailable",
          },
        }),
      },
    ];

    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg",
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

    await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
    });

    expect(appended[0]?.threadId).toBeNull();
  });

  it("replays live-style fact entries by reconstructing events from metadata_json", async () => {
    const timeline = [
      {
        id: "fact-1",
        entry_type: "fact",
        content: "item.completed [actor:shankha98]: tool:Edit",
        metadata_json: JSON.stringify({
          actor_id: "shankha98",
          event_type: "item.completed",
          payload: {
            item: {
              type: "agent_message",
              text: "tool:Edit",
            },
          },
          project_id: "repo-x",
          reasoning_availability: "unavailable",
          repo_id: "repo-x",
          session_id: "sess-live-1",
          source: "claude_code_history",
          thread_id: "thread-live-1",
          ts: "2026-03-21T17:54:26.102Z",
        }),
      },
    ];

    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg",
          offset: appended.length,
          checksum: `sum-${appended.length}`,
          deduplicated: false,
        };
      },
      async appendRawLine(): Promise<void> {},
    };

    const memory = {
      async listActivity(): Promise<Record<string, unknown>> {
        return { entries: timeline, next_page_token: "" };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
      replayMode: "activity",
    });

    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.eventType).toBe("item.completed");
    expect(appended[0]?.source).toBe("claude_code_history");
    expect(appended[0]?.sessionId).toBe("sess-live-1");
    expect(appended[0]?.threadId).toBe("thread-live-1");
    expect((appended[0]?.payload.item as Record<string, unknown>)?.text).toBe("tool:Edit");
  });

  it("supports explicit activity replay via paginated listActivity responses", async () => {
    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg",
          offset: appended.length,
          checksum: `sum-${appended.length}`,
          deduplicated: false,
        };
      },
      async appendRawLine(): Promise<void> {},
    };

    const listCalls: Array<Record<string, unknown>> = [];
    const memory = {
      async listActivity(payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
        listCalls.push(payload ?? {});
        const pageToken = String(payload?.pageToken ?? payload?.page_token ?? "");
        if (pageToken === "page-2") {
          return {
            entries: [
              {
                id: "activity-2",
                entry_type: "codaph_event",
                created_at: "2026-02-23T10:00:01.000Z",
                content: JSON.stringify({
                  schema: "codaph_event.v2",
                  event: {
                    eventId: "evt-2",
                    source: "codex_exec",
                    repoId: "repo-x",
                    actorId: "friend",
                    sessionId: "sess-1",
                    threadId: "thread-1",
                    ts: "2026-02-23T10:00:01.000Z",
                    eventType: "item.completed",
                    payload: { item: { type: "reasoning", text: "second page" } },
                    reasoningAvailability: "full",
                  },
                }),
              },
            ],
            next_page_token: "",
          };
        }
        return {
          entries: [
            {
              id: "activity-1",
              entry_type: "codaph_event",
              created_at: "2026-02-23T10:00:00.000Z",
              content: JSON.stringify({
                schema: "codaph_event.v2",
                event: {
                  eventId: "evt-1",
                  source: "codex_exec",
                  repoId: "repo-x",
                  actorId: "friend",
                  sessionId: "sess-1",
                  threadId: "thread-1",
                  ts: "2026-02-23T10:00:00.000Z",
                  eventType: "prompt.submitted",
                  payload: { prompt: "activity replay prompt" },
                  reasoningAvailability: "unavailable",
                },
              }),
            },
          ],
          next_page_token: "page-2",
        };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
      replayMode: "activity",
    });

    expect(summary.replayMode).toBe("activity");
    expect(summary.timelineEvents).toBe(2);
    expect(summary.imported).toBe(2);
    expect(appended.map((event) => event.eventType)).toEqual(["prompt.submitted", "item.completed"]);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]?.run_id).toBe("codaph:repo-x");
    expect(listCalls[0]?.sort).toBe("asc");
    expect(listCalls[1]?.page_token).toBe("page-2");
  });

  it("falls back to activity replay when snapshot has memory state but no timeline", async () => {
    const appended: CapturedEventEnvelope[] = [];
    const mirror = {
      async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
        appended.push(event);
        return {
          segment: "seg",
          offset: appended.length,
          checksum: `sum-${appended.length}`,
          deduplicated: false,
        };
      },
      async appendRawLine(): Promise<void> {},
    };

    const snapshotCalls: Array<Record<string, unknown>> = [];
    const activityCalls: Array<Record<string, unknown>> = [];
    const memory = {
      async fetchContextSnapshot(payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
        snapshotCalls.push(payload ?? {});
        return {
          timeline: [],
          snapshot: {
            summary: "Snapshot contains assembled memory but no replayable timeline.",
            facts: ["Known fact 1"],
          },
          promotions: [{ target: "nexus:1" }],
        };
      },
      async listActivity(payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
        activityCalls.push(payload ?? {});
        return {
          entries: [
            {
              id: "fact-1",
              entry_type: "fact",
              metadata_json: JSON.stringify({
                actor_id: "shankha98",
                event_type: "item.completed",
                payload: {
                  item: {
                    type: "agent_message",
                    text: "recovered via activity replay",
                  },
                },
                repo_id: "repo-x",
                session_id: "sess-1",
                source: "codex_exec",
                ts: "2026-03-25T10:00:00.000Z",
              }),
            },
          ],
          next_page_token: "",
        };
      },
    } as unknown as MubitMemoryEngine;

    const summary = await syncMubitRemoteActivity({
      mirror,
      memory,
      runId: "codaph:repo-x",
      repoId: "repo-x",
    });

    expect(summary.replayMode).toBe("activity");
    expect(summary.imported).toBe(1);
    expect(summary.diagnosticNote).toContain("snapshot returned assembled memory");
    expect(snapshotCalls).toHaveLength(1);
    expect(activityCalls).toHaveLength(1);
    expect(appended[0]?.eventType).toBe("item.completed");
  });
});
