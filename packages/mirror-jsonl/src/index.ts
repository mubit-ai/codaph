import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedEventEnvelope, MirrorAppendResult, MirrorAppender } from "@codaph/core-types";

export interface SegmentMeta {
  id: string;
  relativePath: string;
  from: string;
  to: string;
  eventCount: number;
}

export interface RepoManifest {
  repoId: string;
  segments: Record<string, SegmentMeta>;
}

export interface SparseSessionIndex {
  from: string;
  to: string;
  eventCount: number;
  segments: string[];
  threads: string[];
}

export interface SparseThreadIndex {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  segments: string[];
}

export interface SparseIndex {
  repoId: string;
  sessions: Record<string, SparseSessionIndex>;
  threads: Record<string, SparseThreadIndex>;
}

export function getIndexPaths(rootDir: string, repoId: string): {
  manifestPath: string;
  sparsePath: string;
} {
  const base = join(rootDir, "index", repoId);
  return {
    manifestPath: join(base, "manifest.json"),
    sparsePath: join(base, "sparse-index.json"),
  };
}

function getDateParts(ts: string): { yyyy: string; mm: string; dd: string; segmentId: string } {
  const d = new Date(ts);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { yyyy, mm, dd, segmentId: `${yyyy}${mm}${dd}` };
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function readManifest(rootDir: string, repoId: string): Promise<RepoManifest> {
  const { manifestPath } = getIndexPaths(rootDir, repoId);
  return readJsonOrDefault<RepoManifest>(manifestPath, { repoId, segments: {} });
}

export async function readSparseIndex(rootDir: string, repoId: string): Promise<SparseIndex> {
  const { sparsePath } = getIndexPaths(rootDir, repoId);
  return readJsonOrDefault<SparseIndex>(sparsePath, { repoId, sessions: {}, threads: {} });
}

export async function readEventsFromSegments(
  rootDir: string,
  segmentPaths: string[],
): Promise<CapturedEventEnvelope[]> {
  const events: CapturedEventEnvelope[] = [];
  for (const rel of segmentPaths) {
    const abs = join(rootDir, rel);
    let raw = "";
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as CapturedEventEnvelope);
      } catch {
        // ignore bad line for now
      }
    }
  }
  return events;
}

export class JsonlMirror implements MirrorAppender {
  constructor(private readonly rootDir: string = ".codaph") {}

  async appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult> {
    const { yyyy, mm, dd, segmentId } = getDateParts(event.ts);
    const relativePath = join(
      "events",
      event.repoId,
      yyyy,
      mm,
      dd,
      `segment-${segmentId}.jsonl`,
    );
    const abs = join(this.rootDir, relativePath);
    await mkdir(dirname(abs), { recursive: true });

    const line = JSON.stringify(event);
    await appendFile(abs, `${line}\n`, "utf8");

    const manifest = await readManifest(this.rootDir, event.repoId);
    const sparse = await readSparseIndex(this.rootDir, event.repoId);

    const currentSegment = manifest.segments[segmentId] ?? {
      id: segmentId,
      relativePath,
      from: event.ts,
      to: event.ts,
      eventCount: 0,
    };

    currentSegment.eventCount += 1;
    if (event.ts < currentSegment.from) {
      currentSegment.from = event.ts;
    }
    if (event.ts > currentSegment.to) {
      currentSegment.to = event.ts;
    }
    manifest.segments[segmentId] = currentSegment;

    const session = sparse.sessions[event.sessionId] ?? {
      from: event.ts,
      to: event.ts,
      eventCount: 0,
      segments: [],
      threads: [],
    };
    session.eventCount += 1;
    if (event.ts < session.from) {
      session.from = event.ts;
    }
    if (event.ts > session.to) {
      session.to = event.ts;
    }
    if (!session.segments.includes(relativePath)) {
      session.segments.push(relativePath);
    }
    if (event.threadId && !session.threads.includes(event.threadId)) {
      session.threads.push(event.threadId);
    }
    sparse.sessions[event.sessionId] = session;

    if (event.threadId) {
      const thread = sparse.threads[event.threadId] ?? {
        sessionId: event.sessionId,
        from: event.ts,
        to: event.ts,
        eventCount: 0,
        segments: [],
      };
      thread.eventCount += 1;
      if (event.ts < thread.from) {
        thread.from = event.ts;
      }
      if (event.ts > thread.to) {
        thread.to = event.ts;
      }
      if (!thread.segments.includes(relativePath)) {
        thread.segments.push(relativePath);
      }
      sparse.threads[event.threadId] = thread;
    }

    const { manifestPath, sparsePath } = getIndexPaths(this.rootDir, event.repoId);
    await writeJson(manifestPath, manifest);
    await writeJson(sparsePath, sparse);

    return {
      segment: relativePath,
      offset: currentSegment.eventCount,
      checksum: createHash("sha256").update(line).digest("hex").slice(0, 16),
    };
  }

  async appendRawLine(sessionId: string, line: string): Promise<void> {
    const path = join(this.rootDir, "runs", sessionId, "raw-codex.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  }
}
