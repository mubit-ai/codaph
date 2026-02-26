import { stat } from "node:fs/promises";
import { join } from "node:path";

export type AgentProviderId = "codex" | "claude-code" | "gemini-cli";

export const AGENT_PROVIDER_ORDER: AgentProviderId[] = ["codex", "claude-code", "gemini-cli"];

const PROVIDER_LABELS: Record<AgentProviderId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "gemini-cli": "Gemini CLI",
};

const PROVIDER_MARKERS: Record<AgentProviderId, string> = {
  codex: ".codex",
  "claude-code": ".claude",
  "gemini-cli": ".gemini",
};

const PROVIDER_REPO_MARKER_CANDIDATES: Record<AgentProviderId, string[]> = {
  codex: [".codex"],
  // Claude Code project scope can exist as .claude/ OR CLAUDE.md in the repo root.
  "claude-code": [".claude", "CLAUDE.md", "CLAUDE.local.md"],
  "gemini-cli": [".gemini"],
};

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return value === "codex" || value === "claude-code" || value === "gemini-cli";
}

export function agentProviderLabel(provider: AgentProviderId): string {
  return PROVIDER_LABELS[provider];
}

export function agentProviderMarkerDir(provider: AgentProviderId): string {
  return PROVIDER_MARKERS[provider];
}

export function normalizeAgentProviderList(values: Iterable<unknown>): AgentProviderId[] {
  const seen = new Set<AgentProviderId>();
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "claude" || normalized === "claudecode" || normalized === "claude-code") {
      seen.add("claude-code");
      continue;
    }
    if (normalized === "gemini" || normalized === "gemini-cli" || normalized === "geminicli") {
      seen.add("gemini-cli");
      continue;
    }
    if (normalized === "codex") {
      seen.add("codex");
      continue;
    }
  }
  return AGENT_PROVIDER_ORDER.filter((provider) => seen.has(provider));
}

export function parseProvidersFlag(
  raw: string | null | undefined,
): { kind: "auto" | "all" } | { kind: "providers"; providers: AgentProviderId[] } | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "auto") {
    return { kind: "auto" };
  }
  if (lower === "all") {
    return { kind: "all" };
  }
  const providers = normalizeAgentProviderList(trimmed.split(","));
  if (providers.length === 0) {
    throw new Error(
      `Invalid provider list "${trimmed}". Supported providers: ${AGENT_PROVIDER_ORDER.join(", ")}, or use auto/all.`,
    );
  }
  return { kind: "providers", providers };
}

export async function detectAgentProvidersForRepo(repoRoot: string): Promise<AgentProviderId[]> {
  const detected: AgentProviderId[] = [];
  for (const provider of AGENT_PROVIDER_ORDER) {
    const markers = PROVIDER_REPO_MARKER_CANDIDATES[provider] ?? [agentProviderMarkerDir(provider)];
    for (const markerRel of markers) {
      const marker = join(repoRoot, markerRel);
      try {
        await stat(marker);
        detected.push(provider);
        break;
      } catch {
        // ignore missing marker
      }
    }
  }
  return detected;
}

export function formatAgentProviderList(providers: AgentProviderId[]): string {
  if (providers.length === 0) {
    return "(none)";
  }
  return providers.map((provider) => agentProviderLabel(provider)).join(", ");
}
