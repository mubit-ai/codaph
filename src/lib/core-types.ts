import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type AgentSource =
  | "codex_sdk"
  | "codex_exec"
  | "codex_history"
  | "claude_code_history"
  | "gemini_cli_history";

export type ReasoningAvailability = "full" | "partial" | "unavailable";

export interface ThreadEventLike {
  type: string;
  [key: string]: unknown;
}

export interface CapturedEventEnvelope {
  eventId: string;
  source: AgentSource;
  repoId: string;
  actorId: string | null;
  sessionId: string;
  threadId: string | null;
  ts: string;
  eventType: string;
  payload: Record<string, unknown>;
  reasoningAvailability: ReasoningAvailability;
}

export interface CreateCapturedEventInput {
  eventId?: string;
  source: AgentSource;
  repoId: string;
  actorId?: string | null;
  sessionId: string;
  threadId: string | null;
  ts: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  reasoningAvailability?: ReasoningAvailability;
}

export interface AdapterRunOptions {
  prompt: string;
  cwd: string;
  repoId?: string;
  model?: string;
  resumeThreadId?: string;
}

export interface AdapterRunResult {
  sessionId: string;
  threadId: string | null;
  finalResponse: string | null;
}

export interface CodexAdapter {
  runAndCapture(
    options: AdapterRunOptions,
    onEvent?: (event: CapturedEventEnvelope) => Promise<void> | void,
  ): Promise<AdapterRunResult>;
}

export interface MirrorAppendResult {
  segment: string;
  offset: number;
  checksum: string;
  deduplicated?: boolean;
}

export interface MirrorAppender {
  appendEvent(event: CapturedEventEnvelope): Promise<MirrorAppendResult>;
  appendRawLine(sessionId: string, line: string): Promise<void>;
}

export interface MemoryWriteResult {
  accepted: boolean;
  deduplicated?: boolean;
  jobId?: string;
  raw?: unknown;
}

export interface MemoryEngine {
  writeEvent(event: CapturedEventEnvelope): Promise<MemoryWriteResult>;
  writeEventsBatch?(events: CapturedEventEnvelope[]): Promise<void>;
  writeRunState?(runId: string, statePatch: Record<string, unknown>): Promise<void>;
}

export interface TimelineFilter {
  repoId: string;
  sessionId?: string;
  threadId?: string;
  actorId?: string;
  from?: string;
  to?: string;
  itemType?: string;
}

export interface AgentStatusSnapshot {
  ts: string;
  repoPath: string;
  branch: string | null;
  headSha: string | null;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedFiles: string[];
  source: "manual" | "pre-commit";
}

export function createEventId(input: {
  source: AgentSource;
  threadId: string | null;
  sequence: number;
  eventType: string;
  ts: string;
}): string {
  const raw = [
    input.source,
    input.threadId ?? "no-thread",
    String(input.sequence),
    input.eventType,
    input.ts,
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export function createCapturedEvent(input: CreateCapturedEventInput): CapturedEventEnvelope {
  const actorId =
    typeof input.actorId === "string" && input.actorId.trim().length > 0
      ? input.actorId.trim()
      : null;
  const eventId =
    typeof input.eventId === "string" && input.eventId.trim().length > 0
      ? input.eventId.trim()
      : createEventId({
        source: input.source,
        threadId: input.threadId,
        sequence: input.sequence,
        eventType: input.eventType,
        ts: input.ts,
      });

  return {
    eventId,
    source: input.source,
    repoId: input.repoId,
    actorId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    ts: input.ts,
    eventType: input.eventType,
    payload: input.payload,
    reasoningAvailability: input.reasoningAvailability ?? "unavailable",
  };
}

export function repoIdFromPath(pathname: string): string {
  const abs = resolve(pathname);
  return createHash("sha1").update(abs).digest("hex").slice(0, 12);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
