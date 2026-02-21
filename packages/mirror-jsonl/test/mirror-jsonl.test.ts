import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlMirror, readManifest, readSparseIndex } from "../src/index";
import type { CapturedEventEnvelope } from "@codaph/core-types";

describe("jsonl mirror", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codaph-mirror-"));
  });

  it("appends events and updates indexes", async () => {
    const mirror = new JsonlMirror(root);
    const event: CapturedEventEnvelope = {
      eventId: "e1",
      source: "codex_sdk",
      repoId: "repo-1",
      sessionId: "s1",
      threadId: "t1",
      ts: "2026-02-21T20:10:05Z",
      eventType: "turn.started",
      payload: {},
      reasoningAvailability: "unavailable",
    };

    const res = await mirror.appendEvent(event);
    expect(res.segment).toContain("events/repo-1/");

    const manifest = await readManifest(root, "repo-1");
    const sparse = await readSparseIndex(root, "repo-1");

    expect(Object.keys(manifest.segments).length).toBe(1);
    expect(sparse.sessions.s1?.eventCount).toBe(1);
    expect(sparse.threads.t1?.eventCount).toBe(1);
  });

  it("supports raw line append", async () => {
    const mirror = new JsonlMirror(root);
    await mirror.appendRawLine("s2", '{"type":"thread.started"}');

    await rm(root, { recursive: true, force: true });
  });
});
