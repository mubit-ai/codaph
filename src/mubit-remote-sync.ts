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
  promptRunId?: string;
  sessionSummaryRunId?: string;
  diffRunId?: string;
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
  promptTimelineEvents?: number;
  sessionSummaryTimelineEvents?: number;
  diffTimelineEvents?: number;
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
  if (
    source === "codex_sdk" ||
    source === "codex_exec" ||
    source === "codex_history" ||
    source === "claude_code_history" ||
    source === "gemini_cli_history"
  ) {
    return source;
  }
  return "codex_history";
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
  if (activityType === "codaph_event" || activityType === "codaph_prompt") {
    return true;
  }

  const schema = asString(envelopeRecord.schema);
  if (schema && (schema.startsWith("codaph_event") || schema.startsWith("codaph_prompt"))) {
    return true;
  }

  const payloadType = asString(envelopeRecord.type);
  return payloadType === "codaph_event" || payloadType === "codaph_prompt";
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
  const threadId = asString(nested.threadId);
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
  const priorObservedUniqueEvents = Math.max(0, priorState.observedUniqueEvents ?? 0);
  const priorObservedTimelineEvents = Math.max(0, priorState.observedUniqueTimelineEvents ?? 0);
  const priorObservedPromptTimelineEvents = Math.max(0, priorState.observedUniquePromptTimelineEvents ?? 0);
  const priorObservedSessionSummaryTimelineEvents = Math.max(
    0,
    priorState.observedUniqueSessionSummaryTimelineEvents ?? 0,
  );
  const priorObservedDiffTimelineEvents = Math.max(0, priorState.observedUniqueDiffTimelineEvents ?? 0);
  const startedAt = new Date().toISOString();

  let timeline: unknown[] = [];
  let promptTimeline: unknown[] = [];
  let sessionSummaryTimeline: unknown[] = [];
  let diffTimeline: unknown[] = [];
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

  const optionalSnapshots = await Promise.all([
    (async () => {
      if (!options.promptRunId || options.promptRunId === options.runId) {
        return { kind: "prompt" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
      try {
        const promptSnapshot = await options.memory.fetchContextSnapshot({
          runId: options.promptRunId,
          timelineLimit: requestedTimelineLimit,
          refresh,
        });
        const nextTimeline = Array.isArray(promptSnapshot.timeline) ? promptSnapshot.timeline : [];
        return {
          kind: "prompt" as const,
          timeline: nextTimeline,
          fingerprint: summarizeTimelineFingerprint(nextTimeline),
        };
      } catch {
        return { kind: "prompt" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
    })(),
    (async () => {
      if (!options.sessionSummaryRunId || options.sessionSummaryRunId === options.runId) {
        return { kind: "session" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
      try {
        const summarySnapshot = await options.memory.fetchContextSnapshot({
          runId: options.sessionSummaryRunId,
          timelineLimit: requestedTimelineLimit,
          refresh,
        });
        const nextTimeline = Array.isArray(summarySnapshot.timeline) ? summarySnapshot.timeline : [];
        return {
          kind: "session" as const,
          timeline: nextTimeline,
          fingerprint: summarizeTimelineFingerprint(nextTimeline),
        };
      } catch {
        return { kind: "session" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
    })(),
    (async () => {
      if (!options.diffRunId || options.diffRunId === options.runId) {
        return { kind: "diff" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
      try {
        const diffSnapshot = await options.memory.fetchContextSnapshot({
          runId: options.diffRunId,
          timelineLimit: requestedTimelineLimit,
          refresh,
        });
        const nextTimeline = Array.isArray(diffSnapshot.timeline) ? diffSnapshot.timeline : [];
        return {
          kind: "diff" as const,
          timeline: nextTimeline,
          fingerprint: summarizeTimelineFingerprint(nextTimeline),
        };
      } catch {
        return { kind: "diff" as const, timeline: [] as unknown[], fingerprint: null as string | null };
      }
    })(),
  ]);

  let promptSnapshotFingerprint: string | null = null;
  let sessionSummarySnapshotFingerprint: string | null = null;
  let diffSnapshotFingerprint: string | null = null;
  for (const snapshotResult of optionalSnapshots) {
    if (snapshotResult.kind === "prompt") {
      promptTimeline = snapshotResult.timeline;
      promptSnapshotFingerprint = snapshotResult.fingerprint;
      continue;
    }
    if (snapshotResult.kind === "session") {
      sessionSummaryTimeline = snapshotResult.timeline;
      sessionSummarySnapshotFingerprint = snapshotResult.fingerprint;
      continue;
    }
    diffTimeline = snapshotResult.timeline;
    diffSnapshotFingerprint = snapshotResult.fingerprint;
  }

  const mainFingerprint = summarizeTimelineFingerprint(timeline);
  if (promptTimeline.length > 0 || sessionSummaryTimeline.length > 0 || diffTimeline.length > 0) {
    snapshotFingerprint = createHash("sha256")
      .update(
        `main:${mainFingerprint ?? "none"}|prompt:${promptSnapshotFingerprint ?? "none"}|session:${sessionSummarySnapshotFingerprint ?? "none"}|diff:${diffSnapshotFingerprint ?? "none"}`,
      )
      .digest("hex")
      .slice(0, 24);
  } else {
    snapshotFingerprint = mainFingerprint;
  }
  if (snapshotFingerprint && priorState.lastSnapshotFingerprint && snapshotFingerprint === priorState.lastSnapshotFingerprint) {
    consecutiveSameSnapshotCount = (priorState.consecutiveSameSnapshotCount ?? 0) + 1;
  } else {
    consecutiveSameSnapshotCount = 0;
  }
  const combinedTimeline = [
    ...sessionSummaryTimeline.map((entry) => ({ kind: "session" as const, entry })),
    ...diffTimeline.map((entry) => ({ kind: "diff" as const, entry })),
    ...promptTimeline.map((entry) => ({ kind: "prompt" as const, entry })),
    ...timeline.map((entry) => ({ kind: "main" as const, entry })),
  ];
  const shorterStreams: Array<{ label: string; length: number; previouslyObserved: number }> = [];
  if (requestedTimelineLimit > timeline.length && timeline.length > 0) {
    shorterStreams.push({ label: "events", length: timeline.length, previouslyObserved: priorObservedTimelineEvents });
  }
  if (requestedTimelineLimit > promptTimeline.length && promptTimeline.length > 0) {
    shorterStreams.push({
      label: "prompts",
      length: promptTimeline.length,
      previouslyObserved: priorObservedPromptTimelineEvents,
    });
  }
  if (requestedTimelineLimit > sessionSummaryTimeline.length && sessionSummaryTimeline.length > 0) {
    shorterStreams.push({
      label: "sessions",
      length: sessionSummaryTimeline.length,
      previouslyObserved: priorObservedSessionSummaryTimelineEvents,
    });
  }
  if (requestedTimelineLimit > diffTimeline.length && diffTimeline.length > 0) {
    shorterStreams.push({
      label: "diffs",
      length: diffTimeline.length,
      previouslyObserved: priorObservedDiffTimelineEvents,
    });
  }
  const windowedStreams = shorterStreams.filter((stream) => stream.previouslyObserved > stream.length);
  if (
    snapshotFingerprint &&
    consecutiveSameSnapshotCount >= 3 &&
    windowedStreams.length > 0
  ) {
    suspectedServerCap = true;
    const streams = windowedStreams.map((stream) => `${stream.label}=${stream.length}`);
    diagnosticNote =
      `Mubit snapshot window appears limited (${streams.join(", ")} while requested ${requestedTimelineLimit}); Codaph has already seen more remote events than this, so the backend is returning a shorter repeated window rather than the full history. Codaph is healthy and still deduping locally.`;
  }

  let imported = 0;
  let deduplicated = 0;
  let skipped = 0;
  let lastTs: string | null = null;
  let timelineMaxTs: string | null = null;
  const sessions = new Set<string>();
  const contributors = new Set<string>();
  const fallbackActorId = options.fallbackActorId ?? null;
  const importedByStream = {
    main: 0,
    prompt: 0,
    session: 0,
    diff: 0,
  };
  for (let i = 0; i < combinedTimeline.length; i += 1) {
    const rawTimelineEntry = combinedTimeline[i];
    const streamKind = rawTimelineEntry?.kind ?? "main";
    const rawEntry = rawTimelineEntry?.entry;
    if (isRecord(rawEntry)) {
      const createdAt = asString(rawEntry.created_at);
      if (createdAt && isIsoDate(createdAt)) {
        timelineMaxTs = maxIsoTs(timelineMaxTs, new Date(createdAt).toISOString());
      }
    }
    const event = parseTimelineEntry(rawEntry, options.repoId, fallbackActorId);
    if (!event) {
      skipped += 1;
      options.onProgress?.({
        current: i + 1,
        total: combinedTimeline.length,
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
      importedByStream[streamKind] += 1;
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
      total: combinedTimeline.length,
      imported,
      deduplicated,
      skipped,
    });
  }

  const noRemoteChangesDetected = Boolean(snapshotFingerprint && priorState.lastSnapshotFingerprint === snapshotFingerprint);
  if (noRemoteChangesDetected && !diagnosticNote) {
    diagnosticNote = "No remote changes detected (snapshot matches previous pull).";
  }

  const observedUniqueEvents = priorObservedUniqueEvents + imported;
  const observedUniqueTimelineEvents = priorObservedTimelineEvents + importedByStream.main;
  const observedUniquePromptTimelineEvents = priorObservedPromptTimelineEvents + importedByStream.prompt;
  const observedUniqueSessionSummaryTimelineEvents =
    priorObservedSessionSummaryTimelineEvents + importedByStream.session;
  const observedUniqueDiffTimelineEvents = priorObservedDiffTimelineEvents + importedByStream.diff;

  if (options.statePath) {
    const next = {
      ...priorState,
      lastRunAt: startedAt,
      lastSuccessAt: new Date().toISOString(),
      lastTriggerSource: options.triggerSource ?? priorState.lastTriggerSource ?? "manual",
      requestedTimelineLimit,
      receivedTimelineCount: combinedTimeline.length,
      observedUniqueEvents,
      observedUniqueTimelineEvents,
      observedUniquePromptTimelineEvents,
      observedUniqueSessionSummaryTimelineEvents,
      observedUniqueDiffTimelineEvents,
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
    timelineEvents: combinedTimeline.length,
    promptTimelineEvents: promptTimeline.length,
    sessionSummaryTimelineEvents: sessionSummaryTimeline.length,
    diffTimelineEvents: diffTimeline.length,
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
