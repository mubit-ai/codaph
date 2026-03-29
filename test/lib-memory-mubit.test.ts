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
    expect(remembers[0].lane).toBe("prompt");
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

  it("forwards MuBit recall options when provided", async () => {
    const recallCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        recall: async (payload: RecallOptions) => {
          recallCalls.push(payload as unknown as Record<string, unknown>);
          return { final_answer: "recent answer", evidence: [] };
        },
        control: {
          setVariable: async () => ({ success: true }),
        },
      },
    });

    await engine.querySemanticContext({
      runId: "codaph:repo:session",
      query: "what changed recently?",
      limit: 4,
      includeLinkedRuns: true,
      laneFilter: "summary",
      minTimestamp: 1711368000,
      maxTimestamp: 1711454400,
      budget: "small",
      rankBy: "freshness",
      explain: true,
    });

    expect(recallCalls).toHaveLength(1);
    expect(recallCalls[0]).toMatchObject({
      session_id: "codaph:repo:session",
      query: "what changed recently?",
      include_linked_runs: true,
      limit: 4,
      lane_filter: "summary",
      min_timestamp: 1711368000,
      max_timestamp: 1711454400,
      budget: "small",
      rank_by: "freshness",
      explain: true,
    });
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

  it("preserves SDK control method binding when calling wrapped control APIs", async () => {
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          _transport: { marker: "ok" },
          async contextSnapshot(this: { _transport?: { marker?: string } }, payload?: Record<string, unknown>) {
            if (this._transport?.marker !== "ok") {
              throw new Error("lost control binding");
            }
            return {
              timeline: [],
              seen_run_id: payload?.run_id,
            };
          },
        } as unknown as Record<string, unknown>,
      } as unknown as any,
    });

    const snapshot = await engine.fetchContextSnapshot({
      runId: "codaph:repo:session",
    });

    expect(snapshot.seen_run_id).toBe("codaph:repo:session");
  });

  it("retrieves structured context blocks through the control context API", async () => {
    const contextCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          context: async (payload?: Record<string, unknown>) => {
            contextCalls.push(payload ?? {});
            return {
              context_block: "lesson: use repo-local queue first",
              token_estimate: 42,
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.getContextBlock({
      runId: "codaph:repo-abc:session-1",
      query: "what should the next agent know?",
      sections: ["lessons", "handoffs"],
      mode: "sections",
      format: "structured",
      maxTokenBudget: 500,
      limit: 7,
      agentId: "codex",
    });

    expect(result.context_block).toContain("repo-local queue");
    expect(contextCalls).toHaveLength(1);
    expect(contextCalls[0].run_id).toBe("codaph:repo-abc:session-1");
    expect(contextCalls[0].query).toBe("what should the next agent know?");
    expect(contextCalls[0].mode).toBe("sections");
    expect(contextCalls[0].format).toBe("structured");
    expect(contextCalls[0].max_token_budget).toBe(500);
    expect(contextCalls[0].limit).toBe(7);
    expect(contextCalls[0].agent_id).toBe("codex");
    expect(contextCalls[0].sections).toEqual(["lessons", "handoffs"]);
  });

  it("normalizes sections mode without explicit sections to full mode", async () => {
    const contextCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          context: async (payload?: Record<string, unknown>) => {
            contextCalls.push(payload ?? {});
            return {
              context_block: "full mode context",
              section_summaries: [{ section_name: "Known Facts" }],
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.getContextBlock({
      runId: "codaph:repo-abc",
      query: "what should the next agent know?",
      mode: "sections",
      format: "structured",
      limit: 5,
    });

    expect(result.context_block).toContain("full mode context");
    expect(contextCalls).toHaveLength(1);
    expect(contextCalls[0].mode).toBe("full");
    expect(contextCalls[0].sections).toBeUndefined();
  });

  it("creates a fallback checkpoint context snapshot when omitted", async () => {
    const checkpointCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          checkpoint: async (payload?: Record<string, unknown>) => {
            checkpointCalls.push(payload ?? {});
            return { success: true, checkpoint_id: "cp-fallback" };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.createCheckpoint({
      runId: "codaph:repo-abc",
      label: "before-migration",
    });

    expect(result.checkpoint_id).toBe("cp-fallback");
    expect(checkpointCalls).toHaveLength(1);
    expect(checkpointCalls[0]?.context_snapshot).toContain("before-migration");
    expect(checkpointCalls[0]?.context_snapshot).toContain("codaph:repo-abc");
  });

  it("falls back to strategies and recent activity when Mubit context is empty", async () => {
    const contextCalls: Array<Record<string, unknown>> = [];
    const strategyCalls: Array<Record<string, unknown>> = [];
    const listActivityCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          context: async (payload?: Record<string, unknown>) => {
            contextCalls.push(payload ?? {});
            return {
              context_block: "",
              evidence_candidates_considered: 0,
              sources: [],
            };
          },
          surfaceStrategies: async (payload?: Record<string, unknown>) => {
            strategyCalls.push(payload ?? {});
            return {
              strategies: [
                {
                  strategy_id: "s-1",
                  description: "Use activity replay when snapshot-based context is empty.",
                  supporting_lesson_count: 2,
                },
              ],
            };
          },
          listActivity: async (payload?: Record<string, unknown>) => {
            listActivityCalls.push(payload ?? {});
            return {
              entries: [
                {
                  id: "activity-1",
                  entry_type: "codaph_event",
                  created_at: "2026-03-25T10:00:00.000Z",
                  metadata_json:
                    "{\"event_type\":\"prompt.submitted\",\"session_id\":\"session-1\",\"actor_id\":\"shankha98\",\"payload\":{\"prompt\":\"Investigate empty context on project run\"}}",
                },
                {
                  id: "activity-2",
                  entry_type: "codaph_event",
                  created_at: "2026-03-25T10:01:00.000Z",
                  metadata_json:
                    "{\"event_type\":\"codaph.session.summary\",\"session_id\":\"session-1\",\"payload\":{\"summary\":\"Implemented full activity replay fallback\"}}",
                },
              ],
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.getContextBlock({
      runId: "codaph:repo-abc",
      query: "what should the next agent know?",
      includeLinkedRuns: true,
      limit: 5,
    });

    expect(contextCalls).toHaveLength(1);
    expect(strategyCalls).toHaveLength(1);
    expect(listActivityCalls).toHaveLength(1);
    expect(result.fallback_used).toBe(true);
    expect(result.context_block).toContain("Strategy signals");
    expect(result.context_block).toContain("Use activity replay when snapshot-based context is empty");
    expect(result.context_block).toContain("Recent activity");
    expect(result.context_block).toContain("prompt.submitted");
    expect(result.context_block).toContain("Implemented full activity replay fallback");
    expect(result.evidence_candidates_considered).toBe(3);
    expect(result.source_counts_by_retrieval_mode).toEqual({
      strategy: 1,
      activity: 2,
    });
  });

  it("supplements weak semantic query answers with context without replacing the query result", async () => {
    const recallCalls: Array<Record<string, unknown>> = [];
    const contextCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        recall: async (payload: RecallOptions) => {
          recallCalls.push(payload as unknown as Record<string, unknown>);
          return {
            final_answer: "I do not know.",
            confidence: 0.2,
            evidence: [{ content: "some evidence", source: "codaph-cli" }],
          };
        },
        control: {
          context: async (payload?: Record<string, unknown>) => {
            contextCalls.push(payload ?? {});
            return {
              context_block: "Known facts:\n- Use activity replay when snapshots are empty.",
              section_summaries: [{ section_name: "Known Facts", item_count: 1 }],
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.queryWithContextFallback({
      runId: "codaph:repo-abc",
      query: "what should the next agent know?",
      limit: 6,
      includeLinkedRuns: true,
      mode: "agent_routed",
      contextMode: "summary",
      contextFormat: "structured",
    });

    expect(recallCalls).toHaveLength(1);
    expect(contextCalls).toHaveLength(1);
    expect(result.final_answer).toBe("I do not know.");
    expect(result.query_fallback_used).toBe(true);
    expect(result.query_fallback_reason).toBe("weak_final_answer");
    expect(result.query_result).toMatchObject({
      final_answer: "I do not know.",
    });
    expect(result.supplemental_context_block).toContain("Use activity replay");
    expect((result.supplemental_context as Record<string, unknown>).context_block).toContain("Known facts");
    expect(contextCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      query: "what should the next agent know?",
      mode: "summary",
      format: "structured",
      include_linked_runs: true,
      limit: 6,
    });
  });

  it("keeps strong semantic query answers without fetching fallback context", async () => {
    const recallCalls: Array<Record<string, unknown>> = [];
    const contextCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        recall: async (payload: RecallOptions) => {
          recallCalls.push(payload as unknown as Record<string, unknown>);
          return {
            final_answer: "Use project scope for shared repo memory.",
            confidence: 1,
            evidence: [{ content: "shared repo memory", source: "codaph-cli" }],
          };
        },
        control: {
          context: async (payload?: Record<string, unknown>) => {
            contextCalls.push(payload ?? {});
            return {
              context_block: "unused fallback",
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.queryWithContextFallback({
      runId: "codaph:repo-abc",
      query: "how should we share memory?",
      mode: "agent_routed",
    });

    expect(recallCalls).toHaveLength(1);
    expect(contextCalls).toHaveLength(0);
    expect(result.query_fallback_used).toBe(false);
    expect(result.query_fallback_reason).toBeNull();
    expect(result.final_answer).toContain("project scope");
    expect(result.supplemental_context).toBeNull();
  });

  it("normalizes context snapshots into a repo-facing inspection shape", async () => {
    const snapshotCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          contextSnapshot: async (payload?: Record<string, unknown>) => {
            snapshotCalls.push(payload ?? {});
            return {
              scope: {
                run_id: "state::123::codaph:repo-abc",
                linked_run_ids: ["codaph:repo-abc:session-1"],
              },
              agents: [],
              timeline: [],
              promotions: [
                {
                  policy_rule: "llm_policy",
                  reason: "The user explicitly asked to build and test the integration.",
                  source_record_id: "rec-1",
                },
              ],
              snapshot: {
                summary: "The latest run assembled state without replayable timeline events.",
                progress: ["Imported recent activity."],
                next_actions: ["Inspect the query path."],
                uncertainties: ["Why recall is weaker than getContext."],
                blockers: [],
                facts: ["Activity replay imported 1456 events."],
                updated_at: "2026-03-25T12:00:00.000Z",
              },
            };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.inspectContextSnapshot({
      runId: "codaph:repo-abc",
      timelineLimit: 25,
      refresh: false,
    });

    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      timeline_limit: 25,
      refresh: false,
    });
    expect(result.run_id_requested).toBe("codaph:repo-abc");
    expect(result.run_id_resolved).toBe("state::123::codaph:repo-abc");
    expect(result.linked_run_ids).toEqual(["codaph:repo-abc:session-1"]);
    expect(result.timeline_count).toBe(0);
    expect(result.promotion_count).toBe(1);
    expect(result.has_promotions).toBe(true);
    expect(result.has_replayable_timeline).toBe(false);
    expect(result.snapshot_summary).toContain("assembled state");
    expect(result.snapshot_progress).toEqual(["Imported recent activity."]);
    expect(result.snapshot_next_actions).toEqual(["Inspect the query path."]);
    expect(result.snapshot_uncertainties).toEqual(["Why recall is weaker than getContext."]);
    expect(result.snapshot_facts).toEqual(["Activity replay imported 1456 events."]);
    expect((result.promotion_policy_counts as Record<string, number>).llm_policy).toBe(1);
    expect((result.promotion_samples as Array<Record<string, unknown>>)[0]?.reason).toContain("build and test");
  });

  it("prefers timeline_available when snapshots expose replay support explicitly", async () => {
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          contextSnapshot: async () => ({
            scope: { run_id: "state::123::codaph:repo-abc" },
            timeline_available: true,
            timeline: [],
            promotions: [],
            agents: [],
            snapshot: {
              summary: "Replay state is available even though this snapshot window is empty.",
            },
          }),
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.inspectContextSnapshot({
      runId: "codaph:repo-abc",
    });

    expect(result.timeline_available).toBe(true);
    expect(result.has_replayable_timeline).toBe(true);
  });

  it("wraps list/export activity and run-state control APIs", async () => {
    const listActivityCalls: Array<Record<string, unknown>> = [];
    const exportActivityCalls: Array<Record<string, unknown>> = [];
    const getVariableCalls: Array<Record<string, unknown>> = [];
    const listVariableCalls: Array<Record<string, unknown>> = [];
    const statsCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          listActivity: async (payload?: Record<string, unknown>) => {
            listActivityCalls.push(payload ?? {});
            return { entries: [{ id: "activity-1" }], next_page_token: "next-1" };
          },
          exportActivity: async (payload?: Record<string, unknown>) => {
            exportActivityCalls.push(payload ?? {});
            return { format: "jsonl", content: "{\"id\":\"activity-1\"}\n", entry_count: 1 };
          },
          getVariable: async (payload?: Record<string, unknown>) => {
            getVariableCalls.push(payload ?? {});
            return { name: "codaph.run_state", value_json: "{\"status\":\"ok\"}" };
          },
          listVariables: async (payload?: Record<string, unknown>) => {
            listVariableCalls.push(payload ?? {});
            return { variables: [{ name: "codaph.run_state" }] };
          },
          getRunIngestStats: async (payload?: Record<string, unknown>) => {
            statsCalls.push(payload ?? {});
            return { run_id: "codaph:repo-abc", total_jobs: 3 };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const listResult = await engine.listActivity({
      runId: "codaph:repo-abc",
      entryTypes: ["handoff", "feedback"],
      sort: "asc",
      limit: 50,
      pageToken: "cursor-2",
      excludeDerived: true,
      projection: "compact",
    });
    const exportResult = await engine.exportActivity({
      runId: "codaph:repo-abc",
      entryTypes: ["codaph_event"],
      sort: "asc",
    });
    const variable = await engine.getRunVariable("codaph:repo-abc", "codaph.run_state");
    const variables = await engine.listRunVariables("codaph:repo-abc");
    const stats = await engine.getRunIngestStats("codaph:repo-abc");

    expect((listResult.entries as Array<unknown>).length).toBe(1);
    expect(exportResult.entry_count).toBe(1);
    expect(variable.name).toBe("codaph.run_state");
    expect((variables.variables as Array<unknown>).length).toBe(1);
    expect(stats.total_jobs).toBe(3);
    expect(listActivityCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      entry_types: ["handoff", "feedback"],
      sort: "asc",
      limit: 50,
      page_token: "cursor-2",
      exclude_derived: true,
      projection: "compact",
    });
    expect(exportActivityCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      entry_types: ["codaph_event"],
      sort: "asc",
    });
    expect(getVariableCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      name: "codaph.run_state",
    });
    expect(listVariableCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
    });
    expect(statsCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
    });
  });

  it("filters derived activity and projects compact entries when the backend does not", async () => {
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          listActivity: async () => ({
            entries: [
              {
                id: "derived-1",
                entry_type: "fact",
                content: "Very long derived content that should be removed when excludeDerived is requested.",
                metadata_json: "{\"promotion\":true,\"source_record_id\":\"src-1\"}",
              },
              {
                id: "handoff-1",
                entry_type: "handoff",
                source: "claude-code",
                created_at: "2026-03-25T10:00:00.000Z",
                content: "continue validating the new mubit integration features in codaph",
              },
              {
                id: "feedback-1",
                entry_type: "feedback",
                source: "feedback",
                created_at: "2026-03-25T10:01:00.000Z",
                content:
                  "looks good but this line is intentionally long so compact projection has to trim it down before returning it to the caller for audit-style output",
              },
            ],
          }),
        } as Record<string, unknown>,
      } as unknown as any,
    });

    const result = await engine.listActivity({
      runId: "codaph:repo-abc",
      limit: 10,
      excludeDerived: true,
      projection: "compact",
    });

    expect(result.exclude_derived_fallback_used).toBe(true);
    expect(result.projection_fallback_used).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
    expect((result.entries as Array<Record<string, unknown>>).map((entry) => entry.id)).toEqual([
      "handoff-1",
      "feedback-1",
    ]);
    expect((result.entries as Array<Record<string, unknown>>)[0]).toEqual({
      id: "handoff-1",
      entry_type: "handoff",
      source: "claude-code",
      created_at: "2026-03-25T10:00:00.000Z",
      content: "continue validating the new mubit integration features in codaph",
    });
    expect(
      String((result.entries as Array<Record<string, unknown>>)[1]?.content ?? ""),
    ).toContain("intentionally long");
    expect(
      String((result.entries as Array<Record<string, unknown>>)[1]?.content ?? "").length,
    ).toBeLessThan(210);
  });

  it("wraps diagnostics, linking, reflection, agent registry, and handoffs", async () => {
    const linkCalls: Array<Record<string, unknown>> = [];
    const checkpointCalls: Array<Record<string, unknown>> = [];
    const memoryHealthCalls: Array<Record<string, unknown>> = [];
    const diagnoseCalls: Array<Record<string, unknown>> = [];
    const reflectCalls: Array<Record<string, unknown>> = [];
    const strategyCalls: Array<Record<string, unknown>> = [];
    const registerAgentCalls: Array<Record<string, unknown>> = [];
    const listAgentsCalls: Array<Record<string, unknown>> = [];
    const handoffCalls: Array<Record<string, unknown>> = [];
    const feedbackCalls: Array<Record<string, unknown>> = [];
    const stepOutcomeCalls: Array<Record<string, unknown>> = [];
    const outcomeCalls: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          linkRun: async (payload?: Record<string, unknown>) => {
            linkCalls.push(payload ?? {});
            return { success: true };
          },
          checkpoint: async (payload?: Record<string, unknown>) => {
            checkpointCalls.push(payload ?? {});
            return { success: true, checkpoint_id: "cp-1" };
          },
          memoryHealth: async (payload?: Record<string, unknown>) => {
            memoryHealthCalls.push(payload ?? {});
            return { stale_entries: 2 };
          },
          diagnose: async (payload?: Record<string, unknown>) => {
            diagnoseCalls.push(payload ?? {});
            return { summary: "same auth failure", total_failure_lessons: 1 };
          },
          reflect: async (payload?: Record<string, unknown>) => {
            reflectCalls.push(payload ?? {});
            return { lessons_stored: 2 };
          },
          surfaceStrategies: async (payload?: Record<string, unknown>) => {
            strategyCalls.push(payload ?? {});
            return { strategies: [{ strategy_id: "s-1" }] };
          },
          registerAgent: async (payload?: Record<string, unknown>) => {
            registerAgentCalls.push(payload ?? {});
            return { success: true };
          },
          listAgents: async (payload?: Record<string, unknown>) => {
            listAgentsCalls.push(payload ?? {});
            return { agents: [{ agent_id: "codex" }] };
          },
          createHandoff: async (payload?: Record<string, unknown>) => {
            handoffCalls.push(payload ?? {});
            return { success: true, handoff_id: "handoff-1" };
          },
          submitFeedback: async (payload?: Record<string, unknown>) => {
            feedbackCalls.push(payload ?? {});
            return { success: true, feedback_id: "feedback-1" };
          },
          recordStepOutcome: async (payload?: Record<string, unknown>) => {
            stepOutcomeCalls.push(payload ?? {});
            return { accepted: true, step_outcome_id: "step-1" };
          },
          recordOutcome: async (payload?: Record<string, unknown>) => {
            outcomeCalls.push(payload ?? {});
            return { success: true, reinforcement_count: 2 };
          },
        } as Record<string, unknown>,
      } as unknown as any,
    });

    await engine.linkRun("codaph:repo-abc", "codaph:repo-abc:session-1");
    const checkpoint = await engine.createCheckpoint({
      runId: "codaph:repo-abc",
      label: "before-migration",
      contextSnapshot: "current context",
      metadata: { source: "test" },
      agentId: "codex",
    });
    const health = await engine.inspectMemoryHealth({
      runId: "codaph:repo-abc",
      staleThresholdDays: 14,
      limit: 25,
    });
    const diagnosis = await engine.diagnoseFailure({
      runId: "codaph:repo-abc",
      errorText: "auth failure",
      errorType: "test",
      limit: 3,
    });
    const reflection = await engine.reflectRun({
      runId: "codaph:repo-abc",
      includeLinkedRuns: true,
      lastNItems: 25,
    });
    const strategies = await engine.surfaceStrategies({
      runId: "codaph:repo-abc",
      lessonTypes: ["success"],
      maxStrategies: 2,
    });
    await engine.registerAgent({
      runId: "codaph:repo-abc",
      agentId: "codex",
      role: "implementer",
      capabilities: ["edit", "test"],
      sharedMemoryLanes: ["history"],
    });
    const agents = await engine.listAgents("codaph:repo-abc");
    const handoff = await engine.createHandoff({
      runId: "codaph:repo-abc",
      taskId: "task-1",
      fromAgentId: "claude",
      toAgentId: "codex",
      content: "pick up auth cleanup",
      requestedAction: "continue",
      metadata: { pr: 12 },
    });
    const feedback = await engine.submitHandoffFeedback({
      runId: "codaph:repo-abc",
      handoffId: "handoff-1",
      verdict: "approve",
      comments: "looks good",
      fromAgentId: "gemini",
    });
    await engine.recordStepOutcome({
      runId: "codaph:repo-abc",
      stepId: "step-1",
      stepName: "planning",
      outcome: "success",
      signal: 0.5,
      rationale: "good plan",
      directiveHint: "keep context concise",
      agentId: "codex",
    });
    await engine.recordOutcome({
      runId: "codaph:repo-abc",
      referenceId: "lesson-1",
      outcome: "success",
      signal: 1,
      rationale: "worked",
      agentId: "codex",
    });

    expect(checkpoint.checkpoint_id).toBe("cp-1");
    expect(health.stale_entries).toBe(2);
    expect(diagnosis.summary).toContain("auth");
    expect(reflection.lessons_stored).toBe(2);
    expect((strategies.strategies as Array<unknown>).length).toBe(1);
    expect((agents.agents as Array<unknown>).length).toBe(1);
    expect(handoff.handoff_id).toBe("handoff-1");
    expect(feedback.feedback_id).toBe("feedback-1");
    expect(linkCalls[0]).toEqual({ run_id: "codaph:repo-abc", linked_run_id: "codaph:repo-abc:session-1" });
    expect(checkpointCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      label: "before-migration",
      context_snapshot: "current context",
      agent_id: "codex",
    });
    expect(memoryHealthCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      stale_threshold_days: 14,
      limit: 25,
    });
    expect(diagnoseCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      error_text: "auth failure",
      error_type: "test",
      limit: 3,
    });
    expect(reflectCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      include_linked_runs: true,
      last_n_items: 25,
    });
    expect(strategyCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      lesson_types: ["success"],
      max_strategies: 2,
    });
    expect(registerAgentCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      agent_id: "codex",
      role: "implementer",
    });
    expect(listAgentsCalls[0]).toEqual({ run_id: "codaph:repo-abc" });
    expect(handoffCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      task_id: "task-1",
      from_agent_id: "claude",
      to_agent_id: "codex",
      requested_action: "continue",
    });
    expect(feedbackCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      handoff_id: "handoff-1",
      verdict: "approve",
      comments: "looks good",
      from_agent_id: "gemini",
    });
    expect(stepOutcomeCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      step_id: "step-1",
      step_name: "planning",
      directive_hint: "keep context concise",
    });
    expect(outcomeCalls[0]).toMatchObject({
      run_id: "codaph:repo-abc",
      reference_id: "lesson-1",
      outcome: "success",
    });
  });

  it("assigns MuBit lanes for reasoning, tool, summary, and generic events", async () => {
    const remembers: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
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
      eventId: "evt-reasoning",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-03-25T10:00:00.000Z",
      eventType: "item.completed",
      payload: { item: { type: "reasoning", text: "thinking" } },
      reasoningAvailability: "full",
    });
    await engine.writeEvent({
      eventId: "evt-tool",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-03-25T10:00:01.000Z",
      eventType: "item.completed",
      payload: { item: { type: "tool_call", name: "rg" } },
      reasoningAvailability: "unavailable",
    });
    await engine.writeEvent({
      eventId: "evt-summary",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-03-25T10:00:02.000Z",
      eventType: "codaph.session.summary",
      payload: { item: { type: "codaph_session_summary", summary: "Done" } },
      reasoningAvailability: "unavailable",
    });
    await engine.writeEvent({
      eventId: "evt-event",
      source: "codex_exec",
      repoId: "repo-abc",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-03-25T10:00:03.000Z",
      eventType: "turn.started",
      payload: {},
      reasoningAvailability: "unavailable",
    });

    expect(remembers.map((entry) => entry.lane)).toEqual(["reasoning", "tool", "summary", "event"]);
  });
});
