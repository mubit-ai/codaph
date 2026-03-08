import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SessionArtifactState {
  to: string;
  eventCount: number;
  artifactEventCount: number;
  publishedAt: string;
}

export interface ArtifactPublicationState {
  version: number;
  sessions: Record<string, SessionArtifactState>;
}

export interface ArtifactSessionSnapshot {
  sessionId: string;
  to: string;
  eventCount: number;
}

const ARTIFACT_PUBLICATION_STATE_VERSION = 1;

function defaultArtifactPublicationState(): ArtifactPublicationState {
  return {
    version: ARTIFACT_PUBLICATION_STATE_VERSION,
    sessions: {},
  };
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function getArtifactPublicationStatePath(mirrorRoot: string, repoId: string): string {
  return join(mirrorRoot, "index", repoId, "artifact-publication-state.json");
}

export async function readArtifactPublicationState(path: string): Promise<ArtifactPublicationState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record || asFiniteNumber(record.version) !== ARTIFACT_PUBLICATION_STATE_VERSION) {
      return defaultArtifactPublicationState();
    }
    const sessionsRaw = asRecord(record.sessions) ?? {};
    const sessions: Record<string, SessionArtifactState> = {};
    for (const [sessionId, rawSession] of Object.entries(sessionsRaw)) {
      const session = asRecord(rawSession);
      const to = asString(session?.to);
      const eventCount = asFiniteNumber(session?.eventCount);
      const artifactEventCount = asFiniteNumber(session?.artifactEventCount);
      const publishedAt = asString(session?.publishedAt);
      if (!to || eventCount == null || artifactEventCount == null || !publishedAt) {
        continue;
      }
      sessions[sessionId] = {
        to,
        eventCount,
        artifactEventCount,
        publishedAt,
      };
    }
    return {
      version: ARTIFACT_PUBLICATION_STATE_VERSION,
      sessions,
    };
  } catch {
    return defaultArtifactPublicationState();
  }
}

export async function writeArtifactPublicationState(path: string, state: ArtifactPublicationState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function shouldRepublishSessionArtifacts(
  state: ArtifactPublicationState,
  session: ArtifactSessionSnapshot,
): boolean {
  const existing = state.sessions[session.sessionId];
  if (!existing) {
    return true;
  }
  return existing.to !== session.to || existing.eventCount !== session.eventCount;
}
