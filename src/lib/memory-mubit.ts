import {
  Client,
  type ClientConfig,
  type RecallOptions,
  type RememberOptions,
} from "@mubit-ai/sdk";
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

export interface MubitContextBlockOptions {
  runId: string;
  query: string;
  limit?: number;
  maxTokenBudget?: number;
  includeLinkedRuns?: boolean;
  includeWorkingMemory?: boolean;
  format?: string;
  entryTypes?: string[];
  mode?: string;
  sections?: string[];
  laneFilter?: string;
  agentId?: string;
}

export interface MubitListActivityOptions {
  runId: string;
  userId?: string;
  agentId?: string;
  entryTypes?: string[];
  createdAfter?: string;
  createdBefore?: string;
  sort?: "asc" | "desc";
  limit?: number;
  pageToken?: string;
}

export interface MubitExportActivityOptions extends Omit<MubitListActivityOptions, "pageToken"> {
  format?: string;
}

export interface MubitCheckpointOptions {
  runId: string;
  label: string;
  contextSnapshot?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
  agentId?: string;
}

export interface MubitMemoryHealthOptions {
  runId: string;
  staleThresholdDays?: number;
  limit?: number;
  userId?: string;
  agentId?: string;
}

export interface MubitDiagnoseOptions {
  runId: string;
  errorText: string;
  errorType?: string;
  limit?: number;
  userId?: string;
  agentId?: string;
}

export interface MubitReflectOptions {
  runId: string;
  includeLinkedRuns?: boolean;
  lastNItems?: number;
  userId?: string;
  agentId?: string;
}

export interface MubitSurfaceStrategiesOptions {
  runId: string;
  lessonTypes?: string[];
  maxStrategies?: number;
  userId?: string;
  agentId?: string;
}

export interface MubitRegisterAgentOptions {
  runId: string;
  agentId: string;
  role?: string;
  capabilities?: string[];
  sharedMemoryLanes?: string[];
  metadata?: Record<string, unknown>;
  userId?: string;
}

export interface MubitCreateHandoffOptions {
  runId: string;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  requestedAction?: string;
  metadata?: Record<string, unknown>;
  userId?: string;
}

export interface MubitHandoffFeedbackOptions {
  runId: string;
  handoffId: string;
  verdict: string;
  comments?: string;
  fromAgentId?: string;
  userId?: string;
}

export interface MubitRecordStepOutcomeOptions {
  runId: string;
  stepId: string;
  stepName?: string;
  outcome: string;
  signal?: number;
  rationale?: string;
  directiveHint?: string;
  agentId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface MubitRecordOutcomeOptions {
  runId: string;
  referenceId: string;
  outcome: string;
  signal?: number;
  rationale?: string;
  agentId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
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
  linkRuns?: boolean;
  enabled?: boolean;
  client?: MubitClientLike;
}

interface MubitClientLike {
  remember?(options: RememberOptions): Promise<unknown>;
  recall?(options: RecallOptions): Promise<unknown>;
  core?: {
    ingest?(payload?: Record<string, unknown>): Promise<unknown>;
    insert?(payload?: Record<string, unknown>): Promise<unknown>;
  };
  control: {
    ingest?(payload?: Record<string, unknown>): Promise<unknown>;
    setVariable?(payload?: Record<string, unknown>): Promise<unknown>;
    getVariable?(payload?: Record<string, unknown>): Promise<unknown>;
    listVariables?(payload?: Record<string, unknown>): Promise<unknown>;
    query?(payload?: Record<string, unknown>): Promise<unknown>;
    appendActivity?(payload?: Record<string, unknown>): Promise<unknown>;
    contextSnapshot?(payload?: Record<string, unknown>): Promise<unknown>;
    context?(payload?: Record<string, unknown>): Promise<unknown>;
    listActivity?(payload?: Record<string, unknown>): Promise<unknown>;
    exportActivity?(payload?: Record<string, unknown>): Promise<unknown>;
    getRunIngestStats?(payload?: Record<string, unknown>): Promise<unknown>;
    linkRun?(payload?: Record<string, unknown>): Promise<unknown>;
    unlinkRun?(payload?: Record<string, unknown>): Promise<unknown>;
    memoryHealth?(payload?: Record<string, unknown>): Promise<unknown>;
    diagnose?(payload?: Record<string, unknown>): Promise<unknown>;
    checkpoint?(payload?: Record<string, unknown>): Promise<unknown>;
    registerAgent?(payload?: Record<string, unknown>): Promise<unknown>;
    listAgents?(payload?: Record<string, unknown>): Promise<unknown>;
    reflect?(payload?: Record<string, unknown>): Promise<unknown>;
    surfaceStrategies?(payload?: Record<string, unknown>): Promise<unknown>;
    recordOutcome?(payload?: Record<string, unknown>): Promise<unknown>;
    recordStepOutcome?(payload?: Record<string, unknown>): Promise<unknown>;
    createHandoff?(payload?: Record<string, unknown>): Promise<unknown>;
    submitFeedback?(payload?: Record<string, unknown>): Promise<unknown>;
  };
}

interface JsonObject {
  [key: string]: unknown;
}

interface EnvLike {
  [key: string]: string | undefined;
}

interface ResolvedTransportLike {
  httpEndpoint?: unknown;
  grpcEndpoint?: unknown;
  transport?: unknown;
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

function parseJsonRecord(value: unknown): JsonObject | null {
  const direct = asRecord(value);
  if (direct) {
    return direct;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function envString(env: EnvLike, key: string): string | undefined {
  return asString(env[key]);
}

function normalizeMubitRegion(value: unknown): "eu" | undefined {
  const region = asString(value)?.toLowerCase();
  if (!region) {
    return undefined;
  }
  if (region === "eu" || region === "europe" || region === "europe-west") {
    return "eu";
  }
  return undefined;
}

export function resolveMubitRegionalEndpointDefaults(
  env: EnvLike = process.env,
): Pick<MubitMemoryOptions, "httpEndpoint" | "grpcEndpoint"> {
  const hasExplicitEndpoint =
    Boolean(envString(env, "MUBIT_ENDPOINT")) ||
    Boolean(envString(env, "MUBIT_HTTP_ENDPOINT")) ||
    Boolean(envString(env, "MUBIT_GRPC_ENDPOINT"));
  if (hasExplicitEndpoint) {
    return {};
  }

  const region =
    normalizeMubitRegion(envString(env, "MUBIT_REGION")) ??
    normalizeMubitRegion(envString(env, "MUBIT_INSTANCE_REGION")) ??
    normalizeMubitRegion(envString(env, "MUBIT_TENANT_REGION"));
  if (region === "eu") {
    return {
      httpEndpoint: "https://api.eu.mubit.ai",
      grpcEndpoint: "grpc.api.eu.mubit.ai:443",
    };
  }
  return {};
}

function buildMubitConnectivityHint(env: EnvLike = process.env): string {
  const region =
    normalizeMubitRegion(envString(env, "MUBIT_REGION")) ??
    normalizeMubitRegion(envString(env, "MUBIT_INSTANCE_REGION")) ??
    normalizeMubitRegion(envString(env, "MUBIT_TENANT_REGION"));
  if (region === "eu") {
    return " If this is your EU tenant, set MUBIT_HTTP_ENDPOINT=https://api.eu.mubit.ai and MUBIT_GRPC_ENDPOINT=grpc.api.eu.mubit.ai:443, or export MUBIT_REGION=EU.";
  }
  return " If this tenant is regional, set MUBIT_HTTP_ENDPOINT and MUBIT_GRPC_ENDPOINT, or pass --mubit-http-endpoint and --mubit-grpc-endpoint.";
}

function isConnectivityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to connect|econnrefused|enotfound|http request failed/i.test(message);
}

function describeResolvedEndpoints(transport: ResolvedTransportLike | null): string {
  if (!transport) {
    return "";
  }
  const httpEndpoint = asString(transport.httpEndpoint);
  const grpcEndpoint = asString(transport.grpcEndpoint);
  const mode = asString(transport.transport);
  const parts = [
    httpEndpoint ? `HTTP=${httpEndpoint}` : null,
    grpcEndpoint ? `gRPC=${grpcEndpoint}` : null,
    mode ? `transport=${mode}` : null,
  ].filter((part): part is string => !!part);
  if (parts.length === 0) {
    return "";
  }
  return ` Resolved endpoints: ${parts.join(", ")}.`;
}

function withMubitConnectivityHint(
  error: unknown,
  env: EnvLike = process.env,
  transport: ResolvedTransportLike | null = null,
): Error {
  if (!(error instanceof Error)) {
    return new Error(`${String(error)}${describeResolvedEndpoints(transport)}${buildMubitConnectivityHint(env)}`);
  }
  if (!isConnectivityError(error)) {
    return error;
  }
  if (/MUBIT_HTTP_ENDPOINT|--mubit-http-endpoint/i.test(error.message)) {
    return error;
  }
  return new Error(`${error.message}${describeResolvedEndpoints(transport)}${buildMubitConnectivityHint(env)}`, { cause: error });
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

function stableNodeIdFromEventId(eventId: string): number {
  const hex = eventId.replace(/[^a-fA-F0-9]/g, "");
  const slice = (hex.length >= 13 ? hex.slice(0, 13) : hex.padEnd(13, "0")).toLowerCase();
  const parsed = Number.parseInt(slice, 16);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return parsed;
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

  if (itemType === "codaph_session_summary") {
    const snapshotId = asString(item.snapshot_id);
    const sessionId = asString(item.session_id);
    const promptCount = typeof item.prompt_count === "number" ? item.prompt_count : null;
    const fileCount = typeof item.file_count === "number" ? item.file_count : null;
    const tokenEstimate = typeof item.token_estimate === "number" ? item.token_estimate : null;
    if (snapshotId) {
      output.snapshot_id = snapshotId;
    }
    if (sessionId) {
      output.session_id = sessionId;
    }
    if (promptCount !== null) {
      output.prompt_count = promptCount;
    }
    if (fileCount !== null) {
      output.file_count = fileCount;
    }
    if (tokenEstimate !== null) {
      output.token_estimate = tokenEstimate;
    }
    if (Array.isArray(item.files)) {
      const files = item.files
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
        .map((entry) => ({
          path: asString(entry.path) ?? "(unknown)",
          plus: typeof entry.plus === "number" ? entry.plus : 0,
          minus: typeof entry.minus === "number" ? entry.minus : 0,
        }))
        .slice(0, 300);
      if (files.length > 0) {
        output.files = files;
      }
    }
    return output;
  }

  if (itemType === "codaph_prompt_diff_part") {
    const promptId = typeof item.prompt_id === "number" ? item.prompt_id : null;
    const promptEventId = asString(item.prompt_event_id);
    const snapshotId = asString(item.snapshot_id);
    const partIndex = typeof item.part_index === "number" ? item.part_index : null;
    const partCount = typeof item.part_count === "number" ? item.part_count : null;
    if (snapshotId) {
      output.snapshot_id = snapshotId;
    }
    if (promptId !== null) {
      output.prompt_id = promptId;
    }
    if (promptEventId) {
      output.prompt_event_id = promptEventId;
    }
    if (partIndex !== null) {
      output.part_index = partIndex;
    }
    if (partCount !== null) {
      output.part_count = partCount;
    }
    if (typeof item.truncated === "boolean") {
      output.truncated = item.truncated;
    }
    if (Array.isArray(item.lines)) {
      const lines = item.lines
        .map((line) => (typeof line === "string" ? truncate(line, 500) : null))
        .filter((line): line is string => !!line)
        .slice(0, 220);
      if (lines.length > 0) {
        output.lines = lines;
      }
    }
    if (Array.isArray(item.files)) {
      const files = item.files
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
        .map((entry) => ({
          path: asString(entry.path) ?? "(unknown)",
          plus: typeof entry.plus === "number" ? entry.plus : 0,
          minus: typeof entry.minus === "number" ? entry.minus : 0,
        }))
        .slice(0, 120);
      if (files.length > 0) {
        output.files = files;
      }
    }
    return output;
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

function hasStructuredContextContent(response: Record<string, unknown>): boolean {
  const preferredStrings = [response.context_block, response.context, response.summary];
  if (preferredStrings.some((value) => typeof value === "string" && value.trim().length > 0)) {
    return true;
  }
  if (Array.isArray(response.section_summaries) && response.section_summaries.length > 0) {
    return true;
  }
  if (Array.isArray(response.sources) && response.sources.length > 0) {
    return true;
  }
  return false;
}

function shortIsoTimestamp(value: unknown): string | null {
  const iso = asString(value);
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().replace(".000Z", "Z");
}

function summarizeStrategyLine(strategy: Record<string, unknown>): string | null {
  const description =
    compactString(strategy.description, 260) ??
    compactString(strategy.summary, 260) ??
    compactString(strategy.title, 200);
  if (!description) {
    return null;
  }
  const supportCount =
    typeof strategy.supporting_lesson_count === "number"
      ? strategy.supporting_lesson_count
      : typeof strategy.supportingLessonCount === "number"
        ? strategy.supportingLessonCount
        : null;
  return supportCount && supportCount > 0
    ? `- ${description} (supporting lessons: ${supportCount})`
    : `- ${description}`;
}

function summarizeActivityLine(entry: Record<string, unknown>): { line: string; entryType: string } | null {
  const entryType =
    asString(entry.entry_type) ??
    asString(entry.origin_entry_type) ??
    asString(entry.type) ??
    "activity";
  const metadata = parseJsonRecord(entry.metadata_json);
  const eventType =
    asString(metadata?.event_type) ??
    asString(metadata?.eventType) ??
    asString(entry.event_type) ??
    entryType;
  const sessionId =
    asString(metadata?.session_id) ??
    asString(metadata?.sessionId) ??
    asString(entry.session_id);
  const actorId =
    asString(metadata?.actor_id) ??
    asString(metadata?.actorId) ??
    asString(entry.actor_id);
  const payload = asRecord(metadata?.payload) ?? parseJsonRecord(metadata?.payload) ?? null;
  const text =
    compactString(payload, 220) ??
    compactString(entry.content, 220) ??
    compactString(entry.activity, 220) ??
    compactString(entry.payload, 220);
  const timestamp = shortIsoTimestamp(entry.created_at) ?? shortIsoTimestamp(entry.ts);

  const parts = [
    timestamp,
    eventType,
    actorId ? `[actor:${actorId}]` : null,
    sessionId ? `[session:${sessionId}]` : null,
  ].filter((part): part is string => !!part);

  const header = parts.join(" ");
  if (!header && !text) {
    return null;
  }
  return {
    entryType,
    line: text ? `- ${header}: ${text}` : `- ${header}`,
  };
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

export function mubitSessionSummaryRunIdForProject(
  repoId: string,
  runIdPrefix = "codaph-sessions",
): string {
  return `${runIdPrefix}:${repoId}`;
}

export function mubitDiffRunIdForProject(
  repoId: string,
  runIdPrefix = "codaph-diffs",
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
  private readonly linkRuns: boolean;
  private readonly resolvedTransport: ResolvedTransportLike | null;
  private readonly linkedRunPairs = new Set<string>();

  constructor(options: MubitMemoryOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.agentId = options.agentId ?? "codaph";
    this.runIdPrefix = options.runIdPrefix ?? "codaph";
    this.projectId = asString(options.projectId);
    this.actorId = asString(options.actorId);
    this.runScope = options.runScope ?? "session";
    this.linkRuns = options.linkRuns === true;

    if (options.client) {
      this.client = options.client;
      this.resolvedTransport = asRecord((options.client as unknown as Record<string, unknown>)._transport);
      this.configured = true;
      return;
    }

    const apiKey = asString(options.apiKey ?? process.env.MUBIT_API_KEY);
    this.configured = Boolean(apiKey);
    const regionalDefaults = resolveMubitRegionalEndpointDefaults(process.env);

    const config: ClientConfig = {
      api_key: apiKey,
      transport: options.transport,
      endpoint: options.endpoint,
      http_endpoint: options.httpEndpoint ?? regionalDefaults.httpEndpoint,
      grpc_endpoint: options.grpcEndpoint ?? regionalDefaults.grpcEndpoint,
    };

    this.client = new Client(config) as unknown as MubitClientLike;
    this.resolvedTransport = asRecord((this.client as unknown as Record<string, unknown>)._transport);
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

  projectRunIdForRepo(repoId: string): string {
    const sharedRepoId = this.projectId ?? repoId;
    return mubitRunIdForProject(sharedRepoId, this.runIdPrefix);
  }

  private sessionSummaryRunIdForRepo(repoId: string): string {
    const sharedRepoId = this.projectId ?? repoId;
    return mubitSessionSummaryRunIdForProject(sharedRepoId, `${this.runIdPrefix}-sessions`);
  }

  private diffRunIdForRepo(repoId: string): string {
    const sharedRepoId = this.projectId ?? repoId;
    return mubitDiffRunIdForProject(sharedRepoId, `${this.runIdPrefix}-diffs`);
  }

  private runIdForEvent(event: CapturedEventEnvelope): string {
    if (event.eventType === "codaph.session.summary") {
      return this.sessionSummaryRunIdForRepo(event.repoId);
    }
    if (event.eventType === "codaph.prompt.diff.part") {
      return this.diffRunIdForRepo(event.repoId);
    }
    return this.runIdForSession(event.repoId, event.sessionId);
  }

  private disabledResponse(): Record<string, unknown> {
    return {
      disabled: true,
      reason: "Mubit is not configured. Set MUBIT_API_KEY or pass --mubit-api-key.",
    };
  }

  private unsupportedResponse(method: string): Record<string, unknown> {
    return {
      unsupported: true,
      reason: `Mubit SDK does not expose control.${method} in this runtime.`,
    };
  }

  private async callControlMethod(
    method: keyof MubitClientLike["control"],
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return this.disabledResponse();
    }
    const handler = this.client.control[method];
    if (!handler) {
      return this.unsupportedResponse(String(method));
    }

    let result: unknown;
    try {
      result = await handler.call(this.client.control, payload);
    } catch (error) {
      throw withMubitConnectivityHint(error, process.env, this.resolvedTransport);
    }
    const record = asRecord(result);
    return record ?? { raw: result };
  }

  private async buildFallbackContextBlock(
    options: MubitContextBlockOptions,
    primaryResponse: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const maxStrategies =
      Number.isFinite(options.limit) && (options.limit ?? 0) > 0
        ? Math.max(1, Math.min(3, Math.floor(options.limit as number)))
        : 3;
    const activityLimit =
      Number.isFinite(options.limit) && (options.limit ?? 0) > 0
        ? Math.max(2, Math.min(8, Math.floor(options.limit as number)))
        : 6;

    const [strategiesResponse, activityResponse] = await Promise.all([
      this.surfaceStrategies({
        runId: options.runId,
        maxStrategies,
        agentId: options.agentId,
      }).catch(() => ({}) as Record<string, unknown>),
      this.listActivity({
        runId: options.runId,
        sort: "desc",
        limit: activityLimit,
        agentId: options.agentId,
        entryTypes: options.entryTypes,
      }).catch(() => ({}) as Record<string, unknown>),
    ]);

    const strategyItems = Array.isArray(strategiesResponse.strategies)
      ? strategiesResponse.strategies.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
        )
      : [];
    const activityItems = Array.isArray(activityResponse.entries)
      ? activityResponse.entries.filter(
          (entry): entry is Record<string, unknown> =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry),
        )
      : [];

    const strategyLines = strategyItems.map((entry) => summarizeStrategyLine(entry)).filter((entry): entry is string => !!entry);
    const activitySummaries = activityItems
      .map((entry) => summarizeActivityLine(entry))
      .filter((entry): entry is { line: string; entryType: string } => !!entry);

    if (strategyLines.length === 0 && activitySummaries.length === 0) {
      return primaryResponse;
    }

    const sectionLines: string[] = [
      "Mubit context fallback used because the primary context response was empty.",
    ];
    if (strategyLines.length > 0) {
      sectionLines.push("", "Strategy signals:", ...strategyLines);
    }
    if (activitySummaries.length > 0) {
      sectionLines.push("", "Recent activity:", ...activitySummaries.map((entry) => entry.line));
    }

    const sourceCountsByEntryType: Record<string, number> = {};
    for (const entry of activitySummaries) {
      sourceCountsByEntryType[entry.entryType] = (sourceCountsByEntryType[entry.entryType] ?? 0) + 1;
    }

    return {
      ...primaryResponse,
      context_block: sectionLines.join("\n"),
      fallback_used: true,
      fallback_modes: [
        ...(strategyLines.length > 0 ? ["strategy"] : []),
        ...(activitySummaries.length > 0 ? ["activity"] : []),
      ],
      evidence_candidates_considered: strategyLines.length + activitySummaries.length,
      section_summaries: [
        ...(strategyLines.length > 0
          ? [
              {
                section_name: "Strategy signals",
                summary: `${strategyLines.length} strategy signal${strategyLines.length === 1 ? "" : "s"} surfaced from Mubit lessons.`,
              },
            ]
          : []),
        ...(activitySummaries.length > 0
          ? [
              {
                section_name: "Recent activity",
                summary: `${activitySummaries.length} recent activit${activitySummaries.length === 1 ? "y" : "ies"} surfaced from Mubit activity logs.`,
              },
            ]
          : []),
      ],
      source_counts_by_entry_type: sourceCountsByEntryType,
      source_counts_by_retrieval_mode: {
        strategy: strategyLines.length,
        activity: activitySummaries.length,
      },
      sources: [
        ...strategyItems.slice(0, strategyLines.length).map((entry) => ({
          retrieval_mode: "strategy",
          entry_type: "strategy",
          strategy_id: asString(entry.strategy_id) ?? asString(entry.strategyId) ?? null,
          description:
            compactString(entry.description, 260) ??
            compactString(entry.summary, 260) ??
            compactString(entry.title, 200),
        })),
        ...activityItems.slice(0, activitySummaries.length).map((entry, index) => ({
          retrieval_mode: "activity",
          entry_type:
            asString(entry.entry_type) ??
            asString(entry.origin_entry_type) ??
            asString(entry.type) ??
            "activity",
          id: asString(entry.id) ?? `activity-${index + 1}`,
          created_at: asString(entry.created_at) ?? null,
        })),
      ],
      token_estimate:
        typeof primaryResponse.token_estimate === "number"
          ? primaryResponse.token_estimate
          : sectionLines.join("\n").length,
    };
  }

  private buildIngestItem(event: CapturedEventEnvelope): Record<string, unknown> {
    const hints = {
      source: event.source,
      event_type: event.eventType,
      reasoning_availability: event.reasoningAvailability,
    };
    const metadata = {
      repo_id: event.repoId,
      project_id: this.projectId ?? event.repoId,
      actor_id: event.actorId ?? this.actorId ?? null,
      session_id: event.sessionId,
      thread_id: event.threadId,
      ts: event.ts,
    };

    return {
      item_id: event.eventId,
      content_type: "text",
      text: eventToText(event),
      payload_json: toJson(event.payload),
      hints_json: toJson(hints),
      metadata_json: toJson(metadata),
    };
  }

  private buildRememberOptions(runId: string, event: CapturedEventEnvelope): RememberOptions {
    return {
      session_id: runId,
      content: eventToText(event),
      agent_id: this.agentId,
      item_id: event.eventId,
      content_type: "text",
      metadata: {
        repo_id: event.repoId,
        project_id: this.projectId ?? event.repoId,
        actor_id: event.actorId ?? this.actorId ?? null,
        session_id: event.sessionId,
        thread_id: event.threadId,
        ts: event.ts,
      },
      hints: {
        source: event.source,
        event_type: event.eventType,
        reasoning_availability: event.reasoningAvailability,
      },
      payload: event.payload,
      source: event.source,
      parallel: false,
      wait: false,
      idempotency_key: event.eventId,
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

  private buildCoreInsertPayload(runId: string, event: CapturedEventEnvelope): Record<string, unknown> {
    const metadata = {
      event_id: event.eventId,
      repo_id: event.repoId,
      project_id: this.projectId ?? event.repoId,
      actor_id: event.actorId ?? this.actorId ?? null,
      session_id: event.sessionId,
      thread_id: event.threadId,
      ts: event.ts,
      source: event.source,
      event_type: event.eventType,
      reasoning_availability: event.reasoningAvailability,
      payload: event.payload,
    };

    return {
      id: stableNodeIdFromEventId(event.eventId),
      text: eventToText(event),
      metadata: Buffer.from(toJson(metadata), "utf8"),
      run_id: runId,
      session_id: event.sessionId,
    };
  }

  private async insertEventsViaCore(runId: string, events: CapturedEventEnvelope[]): Promise<unknown> {
    if (!this.client.core?.insert) {
      throw new Error(
        "Mubit ingest is unavailable. Expected client.remember, control.ingest, core.ingest, or core.insert.",
      );
    }

    const results: unknown[] = [];
    for (const event of events) {
      results.push(await this.client.core.insert(this.buildCoreInsertPayload(runId, event)));
    }
    if (events.length === 1) {
      return results[0] ?? { success: true };
    }
    return { success: true, count: results.length, results };
  }

  private async rememberEvent(runId: string, event: CapturedEventEnvelope): Promise<unknown> {
    if (this.client.remember) {
      return await this.client.remember(this.buildRememberOptions(runId, event));
    }
    if (this.client.control.ingest) {
      return await this.client.control.ingest(this.buildIngestPayload(runId, [event]));
    }
    if (this.client.core?.ingest) {
      return await this.client.core.ingest(this.buildIngestPayload(runId, [event]));
    }
    return await this.insertEventsViaCore(runId, [event]);
  }

  private async ingestEvents(runId: string, events: CapturedEventEnvelope[]): Promise<unknown> {
    if (events.length === 1) {
      const [event] = events;
      if (!event) {
        return { accepted: false };
      }
      return await this.rememberEvent(runId, event);
    }
    if (this.client.control.ingest) {
      return await this.client.control.ingest(this.buildIngestPayload(runId, events));
    }
    if (this.client.core?.ingest) {
      return await this.client.core.ingest(this.buildIngestPayload(runId, events));
    }
    return await this.insertEventsViaCore(runId, events);
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
        const runId = this.runIdForEvent(event);
        await this.appendActivitiesForEvent(event, runId);
      }
    });
    await Promise.allSettled(workers);
  }

  private async maybeLinkRunForSession(repoId: string, runId: string): Promise<void> {
    if (!this.linkRuns || this.runScope !== "session") {
      return;
    }
    const projectRunId = this.projectRunIdForRepo(repoId);
    if (projectRunId === runId) {
      return;
    }
    const key = `${projectRunId}=>${runId}`;
    if (this.linkedRunPairs.has(key)) {
      return;
    }
    const result = await this.linkRun(projectRunId, runId);
    if (result.unsupported === true || result.disabled === true) {
      return;
    }
    this.linkedRunPairs.add(key);
  }

  async writeEvent(event: CapturedEventEnvelope): Promise<MemoryWriteResult> {
    if (!this.isEnabled()) {
      return { accepted: false, raw: { disabled: true } };
    }

    const runId = this.runIdForEvent(event);
    const result = await this.ingestEvents(runId, [event]);
    const record = asRecord(result);
    await this.appendActivitiesForEvent(event, runId);
    await this.maybeLinkRunForSession(event.repoId, runId).catch(() => {});
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
      const runId = this.runIdForEvent(event);
      const group = byRun.get(runId);
      if (group) {
        group.push(event);
      } else {
        byRun.set(runId, [event]);
      }
    }

    for (const [runId, group] of byRun.entries()) {
      await this.ingestEvents(runId, group);
      const repoId = group[0]?.repoId;
      if (repoId) {
        await this.maybeLinkRunForSession(repoId, runId).catch(() => {});
      }
    }

    await this.appendActivitiesForBatch(events, 4);
  }

  async writeRunState(runId: string, statePatch: Record<string, unknown>): Promise<void> {
    const result = await this.callControlMethod("setVariable", {
      run_id: runId,
      name: "codaph.run_state",
      value_json: toJson(statePatch),
      source: "system",
    });
    if (result.disabled === true || result.unsupported === true) {
      return;
    }
  }

  async getContextBlock(options: MubitContextBlockOptions): Promise<Record<string, unknown>> {
    const sections = options.sections?.length ? options.sections : undefined;
    const mode = options.mode === "sections" && !sections ? "full" : options.mode;
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      query: options.query,
      include_linked_runs: options.includeLinkedRuns ?? false,
    };
    if (Number.isFinite(options.limit) && (options.limit ?? 0) > 0) {
      payload.limit = Math.floor(options.limit as number);
    }
    if (Number.isFinite(options.maxTokenBudget) && (options.maxTokenBudget ?? 0) > 0) {
      payload.max_token_budget = Math.floor(options.maxTokenBudget as number);
    }
    if (typeof options.includeWorkingMemory === "boolean") {
      payload.include_working_memory = options.includeWorkingMemory;
    }
    if (options.format) {
      payload.format = options.format;
    }
    if (mode) {
      payload.mode = mode;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    if (options.laneFilter) {
      payload.lane_filter = options.laneFilter;
    }
    if (options.entryTypes?.length) {
      payload.entry_types = options.entryTypes;
    }
    if (sections) {
      payload.sections = sections;
    }
    const response = await this.callControlMethod("context", payload);
    if (response.disabled === true) {
      return response;
    }
    if (hasStructuredContextContent(response)) {
      return response;
    }
    return await this.buildFallbackContextBlock(options, response);
  }

  async listActivity(options: MubitListActivityOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
    };
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    if (options.entryTypes?.length) {
      payload.entry_types = options.entryTypes;
    }
    if (options.createdAfter) {
      payload.created_after = options.createdAfter;
    }
    if (options.createdBefore) {
      payload.created_before = options.createdBefore;
    }
    if (options.sort) {
      payload.sort = options.sort;
    }
    if (Number.isFinite(options.limit) && (options.limit ?? 0) > 0) {
      payload.limit = Math.floor(options.limit as number);
    }
    if (options.pageToken) {
      payload.page_token = options.pageToken;
    }
    return await this.callControlMethod("listActivity", payload);
  }

  async exportActivity(options: MubitExportActivityOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
    };
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    if (options.entryTypes?.length) {
      payload.entry_types = options.entryTypes;
    }
    if (options.createdAfter) {
      payload.created_after = options.createdAfter;
    }
    if (options.createdBefore) {
      payload.created_before = options.createdBefore;
    }
    if (options.sort) {
      payload.sort = options.sort;
    }
    if (Number.isFinite(options.limit) && (options.limit ?? 0) > 0) {
      payload.limit = Math.floor(options.limit as number);
    }
    if (options.format) {
      payload.format = options.format;
    }
    return await this.callControlMethod("exportActivity", payload);
  }

  async getRunVariable(runId: string, name: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("getVariable", {
      run_id: runId,
      name,
    });
  }

  async listRunVariables(runId: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("listVariables", {
      run_id: runId,
    });
  }

  async getRunIngestStats(runId: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("getRunIngestStats", {
      run_id: runId,
    });
  }

  async linkRun(runId: string, linkedRunId: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("linkRun", {
      run_id: runId,
      linked_run_id: linkedRunId,
    });
  }

  async unlinkRun(runId: string, linkedRunId: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("unlinkRun", {
      run_id: runId,
      linked_run_id: linkedRunId,
    });
  }

  async createCheckpoint(options: MubitCheckpointOptions): Promise<Record<string, unknown>> {
    const fallbackContextSnapshot =
      options.contextSnapshot && options.contextSnapshot.trim().length > 0
        ? options.contextSnapshot
        : `Codaph checkpoint "${options.label}" for ${options.runId}.`;
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      label: options.label,
      context_snapshot: fallbackContextSnapshot,
    };
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      payload.metadata_json = toJson(options.metadata);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    return await this.callControlMethod("checkpoint", payload);
  }

  async inspectMemoryHealth(options: MubitMemoryHealthOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
    };
    if (Number.isFinite(options.staleThresholdDays) && (options.staleThresholdDays ?? 0) >= 0) {
      payload.stale_threshold_days = Math.floor(options.staleThresholdDays as number);
    }
    if (Number.isFinite(options.limit) && (options.limit ?? 0) > 0) {
      payload.limit = Math.floor(options.limit as number);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    return await this.callControlMethod("memoryHealth", payload);
  }

  async diagnoseFailure(options: MubitDiagnoseOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      error_text: options.errorText,
    };
    if (options.errorType) {
      payload.error_type = options.errorType;
    }
    if (Number.isFinite(options.limit) && (options.limit ?? 0) > 0) {
      payload.limit = Math.floor(options.limit as number);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    return await this.callControlMethod("diagnose", payload);
  }

  async reflectRun(options: MubitReflectOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      include_linked_runs: options.includeLinkedRuns ?? false,
    };
    if (Number.isFinite(options.lastNItems) && (options.lastNItems ?? 0) > 0) {
      payload.last_n_items = Math.floor(options.lastNItems as number);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    return await this.callControlMethod("reflect", payload);
  }

  async surfaceStrategies(options: MubitSurfaceStrategiesOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
    };
    if (options.lessonTypes?.length) {
      payload.lesson_types = options.lessonTypes;
    }
    if (Number.isFinite(options.maxStrategies) && (options.maxStrategies ?? 0) > 0) {
      payload.max_strategies = Math.floor(options.maxStrategies as number);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    return await this.callControlMethod("surfaceStrategies", payload);
  }

  async registerAgent(options: MubitRegisterAgentOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      agent_id: options.agentId,
    };
    if (options.role) {
      payload.role = options.role;
    }
    if (options.capabilities?.length) {
      payload.capabilities = options.capabilities;
    }
    if (options.sharedMemoryLanes?.length) {
      payload.shared_memory_lanes = options.sharedMemoryLanes;
    }
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      payload.metadata_json = toJson(options.metadata);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    return await this.callControlMethod("registerAgent", payload);
  }

  async listAgents(runId: string): Promise<Record<string, unknown>> {
    return await this.callControlMethod("listAgents", {
      run_id: runId,
    });
  }

  async createHandoff(options: MubitCreateHandoffOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      task_id: options.taskId,
      from_agent_id: options.fromAgentId,
      to_agent_id: options.toAgentId,
      content: options.content,
    };
    if (options.requestedAction) {
      payload.requested_action = options.requestedAction;
    }
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      payload.metadata_json = toJson(options.metadata);
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    return await this.callControlMethod("createHandoff", payload);
  }

  async submitHandoffFeedback(options: MubitHandoffFeedbackOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      handoff_id: options.handoffId,
      verdict: options.verdict,
    };
    if (options.comments) {
      payload.comments = options.comments;
    }
    if (options.fromAgentId) {
      payload.from_agent_id = options.fromAgentId;
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    return await this.callControlMethod("submitFeedback", payload);
  }

  async recordStepOutcome(options: MubitRecordStepOutcomeOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      step_id: options.stepId,
      outcome: options.outcome,
    };
    if (options.stepName) {
      payload.step_name = options.stepName;
    }
    if (typeof options.signal === "number" && Number.isFinite(options.signal)) {
      payload.signal = options.signal;
    }
    if (options.rationale) {
      payload.rationale = options.rationale;
    }
    if (options.directiveHint) {
      payload.directive_hint = options.directiveHint;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      payload.metadata_json = toJson(options.metadata);
    }
    return await this.callControlMethod("recordStepOutcome", payload);
  }

  async recordOutcome(options: MubitRecordOutcomeOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      reference_id: options.referenceId,
      outcome: options.outcome,
    };
    if (typeof options.signal === "number" && Number.isFinite(options.signal)) {
      payload.signal = options.signal;
    }
    if (options.rationale) {
      payload.rationale = options.rationale;
    }
    if (options.agentId) {
      payload.agent_id = options.agentId;
    }
    if (options.userId) {
      payload.user_id = options.userId;
    }
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      payload.metadata_json = toJson(options.metadata);
    }
    return await this.callControlMethod("recordOutcome", payload);
  }

  async querySemanticContext(options: MubitSemanticQueryOptions): Promise<Record<string, unknown>> {
    if (!this.isEnabled()) {
      return this.disabledResponse();
    }

    const limit = Number.isFinite(options.limit) && (options.limit ?? 0) > 0 ? Math.floor(options.limit as number) : 8;
    const mode = options.mode ?? "direct_bypass";
    const directLane = options.directLane ?? "hdql_query";
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      query: options.query,
      mode,
      include_linked_runs: options.includeLinkedRuns ?? false,
      limit,
      embedding: [],
    };
    if (mode === "direct_bypass") {
      payload.direct_lane = directLane;
    }
    let result: unknown;
    if (this.client.recall) {
      result = await this.client.recall({
        session_id: options.runId,
        query: options.query,
        mode,
        direct_lane: directLane,
        include_linked_runs: options.includeLinkedRuns ?? false,
        limit,
        embedding: [],
      });
    } else if (this.client.control.query) {
      result = await this.client.control.query(payload);
    } else {
      throw new Error("Mubit recall/query API is unavailable in this runtime.");
    }
    const record = asRecord(result);
    const meta = {
      codaph_query_lane: mode === "direct_bypass" ? directLane : "agent_routed",
      codaph_query_mode: mode,
    };
    return record ? { ...record, ...meta } : { raw: result, ...meta };
  }

  async fetchContextSnapshot(options: MubitContextSnapshotOptions): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      run_id: options.runId,
      timeline_limit:
        Number.isFinite(options.timelineLimit) && (options.timelineLimit ?? 0) > 0
          ? Math.floor(options.timelineLimit as number)
          : 500,
      refresh: Boolean(options.refresh),
    };
    return await this.callControlMethod("contextSnapshot", payload);
  }
}

export function createMubitMemoryFromEnv(options: Omit<MubitMemoryOptions, "apiKey"> = {}): MubitMemoryEngine | null {
  const apiKey = asString(process.env.MUBIT_API_KEY);
  if (!apiKey) {
    return null;
  }
  return new MubitMemoryEngine({ ...options, apiKey });
}
