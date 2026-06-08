import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoredSummary, putStoredSummary } from "../src/lib/summary-store";
import { fileFreshness, isFresh } from "../src/lib/file-freshness";

const mirror = mkdtempSync(join(tmpdir(), "codaph-sumstore-"));
afterAll(() => rmSync(mirror, { recursive: true, force: true }));

describe("summary-store", () => {
  it("round-trips a stored summary and returns null for an unknown path", () => {
    expect(getStoredSummary(mirror, "src/unknown.ts")).toBeNull();
    putStoredSummary(mirror, {
      path: "src/foo.ts",
      contentHash: "abc123",
      mtimeMs: 1000,
      summary: "foo owns the circuit",
      confidence: 0.8,
    });
    const got = getStoredSummary(mirror, "src/foo.ts");
    expect(got?.summary).toBe("foo owns the circuit");
    expect(got?.contentHash).toBe("abc123");
    expect(got?.confidence).toBe(0.8);
    expect(typeof got?.updatedAt).toBe("string");
  });

  it("a cached summary is fresh until the file changes (end-to-end with freshness)", () => {
    const file = join(mirror, "tracked.ts");
    writeFileSync(file, "export const x = 1;");
    const stamp = fileFreshness(file);
    putStoredSummary(mirror, {
      path: file,
      contentHash: stamp.contentHash,
      mtimeMs: stamp.mtimeMs,
      summary: "declares x",
      confidence: 0.9,
    });

    // Unchanged → cached summary is fresh (offload-eligible).
    expect(isFresh(getStoredSummary(mirror, file), fileFreshness(file))).toBe(true);

    // Edit the file → the stored stamp no longer matches → stale.
    writeFileSync(file, "export const x = 2; // changed");
    expect(isFresh(getStoredSummary(mirror, file), fileFreshness(file))).toBe(false);
  });
});
