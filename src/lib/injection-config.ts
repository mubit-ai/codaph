// Resolves the effective memory-injection configuration from (in order of
// precedence): the CODAPH_INJECT env kill-switch, persisted project settings,
// then built-in defaults. Every injection hook reads this so behaviour is
// consistent and centrally tunable.
import type { InjectionSettings, PreToolUseInjectionMode } from "../settings-store";

export interface ResolvedInjectionConfig {
  enabled: boolean;
  timeoutMs: number;
  sessionStart: { enabled: boolean; maxTokens: number; includeOverview: boolean };
  userPrompt: { enabled: boolean; maxTokens: number; minLength: number };
  preToolUse: {
    mode: PreToolUseInjectionMode;
    maxTokens: number;
    maxDenials: number;
    tools: string[];
    // Confidence gates in [0,1]: don't augment below `minConfidenceToAugment`;
    // only deny (short-circuit) at/above the higher `minConfidenceToDeny`.
    minConfidenceToAugment: number;
    minConfidenceToDeny: number;
  };
}

// Conservative defaults. Master `enabled` is OFF: nothing injects until a user
// opts in. Budgets are deliberately tight — injected context must be far
// smaller than the exploration it replaces to be net-positive on tokens.
// sessionStart defaults to the recovery+lessons digest only (includeOverview
// false): the "where things live" overview benchmarked net-negative because it
// seeds MORE exploration, so it is opt-in. The budget is sized for the
// recovery/lessons digest, not the old full overview.
export const DEFAULT_INJECTION_CONFIG: ResolvedInjectionConfig = {
  enabled: false,
  timeoutMs: 2500,
  sessionStart: { enabled: true, maxTokens: 700, includeOverview: false },
  userPrompt: { enabled: true, maxTokens: 800, minLength: 24 },
  preToolUse: {
    mode: "off",
    maxTokens: 400,
    maxDenials: 8,
    tools: ["Read", "Grep", "Glob"],
    minConfidenceToAugment: 0.6,
    minConfidenceToDeny: 0.8,
  },
};

function boolOr(value: boolean | null | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function posIntOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

// Clamp a configured confidence threshold into [0,1], else fall back.
function clamp01(value: number | null | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

// Interpret an env flag like CODAPH_INJECT: "0"/"false"/"off"/"no" => false,
// "1"/"true"/"on"/"yes" => true, anything else => undefined (no opinion).
function parseEnvBool(value: string | undefined): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(lower)) {
    return false;
  }
  if (["1", "true", "on", "yes"].includes(lower)) {
    return true;
  }
  return undefined;
}

// CODAPH_INJECT_PHASES isolates individual injection phases for the A/B bench so
// each can be proven net-positive on its own. When set to a non-empty, non-"off"
// value it takes FULL control of which phases run (enabling injection and turning
// every phase on/off per the token set), so an arm tests exactly one lever:
//   session              → SessionStart digest only
//   prompt               → UserPromptSubmit retrieval only
//   pretool / pretool-augment → PreToolUse in augment mode only
//   pretool-shortcircuit → PreToolUse in shortcircuit mode only
//   all                  → every phase on
//   off / none           → injection disabled
// Tokens are comma/space separated and combinable (e.g. "session,prompt").
function applyInjectPhases(resolved: ResolvedInjectionConfig, value: string | undefined): void {
  if (typeof value !== "string") {
    return;
  }
  const tokens = value
    .trim()
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return;
  }
  if (tokens.includes("off") || tokens.includes("none")) {
    resolved.enabled = false;
    return;
  }
  const has = (token: string): boolean => tokens.includes(token);
  const all = has("all");
  resolved.enabled = true;
  resolved.sessionStart.enabled = all || has("session");
  resolved.userPrompt.enabled = all || has("prompt");
  if (has("pretool-shortcircuit") || has("shortcircuit")) {
    resolved.preToolUse.mode = "shortcircuit";
  } else if (all || has("pretool-augment") || has("pretool") || has("augment")) {
    resolved.preToolUse.mode = "augment";
  } else {
    resolved.preToolUse.mode = "off";
  }
}

export function resolveInjectionConfig(
  injection: InjectionSettings | null | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedInjectionConfig {
  const d = DEFAULT_INJECTION_CONFIG;
  const i = injection ?? {};

  const resolved: ResolvedInjectionConfig = {
    enabled: boolOr(i.enabled, d.enabled),
    timeoutMs: posIntOr(i.timeoutMs, d.timeoutMs),
    sessionStart: {
      enabled: boolOr(i.sessionStartEnabled, d.sessionStart.enabled),
      maxTokens: posIntOr(i.sessionStartMaxTokens, d.sessionStart.maxTokens),
      includeOverview: boolOr(i.sessionStartIncludeOverview, d.sessionStart.includeOverview),
    },
    userPrompt: {
      enabled: boolOr(i.userPromptEnabled, d.userPrompt.enabled),
      maxTokens: posIntOr(i.userPromptMaxTokens, d.userPrompt.maxTokens),
      minLength: posIntOr(i.userPromptMinLength, d.userPrompt.minLength),
    },
    preToolUse: {
      mode: i.preToolUseMode ?? d.preToolUse.mode,
      maxTokens: posIntOr(i.preToolUseMaxTokens, d.preToolUse.maxTokens),
      maxDenials: posIntOr(i.preToolUseMaxDenials, d.preToolUse.maxDenials),
      tools: d.preToolUse.tools,
      minConfidenceToAugment: clamp01(i.preToolUseMinConfidenceToAugment, d.preToolUse.minConfidenceToAugment),
      minConfidenceToDeny: clamp01(i.preToolUseMinConfidenceToDeny, d.preToolUse.minConfidenceToDeny),
    },
  };

  // Per-phase isolation for the bench (configures which phases run) is applied
  // before the master kill-switch so CODAPH_INJECT=0 can still hard-kill an arm.
  applyInjectPhases(resolved, env.CODAPH_INJECT_PHASES);

  // CODAPH_INJECT is a hard kill-switch (and a quick way to force-enable in dev).
  const envSwitch = parseEnvBool(env.CODAPH_INJECT);
  if (envSwitch === false) {
    resolved.enabled = false;
  } else if (envSwitch === true) {
    resolved.enabled = true;
  }

  return resolved;
}
