import { describe, expect, it } from "vitest";
import { MubitMemoryEngine, mubitRunIdForProject, mubitRunIdForSession } from "../src/index";

describe("memory-mubit", () => {
  it("builds stable run ids", () => {
    expect(mubitRunIdForSession("repo123", "session456")).toBe("codaph:repo123:session456");
    expect(mubitRunIdForSession("repo123", "session456", "custom")).toBe(
      "custom:repo123:session456",
    );
    expect(mubitRunIdForProject("repo123")).toBe("codaph:repo123");
    expect(mubitRunIdForProject("repo123", "custom")).toBe("custom:repo123");
  });

  it("writes control ingest payloads with idempotency key", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const engine = new MubitMemoryEngine({
      client: {
        control: {
          ingest: async (payload?: Record<string, unknown>) => {
            captures.push(payload ?? {});
            return { accepted: true, job_id: "job-1", deduplicated: true };
          },
          setVariable: async () => ({ success: true }),
          query: async () => ({ final_answer: "ok" }),
        },
      },
    });

    const result = await engine.writeEvent({
      eventId: "evt-123",
      source: "codex_exec",
      repoId: "repo-abc",
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
        },
      },
    });

    await engine.writeEvent({
      eventId: "evt-456",
      source: "codex_exec",
      repoId: "local-repo-id",
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
});
