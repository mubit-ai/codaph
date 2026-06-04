// Resolves the effective memory-injection configuration from (in order of
// precedence): the CODAPH_INJECT env kill-switch, persisted project settings,
// then built-in defaults. Every injection hook reads this so behaviour is
// consistent and centrally tunable.
import type { InjectionSettings, PreToolUseInjectionMode } from "../settings-store";

export interface ResolvedInjectionConfig {
  enabled: boolean;
  timeoutMs: number;
  sessionStart: { enabled: boolean; maxTokens: number };
  userPrompt: { enabled: boolean; maxTokens: number; minLength: number };
  preToolUse: { mode: PreToolUseInjectionMode; maxTokens: number; maxDenials: number; tools: string[] };
}

// Conservative defaults. Master `enabled` is OFF: nothing injects until a user
// opts in. Budgets are deliberately tight — injected context must be far
// smaller than the exploration it replaces to be net-positive on tokens.
export const DEFAULT_INJECTION_CONFIG: ResolvedInjectionConfig = {
  enabled: false,
  timeoutMs: 2500,
  sessionStart: { enabled: true, maxTokens: 1500 },
  userPrompt: { enabled: true, maxTokens: 800, minLength: 24 },
  preToolUse: { mode: "off", maxTokens: 400, maxDenials: 8, tools: ["Read", "Grep", "Glob"] },
};

function boolOr(value: boolean | null | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function posIntOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
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
    },
  };

  // CODAPH_INJECT is a hard kill-switch (and a quick way to force-enable in dev).
  const envSwitch = parseEnvBool(env.CODAPH_INJECT);
  if (envSwitch === false) {
    resolved.enabled = false;
  } else if (envSwitch === true) {
    resolved.enabled = true;
  }

  return resolved;
}
