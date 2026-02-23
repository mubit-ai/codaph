import type { CapturedEventEnvelope, TimelineFilter } from "./core-types";
import { extractFileDiffs, type FileDiffSummary } from "./diff-engine";
import {
  readEventsFromSegments,
  readManifest,
  readSparseIndex,
  type SparseActorIndex,
  type SparseSessionIndex,
} from "./mirror-jsonl";

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
  constructor(private readonly rootDir: string = ".codaph") {}

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

    const events = await readEventsFromSegments(this.rootDir, segments);
    // TODO(MUBIT): merge semantic context from MuBit query results here.
    return filterEvents(events, filter);
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
