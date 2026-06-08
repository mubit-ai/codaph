// Context-cost attribution for Claude Code sessions.
//
// Cache-read is ~a third of session cost and it compounds: every assistant turn
// re-reads the entire accumulated context at cache-read price. A large tool
// result (a 2,000-line Read, a wide Grep, a noisy Bash run) is therefore taxed
// once per *subsequent* turn for the rest of the session. This module attributes
// that compounding tax to the individual tool results that drive it, so the
// quality-safe win — offloading exploration to a subagent, which reads the real
// file but returns only a short summary so the bulk never enters the main
// context — can be quantified instead of guessed.
//
// Pure: operates on transcript *content*, not paths. File IO lives in the caller.
import { DEFAULT_PRICE_TABLE, resolveModelPrice, type ModelPrice, type PriceTable } from "./token-accounting";

// Tools whose large results are exploration output that a subagent could absorb
// (it reads the real thing and hands back a summary). Edit/Write/etc. are real
// actions with small results — not offloadable.
const OFFLOADABLE_TOOLS = new Set(["read", "grep", "glob", "bash", "webfetch", "notebookread", "toolsearch"]);

export interface ContextCostDriver {
  toolName: string;
  target: string | null; // file path / pattern / command — what the call was about
  toolUseId: string;
  turnIssued: number; // 1-based assistant-turn index that issued the tool_use
  resultTokens: number; // estimated size of the tool result
  rereadTurns: number; // later turns that re-read this result (N - turnIssued)
  cacheWriteUsd: number; // one-time write when the result first enters context
  cacheReadUsd: number; // compounding re-read tax across later turns
  totalUsd: number; // cacheWriteUsd + cacheReadUsd — what offloading would save (less the summary)
  offloadable: boolean;
}

export interface ContextAttribution {
  model: string;
  assistantTurns: number;
  toolResults: number;
  totalResultTokens: number;
  attributableUsd: number; // sum of totalUsd over all tool results
  offloadableUsd: number; // sum over offloadable tool results
  cacheReadUsdActual: number; // actual cache-read cost from usage (grounding)
  cacheWriteUsdActual: number; // actual cache-write cost from usage
  drivers: ContextCostDriver[]; // sorted desc by totalUsd
  unpriced: boolean; // true when the model had no price (USD figures are 0)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Rough token estimate (≈4 chars/token) — for sizing/ranking, not billing. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Flatten a tool_result `content` (string or block array) to text for sizing. */
export function toolResultContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (!rec) {
      parts.push(typeof block === "string" ? block : JSON.stringify(block));
      continue;
    }
    const text = asText(rec.text) ?? asText(rec.content);
    parts.push(text ?? JSON.stringify(rec));
  }
  return parts.join("\n");
}

/** A short human label for what a tool call targeted, by tool. */
export function toolTarget(toolName: string, input: Record<string, unknown> | null): string | null {
  const name = toolName.toLowerCase();
  const i = input ?? {};
  if (name === "bash") {
    const cmd = asText(i.command);
    return cmd ? (cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd) : null;
  }
  if (name === "grep") {
    const pattern = asText(i.pattern);
    const path = asText(i.path);
    return pattern ? `${pattern}${path ? ` in ${path}` : ""}` : null;
  }
  if (name === "glob") {
    return asText(i.pattern);
  }
  if (name === "webfetch") {
    return asText(i.url);
  }
  return asText(i.file_path) ?? asText(i.path) ?? asText(i.pattern) ?? asText(i.notebook_path);
}

interface PendingToolUse {
  toolName: string;
  target: string | null;
  turnIssued: number;
}

/**
 * Attribute compounding context cost to the tool results that drive it.
 * Returns null when the transcript has no assistant turns.
 */
export function attributeContextCost(content: string, priceTable: PriceTable = DEFAULT_PRICE_TABLE): ContextAttribution | null {
  const toolUses = new Map<string, PendingToolUse>();
  const resultTokensById = new Map<string, number>();
  let assistantTurns = 0;
  let model = "unknown";
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

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
    const message = asRecord(obj.message);
    const blocks = Array.isArray(message?.content) ? message?.content : null;

    if (obj.type === "assistant" && message) {
      const usage = asRecord(message.usage);
      if (usage) {
        assistantTurns += 1;
        cacheReadTokens += toFinite(usage.cache_read_input_tokens);
        cacheWriteTokens += toFinite(usage.cache_creation_input_tokens);
        const m = asText(message.model);
        if (m) {
          model = m;
        }
      }
      // tool_use blocks are issued during THIS assistant turn.
      if (blocks) {
        for (const block of blocks) {
          const rec = asRecord(block);
          if (rec?.type !== "tool_use") {
            continue;
          }
          const id = asText(rec.id);
          const name = asText(rec.name);
          if (id && name) {
            toolUses.set(id, {
              toolName: name,
              target: toolTarget(name, asRecord(rec.input)),
              turnIssued: assistantTurns,
            });
          }
        }
      }
      continue;
    }

    // tool_result blocks arrive in user messages after the issuing turn.
    if (blocks) {
      for (const block of blocks) {
        const rec = asRecord(block);
        if (rec?.type !== "tool_result") {
          continue;
        }
        const id = asText(rec.tool_use_id);
        if (id) {
          resultTokensById.set(id, estimateTokens(toolResultContentToText(rec.content)));
        }
      }
    }
  }

  if (assistantTurns === 0) {
    return null;
  }

  const price: ModelPrice | null = resolveModelPrice(model, priceTable);
  const cacheReadPerToken = price ? price.cacheRead / 1_000_000 : 0;
  const cacheWritePerToken = price ? price.cacheWrite / 1_000_000 : 0;

  const drivers: ContextCostDriver[] = [];
  let totalResultTokens = 0;
  for (const [id, use] of toolUses) {
    const resultTokens = resultTokensById.get(id) ?? 0;
    if (resultTokens === 0) {
      continue;
    }
    totalResultTokens += resultTokens;
    // First appearance (turnIssued + 1) is a cache write; turns after that re-read it.
    const rereadTurns = Math.max(0, assistantTurns - use.turnIssued);
    const readTurns = Math.max(0, rereadTurns - 1);
    const cacheWriteUsd = resultTokens * cacheWritePerToken;
    const cacheReadUsd = resultTokens * readTurns * cacheReadPerToken;
    drivers.push({
      toolName: use.toolName,
      target: use.target,
      toolUseId: id,
      turnIssued: use.turnIssued,
      resultTokens,
      rereadTurns,
      cacheWriteUsd,
      cacheReadUsd,
      totalUsd: cacheWriteUsd + cacheReadUsd,
      offloadable: OFFLOADABLE_TOOLS.has(use.toolName.toLowerCase()),
    });
  }
  drivers.sort((a, b) => b.totalUsd - a.totalUsd || b.resultTokens - a.resultTokens);

  const attributableUsd = drivers.reduce((sum, d) => sum + d.totalUsd, 0);
  const offloadableUsd = drivers.reduce((sum, d) => sum + (d.offloadable ? d.totalUsd : 0), 0);

  return {
    model,
    assistantTurns,
    toolResults: drivers.length,
    totalResultTokens,
    attributableUsd,
    offloadableUsd,
    cacheReadUsdActual: cacheReadTokens * cacheReadPerToken,
    cacheWriteUsdActual: cacheWriteTokens * cacheWritePerToken,
    drivers,
    unpriced: price === null,
  };
}

// ---------------------------------------------------------------------------
// Cross-session aggregation
// ---------------------------------------------------------------------------
//
// A single session's attribution shows what cost THIS run. Aggregating across
// many sessions answers the question that actually drives optimisation: which
// (tool, target) pairs are read OVER AND OVER, paying the compounding tax every
// time? Those recurring offloadable targets — a config file every session reads,
// a wide grep everyone runs — are the prime candidates to cache a summary for
// (Phase 2.3 offloading), because a cached summary amortises across every future
// session that would otherwise re-read the bulk.

export interface AggregateTargetDriver {
  toolName: string;
  target: string | null; // file path / pattern / command
  sessions: number; // distinct sessions this (tool,target) appeared in
  occurrences: number; // total tool calls across all sessions
  resultTokens: number; // summed result tokens
  totalUsd: number; // summed compounding tax (write + re-read) across sessions
  offloadable: boolean; // true if the tool's result is exploration a summary could replace
}

export interface AggregateAttribution {
  sessions: number; // number of session attributions aggregated
  assistantTurns: number; // summed across sessions
  toolResults: number; // summed across sessions
  totalResultTokens: number; // summed across sessions
  attributableUsd: number; // summed compounding tax across sessions
  offloadableUsd: number; // summed offloadable tax across sessions
  cacheReadUsdActual: number; // summed actual cache-read cost (grounding)
  cacheWriteUsdActual: number; // summed actual cache-write cost
  unpriced: boolean; // true when any aggregated session was unpriced
  targets: AggregateTargetDriver[]; // recurring (tool,target) pairs, sorted desc by totalUsd
}

// Group key for a (tool, target) pair. NUL-separated so a tool name and target
// can't collide across the boundary.
function targetKey(toolName: string, target: string | null): string {
  return `${toolName.toLowerCase()} ${target ?? ""}`;
}

/**
 * Aggregate per-session attributions into cross-session totals and a ranking of
 * the recurring (tool, target) pairs that drive the most compounding tax. The
 * ranking is the offload work-list: high `totalUsd` + high `sessions` = a target
 * whose summary, cached once, pays back on every future session.
 */
export function aggregateAttributions(attributions: ContextAttribution[]): AggregateAttribution {
  const agg: AggregateAttribution = {
    sessions: attributions.length,
    assistantTurns: 0,
    toolResults: 0,
    totalResultTokens: 0,
    attributableUsd: 0,
    offloadableUsd: 0,
    cacheReadUsdActual: 0,
    cacheWriteUsdActual: 0,
    unpriced: false,
    targets: [],
  };

  const byTarget = new Map<string, AggregateTargetDriver>();
  for (const a of attributions) {
    agg.assistantTurns += a.assistantTurns;
    agg.toolResults += a.toolResults;
    agg.totalResultTokens += a.totalResultTokens;
    agg.attributableUsd += a.attributableUsd;
    agg.offloadableUsd += a.offloadableUsd;
    agg.cacheReadUsdActual += a.cacheReadUsdActual;
    agg.cacheWriteUsdActual += a.cacheWriteUsdActual;
    if (a.unpriced) {
      agg.unpriced = true;
    }
    // Count each (tool,target) at most once toward `sessions` per attribution.
    const seenThisSession = new Set<string>();
    for (const d of a.drivers) {
      const key = targetKey(d.toolName, d.target);
      let entry = byTarget.get(key);
      if (!entry) {
        entry = {
          toolName: d.toolName,
          target: d.target,
          sessions: 0,
          occurrences: 0,
          resultTokens: 0,
          totalUsd: 0,
          offloadable: d.offloadable,
        };
        byTarget.set(key, entry);
      }
      entry.occurrences += 1;
      entry.resultTokens += d.resultTokens;
      entry.totalUsd += d.totalUsd;
      entry.offloadable = entry.offloadable || d.offloadable;
      if (!seenThisSession.has(key)) {
        seenThisSession.add(key);
        entry.sessions += 1;
      }
    }
  }

  agg.targets = [...byTarget.values()].sort(
    (x, y) => y.totalUsd - x.totalUsd || y.sessions - x.sessions || y.resultTokens - x.resultTokens,
  );
  return agg;
}
