import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapturedEventEnvelope, MirrorAppendResult, MirrorAppender } from "./core-types";

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

type IndexWriteMode = "immediate" | "batch";

interface RepoIndexCacheEntry {
  manifest: RepoManifest;
  sparse: SparseIndex;
  eventIds: EventIdIndex;
  paths: ReturnType<typeof getIndexPaths>;
  dirty: boolean;
  dirtyEventCount: number;
}

interface BufferedTextAppend {
  chunks: string[];
  bytes: number;
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
  private readonly indexWriteMode: IndexWriteMode;
  private readonly autoFlushEveryEvents: number;
  private readonly repoIndexCache = new Map<string, RepoIndexCacheEntry>();
  private readonly ensuredDirs = new Set<string>();
  private readonly segmentBuffers = new Map<string, BufferedTextAppend>();
  private readonly rawLineBuffers = new Map<string, BufferedTextAppend>();
  private readonly bufferFlushBytes = 256 * 1024;

  constructor(
    private readonly rootDir: string = ".codaph",
    options: {
      indexWriteMode?: IndexWriteMode;
      autoFlushEveryEvents?: number;
    } = {},
  ) {
    this.indexWriteMode = options.indexWriteMode ?? "immediate";
    const rawEvery = options.autoFlushEveryEvents ?? 50;
    this.autoFlushEveryEvents =
      Number.isFinite(rawEvery) && Math.trunc(rawEvery) > 0 ? Math.trunc(rawEvery) : 0;
  }

  private async ensureDir(path: string): Promise<void> {
    if (this.ensuredDirs.has(path)) {
      return;
    }
    await mkdir(path, { recursive: true });
    this.ensuredDirs.add(path);
  }

  private async appendBuffered(
    bufferMap: Map<string, BufferedTextAppend>,
    absPath: string,
    text: string,
  ): Promise<void> {
    const entry = bufferMap.get(absPath) ?? { chunks: [], bytes: 0 };
    entry.chunks.push(text);
    entry.bytes += Buffer.byteLength(text, "utf8");
    bufferMap.set(absPath, entry);

    if (entry.bytes >= this.bufferFlushBytes) {
      await appendFile(absPath, entry.chunks.join(""), "utf8");
      entry.chunks = [];
      entry.bytes = 0;
    }
  }

  private async flushBufferedMap(bufferMap: Map<string, BufferedTextAppend>): Promise<void> {
    for (const [absPath, entry] of bufferMap.entries()) {
      if (entry.chunks.length === 0) {
        continue;
      }
      await appendFile(absPath, entry.chunks.join(""), "utf8");
      entry.chunks = [];
      entry.bytes = 0;
    }
  }

  private async loadRepoIndexCache(repoId: string): Promise<RepoIndexCacheEntry> {
    const existing = this.repoIndexCache.get(repoId);
    if (existing) {
      return existing;
    }

    const [manifest, sparse, eventIds] = await Promise.all([
      readManifest(this.rootDir, repoId),
      readSparseIndex(this.rootDir, repoId),
      readEventIdIndex(this.rootDir, repoId),
    ]);
    const entry: RepoIndexCacheEntry = {
      manifest,
      sparse,
      eventIds,
      paths: getIndexPaths(this.rootDir, repoId),
      dirty: false,
      dirtyEventCount: 0,
    };
    this.repoIndexCache.set(repoId, entry);
    return entry;
  }

  private async flushRepoIndexCache(repoId: string): Promise<void> {
    const entry = this.repoIndexCache.get(repoId);
    if (!entry || !entry.dirty) {
      return;
    }

    await Promise.all([
      writeJson(entry.paths.manifestPath, entry.manifest),
      writeJson(entry.paths.sparsePath, entry.sparse),
      writeJson(entry.paths.eventIdsPath, entry.eventIds),
    ]);
    entry.dirty = false;
    entry.dirtyEventCount = 0;
  }

  async flush(): Promise<void> {
    await this.flushBufferedMap(this.segmentBuffers);
    await this.flushBufferedMap(this.rawLineBuffers);
    for (const repoId of this.repoIndexCache.keys()) {
      await this.flushRepoIndexCache(repoId);
    }
  }

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
    await this.ensureDir(dirname(abs));

    const cache = await this.loadRepoIndexCache(event.repoId);
    const manifest = cache.manifest;
    const sparse = cache.sparse;
    const eventIds = cache.eventIds;

    const existing = eventIds.events[event.eventId];
    if (existing) {
      return {
        segment: existing.segment,
        offset: 0,
        checksum: createHash("sha256").update(event.eventId).digest("hex").slice(0, 16),
        deduplicated: true,
      };
    }

    const line = JSON.stringify(event);
    if (this.indexWriteMode === "batch") {
      await this.appendBuffered(this.segmentBuffers, abs, `${line}\n`);
    } else {
      await appendFile(abs, `${line}\n`, "utf8");
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

    cache.dirty = true;
    cache.dirtyEventCount += 1;
    if (
      this.indexWriteMode === "immediate" ||
      (this.autoFlushEveryEvents > 0 && cache.dirtyEventCount >= this.autoFlushEveryEvents)
    ) {
      await this.flushRepoIndexCache(event.repoId);
    }

    return {
      segment: relativePath,
      offset: currentSegment.eventCount,
      checksum: createHash("sha256").update(line).digest("hex").slice(0, 16),
      deduplicated: false,
    };
  }

  async appendRawLine(sessionId: string, line: string): Promise<void> {
    const path = join(this.rootDir, "runs", sessionId, "raw-codex.ndjson");
    await this.ensureDir(dirname(path));
    if (this.indexWriteMode === "batch") {
      await this.appendBuffered(this.rawLineBuffers, path, `${line}\n`);
      return;
    }
    await appendFile(path, `${line}\n`, "utf8");
  }
}
