import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { normalizeAgentProviderList, type AgentProviderId } from "./lib/agent-providers";

export type MubitRunScope = "session" | "project";

export interface SyncAutomationSettings {
  enabled?: boolean | null;
  gitPostCommit?: boolean | null;
  agentComplete?: boolean | null;
  agentCompleteProviders?: AgentProviderId[] | null;
  remotePullCooldownSec?: number | null;
  autoPullOnSync?: boolean | null;
  autoWarmTuiOnOpen?: boolean | null;
  lastSetupVersion?: number | null;
}

export interface ProjectSettings {
  projectName?: string | null;
  mubitProjectId?: string | null;
  mubitRunScope?: MubitRunScope | null;
  agentProviders?: AgentProviderId[] | null;
  syncAutomation?: SyncAutomationSettings | null;
}

export interface CodaphSettings {
  mubitApiKey?: string | null;
  openAiApiKey?: string | null;
  mubitActorId?: string | null;
  projects?: Record<string, ProjectSettings>;
}

const DEFAULT_SETTINGS: CodaphSettings = {
  projects: {},
};

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRunScope(value: unknown): MubitRunScope | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  return raw.toLowerCase() === "project" ? "project" : raw.toLowerCase() === "session" ? "session" : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
}

function normalizeAgentProviders(value: unknown): AgentProviderId[] | null {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    const normalized = normalizeAgentProviderList(value);
    return normalized.length > 0 ? normalized : [];
  }
  if (typeof value === "string") {
    const normalized = normalizeAgentProviderList(value.split(","));
    return normalized.length > 0 ? normalized : [];
  }
  return null;
}

function normalizeSyncAutomation(value: unknown): SyncAutomationSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const normalized: SyncAutomationSettings = {
    enabled: asBoolean(record.enabled),
    gitPostCommit: asBoolean(record.gitPostCommit),
    agentComplete: asBoolean(record.agentComplete),
    agentCompleteProviders: normalizeAgentProviders(record.agentCompleteProviders),
    remotePullCooldownSec: asInteger(record.remotePullCooldownSec),
    autoPullOnSync: asBoolean(record.autoPullOnSync),
    autoWarmTuiOnOpen: asBoolean(record.autoWarmTuiOnOpen),
    lastSetupVersion: asInteger(record.lastSetupVersion),
  };
  return normalized;
}

function normalizeProjectSettings(value: unknown): ProjectSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    projectName: asString(record.projectName),
    mubitProjectId: asString(record.mubitProjectId),
    mubitRunScope: normalizeRunScope(record.mubitRunScope),
    agentProviders: normalizeAgentProviders(record.agentProviders),
    syncAutomation: normalizeSyncAutomation(record.syncAutomation),
  };
}

function getSettingsPath(): string {
  return join(homedir(), ".codaph", "settings.json");
}

export function loadCodaphSettings(): CodaphSettings {
  try {
    const raw = readFileSync(getSettingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const projectsRaw =
      parsed.projects && typeof parsed.projects === "object" && !Array.isArray(parsed.projects)
        ? (parsed.projects as Record<string, unknown>)
        : {};

    const projects: Record<string, ProjectSettings> = {};
    for (const [key, value] of Object.entries(projectsRaw)) {
      const normalized = normalizeProjectSettings(value);
      if (!normalized) {
        continue;
      }
      projects[resolve(key)] = normalized;
    }

    return {
      mubitApiKey: asString(parsed.mubitApiKey),
      openAiApiKey: asString(parsed.openAiApiKey),
      mubitActorId: asString(parsed.mubitActorId),
      projects,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveCodaphSettings(settings: CodaphSettings): void {
  const path = getSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const normalizedProjects: Record<string, ProjectSettings> = {};
  for (const [projectPath, projectSettings] of Object.entries(settings.projects ?? {})) {
    const normalized = normalizeProjectSettings(projectSettings);
    if (!normalized) {
      continue;
    }
    normalizedProjects[resolve(projectPath)] = normalized;
  }
  const payload: CodaphSettings = {
    mubitApiKey: asString(settings.mubitApiKey),
    openAiApiKey: asString(settings.openAiApiKey),
    mubitActorId: asString(settings.mubitActorId),
    projects: normalizedProjects,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function getProjectSettings(settings: CodaphSettings, projectPath: string): ProjectSettings {
  const projects = settings.projects ?? {};
  return projects[resolve(projectPath)] ?? {};
}

export function updateProjectSettings(
  settings: CodaphSettings,
  projectPath: string,
  patch: Partial<ProjectSettings>,
): CodaphSettings {
  const normalized = resolve(projectPath);
  const projects = { ...(settings.projects ?? {}) };
  const current = projects[normalized] ?? {};
  projects[normalized] = {
    ...current,
    ...patch,
  };
  return {
    ...settings,
    projects,
  };
}

export function removeProjectSettings(settings: CodaphSettings, projectPath: string): CodaphSettings {
  const normalized = resolve(projectPath);
  const existing = settings.projects ?? {};
  if (!(normalized in existing)) {
    return {
      ...settings,
      projects: { ...existing },
    };
  }

  const projects = { ...existing };
  delete projects[normalized];
  return {
    ...settings,
    projects,
  };
}

export function updateGlobalSettings(
  settings: CodaphSettings,
  patch: Partial<Pick<CodaphSettings, "mubitApiKey" | "openAiApiKey" | "mubitActorId">>,
): CodaphSettings {
  return {
    ...settings,
    ...patch,
  };
}

function runCommand(projectPath: string, cmd: string, args: string[]): string | null {
  try {
    const raw = execFileSync(cmd, args, {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024,
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function parseGitHubOwnerRepo(remote: string): string | null {
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/,
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
    /^git:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(remote);
    if (!match) {
      continue;
    }
    const owner = match[1]?.trim();
    const repo = match[2]?.trim();
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
  }

  return null;
}

export function detectGitHubProjectId(projectPath: string): string | null {
  const remote = runCommand(projectPath, "git", ["config", "--get", "remote.origin.url"]);
  if (!remote) {
    return null;
  }
  return parseGitHubOwnerRepo(remote);
}

export function detectGitHubActorId(projectPath: string): string | null {
  const ghLogin = runCommand(projectPath, "gh", ["api", "user", "--jq", ".login"]);
  if (ghLogin) {
    return ghLogin;
  }

  const githubUser = runCommand(projectPath, "git", ["config", "--get", "github.user"]);
  if (githubUser) {
    return githubUser;
  }

  const userName = runCommand(projectPath, "git", ["config", "--get", "user.name"]);
  if (userName) {
    return userName;
  }

  const userEmail = runCommand(projectPath, "git", ["config", "--get", "user.email"]);
  if (userEmail && userEmail.includes("@")) {
    return userEmail.split("@")[0] ?? null;
  }

  return process.env.USER ?? process.env.USERNAME ?? null;
}

export function detectGitHubDefaults(projectPath: string): { projectId: string | null; actorId: string | null } {
  return {
    projectId: detectGitHubProjectId(projectPath),
    actorId: detectGitHubActorId(projectPath),
  };
}
