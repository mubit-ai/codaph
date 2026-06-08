// Token accounting for Claude Code sessions.
//
// Claude Code persists each session as a JSONL transcript under
// ~/.claude/projects/<project>/<session-id>.jsonl. Every assistant message line
// carries a `message.usage` object with the exact token counts the API billed:
//   { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }
// plus `message.model`. We sum these to measure what a session actually cost, so
// the memory-injection features can be proven net-positive (or not) via A/B.
//
// This module is intentionally pure (operates on transcript *content*, not paths)
// so it is trivially unit-testable. File IO lives in the caller.

export interface TokenUsage {
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
  messages: number;
}

export interface TranscriptUsage {
  totals: TokenUsage;
  byModel: Record<string, TokenUsage>;
  lastTimestamp: string | null;
  gitBranch: string | null;
  cwd: string | null;
  sessionId: string | null;
}

// USD per 1,000,000 tokens. Cache-write is the price to create a cache entry
// (cache_creation_input_tokens); cache-read is the discounted price to reuse one.
export interface ModelPrice {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

// Representative public Anthropic list prices as of early 2026. These are
// DEFAULTS only — they drift over time and vary by tier/region, so callers may
// override them via Codaph settings. Keys are matched against the model id by
// exact match first, then case-insensitive substring (so "claude-opus-4-8" and
// "claude-opus-4-8[1m]" both resolve to the "opus" entry).
export const DEFAULT_PRICE_TABLE: PriceTable = {
  opus: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 },
  sonnet: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  haiku: { input: 0.8, cacheWrite: 1.0, cacheRead: 0.08, output: 4 },
};

export function emptyUsage(): TokenUsage {
  return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, messages: 0 };
}

export function addUsage(into: TokenUsage, delta: TokenUsage): TokenUsage {
  into.input += delta.input;
  into.cacheCreate += delta.cacheCreate;
  into.cacheRead += delta.cacheRead;
  into.output += delta.output;
  into.messages += delta.messages;
  return into;
}

// Total tokens that flowed through the model for this usage, useful as a single
// scalar for quick comparisons (it is NOT cost — use estimateCost for that).
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheCreate + usage.cacheRead + usage.output;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Sum the token usage recorded in a Claude Code transcript.
 *
 * Tolerant of malformed lines (skips them) and of schema drift (reads only the
 * fields it knows). Counts every assistant message that carries a `usage`
 * object, including subagent/sidechain turns since those are real billed spend.
 */
export function parseTranscriptUsage(content: string): TranscriptUsage {
  const totals = emptyUsage();
  const byModel: Record<string, TokenUsage> = {};
  let lastTimestamp: string | null = null;
  let gitBranch: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asRecord(parsed);
    if (!obj) {
      continue;
    }

    // Capture session-level metadata from any line that carries it.
    gitBranch = asNonEmptyString(obj.gitBranch) ?? gitBranch;
    cwd = asNonEmptyString(obj.cwd) ?? cwd;
    sessionId = asNonEmptyString(obj.sessionId) ?? sessionId;
    const ts = asNonEmptyString(obj.timestamp);
    if (ts && (lastTimestamp === null || ts > lastTimestamp)) {
      lastTimestamp = ts;
    }

    if (obj.type !== "assistant") {
      continue;
    }
    const message = asRecord(obj.message);
    const usage = asRecord(message?.usage);
    if (!message || !usage) {
      continue;
    }

    const delta: TokenUsage = {
      input: toFiniteNumber(usage.input_tokens),
      cacheCreate: toFiniteNumber(usage.cache_creation_input_tokens),
      cacheRead: toFiniteNumber(usage.cache_read_input_tokens),
      output: toFiniteNumber(usage.output_tokens),
      messages: 1,
    };
    addUsage(totals, delta);

    const model = asNonEmptyString(message.model) ?? "unknown";
    if (!byModel[model]) {
      byModel[model] = emptyUsage();
    }
    addUsage(byModel[model], delta);
  }

  return { totals, byModel, lastTimestamp, gitBranch, cwd, sessionId };
}

// Which agent produced a transcript — selects the right usage parser. Their
// on-disk formats and token-usage shapes differ, but all normalise to the same
// TranscriptUsage so downstream cohort/cost code is provider-agnostic.
export type TranscriptProvider = "claude" | "codex" | "gemini";

// --- Codex (OpenAI) transcripts ---------------------------------------------
//
// Codex persists sessions as JSONL rollouts under ~/.codex/sessions/**. Token
// usage rides on `event_msg` lines whose payload.type is "token_count":
// payload.info carries a CUMULATIVE `total_token_usage` shaped
//   { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens }
// where input_tokens INCLUDES the cached subset and output_tokens INCLUDES
// reasoning (verified on real rollouts: input + output == total). We take the
// final cumulative total as the session total and map it onto TokenUsage:
//   cacheRead   = cached_input_tokens     (discounted, reused prompt)
//   input       = input_tokens − cached   (fresh, full-price prompt)
//   output      = output_tokens           (incl. reasoning)
//   cacheCreate = 0                       (OpenAI bills no separate cache-write line)
export function parseCodexTranscriptUsage(content: string): TranscriptUsage {
  const totals = emptyUsage();
  const byModel: Record<string, TokenUsage> = {};
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let model: string | null = null;
  let cumulative: { input: number; cached: number; output: number } | null = null;
  let turns = 0;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const obj = asRecord(parsed);
    if (!obj) {
      continue;
    }
    const ts = asNonEmptyString(obj.timestamp);
    if (ts && (lastTimestamp === null || ts > lastTimestamp)) {
      lastTimestamp = ts;
    }
    const payload = asRecord(obj.payload);
    // cwd + model live on turn_context payloads; id on session_meta. Best-effort.
    cwd = asNonEmptyString(payload?.cwd) ?? cwd;
    model = asNonEmptyString(payload?.model) ?? model;
    sessionId = asNonEmptyString(payload?.id) ?? asNonEmptyString(payload?.session_id) ?? sessionId;

    if (obj.type === "event_msg" && payload?.type === "token_count") {
      const info = asRecord(payload.info);
      const total = asRecord(info?.total_token_usage);
      if (total) {
        cumulative = {
          input: toFiniteNumber(total.input_tokens),
          cached: toFiniteNumber(total.cached_input_tokens),
          output: toFiniteNumber(total.output_tokens),
        };
      }
      if (asRecord(info?.last_token_usage)) {
        turns += 1;
      }
    }
  }

  if (cumulative) {
    totals.cacheRead = cumulative.cached;
    totals.input = Math.max(0, cumulative.input - cumulative.cached);
    totals.output = cumulative.output;
    totals.cacheCreate = 0;
    totals.messages = turns;
    byModel[model ?? "unknown"] = { ...totals };
  }

  return { totals, byModel, lastTimestamp, gitBranch: null, cwd, sessionId };
}

// --- Gemini CLI transcripts -------------------------------------------------
//
// Gemini logs (JSON or JSONL under ~/.gemini) attach a `usageMetadata` (or
// snake_case `usage_metadata`) object to each model response, shaped
//   { promptTokenCount, candidatesTokenCount, cachedContentTokenCount,
//     thoughtsTokenCount, totalTokenCount }
// PER response (not cumulative), so we sum across every occurrence found by
// walking the parsed structure. Mapping mirrors the Codex one:
//   cacheRead = cachedContentTokenCount
//   input     = promptTokenCount − cached
//   output    = candidatesTokenCount + thoughtsTokenCount  (reasoning billed as output)
// Best-effort: no on-disk sample was available to verify, so it reads only the
// fields it knows and skips anything malformed.
function collectGeminiUsage(node: unknown, into: TokenUsage): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectGeminiUsage(child, into);
    }
    return;
  }
  const rec = asRecord(node);
  if (!rec) {
    return;
  }
  const usage = asRecord(rec.usageMetadata) ?? asRecord(rec.usage_metadata);
  if (usage) {
    const prompt = toFiniteNumber(usage.promptTokenCount ?? usage.prompt_token_count);
    const cached = toFiniteNumber(usage.cachedContentTokenCount ?? usage.cached_content_token_count);
    const candidates = toFiniteNumber(usage.candidatesTokenCount ?? usage.candidates_token_count);
    const thoughts = toFiniteNumber(usage.thoughtsTokenCount ?? usage.thoughts_token_count);
    into.cacheRead += cached;
    into.input += Math.max(0, prompt - cached);
    into.output += candidates + thoughts;
    into.messages += 1;
  }
  for (const value of Object.values(rec)) {
    if (typeof value === "object" && value !== null) {
      collectGeminiUsage(value, into);
    }
  }
}

export function parseGeminiTranscriptUsage(content: string): TranscriptUsage {
  const totals = emptyUsage();
  const byModel: Record<string, TokenUsage> = {};
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;
  let sessionId: string | null = null;
  let model: string | null = null;

  // Gemini logs are sometimes one JSON document, sometimes JSONL. Try the whole
  // thing first; fall back to per-line parsing.
  const nodes: unknown[] = [];
  try {
    nodes.push(JSON.parse(content));
  } catch {
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      try {
        nodes.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
  }

  for (const node of nodes) {
    collectGeminiUsage(node, totals);
    const rec = asRecord(node);
    if (rec) {
      cwd = asNonEmptyString(rec.cwd) ?? asNonEmptyString(rec.projectRoot) ?? cwd;
      sessionId = asNonEmptyString(rec.sessionId) ?? asNonEmptyString(rec.session_id) ?? sessionId;
      model = asNonEmptyString(rec.model) ?? model;
      const ts = asNonEmptyString(rec.timestamp) ?? asNonEmptyString(rec.ts);
      if (ts && (lastTimestamp === null || ts > lastTimestamp)) {
        lastTimestamp = ts;
      }
    }
  }

  if (totals.messages > 0) {
    byModel[model ?? "unknown"] = { ...totals };
  }
  return { totals, byModel, lastTimestamp, gitBranch: null, cwd, sessionId };
}

/** Parse a transcript's token usage using the parser for its producing agent. */
export function parseTranscriptUsageForProvider(content: string, provider: TranscriptProvider): TranscriptUsage {
  switch (provider) {
    case "codex":
      return parseCodexTranscriptUsage(content);
    case "gemini":
      return parseGeminiTranscriptUsage(content);
    default:
      return parseTranscriptUsage(content);
  }
}

/** Resolve the price for a model id: exact match, then case-insensitive substring. */
export function resolveModelPrice(model: string, table: PriceTable = DEFAULT_PRICE_TABLE): ModelPrice | null {
  if (table[model]) {
    return table[model];
  }
  const lower = model.toLowerCase();
  for (const [key, price] of Object.entries(table)) {
    if (lower.includes(key.toLowerCase())) {
      return price;
    }
  }
  return null;
}

/** Estimate USD cost for one model's usage. Returns 0 when the model is unpriced. */
export function estimateCost(usage: TokenUsage, price: ModelPrice | null): number {
  if (!price) {
    return 0;
  }
  return (
    (usage.input * price.input +
      usage.cacheCreate * price.cacheWrite +
      usage.cacheRead * price.cacheRead +
      usage.output * price.output) /
    1_000_000
  );
}

// USD cost split by token type. The headline insight for cost reduction:
// output is priced ~50x cache-read, so it can dominate COST while being a tiny
// fraction of TOKENS. A token-count view hides this; this breakdown surfaces it.
export interface CostByType {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function emptyCostByType(): CostByType {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

export function addCostByType(into: CostByType, delta: CostByType): CostByType {
  into.input += delta.input;
  into.cacheWrite += delta.cacheWrite;
  into.cacheRead += delta.cacheRead;
  into.output += delta.output;
  return into;
}

export function totalCostByType(cost: CostByType): number {
  return cost.input + cost.cacheWrite + cost.cacheRead + cost.output;
}

/** USD cost split by token type for one model's usage (all 0 when unpriced). */
export function estimateCostByType(usage: TokenUsage, price: ModelPrice | null): CostByType {
  if (!price) {
    return emptyCostByType();
  }
  return {
    input: (usage.input * price.input) / 1_000_000,
    cacheWrite: (usage.cacheCreate * price.cacheWrite) / 1_000_000,
    cacheRead: (usage.cacheRead * price.cacheRead) / 1_000_000,
    output: (usage.output * price.output) / 1_000_000,
  };
}

export interface TranscriptCost {
  totalUsd: number;
  byModelUsd: Record<string, number>;
  unpricedModels: string[];
}

/** Estimate USD cost across all models in a parsed transcript. */
export function estimateTranscriptCost(
  usage: TranscriptUsage,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): TranscriptCost {
  const byModelUsd: Record<string, number> = {};
  const unpricedModels: string[] = [];
  let totalUsd = 0;
  for (const [model, modelUsage] of Object.entries(usage.byModel)) {
    const price = resolveModelPrice(model, table);
    if (!price) {
      unpricedModels.push(model);
    }
    const cost = estimateCost(modelUsage, price);
    byModelUsd[model] = cost;
    totalUsd += cost;
  }
  return { totalUsd, byModelUsd, unpricedModels };
}

// ---------------------------------------------------------------------------
// Session token records — the durable, queryable shape we write to the mirror
// (event type "codaph.session.tokens") so `codaph tokens` can report and A/B.
// ---------------------------------------------------------------------------

export const SESSION_TOKENS_EVENT_TYPE = "codaph.session.tokens";
export const SESSION_TOKENS_SCHEMA = "codaph.session.tokens.v1";

// How injection was configured when this session ran — lets `--compare` split
// sessions into injection-on vs injection-off cohorts. Written best-effort by
// the injection hooks; absent (active:false) when injection never ran.
export interface SessionInjectionTag {
  active: boolean;
  injectedTokens: number;
  config: string | null;
}

export interface SessionTokensPayload {
  schema: string;
  session_id: string;
  cwd: string | null;
  git_branch: string | null;
  transcript_path: string | null;
  totals: TokenUsage;
  by_model: Record<string, TokenUsage>;
  cost_usd: number;
  by_model_usd: Record<string, number>;
  unpriced_models: string[];
  injection: SessionInjectionTag;
}

/** Build the event payload recorded per session at SessionEnd. */
export function buildSessionTokensPayload(args: {
  sessionId: string;
  usage: TranscriptUsage;
  cost: TranscriptCost;
  transcriptPath: string | null;
  injection?: SessionInjectionTag;
}): SessionTokensPayload {
  return {
    schema: SESSION_TOKENS_SCHEMA,
    session_id: args.sessionId,
    cwd: args.usage.cwd,
    git_branch: args.usage.gitBranch,
    transcript_path: args.transcriptPath,
    totals: args.usage.totals,
    by_model: args.usage.byModel,
    cost_usd: args.cost.totalUsd,
    by_model_usd: args.cost.byModelUsd,
    unpriced_models: args.cost.unpricedModels,
    injection: args.injection ?? { active: false, injectedTokens: 0, config: null },
  };
}

function readUsageRecord(value: unknown): TokenUsage {
  const rec = asRecord(value);
  return {
    input: toFiniteNumber(rec?.input),
    cacheCreate: toFiniteNumber(rec?.cacheCreate),
    cacheRead: toFiniteNumber(rec?.cacheRead),
    output: toFiniteNumber(rec?.output),
    messages: toFiniteNumber(rec?.messages),
  };
}

/** Defensively read a stored payload back into the typed shape. */
export function parseSessionTokensPayload(value: unknown): SessionTokensPayload | null {
  const rec = asRecord(value);
  const sessionId = asNonEmptyString(rec?.session_id);
  if (!rec || !sessionId) {
    return null;
  }
  const injectionRec = asRecord(rec.injection);
  return {
    schema: asNonEmptyString(rec.schema) ?? SESSION_TOKENS_SCHEMA,
    session_id: sessionId,
    cwd: asNonEmptyString(rec.cwd),
    git_branch: asNonEmptyString(rec.git_branch),
    transcript_path: asNonEmptyString(rec.transcript_path),
    totals: readUsageRecord(rec.totals),
    by_model: ((): Record<string, TokenUsage> => {
      const out: Record<string, TokenUsage> = {};
      const byModel = asRecord(rec.by_model);
      if (byModel) {
        for (const [model, usage] of Object.entries(byModel)) {
          out[model] = readUsageRecord(usage);
        }
      }
      return out;
    })(),
    cost_usd: toFiniteNumber(rec.cost_usd),
    by_model_usd: ((): Record<string, number> => {
      const out: Record<string, number> = {};
      const byModelUsd = asRecord(rec.by_model_usd);
      if (byModelUsd) {
        for (const [model, cost] of Object.entries(byModelUsd)) {
          out[model] = toFiniteNumber(cost);
        }
      }
      return out;
    })(),
    unpriced_models: Array.isArray(rec.unpriced_models)
      ? rec.unpriced_models.filter((m): m is string => typeof m === "string")
      : [],
    injection: injectionRec
      ? {
          active: injectionRec.active === true,
          injectedTokens: toFiniteNumber(injectionRec.injectedTokens),
          config: asNonEmptyString(injectionRec.config),
        }
      : { active: false, injectedTokens: 0, config: null },
  };
}

/**
 * Collapse multiple snapshots of the same session to the most complete one.
 * SessionEnd may fire more than once for a session (e.g. resume), each time
 * recording cumulative usage; we keep the snapshot with the most messages.
 */
export function latestSessionTokenRecords(records: SessionTokensPayload[]): SessionTokensPayload[] {
  const bySession = new Map<string, SessionTokensPayload>();
  for (const record of records) {
    const existing = bySession.get(record.session_id);
    if (!existing || record.totals.messages >= existing.totals.messages) {
      bySession.set(record.session_id, record);
    }
  }
  return [...bySession.values()];
}

export interface SessionTokenCohort {
  sessions: number;
  usage: TokenUsage;
  costUsd: number;
  costByType: CostByType;
  injectedTokens: number;
}

function emptyCohort(): SessionTokenCohort {
  return { sessions: 0, usage: emptyUsage(), costUsd: 0, costByType: emptyCostByType(), injectedTokens: 0 };
}

function addToCohort(cohort: SessionTokenCohort, record: SessionTokensPayload, priceTable: PriceTable): void {
  cohort.sessions += 1;
  addUsage(cohort.usage, record.totals);
  cohort.costUsd += record.cost_usd;
  cohort.injectedTokens += record.injection.injectedTokens;
  // Re-price per-model usage by type so the breakdown reflects the (possibly
  // overridden) price table; sums to ~cost_usd under the same table.
  for (const [model, usage] of Object.entries(record.by_model)) {
    addCostByType(cohort.costByType, estimateCostByType(usage, resolveModelPrice(model, priceTable)));
  }
}

export interface SessionTokenReport {
  all: SessionTokenCohort;
  injectionOn: SessionTokenCohort;
  injectionOff: SessionTokenCohort;
}

/** Aggregate session records into overall + injection-on/off cohorts (for --compare). */
export function summarizeSessionTokens(
  records: SessionTokensPayload[],
  priceTable: PriceTable = DEFAULT_PRICE_TABLE,
): SessionTokenReport {
  const report: SessionTokenReport = {
    all: emptyCohort(),
    injectionOn: emptyCohort(),
    injectionOff: emptyCohort(),
  };
  for (const record of latestSessionTokenRecords(records)) {
    addToCohort(report.all, record, priceTable);
    addToCohort(record.injection.active ? report.injectionOn : report.injectionOff, record, priceTable);
  }
  return report;
}

/**
 * Average cost per session for a cohort — the headline number for A/B. Returns
 * 0 for an empty cohort. Compare injectionOn vs injectionOff to judge savings.
 */
export function averageCostPerSession(cohort: SessionTokenCohort): number {
  return cohort.sessions > 0 ? cohort.costUsd / cohort.sessions : 0;
}
