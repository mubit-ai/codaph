import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlMirror, getIndexPaths } from "../src/lib/mirror-jsonl";
import { QueryService } from "../src/lib/query-service";
import type { CapturedEventEnvelope } from "../src/lib/core-types";

describe("query-service", () => {
  it("lists sessions and returns timelines", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-query-"));
    const mirror = new JsonlMirror(root);
    const query = new QueryService(root);

    const event: CapturedEventEnvelope = {
      eventId: "e1",
      source: "codex_exec",
      repoId: "repo-1",
      actorId: "anil",
      sessionId: "session-1",
      threadId: "thread-1",
      ts: "2026-02-21T20:10:05Z",
      eventType: "item.completed",
      reasoningAvailability: "unavailable",
      payload: {
        item: {
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }],
        },
      },
    };

    await mirror.appendEvent(event);

    const sessions = await query.listSessions("repo-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("session-1");

    const timeline = await query.getTimeline({ repoId: "repo-1", sessionId: "session-1" });
    expect(timeline).toHaveLength(1);
    const actorTimeline = await query.getTimeline({ repoId: "repo-1", sessionId: "session-1", actorId: "anil" });
    expect(actorTimeline).toHaveLength(1);
    const contributors = await query.listContributors("repo-1", "session-1");
    expect(contributors[0]?.actorId).toBe("anil");

    const diffs = await query.getDiffSummary("repo-1", "session-1");
    expect(diffs[0]?.path).toBe("src/a.ts");
  });

  it("caches sparse-index and manifest within a QueryService instance", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-query-cache-"));
    const mirror = new JsonlMirror(root);
    const query = new QueryService(root);

    const event: CapturedEventEnvelope = {
      eventId: "e1",
      source: "codex_exec",
      repoId: "repo-cache",
      actorId: "anil",
      sessionId: "session-cache",
      threadId: "thread-cache",
      ts: "2026-02-21T20:10:05Z",
      eventType: "item.completed",
      reasoningAvailability: "unavailable",
      payload: { item: { type: "agent_message", text: "hi" } },
    };
    await mirror.appendEvent(event);

    // Warm the cache.
    expect(await query.listSessions("repo-cache")).toHaveLength(1);
    expect(await query.getTimeline({ repoId: "repo-cache", sessionId: "session-cache" })).toHaveLength(1);

    // Delete the on-disk indexes. If the cache is honored, the next read still sees the data.
    const { sparsePath, manifestPath } = getIndexPaths(root, "repo-cache");
    await rm(sparsePath, { force: true });
    await rm(manifestPath, { force: true });

    expect(await query.listSessions("repo-cache")).toHaveLength(1);
    expect(await query.getTimeline({ repoId: "repo-cache", sessionId: "session-cache" })).toHaveLength(1);

    // After invalidation, a fresh disk read returns the empty defaults.
    query.invalidate("repo-cache");
    expect(await query.listSessions("repo-cache")).toHaveLength(0);
  });
});
