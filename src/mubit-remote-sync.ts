import { createHash } from "node:crypto";
import type {
  AgentSource,
  CapturedEventEnvelope,
  MirrorAppender,
  ReasoningAvailability,
} from "./lib/core-types";
import type { MubitMemoryEngine } from "./lib/memory-mubit";
import {
  defaultMubitRemoteSyncState,
  readMubitRemoteSyncState,
  writeMubitRemoteSyncState,
} from "./mubit-remote-sync-state";

interface JsonRecord {
  [key: string]: unknown;
}

export interface MubitRemoteSyncOptions {
  mirror: MirrorAppender;
  memory: MubitMemoryEngine;
  runId: string;
  repoId: string;
  fallbackActorId?: string | null;
  timelineLimit?: number;
  refresh?: boolean;
  statePath?: string;
  triggerSource?: string;
  onProgress?: (progress: { current: number; total: number; imported: number; deduplicated: number; skipped: number }) => void;
}

export interface MubitRemoteSyncSummary {
  runId: string;
  timelineEvents: number;
  requestedTimelineLimit: number;
  refresh: boolean;
  imported: number;
  deduplicated: number;
  skipped: number;
  sessions: number;
  contributors: number;
  lastTs: string | null;
  snapshotFingerprint: string | null;
  consecutiveSameSnapshotCount: number;
  noRemoteChangesDetected: boolean;
  suspectedServerCap: boolean;
  diagnosticNote: string | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSource(value: unknown): AgentSource {
  const source = asString(value);
  if (source === "codex_sdk" || source === "codex_exec") {
    return source;
  }
  return "codex_exec";
}

function normalizeReasoning(value: unknown): ReasoningAvailability {
  const raw = asString(value)?.toLowerCase();
  if (raw === "full" || raw === "partial" || raw === "unavailable") {
    return raw;
  }
  return "unavailable";
}

function isIsoDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

function buildFallbackEventId(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function extractActivityRecord(rawTimeline: JsonRecord): JsonRecord | null {
  const directActivity = parseJsonRecord(rawTimeline.activity);
  if (directActivity) {
    return directActivity;
  }

  const payloadRecord = parseJsonRecord(rawTimeline.payload);
  if (!payloadRecord) {
    return null;
  }

  const nestedActivity = parseJsonRecord(payloadRecord.activity);
  if (nestedActivity) {
    return nestedActivity;
  }

  return payloadRecord;
}

function extractEnvelopeRecord(activityRecord: JsonRecord): JsonRecord | null {
  const payloadRecord = parseJsonRecord(activityRecord.payload);
  if (payloadRecord) {
    return payloadRecord;
  }

  if (isRecord(activityRecord.event) || isRecord(activityRecord.payload)) {
    return activityRecord;
  }

  return null;
}

function isCodaphActivity(activityRecord: JsonRecord, envelopeRecord: JsonRecord): boolean {
  const activityType = asString(activityRecord.type);
  if (activityType === "codaph_event") {
    return true;
  }

  const schema = asString(envelopeRecord.schema);
  if (schema && schema.startsWith("codaph_event")) {
    return true;
  }

  const payloadType = asString(envelopeRecord.type);
  return payloadType === "codaph_event";
}

function looksLikeCapturedEvent(record: JsonRecord): boolean {
  return Boolean(
    asString(record.eventType) ??
      asString(record.sessionId) ??
      asString(record.eventId) ??
      asString(record.threadId) ??
      asString(record.prompt),
  );
}

function resolveNestedEventRecord(envelopeRecord: JsonRecord): JsonRecord {
  if (isRecord(envelopeRecord.event)) {
    return envelopeRecord.event;
  }

  if (looksLikeCapturedEvent(envelopeRecord)) {
    return envelopeRecord;
  }

  const payloadRecord = parseJsonRecord(envelopeRecord.payload);
  if (payloadRecord && looksLikeCapturedEvent(payloadRecord)) {
    return payloadRecord;
  }

  return envelopeRecord;
}

function parseTimelineEntry(
  rawTimeline: unknown,
  repoId: string,
  fallbackActorId: string | null,
): CapturedEventEnvelope | null {
  if (!isRecord(rawTimeline)) {
    return null;
  }
  const activityRecord = extractActivityRecord(rawTimeline);
  if (!activityRecord) {
    return null;
  }
  const envelopeRecord = extractEnvelopeRecord(activityRecord);
  if (!envelopeRecord) {
    return null;
  }
  if (!isCodaphActivity(activityRecord, envelopeRecord)) {
    return null;
  }

  const nested = resolveNestedEventRecord(envelopeRecord);

  const eventType = asString(nested.eventType) ?? asString(nested.type) ?? "remote.activity";
  const sessionId =
    asString(nested.sessionId) ??
    asString(activityRecord.input_ref) ??
    asString(rawTimeline.id) ??
    "remote-session";
  const threadId = asString(nested.threadId) ?? sessionId;
  const tsCandidate =
    asString(nested.ts) ??
    asString(activityRecord.ts) ??
    asString(rawTimeline.created_at) ??
    new Date().toISOString();
  const ts = isIsoDate(tsCandidate) ? new Date(tsCandidate).toISOString() : new Date().toISOString();
  const eventId =
    asString(nested.eventId) ??
    asString(activityRecord.output_ref) ??
    buildFallbackEventId(`${asString(rawTimeline.id) ?? "timeline"}|${ts}|${eventType}|${sessionId}`);
  const actorId = asString(nested.actorId) ?? fallbackActorId;
  const source = normalizeSource(nested.source);
  const reasoningAvailability = normalizeReasoning(nested.reasoningAvailability);

  const payload = isRecord(nested.payload) ? nested.payload : {};
  return {
    eventId,
    source,
    repoId,
    actorId,
    sessionId,
    threadId,
    ts,
    eventType,
    payload,
    reasoningAvailability,
  };
}

function summarizeTimelineFingerprint(timeline: unknown[]): string | null {
  if (timeline.length === 0) {
    return null;
  }

  const hasher = createHash("sha256");
  for (let i = 0; i < timeline.length; i += 1) {
    const entry = timeline[i];
    if (isRecord(entry)) {
      const id = asString(entry.id) ?? `idx:${i}`;
      const createdAt = asString(entry.created_at) ?? "";
      const payloadStr =
        typeof entry.payload === "string"
          ? entry.payload
          : typeof entry.activity === "string"
            ? entry.activity
            : "";
      hasher.update(`${id}|${createdAt}|${hashText(payloadStr)}\n`);
      continue;
    }
    hasher.update(`${hashText(JSON.stringify(entry) ?? String(entry))}\n`);
  }
  return hasher.digest("hex").slice(0, 24);
}

function maxIsoTs(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return a > b ? a : b;
}

export async function syncMubitRemoteActivity(options: MubitRemoteSyncOptions): Promise<MubitRemoteSyncSummary> {
  const requestedTimelineLimit =
    Number.isFinite(options.timelineLimit) && (options.timelineLimit ?? 0) > 0
      ? Math.floor(options.timelineLimit as number)
      : 1200;
  const refresh = options.refresh ?? true;
  const priorState = options.statePath ? await readMubitRemoteSyncState(options.statePath) : defaultMubitRemoteSyncState();
  const startedAt = new Date().toISOString();

  let timeline: unknown[] = [];
  let snapshotFingerprint: string | null = null;
  let consecutiveSameSnapshotCount = 0;
  let suspectedServerCap = false;
  let diagnosticNote: string | null = null;

  const writeFailureState = async (errorMessage: string): Promise<void> => {
    if (!options.statePath) {
      return;
    }
    const next = {
      ...priorState,
      lastRunAt: startedAt,
      lastTriggerSource: options.triggerSource ?? priorState.lastTriggerSource ?? "manual",
      requestedTimelineLimit,
      lastError: errorMessage,
    };
    await writeMubitRemoteSyncState(options.statePath, next);
  };

  let snapshot: Record<string, unknown>;
  try {
    snapshot = await options.memory.fetchContextSnapshot({
      runId: options.runId,
      timelineLimit: requestedTimelineLimit,
      refresh,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFailureState(message).catch(() => {});
    throw error;
  }

  timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  snapshotFingerprint = summarizeTimelineFingerprint(timeline);
  if (snapshotFingerprint && priorState.lastSnapshotFingerprint && snapshotFingerprint === priorState.lastSnapshotFingerprint) {
    consecutiveSameSnapshotCount = (priorState.consecutiveSameSnapshotCount ?? 0) + 1;
  } else {
    consecutiveSameSnapshotCount = 0;
  }
  if (
    snapshotFingerprint &&
    consecutiveSameSnapshotCount >= 3 &&
    requestedTimelineLimit > timeline.length &&
    timeline.length > 0
  ) {
    suspectedServerCap = true;
    diagnosticNote =
      `Mubit snapshot appears capped (received ${timeline.length} despite requested ${requestedTimelineLimit}); Codaph is deduping locally. This is a snapshot API limitation, not a local sync error.`;
  }

  let imported = 0;
  let deduplicated = 0;
  let skipped = 0;
  let lastTs: string | null = null;
  let timelineMaxTs: string | null = null;
  const sessions = new Set<string>();
  const contributors = new Set<string>();
  const fallbackActorId = options.fallbackActorId ?? null;

  for (let i = 0; i < timeline.length; i += 1) {
    const rawTimelineEntry = timeline[i];
    if (isRecord(rawTimelineEntry)) {
      const createdAt = asString(rawTimelineEntry.created_at);
      if (createdAt && isIsoDate(createdAt)) {
        timelineMaxTs = maxIsoTs(timelineMaxTs, new Date(createdAt).toISOString());
      }
    }
    const event = parseTimelineEntry(rawTimelineEntry, options.repoId, fallbackActorId);
    if (!event) {
      skipped += 1;
      options.onProgress?.({
        current: i + 1,
        total: timeline.length,
        imported,
        deduplicated,
        skipped,
      });
      continue;
    }

    const appended = await options.mirror.appendEvent(event);
    if (appended.deduplicated) {
      deduplicated += 1;
    } else {
      imported += 1;
      sessions.add(event.sessionId);
      if (event.actorId) {
        contributors.add(event.actorId);
      }
      if (!lastTs || event.ts > lastTs) {
        lastTs = event.ts;
      }
    }
    timelineMaxTs = maxIsoTs(timelineMaxTs, event.ts);

    options.onProgress?.({
      current: i + 1,
      total: timeline.length,
      imported,
      deduplicated,
      skipped,
    });
  }

  const noRemoteChangesDetected = Boolean(snapshotFingerprint && priorState.lastSnapshotFingerprint === snapshotFingerprint);
  if (noRemoteChangesDetected && !diagnosticNote) {
    diagnosticNote = "No remote changes detected (snapshot matches previous pull).";
  }

  if (options.statePath) {
    const next = {
      ...priorState,
      lastRunAt: startedAt,
      lastSuccessAt: new Date().toISOString(),
      lastTriggerSource: options.triggerSource ?? priorState.lastTriggerSource ?? "manual",
      requestedTimelineLimit,
      receivedTimelineCount: timeline.length,
      lastImported: imported,
      lastDeduplicated: deduplicated,
      lastSkipped: skipped,
      lastMaxTs: timelineMaxTs,
      lastSnapshotFingerprint: snapshotFingerprint,
      consecutiveSameSnapshotCount,
      suspectedServerCap,
      lastError: null,
      pendingTrigger: {
        pending: false,
        source: null,
        ts: null,
      },
    };
    await writeMubitRemoteSyncState(options.statePath, next).catch(() => {});
  }

  return {
    runId: options.runId,
    timelineEvents: timeline.length,
    requestedTimelineLimit,
    refresh,
    imported,
    deduplicated,
    skipped,
    sessions: sessions.size,
    contributors: contributors.size,
    lastTs,
    snapshotFingerprint,
    consecutiveSameSnapshotCount,
    noRemoteChangesDetected,
    suspectedServerCap,
    diagnosticNote,
  };
}
