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
  memoryBatchSize?: number;
  retryMemoryWriteOnLocalDedup?: boolean;
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
  private pendingMemoryBatch: CapturedEventEnvelope[] = [];

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

  private getMemoryBatchSize(): number {
    if (!this.options.memoryEngine?.writeEventsBatch) {
      return 1;
    }
    const raw = this.options.memoryBatchSize ?? 1;
    if (!Number.isFinite(raw)) {
      return 1;
    }
    return Math.max(1, Math.trunc(raw));
  }

  private getMemoryWriteTimeoutMsForBatch(batchSize: number): number {
    const baseTimeoutMs = this.options.memoryWriteTimeoutMs ?? 15000;
    const multiplier = Math.max(1, Math.min(6, Math.ceil(batchSize / 8)));
    return baseTimeoutMs * multiplier;
  }

  private handleMemoryWriteError(error: unknown, event: CapturedEventEnvelope): void {
    this.consecutiveMemoryErrors += 1;
    const maxConsecutiveErrors = this.options.memoryMaxConsecutiveErrors ?? 3;
    if (!this.memoryCircuitOpen && this.consecutiveMemoryErrors >= maxConsecutiveErrors) {
      this.memoryCircuitOpen = true;
      if (this.options.onMemoryError) {
        this.options.onMemoryError(
          new Error(`Mubit write circuit opened after ${this.consecutiveMemoryErrors} consecutive errors`),
          event,
        );
      }
    }
    if (this.options.onMemoryError) {
      this.options.onMemoryError(error, event);
    }
  }

  private async writeMemoryEvent(event: CapturedEventEnvelope): Promise<void> {
    if (!this.options.memoryEngine || this.memoryCircuitOpen) {
      return;
    }

    try {
      const timeoutMs = this.options.memoryWriteTimeoutMs ?? 15000;
      await withTimeout(this.options.memoryEngine.writeEvent(event), timeoutMs, "Mubit write");
      this.consecutiveMemoryErrors = 0;
    } catch (error) {
      this.handleMemoryWriteError(error, event);
      if (this.options.failOnMemoryError) {
        throw error;
      }
    }
  }

  private async writeMemoryBatch(events: CapturedEventEnvelope[]): Promise<void> {
    if (!this.options.memoryEngine?.writeEventsBatch || this.memoryCircuitOpen || events.length === 0) {
      return;
    }

    const representativeEvent = events[events.length - 1] ?? events[0];
    if (!representativeEvent) {
      return;
    }

    try {
      const timeoutMs = this.getMemoryWriteTimeoutMsForBatch(events.length);
      await withTimeout(this.options.memoryEngine.writeEventsBatch(events), timeoutMs, "Mubit write");
      this.consecutiveMemoryErrors = 0;
    } catch (error) {
      this.handleMemoryWriteError(error, representativeEvent);
      if (this.options.failOnMemoryError) {
        throw error;
      }
    }
  }

  private async enqueueMemoryTask(taskFactory: () => Promise<void>): Promise<void> {
    const concurrency = this.getMemoryWriteConcurrency();
    if (concurrency <= 1) {
      await taskFactory();
      return;
    }

    while (this.pendingMemoryWrites.size >= concurrency) {
      await Promise.race(this.pendingMemoryWrites);
    }

    let task: Promise<void>;
    task = taskFactory()
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

  private async flushPendingMemoryBatch(): Promise<void> {
    if (this.pendingMemoryBatch.length === 0 || this.memoryCircuitOpen) {
      this.pendingMemoryBatch = [];
      return;
    }

    const batch = this.pendingMemoryBatch;
    this.pendingMemoryBatch = [];
    const canBatch = Boolean(this.options.memoryEngine?.writeEventsBatch) && batch.length > 1;
    if (canBatch) {
      await this.enqueueMemoryTask(() => this.writeMemoryBatch(batch));
      return;
    }

    for (const event of batch) {
      await this.enqueueMemoryTask(() => this.writeMemoryEvent(event));
    }
  }

  private async enqueueMemoryWrite(event: CapturedEventEnvelope): Promise<void> {
    const batchSize = this.getMemoryBatchSize();
    if (batchSize <= 1) {
      await this.enqueueMemoryTask(() => this.writeMemoryEvent(event));
      return;
    }

    this.pendingMemoryBatch.push(event);
    if (this.pendingMemoryBatch.length >= batchSize) {
      await this.flushPendingMemoryBatch();
    }
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
      if (this.options.retryMemoryWriteOnLocalDedup && this.options.memoryEngine && !this.memoryCircuitOpen) {
        await this.enqueueMemoryWrite(event);
      }
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
    await this.flushPendingMemoryBatch();
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
