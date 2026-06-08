import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFreshness, freshnessStamp, isFresh, gitHeadSha } from "../src/lib/file-freshness";

const dir = mkdtempSync(join(tmpdir(), "codaph-fresh-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fileFreshness", () => {
  it("hashes an existing file and reports absence for a missing one", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "hello world");
    const f = fileFreshness(p);
    expect(f.exists).toBe(true);
    expect(f.size).toBe(11);
    expect(f.contentHash).toMatch(/^[0-9a-f]{40}$/); // sha1 hex
    expect(f.mtimeMs).toBeGreaterThan(0);

    const missing = fileFreshness(join(dir, "nope.txt"));
    expect(missing.exists).toBe(false);
    expect(missing.contentHash).toBeNull();
  });

  it("hash changes when content changes", () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, "v1");
    const h1 = fileFreshness(p).contentHash;
    writeFileSync(p, "v2-different");
    const h2 = fileFreshness(p).contentHash;
    expect(h1).not.toBe(h2);
  });
});

describe("isFresh", () => {
  it("is fresh when content hash matches, stale when it differs", () => {
    const p = join(dir, "c.txt");
    writeFileSync(p, "original");
    const stamp = freshnessStamp(p);
    expect(isFresh(stamp, fileFreshness(p))).toBe(true);

    writeFileSync(p, "edited content");
    expect(isFresh(stamp, fileFreshness(p))).toBe(false);
  });

  it("is never fresh for a missing file or a missing stamp", () => {
    const gone = fileFreshness(join(dir, "ghost.txt"));
    expect(isFresh({ contentHash: "abc" }, gone)).toBe(false);
    const p = join(dir, "d.txt");
    writeFileSync(p, "x");
    expect(isFresh(null, fileFreshness(p))).toBe(false);
    expect(isFresh(undefined, fileFreshness(p))).toBe(false);
  });

  it("falls back to mtime when a hash is unavailable: stale if the file is newer", () => {
    const current = { exists: true, mtimeMs: 2000, contentHash: null, size: 1 };
    expect(isFresh({ mtimeMs: 2000 }, current)).toBe(true); // not newer
    expect(isFresh({ mtimeMs: 2500 }, current)).toBe(true); // older capture? current is older → fresh
    expect(isFresh({ mtimeMs: 1500 }, current)).toBe(false); // current newer than capture → stale
  });

  it("is conservatively stale with no usable signal", () => {
    const current = { exists: true, mtimeMs: 0, contentHash: null, size: 0 };
    expect(isFresh({ contentHash: null, mtimeMs: null }, current)).toBe(false);
  });
});

describe("gitHeadSha", () => {
  it("returns a sha inside this repo and null outside a repo", () => {
    const sha = gitHeadSha(process.cwd());
    expect(sha === null || /^[0-9a-f]{7,40}$/.test(sha)).toBe(true); // a sha or null (CI shallow/no-git)
    expect(gitHeadSha(dir)).toBeNull(); // tmp dir is not a git repo
  });
});
