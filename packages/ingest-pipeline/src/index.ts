import {
  createCapturedEvent,
  type AgentSource,
  type CapturedEventEnvelope,
  type MemoryEngine,
  type MirrorAppender,
  type ReasoningAvailability,
} from "@codaph/core-types";
import { redactUnknown } from "@codaph/security";

export interface IngestContext {
  source: AgentSource;
  repoId: string;
  sessionId: string;
  threadId: string | null;
  sequence: number;
  ts?: string;
}

export interface IngestPipelineOptions {
  memoryEngine?: MemoryEngine;
  failOnMemoryError?: boolean;
  onMemoryError?: (error: unknown, event: CapturedEventEnvelope) => void;
  memoryWriteTimeoutMs?: number;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getReasoningAvailability(payload: Record<string, unknown>): ReasoningAvailability {
  const item = payload.item as { type?: string; text?: string } | undefined;
  if (!item || item.type !== "reasoning") {
    return "unavailable";
  }

  if (typeof item.text === "string" && item.text.trim().length > 0) {
    return "full";
  }

  return "partial";
}

export class IngestPipeline {
  constructor(
    private readonly mirror: MirrorAppender,
    private readonly options: IngestPipelineOptions = {},
  ) {}

  async ingest(
    eventType: string,
    payload: Record<string, unknown>,
    ctx: IngestContext,
  ): Promise<CapturedEventEnvelope> {
    const ts = ctx.ts ?? new Date().toISOString();
    const sanitized = redactUnknown(payload);

    const event = createCapturedEvent({
      source: ctx.source,
      repoId: ctx.repoId,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts,
      sequence: ctx.sequence,
      eventType,
      payload: sanitized,
      reasoningAvailability: getReasoningAvailability(sanitized),
    });

    if (this.options.memoryEngine) {
      try {
        const timeoutMs = this.options.memoryWriteTimeoutMs ?? 15000;
        await withTimeout(this.options.memoryEngine.writeEvent(event), timeoutMs, "MuBit write");
      } catch (error) {
        if (this.options.onMemoryError) {
          this.options.onMemoryError(error, event);
        }
        if (this.options.failOnMemoryError) {
          throw error;
        }
      }
    }

    await this.mirror.appendEvent(event);
    return event;
  }

  async ingestRawLine(sessionId: string, line: string): Promise<void> {
    await this.mirror.appendRawLine(sessionId, line);
  }
}
