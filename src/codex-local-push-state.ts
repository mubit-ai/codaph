import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CodexLocalPushState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastTriggerSource: string | null;
  lastScannedFiles: number | null;
  lastMatchedFiles: number | null;
  lastImportedEvents: number | null;
  lastImportedSessions: number | null;
  mubitRequested: boolean | null;
  mubitEnabled: boolean | null;
  lastError: string | null;
}

const DEFAULT_LOCAL_PUSH_STATE: CodexLocalPushState = {
  lastRunAt: null,
  lastSuccessAt: null,
  lastTriggerSource: null,
  lastScannedFiles: null,
  lastMatchedFiles: null,
  lastImportedEvents: null,
  lastImportedSessions: null,
  mubitRequested: null,
  mubitEnabled: null,
  lastError: null,
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

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function getCodexLocalPushStatePath(mirrorRoot: string, repoId: string): string {
  return join(mirrorRoot, "index", repoId, "codex-local-push-state.json");
}

export function defaultCodexLocalPushState(): CodexLocalPushState {
  return { ...DEFAULT_LOCAL_PUSH_STATE };
}

export async function readCodexLocalPushState(path: string): Promise<CodexLocalPushState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return defaultCodexLocalPushState();
    }
    return {
      lastRunAt: asString(record.lastRunAt),
      lastSuccessAt: asString(record.lastSuccessAt),
      lastTriggerSource: asString(record.lastTriggerSource),
      lastScannedFiles: asFiniteNumber(record.lastScannedFiles),
      lastMatchedFiles: asFiniteNumber(record.lastMatchedFiles),
      lastImportedEvents: asFiniteNumber(record.lastImportedEvents),
      lastImportedSessions: asFiniteNumber(record.lastImportedSessions),
      mubitRequested: asBooleanOrNull(record.mubitRequested),
      mubitEnabled: asBooleanOrNull(record.mubitEnabled),
      lastError: asString(record.lastError),
    };
  } catch {
    return defaultCodexLocalPushState();
  }
}

export async function writeCodexLocalPushState(path: string, state: CodexLocalPushState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
