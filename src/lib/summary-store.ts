// Local per-repo cache of file summaries, keyed by path and stamped with the
// file's content hash + mtime. This is what makes the PreToolUse Read offload
// real: the first Read of a file caches a compact summary; a later Read of the
// SAME unchanged file (this session or a future one on this checkout) serves the
// summary instead of letting the file's bulk re-enter context — and, because the
// hash matches, marks the target FRESH so shortcircuit mode may skip the read.
//
// One small JSON file per path (keyed by a hash of the path) so concurrent
// PreToolUse hooks never race on a shared file. All IO is best-effort: a miss or
// write failure just means a re-query, never a thrown hook.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FreshnessStamp } from "./file-freshness";

export interface StoredSummary extends FreshnessStamp {
  path: string;
  contentHash: string | null;
  mtimeMs: number;
  summary: string;
  confidence: number | null;
  referenceId?: string | null; // Mubit archive ref, when mirrored for cross-contributor reuse
  updatedAt: string;
}

function storeDir(mirrorRoot: string): string {
  return join(mirrorRoot, "summary-store");
}

function entryPath(mirrorRoot: string, filePath: string): string {
  const key = createHash("sha1").update(filePath).digest("hex").slice(0, 16);
  return join(storeDir(mirrorRoot), `${key}.json`);
}

/** Read a cached summary for `filePath`, or null when absent/unreadable. */
export function getStoredSummary(mirrorRoot: string, filePath: string): StoredSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(entryPath(mirrorRoot, filePath), "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { summary?: unknown }).summary === "string" &&
      typeof (parsed as { path?: unknown }).path === "string"
    ) {
      return parsed as StoredSummary;
    }
  } catch {
    // miss / malformed → treat as no cache
  }
  return null;
}

/** Cache a summary for `path`, stamping it with the supplied freshness. */
export function putStoredSummary(
  mirrorRoot: string,
  entry: { path: string; contentHash: string | null; mtimeMs: number; summary: string; confidence: number | null; referenceId?: string | null },
): void {
  try {
    mkdirSync(storeDir(mirrorRoot), { recursive: true });
    const full: StoredSummary = { ...entry, updatedAt: new Date().toISOString() };
    writeFileSync(entryPath(mirrorRoot, entry.path), JSON.stringify(full), "utf8");
  } catch {
    // best-effort: a failed write just means we re-query next time
  }
}
