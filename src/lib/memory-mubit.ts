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
  client?: {
    control: {
      ingest(payload?: Record<string, unknown>): Promise<unknown>;
      setVariable(payload?: Record<string, unknown>): Promise<unknown>;
      query(payload?: Record<string, unknown>): Promise<unknown>;
      appendActivity?(payload?: Record<string, unknown>): Promise<unknown>;
      contextSnapshot?(payload?: Record<string, unknown>): Promise<unknown>;
    };
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

export class MubitMemoryEngine implements MemoryEngine {
  private readonly client: {
    control: {
      ingest(payload?: Record<string, unknown>): Promise<unknown>;
      setVariable(payload?: Record<string, unknown>): Promise<unknown>;
      query(payload?: Record<string, unknown>): Promise<unknown>;
      appendActivity?(payload?: Record<string, unknown>): Promise<unknown>;
      contextSnapshot?(payload?: Record<string, unknown>): Promise<unknown>;
    };
  };

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

    this.client = new Client(config) as unknown as {
      control: {
        ingest(payload?: Record<string, unknown>): Promise<unknown>;
        setVariable(payload?: Record<string, unknown>): Promise<unknown>;
        query(payload?: Record<string, unknown>): Promise<unknown>;
        appendActivity?(payload?: Record<string, unknown>): Promise<unknown>;
        contextSnapshot?(payload?: Record<string, unknown>): Promise<unknown>;
      };
    };
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

  async writeEvent(event: CapturedEventEnvelope): Promise<MemoryWriteResult> {
    if (!this.isEnabled()) {
      return { accepted: false, raw: { disabled: true } };
    }

    const runId = this.runIdForSession(event.repoId, event.sessionId);
    const ingestPayload: Record<string, unknown> = {
      run_id: runId,
      agent_id: this.agentId,
      idempotency_key: event.eventId,
      parallel: false,
      items: [
        {
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
        },
      ],
    };

    const result = await this.client.control.ingest(ingestPayload);
    const record = asRecord(result);
    if (this.client.control.appendActivity) {
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
    return {
      accepted: asBoolean(record?.accepted) ?? true,
      deduplicated: asBoolean(record?.deduplicated),
      jobId: asString(record?.job_id),
      raw: result,
    };
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
      direct_lane: options.directLane ?? "semantic_search",
      include_linked_runs: options.includeLinkedRuns ?? false,
      limit,
      embedding: [],
    };

    const result = await this.client.control.query(payload);
    const record = asRecord(result);
    return record ?? { raw: result };
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
