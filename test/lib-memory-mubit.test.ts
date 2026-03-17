import { describe, expect, it } from "vitest";
import type { RecallOptions, RememberOptions } from "@mubit-ai/sdk";
import {
  MubitMemoryEngine,
  mubitPromptRunIdForProject,
  mubitRunIdForProject,
  mubitRunIdForSession,
  resolveMubitRegionalEndpointDefaults,
} from "../src/lib/memory-mubit";

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

  it("infers EU regional endpoints from MUBIT_REGION when explicit endpoints are absent", () => {
    expect(resolveMubitRegionalEndpointDefaults({ MUBIT_REGION: "EU" })).toEqual({
      httpEndpoint: "https://api.eu.mubit.ai",
      grpcEndpoint: "grpc.api.eu.mubit.ai:443",
    });
    expect(
      resolveMubitRegionalEndpointDefaults({
        MUBIT_REGION: "EU",
        MUBIT_HTTP_ENDPOINT: "https://custom.example",
      }),
    ).toEqual({});
  });

  it("writes remember payloads with idempotency key", async () => {
    const remembers: Array<Record<string, unknown>> = [];
    const activities: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        remember: async (payload: RememberOptions) => {
          remembers.push(payload as unknown as Record<string, unknown>);
          return { accepted: true, job_id: "job-1", deduplicated: true };
        },
        control: {
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
    expect(remembers).toHaveLength(1);
    expect(remembers[0].idempotency_key).toBe("evt-123");
    expect(remembers[0].session_id).toBe("codaph:repo-abc:session-def");
    expect(remembers[0].content).toBe("prompt.submitted [actor:anil]: summarize current repo");
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
        remember: async (_payload: RememberOptions) => ({ accepted: true }),
        control: {
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
    const remembers: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      projectId: "team-repo",
      actorId: "anil",
      runScope: "project",
      client: {
        remember: async (payload: RememberOptions) => {
          remembers.push(payload as unknown as Record<string, unknown>);
          return { accepted: true };
        },
        control: {
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

    expect(remembers).toHaveLength(1);
    expect(remembers[0].session_id).toBe("codaph:team-repo");
    const metadata = (remembers[0].metadata ?? {}) as Record<string, unknown>;
    expect(metadata.project_id).toBe("team-repo");
    expect(metadata.actor_id).toBe("anil");
  });

  it("batches ingest writes through control.ingest and preserves activity streams", async () => {
    const controlIngestCalls: Array<Record<string, unknown>> = [];
    const activities: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          ingest: async (payload?: Record<string, unknown>) => {
            controlIngestCalls.push(payload ?? {});
            return { accepted: true };
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

    expect(controlIngestCalls).toHaveLength(1);
    const payload = controlIngestCalls[0] ?? {};
    expect(payload.run_id).toBe("codaph:repo-abc:session-1");
    expect(Array.isArray(payload.items)).toBe(true);
    expect((payload.items as Array<unknown>).length).toBe(2);
    expect("idempotency_key" in payload).toBe(false);
    expect(activities).toHaveLength(3);
  });

  it("falls back to control.ingest when remember helper is unavailable", async () => {
    const controlIngestCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          ingest: async (payload?: Record<string, unknown>) => {
            controlIngestCalls.push(payload ?? {});
            return { accepted: true, job_id: "job-fallback" };
          },
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async () => ({ success: true }),
        },
      },
    });

    const result = await engine.writeEvent({
      eventId: "evt-fallback",
      source: "codex_exec",
      repoId: "repo-bulk",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-02-24T16:10:00.000Z",
      eventType: "prompt.submitted",
      payload: { prompt: "one" },
      reasoningAvailability: "unavailable",
    });

    expect(result.jobId).toBe("job-fallback");
    expect(controlIngestCalls).toHaveLength(1);
    expect(controlIngestCalls[0].run_id).toBe("codaph:repo-bulk:session-1");
    expect(Array.isArray(controlIngestCalls[0].items)).toBe(true);
    expect((controlIngestCalls[0].items as unknown[]).length).toBe(1);
  });

  it("falls back to core.insert when helper and raw ingest APIs are unavailable", async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        core: {
          insert: async (payload?: Record<string, unknown>) => {
            inserts.push(payload ?? {});
            return { success: true, node_id: 123 };
          },
        },
        control: {
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
          appendActivity: async () => ({ success: true }),
        } as Record<string, unknown>,
      } as unknown as any,
    });

    await engine.writeEvent({
      eventId: "evt-core-insert",
      source: "codex_exec",
      repoId: "repo-core",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-02-24T16:00:00.000Z",
      eventType: "prompt.submitted",
      payload: { prompt: "hello" },
      reasoningAvailability: "unavailable",
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0].run_id).toBe("codaph:repo-core:session-1");
    expect(inserts[0].session_id).toBe("session-1");
    expect(typeof inserts[0].text).toBe("string");
    expect(Buffer.isBuffer(inserts[0].metadata)).toBe(true);
  });

  it("uses strict hdql_query direct-bypass lane for semantic context retrieval", async () => {
    const recallCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        recall: async (payload: RecallOptions) => {
          recallCalls.push(payload as unknown as Record<string, unknown>);
          return { evidence: [{ source: "mubit", content: "match" }] };
        },
        control: {
          setVariable: async () => ({ success: true }),
        },
      },
    });

    const result = await engine.querySemanticContext({
      runId: "codaph:repo:session",
      query: "what changed?",
      limit: 5,
    });

    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0].mode).toBe("direct_bypass");
    expect(recallCalls[0].direct_lane).toBe("hdql_query");
    expect(result.codaph_query_lane).toBe("hdql_query");
    expect(result.codaph_query_mode).toBe("direct_bypass");
  });

  it("does not fall back from hdql_query lane", async () => {
    const recallCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        recall: async (payload: RecallOptions) => {
          const p = payload as unknown as Record<string, unknown>;
          recallCalls.push(p);
          throw new Error("invalid argument: direct_lane hdql_query unsupported");
        },
        control: {
          setVariable: async () => ({ success: true }),
        },
      },
    });

    await expect(
      engine.querySemanticContext({
        runId: "codaph:repo:session",
        query: "why did this fail?",
      }),
    ).rejects.toThrow(/hdql_query unsupported/i);

    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0].direct_lane).toBe("hdql_query");
  });

  it("adds a regional endpoint hint when snapshot sync cannot connect", async () => {
    const prevRegion = process.env.MUBIT_REGION;
    process.env.MUBIT_REGION = "EU";

    try {
      const engine = new MubitMemoryEngine({
        apiKey: "mbt_test",
        client: {
          control: {
            contextSnapshot: async () => {
              throw new Error(
                "control.context_snapshot HTTP request failed: Error: Unable to connect. Is the computer able to access the url?",
              );
            },
          },
        } as unknown as any,
      });

      await expect(
        engine.fetchContextSnapshot({
          runId: "codaph:repo:session",
        }),
      ).rejects.toThrow(/MUBIT_HTTP_ENDPOINT=https:\/\/api\.eu\.mubit\.ai/);
      await expect(
        engine.fetchContextSnapshot({
          runId: "codaph:repo:session",
        }),
      ).rejects.toThrow(/MUBIT_GRPC_ENDPOINT=grpc\.api\.eu\.mubit\.ai:443/);
    } finally {
      if (prevRegion === undefined) {
        delete process.env.MUBIT_REGION;
      } else {
        process.env.MUBIT_REGION = prevRegion;
      }
    }
  });
});
