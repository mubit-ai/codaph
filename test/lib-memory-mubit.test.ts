import { describe, expect, it } from "vitest";
import { MubitMemoryEngine, mubitPromptRunIdForProject, mubitRunIdForProject, mubitRunIdForSession } from "../src/lib/memory-mubit";

describe("memory-mubit", () => {
  it("builds stable run ids", () => {
    expect(mubitRunIdForSession("repo123", "session456")).toBe("codaph:repo123:session456");
    expect(mubitRunIdForSession("repo123", "session456", "custom")).toBe(
      "custom:repo123:session456",
    );
    expect(mubitRunIdForProject("repo123")).toBe("codaph:repo123");
    expect(mubitRunIdForProject("repo123", "custom")).toBe("custom:repo123");
    expect(mubitPromptRunIdForProject("repo123")).toBe("codaph-prompts:repo123");
  });

  it("writes control ingest payloads with idempotency key", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const activities: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          ingest: async (payload?: Record<string, unknown>) => {
            captures.push(payload ?? {});
            return { accepted: true, job_id: "job-1", deduplicated: true };
          },
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async (payload?: Record<string, unknown>) => {
            activities.push(payload ?? {});
            return { success: true };
          },
        },
      },
    });

    const result = await engine.writeEvent({
      eventId: "evt-123",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-def",
      threadId: "thread-1",
      ts: "2026-02-23T09:00:00.000Z",
      eventType: "prompt.submitted",
      payload: { prompt: "summarize current repo" },
      reasoningAvailability: "unavailable",
    });

    expect(result.accepted).toBe(true);
    expect(result.jobId).toBe("job-1");
    expect(result.deduplicated).toBe(true);
    expect(captures).toHaveLength(1);
    expect(captures[0].idempotency_key).toBe("evt-123");
    expect(captures[0].run_id).toBe("codaph:repo-abc:session-def");
    expect(activities).toHaveLength(2);
    const eventActivityPayload = activities.find(
      (entry) => ((entry.activity as Record<string, unknown> | undefined)?.type as string | undefined) === "codaph_event",
    );
    const promptActivityPayload = activities.find(
      (entry) => ((entry.activity as Record<string, unknown> | undefined)?.type as string | undefined) === "codaph_prompt",
    );
    expect(eventActivityPayload?.run_id).toBe("codaph:repo-abc:session-def");
    expect(promptActivityPayload?.run_id).toBe("codaph-prompts:repo-abc");
    const activity = (eventActivityPayload?.activity ?? {}) as Record<string, unknown>;
    expect(activity.type).toBe("codaph_event");
    expect(typeof activity.payload).toBe("string");
    const envelope = JSON.parse(String(activity.payload)) as Record<string, unknown>;
    expect(envelope.schema).toBe("codaph_event.v2");
    const event = envelope.event as Record<string, unknown>;
    expect(event.eventType).toBe("prompt.submitted");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.prompt).toBe("summarize current repo");
    const promptEnvelope = JSON.parse(String((promptActivityPayload?.activity as Record<string, unknown>).payload)) as Record<string, unknown>;
    expect(promptEnvelope.schema).toBe("codaph_prompt.v1");
  });

  it("truncates activity payloads so large prompts are still appendable", async () => {
    const activities: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          ingest: async () => ({ accepted: true }),
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async (payload?: Record<string, unknown>) => {
            activities.push(payload ?? {});
            return { success: true };
          },
        },
      },
    });

    await engine.writeEvent({
      eventId: "evt-large",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-def",
      threadId: "thread-1",
      ts: "2026-02-23T09:00:00.000Z",
      eventType: "prompt.submitted",
      payload: { prompt: "x".repeat(30000) },
      reasoningAvailability: "unavailable",
    });

    expect(activities).toHaveLength(2);
    const eventActivity = activities.find(
      (entry) => ((entry.activity as Record<string, unknown> | undefined)?.type as string | undefined) === "codaph_event",
    );
    const activity = (eventActivity?.activity ?? {}) as Record<string, unknown>;
    const payloadRaw = String(activity.payload);
    expect(payloadRaw.length).toBeLessThan(10000);
  });

  it("supports shared project scope and actor metadata", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      projectId: "team-repo",
      actorId: "anil",
      runScope: "project",
      client: {
        control: {
          ingest: async (payload?: Record<string, unknown>) => {
            captures.push(payload ?? {});
            return { accepted: true };
          },
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async () => ({ success: true }),
        },
      },
    });

    await engine.writeEvent({
      eventId: "evt-456",
      source: "codex_exec",
      repoId: "local-repo-id",
      actorId: null,
      sessionId: "session-xyz",
      threadId: "thread-1",
      ts: "2026-02-23T09:00:00.000Z",
      eventType: "item.completed",
      payload: { item: { type: "reasoning", text: "thinking" } },
      reasoningAvailability: "full",
    });

    expect(captures).toHaveLength(1);
    expect(captures[0].run_id).toBe("codaph:team-repo");
    const item = (captures[0].items as Array<Record<string, unknown>>)[0];
    const metadataRaw = typeof item.metadata_json === "string" ? item.metadata_json : "{}";
    const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
    expect(metadata.project_id).toBe("team-repo");
    expect(metadata.actor_id).toBe("anil");
  });

  it("batches ingest writes and preserves activity streams", async () => {
    const coreIngestCalls: Array<Record<string, unknown>> = [];
    const activities: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        core: {
          ingest: async (payload?: Record<string, unknown>) => {
            coreIngestCalls.push(payload ?? {});
            return { accepted: true };
          },
        },
        control: {
          ingest: async () => ({ accepted: true }),
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async (payload?: Record<string, unknown>) => {
            activities.push(payload ?? {});
            return { success: true };
          },
        },
      },
    });

    await engine.writeEventsBatch?.([
      {
        eventId: "evt-1",
        source: "codex_exec",
        repoId: "repo-abc",
        actorId: "anil",
        sessionId: "session-1",
        threadId: "thread-1",
        ts: "2026-02-24T10:00:00.000Z",
        eventType: "prompt.submitted",
        payload: { prompt: "hello" },
        reasoningAvailability: "unavailable",
      },
      {
        eventId: "evt-2",
        source: "codex_exec",
        repoId: "repo-abc",
        actorId: "anil",
        sessionId: "session-1",
        threadId: "thread-1",
        ts: "2026-02-24T10:00:01.000Z",
        eventType: "item.completed",
        payload: { item: { type: "message", text: "done" } },
        reasoningAvailability: "unavailable",
      },
    ]);

    expect(coreIngestCalls).toHaveLength(1);
    const payload = coreIngestCalls[0] ?? {};
    expect(payload.run_id).toBe("codaph:repo-abc:session-1");
    expect(Array.isArray(payload.items)).toBe(true);
    expect((payload.items as Array<unknown>).length).toBe(2);
    expect("idempotency_key" in payload).toBe(false);
    expect(activities).toHaveLength(3);
  });
});
