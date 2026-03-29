import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MubitMemoryEngine } from "../src/lib/memory-mubit";
import { JsonlMirror } from "../src/lib/mirror-jsonl";
import { codaphMcpToolSchemasForTest } from "../src/mcp-server";
import { type CapturedEventEnvelope, repoIdFromPath } from "../src/lib/core-types";

function findTool(name: string) {
  return codaphMcpToolSchemasForTest().find((t) => t.name === name);
}

function makeEvent(repoId: string, overrides: Partial<CapturedEventEnvelope> = {}): CapturedEventEnvelope {
  return {
    eventId: "evt-1",
    source: "codex_exec",
    repoId,
    actorId: "test-actor",
    sessionId: "session-1",
    threadId: "thread-1",
    ts: "2026-03-20T10:00:00Z",
    eventType: "item.completed",
    reasoningAvailability: "unavailable",
    payload: {
      item: { type: "message", content: "hello" },
    },
    ...overrides,
  };
}

describe("mcp-server", () => {
  const originalApiKey = process.env.MUBIT_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.MUBIT_API_KEY;
    } else {
      process.env.MUBIT_API_KEY = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  it("exposes MuBit activity filters through the MCP activity tool", async () => {
    process.env.MUBIT_API_KEY = "mbt_test";
    const calls: Array<Record<string, unknown>> = [];
    const listActivity = vi
      .spyOn(MubitMemoryEngine.prototype, "listActivity")
      .mockImplementation(async (payload) => {
        calls.push(payload as unknown as Record<string, unknown>);
        return { entries: [] };
      });

    const tool = findTool("codaph_mubit_activity");
    expect(tool).toBeTruthy();

    await tool?.handler(
      { cwd: "/Users/shankha/code/codaph", limit: 10, excludeDerived: true, projection: "compact" },
      { defaultCwd: "/Users/shankha/code/codaph" },
    );

    expect(listActivity).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({ limit: 10, excludeDerived: true, projection: "compact" });
    expect(typeof calls[0]?.runId).toBe("string");
    expect((calls[0]?.runId as string).startsWith("codaph:")).toBe(true);
  });

  // --------------------------------------------------------------------------
  // codaph_status
  // --------------------------------------------------------------------------
  describe("codaph_status", () => {
    it("returns valid status object without crashing", async () => {
      const tool = findTool("codaph_status");
      expect(tool).toBeTruthy();

      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-status-"));
      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(result.cwd).toBe(resolve(tmpDir));
      expect(typeof result.repoId).toBe("string");
      expect(Array.isArray(result.agentProviders)).toBe(true);
      expect(result.automation).toBeDefined();
    });

    it("falls back to a directory when cwd is not provided in args", async () => {
      const tool = findTool("codaph_status");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-status-default-"));

      // When no cwd is in args, resolveProjectContext falls through to
      // registry.lastProjectPath, registry.projects[0], or ctx.defaultCwd.
      // We just verify a valid result is returned without crashing.
      const result = (await tool!.handler({}, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(typeof result.cwd).toBe("string");
      expect(typeof result.repoId).toBe("string");
    });

    it("returns null for localPush and remote when no sync state exists", async () => {
      const tool = findTool("codaph_status");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-status-nosync-"));

      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.localPush).toBeNull();
      expect(result.remote).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // codaph_sessions_list
  // --------------------------------------------------------------------------
  describe("codaph_sessions_list", () => {
    it("returns empty sessions when mirror has no data", async () => {
      const tool = findTool("codaph_sessions_list");
      expect(tool).toBeTruthy();

      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-sessions-"));
      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.cwd).toBe(resolve(tmpDir));
      expect(result.total).toBe(0);
      expect(result.sessions).toEqual([]);
    });

    it("reads sessions from the mirror and returns structured data", async () => {
      const tool = findTool("codaph_sessions_list");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-sessions-data-"));
      const rid = repoIdFromPath(tmpDir);
      const mirrorRoot = join(tmpDir, ".codaph");
      const mirror = new JsonlMirror(mirrorRoot);

      await mirror.appendEvent(makeEvent(rid, { sessionId: "sess-a", ts: "2026-03-20T10:00:00Z" }));
      await mirror.appendEvent(makeEvent(rid, { eventId: "evt-2", sessionId: "sess-b", threadId: "thread-2", ts: "2026-03-20T11:00:00Z" }));
      await mirror.appendEvent(makeEvent(rid, { eventId: "evt-3", sessionId: "sess-a", threadId: "thread-2", ts: "2026-03-20T12:00:00Z" }));

      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(2);
      const sessions = result.sessions as Array<Record<string, unknown>>;
      expect(sessions).toHaveLength(2);
      const sessionIds = sessions.map((s) => s.sessionId);
      expect(sessionIds).toContain("sess-a");
      expect(sessionIds).toContain("sess-b");
    });

    it("respects the limit parameter and reports truncation", async () => {
      const tool = findTool("codaph_sessions_list");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-sessions-limit-"));
      const rid = repoIdFromPath(tmpDir);
      const mirrorRoot = join(tmpDir, ".codaph");
      const mirror = new JsonlMirror(mirrorRoot);

      for (let i = 1; i <= 3; i++) {
        await mirror.appendEvent(makeEvent(rid, { eventId: `evt-${i}`, sessionId: `sess-${i}`, ts: `2026-03-20T1${i}:00:00Z` }));
      }

      const result = (await tool!.handler({ cwd: tmpDir, limit: 2 }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(3);
      expect((result.sessions as unknown[]).length).toBe(2);
      expect(result.truncated).toBe(true);
    });

    it("uses project_path alias for cwd", async () => {
      const tool = findTool("codaph_sessions_list");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-sessions-alias-"));

      const result = (await tool!.handler(
        { project_path: tmpDir },
        { defaultCwd: "/nonexistent" },
      )) as Record<string, unknown>;

      expect(result.cwd).toBe(resolve(tmpDir));
    });
  });

  // --------------------------------------------------------------------------
  // codaph_timeline_get
  // --------------------------------------------------------------------------
  describe("codaph_timeline_get", () => {
    it("returns events from the local mirror", async () => {
      const tool = findTool("codaph_timeline_get");
      expect(tool).toBeTruthy();

      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));
      await mirror.appendEvent(makeEvent(rid));

      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(1);
      expect(result.returned).toBe(1);
      const events = result.events as Array<Record<string, unknown>>;
      expect(events[0]?.eventId).toBe("evt-1");
    });

    it("filters by sessionId", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-filter-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));

      await mirror.appendEvent(makeEvent(rid, { sessionId: "sess-a" }));
      await mirror.appendEvent(makeEvent(rid, { eventId: "evt-2", sessionId: "sess-b", ts: "2026-03-20T11:00:00Z" }));

      const result = (await tool!.handler({ cwd: tmpDir, sessionId: "sess-a" }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(1);
      const events = result.events as Array<Record<string, unknown>>;
      expect(events[0]?.sessionId).toBe("sess-a");
    });

    it("filters by actorId", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-actor-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));

      await mirror.appendEvent(makeEvent(rid, { actorId: "alice" }));
      await mirror.appendEvent(makeEvent(rid, { eventId: "evt-2", actorId: "bob", ts: "2026-03-20T11:00:00Z" }));

      const result = (await tool!.handler({ cwd: tmpDir, actorId: "bob" }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(1);
      const events = result.events as Array<Record<string, unknown>>;
      expect(events[0]?.actorId).toBe("bob");
    });

    it("passes query parameter through as semanticQuery in filter", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-query-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));
      await mirror.appendEvent(makeEvent(rid));

      delete process.env.MUBIT_API_KEY;

      const result = (await tool!.handler({ cwd: tmpDir, query: "what changed in auth?" }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      const filter = result.filter as Record<string, unknown>;
      expect(filter.semanticQuery).toBe("what changed in auth?");
    });

    it("passes semantic_query alias through as semanticQuery in filter", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-sqalias-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));
      await mirror.appendEvent(makeEvent(rid));

      delete process.env.MUBIT_API_KEY;

      const result = (await tool!.handler(
        { cwd: tmpDir, semantic_query: "show me file changes" },
        { defaultCwd: tmpDir },
      )) as Record<string, unknown>;

      const filter = result.filter as Record<string, unknown>;
      expect(filter.semanticQuery).toBe("show me file changes");
    });

    it("respects offset and limit for pagination", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-page-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));

      for (let i = 1; i <= 5; i++) {
        await mirror.appendEvent(makeEvent(rid, { eventId: `evt-${i}`, ts: `2026-03-20T1${i}:00:00Z` }));
      }

      const result = (await tool!.handler({ cwd: tmpDir, offset: 2, limit: 2 }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(5);
      expect(result.returned).toBe(2);
      expect(result.offset).toBe(2);
      expect(result.truncated).toBe(true);
    });

    it("strips payload when includePayload is false", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-nopayload-"));
      const rid = repoIdFromPath(tmpDir);
      const mirror = new JsonlMirror(join(tmpDir, ".codaph"));
      await mirror.appendEvent(makeEvent(rid));

      const result = (await tool!.handler(
        { cwd: tmpDir, includePayload: false },
        { defaultCwd: tmpDir },
      )) as Record<string, unknown>;

      const events = result.events as Array<Record<string, unknown>>;
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({});
      // eventId should still be present even with payload stripped
      expect(events[0]?.eventId).toBe("evt-1");
    });

    it("returns empty events when mirror has no data", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-timeline-empty-"));

      const result = (await tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir })) as Record<string, unknown>;

      expect(result.total).toBe(0);
      expect(result.events).toEqual([]);
    });

    it("includes query schema property for semantic search", () => {
      const tool = findTool("codaph_timeline_get");
      expect(tool).toBeTruthy();
      const props = (tool!.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
      expect(props.query).toBeDefined();
      expect(props.query.type).toBe("string");
      expect(props.semantic_query).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Error cases
  // --------------------------------------------------------------------------
  describe("error cases", () => {
    it("all Mubit-dependent tools return structured error when engine is not enabled", async () => {
      delete process.env.MUBIT_API_KEY;
      delete process.env.MUBIT_APIKEY;
      vi.spyOn(MubitMemoryEngine.prototype, "isEnabled").mockReturnValue(false);

      const mubitToolSpecs: Array<{ name: string; extraArgs?: Record<string, unknown> }> = [
        { name: "codaph_mubit_context", extraArgs: { query: "test query" } },
        { name: "codaph_mubit_snapshot" },
        { name: "codaph_mubit_activity" },
        { name: "codaph_mubit_diagnose", extraArgs: { errorText: "some error" } },
      ];

      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-nomubit-"));

      for (const spec of mubitToolSpecs) {
        const tool = findTool(spec.name);
        expect(tool, `${spec.name} should exist`).toBeTruthy();

        const args: Record<string, unknown> = { cwd: tmpDir, ...spec.extraArgs };
        const result = (await tool!.handler(args, { defaultCwd: tmpDir })) as Record<string, unknown>;

        expect(result.error, `${spec.name} should return mubit_not_configured`).toBe("mubit_not_configured");
        expect(typeof result.setup_instructions).toBe("string");
      }
    });

    it("codaph_status handles non-existent cwd gracefully", async () => {
      const tool = findTool("codaph_status");
      const fakeDir = join(tmpdir(), `codaph-nonexistent-${Date.now()}`);

      const result = (await tool!.handler(
        { cwd: fakeDir },
        { defaultCwd: fakeDir },
      )) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(result.cwd).toBe(resolve(fakeDir));
      expect(result.localPush).toBeNull();
      expect(result.remote).toBeNull();
    });

    it("codaph_sessions_list handles non-existent mirror gracefully", async () => {
      const tool = findTool("codaph_sessions_list");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-nomirror-"));

      const result = (await tool!.handler(
        { cwd: tmpDir },
        { defaultCwd: tmpDir },
      )) as Record<string, unknown>;

      expect(result.total).toBe(0);
      expect(result.sessions).toEqual([]);
    });

    it("codaph_timeline_get handles non-existent mirror gracefully", async () => {
      const tool = findTool("codaph_timeline_get");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-nomirror-tl-"));

      const result = (await tool!.handler(
        { cwd: tmpDir },
        { defaultCwd: tmpDir },
      )) as Record<string, unknown>;

      expect(result.total).toBe(0);
      expect(result.events).toEqual([]);
    });

    it("codaph_diff_summary throws when sessionId is missing", async () => {
      const tool = findTool("codaph_diff_summary");
      const tmpDir = await mkdtemp(join(tmpdir(), "codaph-diff-nosess-"));

      await expect(
        tool!.handler({ cwd: tmpDir }, { defaultCwd: tmpDir }),
      ).rejects.toThrow('"sessionId" is required');
    });
  });
});
