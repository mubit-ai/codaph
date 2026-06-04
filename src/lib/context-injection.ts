// Builds the memory context that Codaph injects back into Claude Code sessions
// (via SessionStart / UserPromptSubmit / PreToolUse hooks) to cut the tokens
// Claude would otherwise spend re-discovering the project.
//
// Logic is split into PURE helpers (extraction, budgeting, formatting, hook
// output, gating — all unit-testable without Mubit) and thin ORCHESTRATORS
// that call the Mubit engine and compose the pure helpers. Orchestrators are
// always fail-open: any error yields null (no injection), never a thrown hook.
import type { MubitMemoryEngine } from "./memory-mubit";
import type { ResolvedInjectionConfig } from "./injection-config";
import type { PreToolUseInjectionMode } from "../settings-store";

// A heading + body section of an injected block.
export interface InjectionPart {
  heading: string;
  body: string;
}

// Shown atop every injection so the model treats memory as hints, not truth —
// stale memory that is trusted blindly costs MORE tokens (chasing wrong leads).
export const INJECTION_TRUST_HEADER =
  "Codaph memory distilled from prior captured agent sessions on this project. " +
  "Use it to avoid re-exploring — but verify against the current code before relying on specifics; " +
  "it may be stale and does not necessarily reflect the latest state.";

// Generic, durable-facts query for the SessionStart project digest. Asks for
// the things a developer needs to NOT rediscover: layout, conventions, decisions.
export const PROJECT_OVERVIEW_QUERY =
  "State durable facts about THIS codebase that a developer needs in order to avoid re-exploring: " +
  "which file or module implements each subsystem (give paths), how key components fit together, " +
  "important conventions, and notable decisions. Do NOT narrate what past sessions did " +
  "(no 'the user explored…', 'the agent listed…'); state knowledge, not activity. " +
  "Prefer durable pointers over volatile detail.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== null);
}

/** Rough token estimate (≈4 chars/token) — used only for budgeting, not billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Hard cap a string to a token budget, appending a truncation marker if cut. */
export function clampToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, Math.trunc(maxTokens)) * 4;
  if (maxChars === 0 || text.length <= maxChars) {
    return text;
  }
  const marker = "\n…(truncated by Codaph token budget)";
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

// A line whose subject is an actor doing something is *activity narration*
// ("The user explored…", "The agent initiated…") — a record of what a past
// session DID, not a durable fact about the codebase. These prefixes catch the
// overwhelming majority Mubit surfaces from captured agent activity.
const NARRATION_SUBJECT_PREFIXES = [
  "the user",
  "the developer",
  "the agent",
  "the assistant",
  "the contributor",
  "the team",
  "the request maps",
  "user ",
  "we ",
];

// Bare leading verbs (no subject) that likewise mark a line as session activity
// rather than knowledge. Deliberately limited to investigative/navigational
// verbs — construction verbs (implements/handles/etc.) often start real facts.
const NARRATION_LEADING_VERB =
  /^(explored|listed|retrieved|inspected|accessed|viewed|opened|ran|executed|navigated|searched|mapped|performed|initiated|analy[sz]ed|reviewed|examined|investigated|audited|requested|asked|identified|began|started|continued|attempted|tried|checked|looked)\b/;

/**
 * True when a fact line is activity narration (what an actor did) rather than
 * durable codebase knowledge (where things live / how things work). Injecting
 * narration prevents no re-exploration yet rides in cache every turn, so it is
 * pure net-negative tax — we strip it before injecting.
 */
export function isActivityNarration(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length === 0) {
    return false;
  }
  if (NARRATION_SUBJECT_PREFIXES.some((prefix) => t.startsWith(prefix))) {
    return true;
  }
  return NARRATION_LEADING_VERB.test(t);
}

/**
 * Distil a retrieved Mubit context block down to durable, injectable facts:
 * drop (a) "(source: …, score: …)" citation noise, (b) activity-narration
 * bullets, and (c) section headers left empty after filtering. Returns "" when
 * nothing durable survives, so callers inject nothing rather than pay the
 * cache-read tax for narration. This is the key guard that keeps injection from
 * going net-negative when a project's memory is dominated by activity logs.
 */
export function distillFactsBlock(text: string): string {
  type Line = { kind: "header" | "content" | "blank"; text: string };
  const parsed: Line[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      parsed.push({ kind: "blank", text: "" });
      continue;
    }
    if (/^\(?\s*source\s*:/i.test(trimmed)) {
      continue; // provenance / "(source: …, score: …)" noise
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      parsed.push({ kind: "header", text: trimmed });
      continue;
    }
    const bullet = trimmed.match(/^([-*]|\d+[.)])\s+(.*)$/);
    const content = (bullet ? bullet[2] : trimmed).replace(/\s*\(source:[^)]*\)\s*$/i, "").trim();
    if (content.length === 0 || isActivityNarration(content)) {
      continue;
    }
    parsed.push({ kind: "content", text: bullet ? `- ${content}` : content });
  }

  // Emit, dropping headers with no content before the next header and
  // collapsing blank runs so the result stays tight.
  const out: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i]!;
    if (line.kind === "blank") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
      continue;
    }
    if (line.kind === "header") {
      let hasContent = false;
      for (let j = i + 1; j < parsed.length && parsed[j]!.kind !== "header"; j++) {
        if (parsed[j]!.kind === "content") {
          hasContent = true;
          break;
        }
      }
      if (!hasContent) {
        continue;
      }
    }
    out.push(line.text);
  }
  return out.join("\n").trim();
}

/** Pull the human-readable context string out of a Mubit getContextBlock response. */
export function extractContextBlockText(response: unknown): string | null {
  const record = asRecord(response);
  if (!record) {
    return null;
  }
  const direct = asText(record.context_block) ?? asText(record.context) ?? asText(record.summary);
  if (direct) {
    const distilled = distillFactsBlock(direct);
    if (distilled.length > 0) {
      return distilled;
    }
    // else: the block was all narration/noise — try section summaries below.
  }
  // Fall back to assembling section summaries if no single block was returned.
  if (Array.isArray(record.section_summaries)) {
    const lines = record.section_summaries
      .map((entry) => {
        const sec = asRecord(entry);
        const name = asText(sec?.section_name);
        const summary = asText(sec?.summary);
        if (!summary) {
          return null;
        }
        return name ? `- ${name}: ${summary}` : `- ${summary}`;
      })
      .filter((line): line is string => line !== null);
    if (lines.length > 0) {
      const distilled = distillFactsBlock(lines.join("\n"));
      if (distilled.length > 0) {
        return distilled;
      }
    }
  }
  return null;
}

/** Compose a concise "where work left off" block from an inspectContextSnapshot response. */
export function extractSnapshotText(response: unknown): string | null {
  const record = asRecord(response);
  if (!record) {
    return null;
  }
  const lines: string[] = [];
  const summary = asText(record.snapshot_summary);
  if (summary) {
    lines.push(summary);
  }
  const nextActions = asTextList(record.snapshot_next_actions);
  if (nextActions.length > 0) {
    lines.push("Next actions:", ...nextActions.map((action) => `- ${action}`));
  }
  const progress = asTextList(record.snapshot_progress);
  if (progress.length > 0) {
    lines.push("Recent progress:", ...progress.map((entry) => `- ${entry}`));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** Extract up to `max` lesson/gotcha lines from a surfaceStrategies response. */
export function extractStrategyLines(response: unknown, max = 5): string[] {
  const record = asRecord(response);
  if (!record || !Array.isArray(record.strategies)) {
    return [];
  }
  const lines: string[] = [];
  for (const entry of record.strategies) {
    const strategy = asRecord(entry);
    const description = asText(strategy?.description) ?? asText(strategy?.summary) ?? asText(strategy?.title);
    if (description) {
      lines.push(`- ${description}`);
    }
    if (lines.length >= max) {
      break;
    }
  }
  return lines;
}

const WEAK_ANSWERS = new Set([
  "i do not know.",
  "i do not know",
  "i don't know.",
  "i don't know",
  "unknown",
  "not enough information",
  "no relevant information found.",
]);

// A synthesized answer that *leads* with a disclaimer of knowledge is a non-answer
// even when it rambles on afterward ("I do not know. While the evidence identifies
// X, it does not document Y…"). Injecting it costs tokens and answers nothing, so
// we treat any answer starting with one of these as weak.
const WEAK_ANSWER_PREFIXES = [
  "i do not know",
  "i don't know",
  "i cannot",
  "i can't",
  "i am unable",
  "i'm unable",
  "i am not able",
  "i am not sure",
  "i'm not sure",
  "i do not have",
  "i don't have",
  "i have no information",
  "no relevant information",
  "not enough information",
  "insufficient information",
  "insufficient evidence",
  "unable to answer",
  "unable to determine",
  "there is no information",
  "there is no explicit",
  "the provided evidence does not",
  "the evidence does not",
  "the provided context does not",
  "the context does not",
  "the provided memory does not",
];

/**
 * True when a semantic answer is empty, an explicit "don't know", or one that
 * opens with a disclaimer of knowledge — any of which is net-negative to inject.
 */
export function isWeakAnswer(text: string | null | undefined): boolean {
  if (!text) {
    return true;
  }
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0 || WEAK_ANSWERS.has(normalized)) {
    return true;
  }
  // Strip leading markdown / quote / list markers before matching prefixes.
  const stripped = normalized.replace(/^[\s"'`*_>\-]+/, "");
  return WEAK_ANSWER_PREFIXES.some((prefix) => stripped.startsWith(prefix));
}

/**
 * Extract a usable answer from a queryWithContextFallback response: the direct
 * semantic answer when it is non-weak, else the supplemental context block.
 */
export function extractPromptAnswer(response: unknown): string | null {
  const record = asRecord(response);
  if (!record) {
    return null;
  }
  const finalAnswer = asText(record.final_answer);
  if (finalAnswer && !isWeakAnswer(finalAnswer)) {
    return finalAnswer;
  }
  const supplemental = asText(record.supplemental_context_block);
  if (supplemental) {
    return supplemental;
  }
  const block = extractContextBlockText(record);
  return block && !isWeakAnswer(block) ? block : null;
}

/**
 * Gate for per-prompt retrieval: skip trivial prompts (too short) and ones with
 * no referent to prior work. Injecting on every prompt is net-negative; this
 * keeps retrieval targeted at prompts that plausibly benefit from memory.
 */
export function shouldInjectForPrompt(prompt: string, minLength: number): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length < minLength) {
    return false;
  }
  // Obvious greetings / acks add nothing to retrieve against.
  if (/^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|yep|nope|sure)\b[.!]?$/i.test(trimmed)) {
    return false;
  }
  return true;
}

/** Assemble parts into a single Markdown block under the trust header, clamped to budget. */
export function formatInjection(parts: InjectionPart[], maxTokens: number): string | null {
  const usable = parts.filter((part) => part.body.trim().length > 0);
  if (usable.length === 0) {
    return null;
  }
  const body = usable.map((part) => `## ${part.heading}\n${part.body.trim()}`).join("\n\n");
  const full = `# Codaph project memory\n${INJECTION_TRUST_HEADER}\n\n${body}`;
  return clampToTokenBudget(full, maxTokens);
}

/**
 * Build the exact stdout JSON a Claude Code hook returns. With no context,
 * returns "{}" (a valid no-op) — never plain text, so stdout is always parseable.
 */
export function buildHookOutput(hookEventName: string, additionalContext: string | null): string {
  if (!additionalContext || additionalContext.trim().length === 0) {
    return "{}";
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// ---------------------------------------------------------------------------
// Orchestrators (call Mubit; always fail-open to null)
// ---------------------------------------------------------------------------

export type SessionStartSource = "startup" | "resume" | "clear" | "compact" | string | null;

// The subset of the Mubit engine the orchestrators use — lets tests pass a stub.
export type InjectionMemory = Pick<
  MubitMemoryEngine,
  "getContextBlock" | "inspectContextSnapshot" | "surfaceStrategies" | "queryWithContextFallback"
>;

async function safe<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/**
 * Build the SessionStart injection. On startup/clear: a project digest
 * (overview + where-left-off + lessons). On compact: a recovery block only, so
 * Claude doesn't re-explore after its context was compacted. On resume: nothing
 * (the prior context is still present). Returns null when there's nothing useful.
 */
export async function buildSessionStartContext(
  memory: InjectionMemory,
  projectRunId: string,
  source: SessionStartSource,
  config: ResolvedInjectionConfig,
): Promise<string | null> {
  if (!config.sessionStart.enabled) {
    return null;
  }
  const budget = config.sessionStart.maxTokens;

  if (source === "resume") {
    return null;
  }

  if (source === "compact") {
    const snapshot = await safe(memory.inspectContextSnapshot({ runId: projectRunId }));
    const recovery = extractSnapshotText(snapshot);
    return recovery
      ? formatInjection([{ heading: "Resuming after compaction — where work left off", body: recovery }], budget)
      : null;
  }

  // startup | clear (and any unknown source): full digest.
  const overviewBudget = Math.max(200, Math.floor(budget * 0.6));
  const [contextBlock, snapshot, strategies] = await Promise.all([
    safe(
      memory.getContextBlock({
        runId: projectRunId,
        query: PROJECT_OVERVIEW_QUERY,
        maxTokenBudget: overviewBudget,
        includeWorkingMemory: true,
        format: "structured",
      }),
    ),
    safe(memory.inspectContextSnapshot({ runId: projectRunId })),
    safe(memory.surfaceStrategies({ runId: projectRunId, maxStrategies: 3 })),
  ]);

  const parts: InjectionPart[] = [];
  const overview = extractContextBlockText(contextBlock);
  if (overview) {
    parts.push({ heading: "Project overview (where things live)", body: overview });
  }
  const recent = extractSnapshotText(snapshot);
  if (recent) {
    parts.push({ heading: "Where recent work left off", body: recent });
  }
  const lessons = extractStrategyLines(strategies, 3);
  if (lessons.length > 0) {
    parts.push({ heading: "Lessons & gotchas", body: lessons.join("\n") });
  }

  return formatInjection(parts, budget);
}

/**
 * Build a UserPromptSubmit injection: targeted retrieval keyed on the prompt,
 * gated so trivial prompts inject nothing and weak results are dropped.
 */
export async function buildPromptContext(
  memory: InjectionMemory,
  projectRunId: string,
  prompt: string,
  config: ResolvedInjectionConfig,
): Promise<string | null> {
  if (!config.userPrompt.enabled || !shouldInjectForPrompt(prompt, config.userPrompt.minLength)) {
    return null;
  }
  const budget = config.userPrompt.maxTokens;
  const response = await safe(
    memory.queryWithContextFallback({
      runId: projectRunId,
      query: prompt,
      limit: 8,
      contextMaxTokenBudget: budget,
      includeLinkedRuns: true,
      rankBy: "relevance",
    }),
  );
  const answer = extractPromptAnswer(response);
  if (!answer || isWeakAnswer(answer)) {
    return null;
  }
  return formatInjection([{ heading: "Relevant prior context for this request", body: answer }], budget);
}

// ---------------------------------------------------------------------------
// PreToolUse short-circuit (experimental, opt-in, default mode "off")
// ---------------------------------------------------------------------------

// Build a "where is X / what is X" memory query from a Read/Grep/Glob tool call.
// Returns null for tools/inputs we don't try to answer from memory.
export function buildToolMemoryQuery(toolName: string, toolInput: Record<string, unknown> | null): string | null {
  const name = (toolName ?? "").toLowerCase();
  const input = asRecord(toolInput) ?? {};
  const pattern = asText(input.pattern);
  const filePath = asText(input.file_path) ?? asText(input.path);
  if (name === "grep" && pattern) {
    return `Where in this project does "${pattern}" appear, and what code handles it? Answer with file paths.`;
  }
  if (name === "glob" && pattern) {
    return `Which files in this project match "${pattern}", and what are they for? Answer with file paths.`;
  }
  if (name === "read" && filePath) {
    return `What is the purpose and key contents of the file ${filePath}?`;
  }
  return null;
}

// Stable signature for a (tool, input) pair — used to dedupe denials per session.
export function toolSignature(toolName: string, toolInput: Record<string, unknown> | null): string {
  let inputKey = "";
  try {
    inputKey = JSON.stringify(toolInput ?? {});
  } catch {
    inputKey = String(toolInput);
  }
  return `${(toolName ?? "").toLowerCase()}:${inputKey}`;
}

export type PreToolDecisionKind = "deny" | "augment" | "allow";
export interface PreToolDecision {
  kind: PreToolDecisionKind;
  text: string | null;
}

// Decide what to do for a PreToolUse call given the retrieved memory answer and
// the per-session denial state. Deny (short-circuit the tool) only happens for
// search tools (grep/glob — memory can plausibly answer "where"), only in
// shortcircuit mode, only once per signature, and only under the denial cap;
// otherwise we fall back to augment (let the tool run, add context) or allow.
export function decidePreToolAction(params: {
  mode: PreToolUseInjectionMode;
  toolName: string;
  answer: string | null;
  alreadyDenied: boolean;
  denialCount: number;
  maxDenials: number;
}): PreToolDecision {
  const { mode, toolName, answer, alreadyDenied, denialCount, maxDenials } = params;
  if (!answer || isWeakAnswer(answer) || mode === "off") {
    return { kind: "allow", text: null };
  }
  if (mode === "augment") {
    return { kind: "augment", text: answer };
  }
  // shortcircuit
  const name = (toolName ?? "").toLowerCase();
  const denyEligible = (name === "grep" || name === "glob") && !alreadyDenied && denialCount < maxDenials;
  return denyEligible ? { kind: "deny", text: answer } : { kind: "augment", text: answer };
}

// Render the PreToolUse hook stdout for a decision. Deny uses
// hookSpecificOutput.permissionDecision; augment adds additionalContext; allow
// is a no-op "{}". The deny reason notes the original call will be retried if
// the memory is insufficient (Claude can re-issue it; the loop guard then allows).
export function buildPreToolHookOutput(decision: PreToolDecision): string {
  if (decision.kind === "deny" && decision.text) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `Codaph memory (verify before relying): ${decision.text}\n\n` +
          "If this does not fully answer the need, re-issue the tool call — it will run.",
      },
    });
  }
  if (decision.kind === "augment" && decision.text) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `Codaph memory (hint, verify): ${decision.text}`,
      },
    });
  }
  return "{}";
}

// Thin Mubit call to answer a tool-memory query; fail-open to null.
export async function fetchToolMemoryAnswer(
  memory: InjectionMemory,
  projectRunId: string,
  query: string,
  maxTokens: number,
): Promise<string | null> {
  const response = await safe(
    memory.queryWithContextFallback({
      runId: projectRunId,
      query,
      limit: 6,
      contextMaxTokenBudget: maxTokens,
      includeLinkedRuns: true,
      rankBy: "relevance",
    }),
  );
  const answer = extractPromptAnswer(response);
  if (!answer || isWeakAnswer(answer)) {
    return null;
  }
  return clampToTokenBudget(answer, maxTokens);
}
