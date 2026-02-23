import { createHash } from "node:crypto";
import type {
  AgentSource,
  CapturedEventEnvelope,
  MirrorAppender,
  ReasoningAvailability,
} from "@codaph/core-types";
import type { MubitMemoryEngine } from "@codaph/memory-mubit";

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
  onProgress?: (progress: { current: number; total: number; imported: number; deduplicated: number; skipped: number }) => void;
}

export interface MubitRemoteSyncSummary {
  runId: string;
  timelineEvents: number;
  imported: number;
  deduplicated: number;
  skipped: number;
  sessions: number;
  contributors: number;
  lastTs: string | null;
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

function parseTimelineEntry(
  rawTimeline: unknown,
  repoId: string,
  fallbackActorId: string | null,
): CapturedEventEnvelope | null {
  if (!isRecord(rawTimeline)) {
    return null;
  }
  const payloadRecord = parseJsonRecord(rawTimeline.payload);
  if (!payloadRecord) {
    return null;
  }
  if (asString(payloadRecord.type) !== "codaph_event") {
    return null;
  }

  const envelopeRecord = parseJsonRecord(payloadRecord.payload);
  if (!envelopeRecord) {
    return null;
  }
  const nested = isRecord(envelopeRecord.event) ? envelopeRecord.event : envelopeRecord;

  const eventType = asString(nested.eventType) ?? asString(nested.type) ?? "remote.activity";
  const sessionId =
    asString(nested.sessionId) ??
    asString(payloadRecord.input_ref) ??
    asString(rawTimeline.id) ??
    "remote-session";
  const threadId = asString(nested.threadId) ?? sessionId;
  const tsCandidate =
    asString(nested.ts) ??
    asString(payloadRecord.ts) ??
    asString(rawTimeline.created_at) ??
    new Date().toISOString();
  const ts = isIsoDate(tsCandidate) ? new Date(tsCandidate).toISOString() : new Date().toISOString();
  const eventId =
    asString(nested.eventId) ??
    asString(payloadRecord.output_ref) ??
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

export async function syncMubitRemoteActivity(options: MubitRemoteSyncOptions): Promise<MubitRemoteSyncSummary> {
  const snapshot = await options.memory.fetchContextSnapshot({
    runId: options.runId,
    timelineLimit: options.timelineLimit ?? 1200,
    refresh: false,
  });

  const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  let imported = 0;
  let deduplicated = 0;
  let skipped = 0;
  let lastTs: string | null = null;
  const sessions = new Set<string>();
  const contributors = new Set<string>();
  const fallbackActorId = options.fallbackActorId ?? null;

  for (let i = 0; i < timeline.length; i += 1) {
    const event = parseTimelineEntry(timeline[i], options.repoId, fallbackActorId);
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

    options.onProgress?.({
      current: i + 1,
      total: timeline.length,
      imported,
      deduplicated,
      skipped,
    });
  }

  return {
    runId: options.runId,
    timelineEvents: timeline.length,
    imported,
    deduplicated,
    skipped,
    sessions: sessions.size,
    contributors: contributors.size,
    lastTs,
  };
}

