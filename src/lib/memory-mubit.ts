import { Client, type ClientConfig } from "@mubit-ai/sdk";
import type { CapturedEventEnvelope, MemoryEngine, MemoryWriteResult } from "./core-types";

export type MubitTransport = "auto" | "http" | "grpc";
export type MubitRunScope = "session" | "project";

export interface MubitSemanticQueryOptions {
  runId: string;
  query: string;
  limit?: number;
  includeLinkedRuns?: boolean;
  directLane?: "semantic_search" | "hdql_query";
  mode?: "agent_routed" | "direct_bypass";
}

export interface MubitContextSnapshotOptions {
  runId: string;
  timelineLimit?: number;
  refresh?: boolean;
}

export interface MubitMemoryOptions {
  apiKey?: string;
  endpoint?: string;
  httpEndpoint?: string;
  grpcEndpoint?: string;
  transport?: MubitTransport;
  agentId?: string;
  runIdPrefix?: string;
  projectId?: string;
  actorId?: string;
  runScope?: MubitRunScope;
  enabled?: boolean;
  client?: MubitClientLike;
}

type MubitIngestMethod = (payload?: Record<string, unknown>) => Promise<unknown>;

interface MubitClientLike {
  core?: {
    ingest?(payload?: Record<string, unknown>): Promise<unknown>;
  };
  control: {
    ingest(payload?: Record<string, unknown>): Promise<unknown>;
    setVariable(payload?: Record<string, unknown>): Promise<unknown>;
    query(payload?: Record<string, unknown>): Promise<unknown>;
    appendActivity?(payload?: Record<string, unknown>): Promise<unknown>;
    contextSnapshot?(payload?: Record<string, unknown>): Promise<unknown>;
  };
}

interface JsonObject {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as JsonObject;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function looksLikeUnsupportedHdqlLaneError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("hdql") ||
    message.includes("hdc") ||
    message.includes("direct_lane") ||
    message.includes("direct lane") ||
    message.includes("invalid argument") ||
    message.includes("unsupported")
  );
}

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}...`;
}

function textFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const out = value
      .map((entry) => textFromUnknown(entry))
      .filter((entry): entry is string => !!entry);
    if (out.length === 0) {
      return null;
    }
    return out.join("\n");
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const candidates = [
    record.text,
    record.prompt,
    record.message,
    record.content,
    record.reasoning,
    record.summary,
    record.output,
    record.input,
    record.value,
    record.stdout,
    record.stderr,
    record.stdout_text,
    record.stderr_text,
  ];

  for (const candidate of candidates) {
    const text = textFromUnknown(candidate);
    if (text) {
      return text;
    }
  }

  return null;
}

function eventToText(event: CapturedEventEnvelope): string {
  const payloadText = textFromUnknown(event.payload.item) ?? textFromUnknown(event.payload);
  if (!payloadText) {
    return `${event.eventType}${event.actorId ? ` [actor:${event.actorId}]` : ""} event in session ${event.sessionId}`;
  }

  return `${event.eventType}${event.actorId ? ` [actor:${event.actorId}]` : ""}: ${truncate(payloadText)}`;
}

function compactString(value: unknown, max = 1600): string | null {
  const text = textFromUnknown(value);
  if (!text) {
    return null;
  }
  return truncate(text, max);
}

function compactItem(item: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const itemType = asString(item.type);
  if (itemType) {
    output.type = itemType;
  }

  const role = asString(item.role);
  if (role) {
    output.role = role;
  }

  const name = asString(item.name);
  if (name) {
    output.name = name;
  }

  const callId = asString(item.call_id);
  if (callId) {
    output.call_id = callId;
  }

  const text =
    compactString(item.text, 1800) ??
    compactString(item.content, 1800) ??
    compactString(item.message, 1800) ??
    compactString(item.summary, 1800);
  if (text) {
    output.text = text;
  }

  const argumentsText = compactString(item.arguments, 1200);
  if (argumentsText) {
    output.arguments = argumentsText;
  }

  const outputText = compactString(item.output, 2000);
  if (outputText) {
    output.output = outputText;
  }

  if (Array.isArray(item.changes)) {
    const changes = item.changes
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      .map((entry) => ({
        path: asString(entry.path) ?? "(unknown)",
        kind: asString(entry.kind) ?? "update",
      }))
      .slice(0, 240);
    if (changes.length > 0) {
      output.changes = changes;
    }
  }

  return output;
}

function compactPayload(event: CapturedEventEnvelope): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const prompt = compactString(event.payload.prompt, 2000) ?? compactString(event.payload.input, 2000);
  if (prompt) {
    output.prompt = prompt;
  }

  const item = asRecord(event.payload.item);
  if (item) {
    const compacted = compactItem(item);
    if (Object.keys(compacted).length > 0) {
      output.item = compacted;
    }
  }

  return output;
}

function compactActivityEnvelope(event: CapturedEventEnvelope): Record<string, unknown> {
  return {
    schema: "codaph_event.v2",
    event: {
      eventId: event.eventId,
      source: event.source,
      repoId: event.repoId,
      actorId: event.actorId,
      sessionId: event.sessionId,
      threadId: event.threadId,
      ts: event.ts,
      eventType: event.eventType,
      reasoningAvailability: event.reasoningAvailability,
      payload: compactPayload(event),
    },
  };
}

function minimalActivityEnvelope(event: CapturedEventEnvelope): Record<string, unknown> {
  return {
    schema: "codaph_event.min",
    event: {
      eventId: event.eventId,
      source: event.source,
      repoId: event.repoId,
      actorId: event.actorId,
      sessionId: event.sessionId,
      threadId: event.threadId,
      ts: event.ts,
      eventType: event.eventType,
      reasoningAvailability: event.reasoningAvailability,
      payload: {},
    },
  };
}

function compactPromptActivityEnvelope(event: CapturedEventEnvelope): Record<string, unknown> {
  const prompt =
    compactString(event.payload.prompt, 2000) ??
    compactString(event.payload.input, 2000) ??
    compactString(event.payload.item, 2000);
  return {
    schema: "codaph_prompt.v1",
    event: {
      eventId: event.eventId,
      source: event.source,
      repoId: event.repoId,
      actorId: event.actorId,
      sessionId: event.sessionId,
      threadId: event.threadId,
      ts: event.ts,
      eventType: "prompt.submitted",
      reasoningAvailability: event.reasoningAvailability,
      payload: {
        ...(prompt ? { prompt } : {}),
        source: "mubit_prompt_stream",
      },
    },
  };
}

function isPromptSubmittedEvent(event: CapturedEventEnvelope): boolean {
  return event.eventType === "prompt.submitted";
}

export function mubitRunIdForSession(
  repoId: string,
  sessionId: string,
  runIdPrefix = "codaph",
): string {
  return `${runIdPrefix}:${repoId}:${sessionId}`;
}

export function mubitRunIdForProject(
  repoId: string,
  runIdPrefix = "codaph",
): string {
  return `${runIdPrefix}:${repoId}`;
}

export function mubitPromptRunIdForProject(
  repoId: string,
  runIdPrefix = "codaph-prompts",
): string {
  return `${runIdPrefix}:${repoId}`;
}

export class MubitMemoryEngine implements MemoryEngine {
  private readonly client: MubitClientLike;

  private readonly configured: boolean;
  private readonly enabled: boolean;
  private readonly agentId: string;
  private readonly runIdPrefix: string;
  private readonly projectId?: string;
  private readonly actorId?: string;
  private readonly runScope: MubitRunScope;

  constructor(options: MubitMemoryOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.agentId = options.agentId ?? "codaph";
    this.runIdPrefix = options.runIdPrefix ?? "codaph";
    this.projectId = asString(options.projectId);
    this.actorId = asString(options.actorId);
    this.runScope = options.runScope ?? "session";

    if (options.client) {
      this.client = options.client;
      this.configured = true;
      return;
    }

    const apiKey = asString(options.apiKey ?? process.env.MUBIT_API_KEY);
    this.configured = Boolean(apiKey);

    const config: ClientConfig = {
      api_key: apiKey,
      transport: options.transport,
      endpoint: options.endpoint,
      http_endpoint: options.httpEndpoint,
      grpc_endpoint: options.grpcEndpoint,
    };

    this.client = new Client(config) as unknown as MubitClientLike;
  }

  isEnabled(): boolean {
    return this.enabled && this.configured;
  }

  runIdForSession(repoId: string, sessionId: string): string {
    const sharedRepoId = this.projectId ?? repoId;
    if (this.runScope === "project") {
      return mubitRunIdForProject(sharedRepoId, this.runIdPrefix);
    }
    return mubitRunIdForSession(sharedRepoId, sessionId, this.runIdPrefix);
  }

  promptRunIdForRepo(repoId: string): string {
    const sharedRepoId = this.projectId ?? repoId;
    return mubitPromptRunIdForProject(sharedRepoId, `${this.runIdPrefix}-prompts`);
  }

  private getIngestMethod(): MubitIngestMethod {
    if (this.client.core?.ingest) {
      return this.client.core.ingest.bind(this.client.core);
    }
    return this.client.control.ingest.bind(this.client.control);
  }

  private buildIngestItem(event: CapturedEventEnvelope): Record<string, unknown> {
    return {
      item_id: event.eventId,
      content_type: "text",
      text: eventToText(event),
      payload_json: toJson(event.payload),
      hints_json: toJson({
        source: event.source,
        event_type: event.eventType,
        reasoning_availability: event.reasoningAvailability,
      }),
      metadata_json: toJson({
        repo_id: event.repoId,
        project_id: this.projectId ?? event.repoId,
        actor_id: event.actorId ?? this.actorId ?? null,
        session_id: event.sessionId,
        thread_id: event.threadId,
        ts: event.ts,
      }),
    };
  }

  private buildIngestPayload(runId: string, events: CapturedEventEnvelope[]): Record<string, unknown> {
    const items = events.map((event) => this.buildIngestItem(event));
    const payload: Record<string, unknown> = {
      run_id: runId,
      agent_id: this.agentId,
      parallel: false,
      items,
    };
    if (events.length === 1) {
      payload.idempotency_key = events[0]?.eventId;
    }
    return payload;
  }

  private async ingestEvents(runId: string, events: CapturedEventEnvelope[]): Promise<unknown> {
    const ingest = this.getIngestMethod();
    return await ingest(this.buildIngestPayload(runId, events));
  }

  private async appendMainActivity(runId: string, event: CapturedEventEnvelope): Promise<void> {
    if (!this.client.control.appendActivity) {
      return;
    }

    const appendPayload = {
      run_id: runId,
      agent_id: this.agentId,
      activity: {
        type: "codaph_event",
        payload: toJson(compactActivityEnvelope(event)),
        ts: event.ts,
        agent_id: this.agentId,
        input_ref: event.sessionId,
        output_ref: event.eventId,
      },
    };

    try {
      await this.client.control.appendActivity(appendPayload);
    } catch (firstError) {
      try {
        await this.client.control.appendActivity({
          run_id: runId,
          agent_id: this.agentId,
          activity: {
            type: "codaph_event",
            payload: toJson(minimalActivityEnvelope(event)),
            ts: event.ts,
            agent_id: this.agentId,
            input_ref: event.sessionId,
            output_ref: event.eventId,
          },
        });
      } catch {
        if (process.env.CODAPH_DEBUG === "1") {
          const message = firstError instanceof Error ? firstError.message : "unknown appendActivity error";
          console.warn(`[codaph] appendActivity failed for ${event.eventId}: ${message}`);
        }
      }
    }
  }

  private async appendPromptActivity(event: CapturedEventEnvelope): Promise<void> {
    if (!this.client.control.appendActivity || !isPromptSubmittedEvent(event)) {
      return;
    }

    try {
      await this.client.control.appendActivity({
        run_id: this.promptRunIdForRepo(event.repoId),
        agent_id: this.agentId,
        activity: {
          type: "codaph_prompt",
          payload: toJson(compactPromptActivityEnvelope(event)),
          ts: event.ts,
          agent_id: this.agentId,
          input_ref: event.sessionId,
          output_ref: event.eventId,
        },
      });
    } catch (promptError) {
      if (process.env.CODAPH_DEBUG === "1") {
        const message = promptError instanceof Error ? promptError.message : "unknown prompt appendActivity error";
        console.warn(`[codaph] prompt appendActivity failed for ${event.eventId}: ${message}`);
      }
    }
  }

  private async appendActivitiesForEvent(event: CapturedEventEnvelope, runId: string): Promise<void> {
    if (!this.client.control.appendActivity) {
      return;
    }
    await this.appendMainActivity(runId, event);
    await this.appendPromptActivity(event);
  }

  private async appendActivitiesForBatch(events: CapturedEventEnvelope[], concurrency = 4): Promise<void> {
    if (!this.client.control.appendActivity || events.length === 0) {
      return;
    }

    const limit = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, events.length) }, async () => {
      while (nextIndex < events.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const event = events[currentIndex];
        if (!event) {
          continue;
        }
        const runId = this.runIdForSession(event.repoId, event.sessionId);
        await this.appendActivitiesForEvent(event, runId);
      }
    });
    await Promise.allSettled(workers);
  }

  async writeEvent(event: CapturedEventEnvelope): Promise<MemoryWriteResult> {
    if (!this.isEnabled()) {
      return { accepted: false, raw: { disabled: true } };
    }

    const runId = this.runIdForSession(event.repoId, event.sessionId);
    const result = await this.ingestEvents(runId, [event]);
    const record = asRecord(result);
    await this.appendActivitiesForEvent(event, runId);
    return {
      accepted: asBoolean(record?.accepted) ?? true,
      deduplicated: asBoolean(record?.deduplicated),
      jobId: asString(record?.job_id),
      raw: result,
    };
  }

  async writeEventsBatch(events: CapturedEventEnvelope[]): Promise<void> {
    if (!this.isEnabled() || events.length === 0) {
      return;
    }

    const byRun = new Map<string, CapturedEventEnvelope[]>();
    for (const event of events) {
      const runId = this.runIdForSession(event.repoId, event.sessionId);
      const group = byRun.get(runId);
      if (group) {
        group.push(event);
      } else {
        byRun.set(runId, [event]);
      }
    }

    for (const [runId, group] of byRun.entries()) {
      await this.ingestEvents(runId, group);
    }

    await this.appendActivitiesForBatch(events, 4);
  }

  async writeRunState(runId: string, statePatch: Record<string, unknown>): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    await this.client.control.setVariable({
      run_id: runId,
      name: "codaph.run_state",
      value_json: toJson(statePatch),
      source: "system",
    });
  }

  async querySemanticContext(options: MubitSemanticQueryOptions): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return {
        disabled: true,
        reason: "Mubit is not configured. Set MUBIT_API_KEY or pass --mubit-api-key.",
      };
    }

    const limit = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.floor(options.limit as number) : 8;
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      query: options.query,
      mode: options.mode ?? "direct_bypass",
      direct_lane: options.directLane ?? "hdql_query",
      include_linked_runs: options.includeLinkedRuns ?? false,
      limit,
      embedding: [],
    };
    const requestedLane =
      payload.direct_lane === "hdql_query" || payload.direct_lane === "semantic_search"
        ? (payload.direct_lane as "hdql_query" | "semantic_search")
        : "hdql_query";

    try {
      const result = await this.client.control.query(payload);
      const record = asRecord(result);
      return record ? { ...record, codaph_query_lane: requestedLane } : { raw: result, codaph_query_lane: requestedLane };
    } catch (firstError) {
      if (requestedLane !== "hdql_query" || !looksLikeUnsupportedHdqlLaneError(firstError)) {
        throw firstError;
      }
      const fallbackPayload = { ...payload, direct_lane: "semantic_search" };
      const result = await this.client.control.query(fallbackPayload);
      const record = asRecord(result);
      const fallbackMeta = {
        codaph_query_lane: "semantic_search" as const,
        codaph_query_lane_fallback: "hdql_query" as const,
      };
      return record ? { ...record, ...fallbackMeta } : { raw: result, ...fallbackMeta };
    }
  }

  async fetchContextSnapshot(options: MubitContextSnapshotOptions): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return {
        disabled: true,
        reason: "Mubit is not configured. Set MUBIT_API_KEY or pass --mubit-api-key.",
      };
    }
    if (!this.client.control.contextSnapshot) {
      return {
        unsupported: true,
        reason: "Mubit SDK does not expose control.contextSnapshot in this runtime.",
      };
    }

    const payload: Record<string, unknown> = {
      run_id: options.runId,
      timeline_limit:
        Number.isFinite(options.timelineLimit) && (options.timelineLimit ?? 0) > 0
          ? Math.floor(options.timelineLimit as number)
          : 500,
      refresh: Boolean(options.refresh),
    };
    const result = await this.client.control.contextSnapshot(payload);
    const record = asRecord(result);
    return record ?? { raw: result };
  }
}

export function createMubitMemoryFromEnv(options: Omit<MubitMemoryOptions, "apiKey"> = {}): MubitMemoryEngine | null {
  const apiKey = asString(process.env.MUBIT_API_KEY);
  if (!apiKey) {
    return null;
  }
  return new MubitMemoryEngine({ ...options, apiKey });
}
