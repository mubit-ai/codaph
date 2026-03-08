import { describe, expect, it } from "vitest";
import { resolveGitHooksDir } from "../src/lib/git-paths";

describe("git-paths", () => {
  it("resolves a relative hooks dir returned by git", () => {
    const resolved = resolveGitHooksDir("/tmp/repo", () => ".git/worktrees/feature/hooks");
    expect(resolved).toBe("/tmp/repo/.git/worktrees/feature/hooks");
  });

  it("preserves an absolute hooks dir returned by git", () => {
    const resolved = resolveGitHooksDir("/tmp/repo", () => "/var/tmp/repo-hooks");
    expect(resolved).toBe("/var/tmp/repo-hooks");
  });

  it("falls back to the default .git/hooks path when git lookup fails", () => {
    const resolved = resolveGitHooksDir("/tmp/repo", () => null);
    expect(resolved).toBe("/tmp/repo/.git/hooks");
  });
});
