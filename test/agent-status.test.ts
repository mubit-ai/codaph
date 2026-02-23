import { describe, expect, it } from "vitest";
import { formatSnapshot, parseGitStatusPorcelain } from "../src/agent-status";

describe("agent status", () => {
  it("parses git porcelain counts", () => {
    const parsed = parseGitStatusPorcelain([
      "M  src/a.ts",
      " M src/b.ts",
      "MM src/c.ts",
      "?? src/d.ts",
    ].join("\n"));

    expect(parsed.stagedCount).toBe(2);
    expect(parsed.unstagedCount).toBe(2);
    expect(parsed.untrackedCount).toBe(1);
    expect(parsed.changedFiles.length).toBe(4);
  });

  it("formats snapshot markdown block", () => {
    const md = formatSnapshot({
      ts: "2026-02-21T20:10:05Z",
      repoPath: "/tmp/repo",
      branch: "main",
      headSha: "abc123",
      stagedCount: 1,
      unstagedCount: 0,
      untrackedCount: 2,
      changedFiles: ["a.ts", "b.ts"],
      source: "manual",
    });

    expect(md).toContain("## Status Snapshot");
    expect(md).toContain("- branch: main");
    expect(md).toContain("- files: a.ts, b.ts");
  });
});
