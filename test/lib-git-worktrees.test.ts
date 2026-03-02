import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  parseGitWorktreeListPorcelain,
  resolveScopedProjectPathsForWorktrees,
  scopeProjectPathAcrossWorktrees,
} from "../src/lib/git-worktrees";

describe("git-worktrees", () => {
  it("parses worktree paths from porcelain output (including spaces)", () => {
    const raw = [
      "worktree /tmp/codaph/repo-main",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /tmp/codaph/repo feature",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature",
      "",
    ].join("\n");

    const parsed = parseGitWorktreeListPorcelain(raw);
    expect(parsed).toEqual([resolve("/tmp/codaph/repo-main"), resolve("/tmp/codaph/repo feature")]);
  });

  it("maps the current project subdirectory to each worktree root", () => {
    const repoRoot = resolve("/tmp/codaph/repo-main");
    const projectPath = join(repoRoot, "apps", "api");
    const scoped = scopeProjectPathAcrossWorktrees(
      [repoRoot, resolve("/tmp/codaph/repo-wt")],
      repoRoot,
      projectPath,
    );

    expect(scoped).toEqual([join(repoRoot, "apps", "api"), resolve("/tmp/codaph/repo-wt/apps/api")]);
  });

  it("falls back to the current project path when git discovery fails", () => {
    const projectPath = resolve("/tmp/codaph/repo-main/apps/api");
    const scoped = resolveScopedProjectPathsForWorktrees(projectPath, () => null);
    expect(scoped).toEqual([projectPath]);
  });

  it("falls back when project path is outside the reported repo root", () => {
    const outsideProject = resolve("/tmp/codaph/outside");
    const scoped = scopeProjectPathAcrossWorktrees([resolve("/tmp/codaph/repo-main")], resolve("/tmp/codaph/repo-main"), outsideProject);
    expect(scoped).toEqual([outsideProject]);
  });
});
