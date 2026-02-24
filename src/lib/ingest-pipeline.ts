import {
  createCapturedEvent,
  type AgentSource,
  type CapturedEventEnvelope,
  type MemoryEngine,
  type MirrorAppender,
  type ReasoningAvailability,
} from "./core-types";
import { redactUnknown } from "./security";

export interface IngestContext {
  source: AgentSource;
  repoId: string;
  actorId?: string | null;
  sessionId: string;
  threadId: string | null;
  sequence: number;
  eventId?: string;
  ts?: string;
}

export interface IngestPipelineOptions {
  memoryEngine?: MemoryEngine;
  failOnMemoryError?: boolean;
  onMemoryError?: (error: unknown, event: CapturedEventEnvelope) => void;
  memoryWriteTimeoutMs?: number;
  memoryMaxConsecutiveErrors?: number;
  memoryWriteConcurrency?: number;
  defaultActorId?: string | null;
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
  private consecutiveMemoryErrors = 0;
  private memoryCircuitOpen = false;
  private readonly pendingMemoryWrites = new Set<Promise<void>>();
  private pendingMemoryWriteError: unknown = null;

  constructor(
    private readonly mirror: MirrorAppender,
    private readonly options: IngestPipelineOptions = {},
  ) {}

  private getMemoryWriteConcurrency(): number {
    const raw = this.options.memoryWriteConcurrency ?? 1;
    if (!Number.isFinite(raw)) {
      return 1;
    }
    return Math.max(1, Math.trunc(raw));
  }

  private async writeMemoryEvent(event: CapturedEventEnvelope): Promise<void> {
    if (!this.options.memoryEngine || this.memoryCircuitOpen) {
      return;
    }

    try {
      const timeoutMs = this.options.memoryWriteTimeoutMs ?? 15000;
      await withTimeout(this.options.memoryEngine.writeEvent(event), timeoutMs, "MuBit write");
      this.consecutiveMemoryErrors = 0;
    } catch (error) {
      this.consecutiveMemoryErrors += 1;
      const maxConsecutiveErrors = this.options.memoryMaxConsecutiveErrors ?? 3;
      if (!this.memoryCircuitOpen && this.consecutiveMemoryErrors >= maxConsecutiveErrors) {
        this.memoryCircuitOpen = true;
        if (this.options.onMemoryError) {
          this.options.onMemoryError(
            new Error(`MuBit write circuit opened after ${this.consecutiveMemoryErrors} consecutive errors`),
            event,
          );
        }
      }
      if (this.options.onMemoryError) {
        this.options.onMemoryError(error, event);
      }
      if (this.options.failOnMemoryError) {
        throw error;
      }
    }
  }

  private async enqueueMemoryWrite(event: CapturedEventEnvelope): Promise<void> {
    const concurrency = this.getMemoryWriteConcurrency();
    if (concurrency <= 1) {
      await this.writeMemoryEvent(event);
      return;
    }

    while (this.pendingMemoryWrites.size >= concurrency) {
      await Promise.race(this.pendingMemoryWrites);
    }

    let task: Promise<void>;
    task = this.writeMemoryEvent(event)
      .catch((error) => {
        if (this.pendingMemoryWriteError == null) {
          this.pendingMemoryWriteError = error;
        }
      })
      .finally(() => {
        this.pendingMemoryWrites.delete(task);
      });

    this.pendingMemoryWrites.add(task);
  }

  async ingest(
    eventType: string,
    payload: Record<string, unknown>,
    ctx: IngestContext,
  ): Promise<CapturedEventEnvelope> {
    const ts = ctx.ts ?? new Date().toISOString();
    const sanitized = redactUnknown(payload);

    const event = createCapturedEvent({
      eventId: ctx.eventId,
      source: ctx.source,
      repoId: ctx.repoId,
      actorId: ctx.actorId ?? this.options.defaultActorId ?? null,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      ts,
      sequence: ctx.sequence,
      eventType,
      payload: sanitized,
      reasoningAvailability: getReasoningAvailability(sanitized),
    });

    const appendResult = await this.mirror.appendEvent(event);
    if (appendResult.deduplicated) {
      return event;
    }

    if (this.options.memoryEngine && !this.memoryCircuitOpen) {
      await this.enqueueMemoryWrite(event);
    }

    return event;
  }

  async ingestRawLine(sessionId: string, line: string): Promise<void> {
    await this.mirror.appendRawLine(sessionId, line);
  }

  async flush(): Promise<void> {
    if (this.pendingMemoryWrites.size > 0) {
      await Promise.allSettled([...this.pendingMemoryWrites]);
    }
    if (this.options.failOnMemoryError && this.pendingMemoryWriteError != null) {
      const error = this.pendingMemoryWriteError;
      this.pendingMemoryWriteError = null;
      throw error;
    }
    this.pendingMemoryWriteError = null;

    const maybeFlush = (this.mirror as { flush?: () => Promise<void> }).flush;
    if (typeof maybeFlush === "function") {
      await maybeFlush.call(this.mirror);
    }
  }
}
