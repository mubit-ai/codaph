// File freshness — the guard that keeps Codaph from short-circuiting a tool with
// STALE memory. A cached summary / "where is X" answer is only safe to serve if
// the underlying file hasn't changed since the memory was captured. The strong
// signal is a content hash (byte-identical → memory still true); mtime is a
// softer fallback; for searches (Grep/Glob), git HEAD is a coarse staleness key.
//
// IO (statSync/readFileSync/git) lives here; the comparison (`isFresh`) is pure
// so it is trivially unit-testable.
import { statSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Files larger than this aren't hashed in full (cost); we fall back to a
// size+mtime signature, which still changes on any edit that changes length or
// touch time — weaker than a content hash but adequate to invalidate memory.
const MAX_HASH_BYTES = 4_000_000;

export interface FileFreshness {
  exists: boolean;
  mtimeMs: number; // 0 when absent
  contentHash: string | null; // sha1 hex of bytes, or "size:…:mtime:…" for huge files, null when absent
  size: number;
}

// A captured stamp stored alongside a memory item, recorded at capture time and
// compared against the live file at serve time.
export interface FreshnessStamp {
  contentHash?: string | null;
  mtimeMs?: number | null;
}

/** Read the live freshness of a file. Never throws — absent/unreadable → exists:false. */
export function fileFreshness(filePath: string): FileFreshness {
  try {
    const st = statSync(filePath);
    if (!st.isFile()) {
      return { exists: false, mtimeMs: 0, contentHash: null, size: 0 };
    }
    let contentHash: string;
    if (st.size <= MAX_HASH_BYTES) {
      contentHash = createHash("sha1").update(readFileSync(filePath)).digest("hex");
    } else {
      contentHash = `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`;
    }
    return { exists: true, mtimeMs: st.mtimeMs, contentHash, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, contentHash: null, size: 0 };
  }
}

/** Build a stamp to store with a memory item captured against `filePath`. */
export function freshnessStamp(filePath: string): FreshnessStamp {
  const f = fileFreshness(filePath);
  return { contentHash: f.contentHash, mtimeMs: f.mtimeMs };
}

/**
 * Pure: is memory captured against `stored` still fresh for the live `current`?
 *   - file gone        → not fresh (can't answer about a deleted file)
 *   - no stamp         → not fresh (we don't know what it was captured against)
 *   - both hashes      → fresh iff byte-identical (the strong signal)
 *   - mtime fallback   → fresh iff the file is no NEWER than when captured
 *   - no usable signal → conservatively stale
 */
export function isFresh(stored: FreshnessStamp | null | undefined, current: FileFreshness): boolean {
  if (!current.exists) {
    return false;
  }
  if (!stored) {
    return false;
  }
  if (stored.contentHash && current.contentHash) {
    return stored.contentHash === current.contentHash;
  }
  if (typeof stored.mtimeMs === "number" && stored.mtimeMs > 0 && current.mtimeMs > 0) {
    return current.mtimeMs <= stored.mtimeMs;
  }
  return false;
}

/**
 * Coarse staleness key for searches (Grep/Glob): the repo's HEAD commit sha.
 * Any commit invalidates search memory — coarse, but safe (never serves a stale
 * "where does X appear" across a code change). Returns null outside a git repo.
 */
export function gitHeadSha(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
