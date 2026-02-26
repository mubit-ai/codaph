import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultCodexLocalPushState, readCodexLocalPushState } from "./codex-local-push-state";
import type { AgentProviderId } from "./lib/agent-providers";

export interface LocalPushProviderStats {
  scannedFiles: number | null;
  matchedFiles: number | null;
  importedEvents: number | null;
  importedSessions: number | null;
  lastError: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
}

export interface LocalPushState {
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
  providers?: Partial<Record<AgentProviderId, LocalPushProviderStats>>;
}

const DEFAULT_LOCAL_PUSH_STATE: LocalPushState = {
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
  providers: {},
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

function normalizeProviderStats(value: unknown): LocalPushProviderStats | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    scannedFiles: asFiniteNumber(record.scannedFiles),
    matchedFiles: asFiniteNumber(record.matchedFiles),
    importedEvents: asFiniteNumber(record.importedEvents),
    importedSessions: asFiniteNumber(record.importedSessions),
    lastError: asString(record.lastError),
    lastRunAt: asString(record.lastRunAt),
    lastSuccessAt: asString(record.lastSuccessAt),
  };
}

function normalizeProviderMap(value: unknown): Partial<Record<AgentProviderId, LocalPushProviderStats>> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const out: Partial<Record<AgentProviderId, LocalPushProviderStats>> = {};
  const entries: Array<AgentProviderId> = ["codex", "claude-code", "gemini-cli"];
  for (const provider of entries) {
    const normalized = normalizeProviderStats(record[provider]);
    if (normalized) {
      out[provider] = normalized;
    }
  }
  return out;
}

export function getLocalPushStatePath(mirrorRoot: string, repoId: string): string {
  return join(mirrorRoot, "index", repoId, "local-push-state.json");
}

export function defaultLocalPushState(): LocalPushState {
  return {
    ...DEFAULT_LOCAL_PUSH_STATE,
    providers: {},
  };
}

function normalizeLocalPushState(parsed: unknown): LocalPushState {
  const record = asRecord(parsed);
  if (!record) {
    return defaultLocalPushState();
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
    providers: normalizeProviderMap(record.providers),
  };
}

export async function readLocalPushState(path: string): Promise<LocalPushState> {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeLocalPushState(JSON.parse(raw) as unknown);
  } catch {
    const legacy = await readCodexLocalPushState(path.replace(/local-push-state\.json$/, "codex-local-push-state.json")).catch(
      () => defaultCodexLocalPushState(),
    );
    if (
      !legacy.lastRunAt &&
      !legacy.lastSuccessAt &&
      !legacy.lastImportedEvents &&
      !legacy.lastMatchedFiles &&
      !legacy.lastScannedFiles &&
      !legacy.lastError
    ) {
      return defaultLocalPushState();
    }
    return {
      lastRunAt: legacy.lastRunAt,
      lastSuccessAt: legacy.lastSuccessAt,
      lastTriggerSource: legacy.lastTriggerSource,
      lastScannedFiles: legacy.lastScannedFiles,
      lastMatchedFiles: legacy.lastMatchedFiles,
      lastImportedEvents: legacy.lastImportedEvents,
      lastImportedSessions: legacy.lastImportedSessions,
      mubitRequested: legacy.mubitRequested,
      mubitEnabled: legacy.mubitEnabled,
      lastError: legacy.lastError,
      providers: {
        codex: {
          scannedFiles: legacy.lastScannedFiles,
          matchedFiles: legacy.lastMatchedFiles,
          importedEvents: legacy.lastImportedEvents,
          importedSessions: legacy.lastImportedSessions,
          lastError: legacy.lastError,
          lastRunAt: legacy.lastRunAt,
          lastSuccessAt: legacy.lastSuccessAt,
        },
      },
    };
  }
}

export async function writeLocalPushState(path: string, state: LocalPushState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

