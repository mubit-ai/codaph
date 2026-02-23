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
  actors: string[];
}

export interface SparseThreadIndex {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  segments: string[];
}

export interface SparseActorIndex {
  from: string;
  to: string;
  eventCount: number;
  sessions: string[];
  segments: string[];
}

export interface SparseIndex {
  repoId: string;
  sessions: Record<string, SparseSessionIndex>;
  threads: Record<string, SparseThreadIndex>;
  actors: Record<string, SparseActorIndex>;
}

export interface EventIdIndexEntry {
  segment: string;
  ts: string;
  sessionId: string;
  actorId: string | null;
}

export interface EventIdIndex {
  repoId: string;
  events: Record<string, EventIdIndexEntry>;
}

export function getIndexPaths(rootDir: string, repoId: string): {
  manifestPath: string;
  sparsePath: string;
  eventIdsPath: string;
} {
  const base = join(rootDir, "index", repoId);
  return {
    manifestPath: join(base, "manifest.json"),
    sparsePath: join(base, "sparse-index.json"),
    eventIdsPath: join(base, "event-ids.json"),
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
  return readJsonOrDefault<SparseIndex>(sparsePath, { repoId, sessions: {}, threads: {}, actors: {} });
}

export async function readEventIdIndex(rootDir: string, repoId: string): Promise<EventIdIndex> {
  const { eventIdsPath } = getIndexPaths(rootDir, repoId);
  return readJsonOrDefault<EventIdIndex>(eventIdsPath, { repoId, events: {} });
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
    const eventIds = await readEventIdIndex(this.rootDir, event.repoId);

    const existing = eventIds.events[event.eventId];
    if (existing) {
      return {
        segment: existing.segment,
        offset: 0,
        checksum: createHash("sha256").update(event.eventId).digest("hex").slice(0, 16),
        deduplicated: true,
      };
    }

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

    const rawSession = sparse.sessions[event.sessionId];
    const session = rawSession ?? {
      from: event.ts,
      to: event.ts,
      eventCount: 0,
      segments: [],
      threads: [],
      actors: [],
    };
    if (!Array.isArray(session.actors)) {
      session.actors = [];
    }
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
    if (event.actorId && !session.actors.includes(event.actorId)) {
      session.actors.push(event.actorId);
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

    if (event.actorId) {
      const actor = sparse.actors[event.actorId] ?? {
        from: event.ts,
        to: event.ts,
        eventCount: 0,
        sessions: [],
        segments: [],
      };
      actor.eventCount += 1;
      if (event.ts < actor.from) {
        actor.from = event.ts;
      }
      if (event.ts > actor.to) {
        actor.to = event.ts;
      }
      if (!actor.sessions.includes(event.sessionId)) {
        actor.sessions.push(event.sessionId);
      }
      if (!actor.segments.includes(relativePath)) {
        actor.segments.push(relativePath);
      }
      sparse.actors[event.actorId] = actor;
    }

    eventIds.events[event.eventId] = {
      segment: relativePath,
      ts: event.ts,
      sessionId: event.sessionId,
      actorId: event.actorId ?? null,
    };

    const { manifestPath, sparsePath, eventIdsPath } = getIndexPaths(this.rootDir, event.repoId);
    await writeJson(manifestPath, manifest);
    await writeJson(sparsePath, sparse);
    await writeJson(eventIdsPath, eventIds);

    return {
      segment: relativePath,
      offset: currentSegment.eventCount,
      checksum: createHash("sha256").update(line).digest("hex").slice(0, 16),
      deduplicated: false,
    };
  }

  async appendRawLine(sessionId: string, line: string): Promise<void> {
    const path = join(this.rootDir, "runs", sessionId, "raw-codex.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${line}\n`, "utf8");
  }
}
