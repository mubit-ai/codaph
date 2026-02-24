import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface PendingSyncTriggerState {
  pending: boolean;
  source: string | null;
  ts: string | null;
}

export interface MubitRemoteSyncState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastTriggerSource: string | null;
  requestedTimelineLimit: number | null;
  receivedTimelineCount: number | null;
  lastImported: number | null;
  lastDeduplicated: number | null;
  lastSkipped: number | null;
  lastMaxTs: string | null;
  lastSnapshotFingerprint: string | null;
  consecutiveSameSnapshotCount: number;
  suspectedServerCap: boolean;
  lastError: string | null;
  pendingTrigger: PendingSyncTriggerState;
}

const DEFAULT_REMOTE_SYNC_STATE: MubitRemoteSyncState = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastTriggerSource: null,
  requestedTimelineLimit: null,
  receivedTimelineCount: null,
  lastImported: null,
  lastDeduplicated: null,
  lastSkipped: null,
  lastMaxTs: null,
  lastSnapshotFingerprint: null,
  consecutiveSameSnapshotCount: 0,
  suspectedServerCap: false,
  lastError: null,
  pendingTrigger: {
    pending: false,
    source: null,
    ts: null,
  },
};

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

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function getMubitRemoteSyncStatePath(mirrorRoot: string, repoId: string): string {
  return join(mirrorRoot, "index", repoId, "mubit-remote-sync-state.json");
}

export async function readMubitRemoteSyncState(path: string): Promise<MubitRemoteSyncState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return { ...DEFAULT_REMOTE_SYNC_STATE };
    }
    const pendingRaw = asRecord(record.pendingTrigger);
    return {
      lastRunAt: asString(record.lastRunAt),
      lastSuccessAt: asString(record.lastSuccessAt),
      lastTriggerSource: asString(record.lastTriggerSource),
      requestedTimelineLimit: asFiniteNumber(record.requestedTimelineLimit),
      receivedTimelineCount: asFiniteNumber(record.receivedTimelineCount),
      lastImported: asFiniteNumber(record.lastImported),
      lastDeduplicated: asFiniteNumber(record.lastDeduplicated),
      lastSkipped: asFiniteNumber(record.lastSkipped),
      lastMaxTs: asString(record.lastMaxTs),
      lastSnapshotFingerprint: asString(record.lastSnapshotFingerprint),
      consecutiveSameSnapshotCount: Math.max(0, Math.floor(asFiniteNumber(record.consecutiveSameSnapshotCount) ?? 0)),
      suspectedServerCap: asBoolean(record.suspectedServerCap, false),
      lastError: asString(record.lastError),
      pendingTrigger: {
        pending: asBoolean(pendingRaw?.pending, false),
        source: asString(pendingRaw?.source),
        ts: asString(pendingRaw?.ts),
      },
    };
  } catch {
    return { ...DEFAULT_REMOTE_SYNC_STATE };
  }
}

export async function writeMubitRemoteSyncState(path: string, state: MubitRemoteSyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function defaultMubitRemoteSyncState(): MubitRemoteSyncState {
  return {
    ...DEFAULT_REMOTE_SYNC_STATE,
    pendingTrigger: { ...DEFAULT_REMOTE_SYNC_STATE.pendingTrigger },
  };
}
