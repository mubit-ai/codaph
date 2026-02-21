import {
  createCapturedEvent,
  type AgentSource,
  type CapturedEventEnvelope,
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
  constructor(private readonly mirror: MirrorAppender) {}

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

    // TODO(MUBIT): write normalized event to MuBit once SDK is available.
    await this.mirror.appendEvent(event);
    return event;
  }

  async ingestRawLine(sessionId: string, line: string): Promise<void> {
    await this.mirror.appendRawLine(sessionId, line);
  }
}
