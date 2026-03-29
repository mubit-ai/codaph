import type { CapturedEventEnvelope, TimelineFilter } from "./core-types";
import { extractFileDiffs, type FileDiffSummary } from "./diff-engine";
import {
  readEventsFromSegments,
  readManifest,
  readSparseIndex,
  type SparseActorIndex,
  type SparseSessionIndex,
} from "./mirror-jsonl";
import type { MubitMemoryEngine } from "./memory-mubit";

export interface SessionSummary {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  threadCount: number;
}

export interface ContributorSummary {
  actorId: string;
  from: string;
  to: string;
  eventCount: number;
  sessionCount: number;
}

function extractSemanticEventIds(result: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const entries = result.entries ?? result.results ?? result.items ?? [];
  if (!Array.isArray(entries)) return ids;
  for (const entry of entries) {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    if (!record) continue;
    const outputRef = record.output_ref ?? record.eventId ?? record.event_id;
    if (typeof outputRef === "string" && outputRef.length > 0) {
      ids.add(outputRef);
    }
    // Also check nested payload for eventId
    const payload = record.payload;
    if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const nestedId = parsed.eventId ?? parsed.event_id;
        if (typeof nestedId === "string" && nestedId.length > 0) ids.add(nestedId);
      } catch { /* ignore parse errors */ }
    } else if (typeof payload === "object" && payload !== null) {
      const p = payload as Record<string, unknown>;
      const nestedId = p.eventId ?? p.event_id;
      if (typeof nestedId === "string" && nestedId.length > 0) ids.add(nestedId);
    }
  }
  return ids;
}

function filterEvents(events: CapturedEventEnvelope[], filter: TimelineFilter): CapturedEventEnvelope[] {
  return events
    .filter((event) => {
      if (filter.sessionId && event.sessionId !== filter.sessionId) {
        return false;
      }
      if (filter.threadId && event.threadId !== filter.threadId) {
        return false;
      }
      if (filter.actorId && event.actorId !== filter.actorId) {
        return false;
      }
      if (filter.from && event.ts < filter.from) {
        return false;
      }
      if (filter.to && event.ts > filter.to) {
        return false;
      }
      if (filter.itemType) {
        const itemType = (event.payload.item as { type?: string } | undefined)?.type;
        if (itemType !== filter.itemType) {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

export class QueryService {
  constructor(
    private readonly rootDir: string = ".codaph",
    private readonly mubitEngine?: MubitMemoryEngine | null,
  ) {}

  async listSessions(repoId: string): Promise<SessionSummary[]> {
    const sparse = await readSparseIndex(this.rootDir, repoId);
    const out: SessionSummary[] = Object.entries(sparse.sessions).map(([sessionId, data]: [string, SparseSessionIndex]) => ({
      sessionId,
      from: data.from,
      to: data.to,
      eventCount: data.eventCount,
      threadCount: data.threads.length,
    }));

    // Show sessions by last activity time so long-running sessions stay visible.
    return out.sort((a, b) => b.to.localeCompare(a.to));
  }

  async listContributors(repoId: string, sessionId?: string): Promise<ContributorSummary[]> {
    const sparse = await readSparseIndex(this.rootDir, repoId);
    const out: ContributorSummary[] = [];
    const actors = sparse.actors ?? {};

    for (const [actorId, data] of Object.entries(actors)) {
      const actor = data as SparseActorIndex;
      if (sessionId && !(actor.sessions ?? []).includes(sessionId)) {
        continue;
      }
      out.push({
        actorId,
        from: actor.from,
        to: actor.to,
        eventCount: actor.eventCount,
        sessionCount: (actor.sessions ?? []).length,
      });
    }

    return out.sort((a, b) => {
      if (a.eventCount !== b.eventCount) {
        return b.eventCount - a.eventCount;
      }
      return b.to.localeCompare(a.to);
    });
  }

  async getTimeline(filter: TimelineFilter): Promise<CapturedEventEnvelope[]> {
    const sparse = await readSparseIndex(this.rootDir, filter.repoId);
    const manifest = await readManifest(this.rootDir, filter.repoId);

    let segments: string[] = [];
    if (filter.sessionId && sparse.sessions[filter.sessionId]) {
      segments = sparse.sessions[filter.sessionId].segments;
    } else if (filter.threadId && sparse.threads[filter.threadId]) {
      segments = sparse.threads[filter.threadId].segments;
    } else {
      segments = Object.values(manifest.segments).map((seg) => seg.relativePath);
    }

    const localEvents = await readEventsFromSegments(this.rootDir, segments);
    const filtered = filterEvents(localEvents, filter);

    if (!filter.semanticQuery || !this.mubitEngine?.isEnabled()) {
      return filtered;
    }

    return this.mergeSemanticResults(filtered, filter);
  }

  private async mergeSemanticResults(
    localEvents: CapturedEventEnvelope[],
    filter: TimelineFilter,
  ): Promise<CapturedEventEnvelope[]> {
    if (!this.mubitEngine || !filter.semanticQuery) {
      return localEvents;
    }

    try {
      const runId = this.mubitEngine.runIdForSession(filter.repoId, filter.sessionId ?? "");
      const result = await this.mubitEngine.querySemanticContext({
        runId,
        query: filter.semanticQuery,
        limit: 20,
        includeLinkedRuns: true,
        rankBy: "relevance",
      });

      if (result.disabled === true || result.unsupported === true) {
        return localEvents;
      }

      const semanticEventIds = extractSemanticEventIds(result);
      if (semanticEventIds.size === 0) {
        return localEvents;
      }

      // Enrich local events with relevance scores
      const enriched = localEvents.map((event) => {
        if (semanticEventIds.has(event.eventId)) {
          return { ...event, _semanticMatch: true } as CapturedEventEnvelope;
        }
        return event;
      });

      // Sort: semantic matches first, then chronological
      return enriched.sort((a, b) => {
        const aMatch = (a as CapturedEventEnvelope & { _semanticMatch?: boolean })._semanticMatch ? 1 : 0;
        const bMatch = (b as CapturedEventEnvelope & { _semanticMatch?: boolean })._semanticMatch ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return a.ts.localeCompare(b.ts);
      });
    } catch {
      // Fail open: return local events if semantic query fails
      return localEvents;
    }
  }

  async *getTimelineStream(filter: TimelineFilter): AsyncGenerator<CapturedEventEnvelope> {
    const events = await this.getTimeline(filter);
    for (const event of events) {
      yield event;
    }
  }

  async getDiffSummary(
    repoId: string,
    sessionId: string,
    pathFilter?: string,
  ): Promise<FileDiffSummary[]> {
    const events = await this.getTimeline({ repoId, sessionId });
    return extractFileDiffs(events, pathFilter);
  }
}
