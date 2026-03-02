import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  createProjectRootMatcher,
  createProjectRootsKey,
  normalizeProjectRoots,
  pathIsOwnedByProjectRoots,
} from "../src/lib/project-roots";

describe("project-roots", () => {
  it("normalizes and deduplicates project roots", () => {
    const base = resolve("/tmp/codaph-project-roots");
    const roots = normalizeProjectRoots(join(base, "repo"), [
      join(base, "repo"),
      join(base, "repo-wt"),
      join(base, "repo-wt"),
    ]);

    expect(roots).toEqual([join(base, "repo"), join(base, "repo-wt")]);
  });

  it("matches owned paths and rejects prefix collisions", () => {
    const projectRoot = resolve("/tmp/codaph-owned/repo");
    const siblingRoot = resolve("/tmp/codaph-owned/repo-wt");
    const roots = [projectRoot, siblingRoot];

    expect(pathIsOwnedByProjectRoots(projectRoot, roots)).toBe(true);
    expect(pathIsOwnedByProjectRoots(join(projectRoot, "src", "index.ts"), roots)).toBe(true);
    expect(pathIsOwnedByProjectRoots(join(siblingRoot, "apps", "api"), roots)).toBe(true);
    expect(pathIsOwnedByProjectRoots(resolve("/tmp/codaph-owned/repo2"), roots)).toBe(false);
  });

  it("creates a stable roots key regardless of input order", () => {
    const base = resolve("/tmp/codaph-project-key");
    const a = join(base, "repo");
    const b = join(base, "repo-wt");

    const keyOne = createProjectRootsKey([a, b]);
    const keyTwo = createProjectRootsKey([b, a, b]);

    expect(keyOne).toBe(keyTwo);
  });

  it("builds a matcher that owns all configured roots", () => {
    const base = resolve("/tmp/codaph-matcher");
    const matcher = createProjectRootMatcher(join(base, "repo"), [join(base, "repo-wt")]);

    expect(matcher.ownsPath(join(base, "repo", "nested"))).toBe(true);
    expect(matcher.ownsPath(join(base, "repo-wt", "nested"))).toBe(true);
    expect(matcher.ownsPath(join(base, "repo2"))).toBe(false);
    expect(matcher.projectRoots.length).toBe(2);
    expect(typeof matcher.projectRootsKey).toBe("string");
  });
});
