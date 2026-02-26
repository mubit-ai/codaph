import { open, readFile, writeFile, mkdir, appendFile, chmod, stat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeAgentProviderList, type AgentProviderId } from "./lib/agent-providers";
import {
  readMubitRemoteSyncState,
  writeMubitRemoteSyncState,
  type MubitRemoteSyncState,
} from "./mubit-remote-sync-state";

export type SyncTriggerSource =
  | "manual"
  | "sync-manual"
  | "tui-startup"
  | "tui-sync"
  | "tui-pull"
  | "hook-post-commit"
  | "hook-post-push"
  | "hook-agent-complete";

export interface SyncAutomationLockHandle {
  path: string;
  token: string;
}

export interface SyncAutomationSettingsResolved {
  enabled: boolean;
  gitPostCommit: boolean;
  agentComplete: boolean;
  agentCompleteProviders: AgentProviderId[];
  remotePullCooldownSec: number;
  autoPullOnSync: boolean;
  autoWarmTuiOnOpen: boolean;
  lastSetupVersion: number | null;
}

export interface HookInstallResult {
  gitPostCommitInstalled: boolean;
  agentCompleteInstalled: boolean;
  partial: boolean;
  warnings: string[];
  manualSteps: string[];
}

const CODAPH_HOOK_BEGIN = "# >>> codaph sync >>>";
const CODAPH_HOOK_END = "# <<< codaph sync <<<";

export const SYNC_AUTOMATION_SETUP_VERSION = 1;

export function defaultSyncAutomationSettings(): SyncAutomationSettingsResolved {
  return {
    enabled: false,
    gitPostCommit: false,
    agentComplete: false,
    agentCompleteProviders: [],
    remotePullCooldownSec: 45,
    autoPullOnSync: true,
    autoWarmTuiOnOpen: true,
    lastSetupVersion: null,
  };
}

export function normalizeSyncAutomationSettings(
  raw: {
    enabled?: boolean | null;
    gitPostCommit?: boolean | null;
    agentComplete?: boolean | null;
    agentCompleteProviders?: AgentProviderId[] | string[] | null;
    remotePullCooldownSec?: number | null;
    autoPullOnSync?: boolean | null;
    autoWarmTuiOnOpen?: boolean | null;
    lastSetupVersion?: number | null;
  } | null | undefined,
): SyncAutomationSettingsResolved {
  const defaults = defaultSyncAutomationSettings();
  const cooldownRaw = raw?.remotePullCooldownSec;
  const cooldown =
    typeof cooldownRaw === "number" && Number.isFinite(cooldownRaw) && cooldownRaw >= 0
      ? Math.trunc(cooldownRaw)
      : defaults.remotePullCooldownSec;
  const normalizedProviderList = Array.isArray(raw?.agentCompleteProviders)
    ? normalizeAgentProviderList(raw.agentCompleteProviders)
    : [];
  const legacyAgentComplete = typeof raw?.agentComplete === "boolean" ? raw.agentComplete : defaults.agentComplete;
  const agentCompleteProviders: AgentProviderId[] = normalizedProviderList.length > 0
    ? normalizedProviderList
    : legacyAgentComplete
      ? (["codex"] as AgentProviderId[])
      : [];
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : defaults.enabled,
    gitPostCommit: typeof raw?.gitPostCommit === "boolean" ? raw.gitPostCommit : defaults.gitPostCommit,
    agentComplete: agentCompleteProviders.length > 0,
    agentCompleteProviders,
    remotePullCooldownSec: cooldown,
    autoPullOnSync: typeof raw?.autoPullOnSync === "boolean" ? raw.autoPullOnSync : defaults.autoPullOnSync,
    autoWarmTuiOnOpen: typeof raw?.autoWarmTuiOnOpen === "boolean" ? raw.autoWarmTuiOnOpen : defaults.autoWarmTuiOnOpen,
    lastSetupVersion:
      typeof raw?.lastSetupVersion === "number" && Number.isFinite(raw.lastSetupVersion)
        ? Math.trunc(raw.lastSetupVersion)
        : defaults.lastSetupVersion,
  };
}

export function getSyncAutomationLogPath(mirrorRoot: string): string {
  return join(mirrorRoot, "logs", "sync-automation.log");
}

export function getSyncLockPath(mirrorRoot: string): string {
  return join(mirrorRoot, "locks", "sync.lock");
}

export async function appendSyncAutomationLog(
  logPath: string,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString();
  const serializedMeta = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${ts} ${message}${serializedMeta}\n`, "utf8");
}

export async function acquireSyncLock(
  lockPath: string,
  options: { waitMs?: number; pollMs?: number; metadata?: Record<string, unknown> } = {},
): Promise<SyncAutomationLockHandle | null> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + Math.max(0, waitMs);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = `${JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString(), ...(options.metadata ?? {}) }, null, 2)}\n`;

  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const fd = await open(lockPath, "wx");
      await fd.writeFile(payload, "utf8");
      await fd.close();
      return { path: lockPath, token };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw error;
      }
      const reclaimed = await tryReclaimStaleSyncLock(lockPath);
      if (reclaimed) {
        continue;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function tryReclaimStaleSyncLock(lockPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number") {
      if (parsed.pid === process.pid) {
        return false;
      }
      if (isProcessAlive(parsed.pid)) {
        return false;
      }
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // fall back to mtime-based cleanup below
  }

  try {
    const info = await stat(lockPath);
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs > 10 * 60 * 1000) {
      await rm(lockPath, { force: true });
      return true;
    }
  } catch {
    // best-effort
  }
  return false;
}

export async function releaseSyncLock(handle: SyncAutomationLockHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  try {
    const raw = await readFile(handle.path, "utf8");
    if (raw.includes(handle.token)) {
      await rm(handle.path, { force: true });
    }
  } catch {
    // best-effort
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLikelyTextFile(content: string): boolean {
  return !content.includes("\u0000");
}

function commandBinaryFromLine(commandLine: string): string | null {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const first = trimmed.split(/\s+/, 1)[0];
  return first && !first.startsWith("$") ? first : null;
}

function buildManagedHookBlock(
  commandLine: string | string[],
  options?: { background?: boolean },
): string {
  const commandLines = (Array.isArray(commandLine) ? commandLine : [commandLine])
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const background = options?.background === true;

  if (commandLines.length === 0) {
    return `${CODAPH_HOOK_BEGIN}
${CODAPH_HOOK_END}`;
  }

  const body: string[] = [];
  for (let i = 0; i < commandLines.length; i += 1) {
    const line = commandLines[i] as string;
    const binary = commandBinaryFromLine(line);
    const keyword = i === 0 ? "if" : "elif";
    if (binary) {
      body.push(`${keyword} command -v ${binary} >/dev/null 2>&1; then`);
    } else {
      body.push(`${keyword} true; then`);
    }
    if (background) {
      body.push(`  (${line}) >/dev/null 2>&1 &`);
    } else {
      body.push(`  ${line}`);
    }
  }
  body.push("fi");

  return `${CODAPH_HOOK_BEGIN}
${body.join("\n")}
${CODAPH_HOOK_END}`;
}

export async function upsertManagedShellHook(
  hookPath: string,
  commandLine: string | string[],
  options?: { background?: boolean },
): Promise<{ updated: boolean; created: boolean; reason?: string }> {
  await mkdir(dirname(hookPath), { recursive: true });
  const existing = await readTextFile(hookPath);
  const block = buildManagedHookBlock(commandLine, options);

  let nextContent: string;
  let created = false;

  if (existing === null) {
    created = true;
    nextContent = `#!/usr/bin/env bash\nset -euo pipefail\n\n${block}\n`;
  } else {
    if (!isLikelyTextFile(existing)) {
      return { updated: false, created: false, reason: "hook file is not a text file" };
    }
    const hasManagedBlock = existing.includes(CODAPH_HOOK_BEGIN) && existing.includes(CODAPH_HOOK_END);
    if (hasManagedBlock) {
      nextContent = existing.replace(
        new RegExp(`${escapeRegExp(CODAPH_HOOK_BEGIN)}[\\s\\S]*?${escapeRegExp(CODAPH_HOOK_END)}`, "m"),
        block,
      );
    } else {
      const base = existing.endsWith("\n") ? existing : `${existing}\n`;
      const withShebang = base.startsWith("#!") ? base : `#!/usr/bin/env bash\n${base}`;
      nextContent = `${withShebang}\n${block}\n`;
    }
  }

  await writeFile(hookPath, nextContent, "utf8");
  await chmod(hookPath, 0o755);
  return { updated: true, created };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function installGitPostCommitHook(
  repoRoot: string,
  commandLine: string | string[] = "codaph hooks run post-commit --quiet",
): Promise<{ ok: boolean; warning?: string }> {
  const hookPath = join(repoRoot, ".git", "hooks", "post-commit");
  const result = await upsertManagedShellHook(hookPath, commandLine, { background: true });
  if (!result.updated) {
    return { ok: false, warning: result.reason ?? "unable to update post-commit hook" };
  }
  return { ok: true };
}

export async function installGitPostPushHook(
  repoRoot: string,
  commandLine: string | string[] = "codaph hooks run post-push --quiet",
): Promise<{ ok: boolean; warning?: string }> {
  const hookPath = join(repoRoot, ".git", "hooks", "post-push");
  const result = await upsertManagedShellHook(hookPath, commandLine, { background: true });
  if (!result.updated) {
    return { ok: false, warning: result.reason ?? "unable to update post-push hook" };
  }
  return { ok: true };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function codexHomeDir(): string {
  const raw = process.env.CODEX_HOME?.trim();
  return raw && raw.length > 0 ? raw : join(homedir(), ".codex");
}

async function detectExistingCodexHookDir(repoRoot: string): Promise<string | null> {
  const codexHome = codexHomeDir();
  const candidates = [
    join(codexHome, "hooks"),
    join(codexHome, "commands", "hooks"),
    join(repoRoot, ".codex", "hooks"),
    join(repoRoot, ".codex", "commands", "hooks"),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function installAgentCompleteHookBestEffort(
  repoRoot: string,
  commandLine: string | string[] = "codaph hooks run agent-complete --quiet",
): Promise<{ ok: boolean; installedPath?: string; warning?: string; manualSnippet: string }> {
  let hookDir = await detectExistingCodexHookDir(repoRoot);
  const manualSnippet = Array.isArray(commandLine) ? (commandLine[0] ?? "codaph hooks run agent-complete --quiet") : commandLine;
  if (!hookDir) {
    const createdHookDir = join(codexHomeDir(), "hooks");
    try {
      await mkdir(createdHookDir, { recursive: true });
      hookDir = createdHookDir;
    } catch {
      return {
        ok: false,
        warning: "No Codex hook directory detected; install the agent-complete hook manually.",
        manualSnippet,
      };
    }
  }

  const hookPath = join(hookDir, "agent-complete");
  const result = await upsertManagedShellHook(hookPath, commandLine);
  if (!result.updated) {
    return {
      ok: false,
      warning: result.reason ?? "unable to update Codex agent-complete hook",
      manualSnippet,
    };
  }
  return { ok: true, installedPath: hookPath, manualSnippet };
}

function firstCommandSnippet(commandLine: string | string[]): string {
  return Array.isArray(commandLine) ? (commandLine[0] ?? "") : commandLine;
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readJsonObjectOrDefault(
  path: string,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason: string }> {
  const raw = await readTextFile(path);
  if (raw == null || raw.trim().length === 0) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { ok: false, reason: "settings file is not a JSON object" };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: "settings file contains invalid JSON" };
  }
}

function commandHookExistsInClaudeStopEntry(value: unknown, command: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const hooks = value.hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  for (const hook of hooks) {
    if (!isRecord(hook)) {
      continue;
    }
    if (hook.type === "command" && typeof hook.command === "string" && hook.command.trim() === command.trim()) {
      return true;
    }
  }
  return false;
}

export async function installClaudeCodeAgentCompleteHookBestEffort(
  repoRoot: string,
  commandLine: string | string[] = "codaph hooks run agent-complete --provider claude-code --quiet",
): Promise<{ ok: boolean; installedPath?: string; warning?: string; manualSnippet: string }> {
  const settingsPath = join(repoRoot, ".claude", "settings.json");
  const manualSnippet = firstCommandSnippet(commandLine) || "codaph hooks run agent-complete --provider claude-code --quiet";
  const existing = await readJsonObjectOrDefault(settingsPath);
  if (!existing.ok) {
    return {
      ok: false,
      warning: `Claude Code settings update failed: ${existing.reason}`,
      manualSnippet,
    };
  }

  const next = { ...existing.value };
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {};
  const stopRaw = hooks.Stop;
  const stopEntries: unknown[] = Array.isArray(stopRaw) ? [...stopRaw] : isRecord(stopRaw) ? [stopRaw] : [];
  const alreadyPresent = stopEntries.some((entry) => commandHookExistsInClaudeStopEntry(entry, manualSnippet));
  if (!alreadyPresent) {
    stopEntries.push({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: manualSnippet,
        },
      ],
    });
  }
  hooks.Stop = stopEntries;
  next.hooks = hooks;

  try {
    await writeJsonFile(settingsPath, next);
    return { ok: true, installedPath: settingsPath, manualSnippet };
  } catch (error) {
    return {
      ok: false,
      warning: `unable to update Claude Code settings: ${error instanceof Error ? error.message : String(error)}`,
      manualSnippet,
    };
  }
}

function geminiHookCommandExists(value: unknown, command: string): boolean {
  if (typeof value === "string") {
    return value.trim() === command.trim();
  }
  if (isRecord(value) && typeof value.command === "string") {
    return value.command.trim() === command.trim();
  }
  if (Array.isArray(value)) {
    return value.some((entry) => geminiHookCommandExists(entry, command));
  }
  return false;
}

function appendGeminiHookValue(value: unknown, command: string): unknown {
  if (value == null) {
    return [command];
  }
  if (typeof value === "string") {
    if (value.trim() === command.trim()) {
      return value;
    }
    return [value, command];
  }
  if (isRecord(value)) {
    if (typeof value.command === "string" && value.command.trim() === command.trim()) {
      return value;
    }
    return [value, command];
  }
  if (Array.isArray(value)) {
    if (value.some((entry) => geminiHookCommandExists(entry, command))) {
      return value;
    }
    return [...value, command];
  }
  return [command];
}

export async function installGeminiCliAgentCompleteHookBestEffort(
  repoRoot: string,
  commandLine: string | string[] = "codaph hooks run agent-complete --provider gemini-cli --quiet",
): Promise<{ ok: boolean; installedPath?: string; warning?: string; manualSnippet: string }> {
  const settingsPath = join(repoRoot, ".gemini", "settings.json");
  const manualSnippet = firstCommandSnippet(commandLine) || "codaph hooks run agent-complete --provider gemini-cli --quiet";
  const existing = await readJsonObjectOrDefault(settingsPath);
  if (!existing.ok) {
    return {
      ok: false,
      warning: `Gemini CLI settings update failed: ${existing.reason}`,
      manualSnippet,
    };
  }

  const next = { ...existing.value };
  const hooks = isRecord(next.hooks) ? { ...next.hooks } : {};
  hooks.AfterAgent = appendGeminiHookValue(hooks.AfterAgent, manualSnippet);
  next.hooks = hooks;

  try {
    await writeJsonFile(settingsPath, next);
    return { ok: true, installedPath: settingsPath, manualSnippet };
  } catch (error) {
    return {
      ok: false,
      warning: `unable to update Gemini CLI settings: ${error instanceof Error ? error.message : String(error)}`,
      manualSnippet,
    };
  }
}

export async function installProviderAgentCompleteHookBestEffort(
  provider: AgentProviderId,
  repoRoot: string,
  commandLine: string | string[],
): Promise<{ ok: boolean; installedPath?: string; warning?: string; manualSnippet: string }> {
  if (provider === "codex") {
    return installAgentCompleteHookBestEffort(repoRoot, commandLine);
  }
  if (provider === "claude-code") {
    return installClaudeCodeAgentCompleteHookBestEffort(repoRoot, commandLine);
  }
  return installGeminiCliAgentCompleteHookBestEffort(repoRoot, commandLine);
}

export async function detectHookManagerWarnings(repoRoot: string): Promise<string[]> {
  const candidates = [
    { label: "Husky", path: join(repoRoot, ".husky") },
    { label: "pre-commit", path: join(repoRoot, ".pre-commit-config.yaml") },
    { label: "Overcommit", path: join(repoRoot, ".overcommit.yml") },
    { label: "Lefthook", path: join(repoRoot, "lefthook.yml") },
    { label: "Lefthook", path: join(repoRoot, ".lefthook.yml") },
    { label: "Lefthook", path: join(repoRoot, "lefthook.yaml") },
    { label: "Lefthook", path: join(repoRoot, ".lefthook.yaml") },
    { label: "Lefthook", path: join(repoRoot, "lefthook.toml") },
    { label: "Lefthook", path: join(repoRoot, ".lefthook.toml") },
    { label: "Lefthook", path: join(repoRoot, "lefthook.json") },
    { label: "Lefthook", path: join(repoRoot, ".lefthook.json") },
  ];

  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate.path))) {
      continue;
    }
    if (seen.has(candidate.label)) {
      continue;
    }
    seen.add(candidate.label);
    warnings.push(
      `${candidate.label} detected in this repo. If it rewrites hooks, re-run \`codaph sync --enable-auto --yes\` to restore Codaph automation.`,
    );
  }
  return warnings;
}

export async function markPendingSyncTrigger(
  statePath: string,
  source: SyncTriggerSource,
): Promise<MubitRemoteSyncState> {
  const current = await readMubitRemoteSyncState(statePath);
  const next: MubitRemoteSyncState = {
    ...current,
    pendingTrigger: {
      pending: true,
      source,
      ts: new Date().toISOString(),
    },
  };
  await writeMubitRemoteSyncState(statePath, next);
  return next;
}

export function shouldRunRemotePullNow(
  lastRunAt: string | null,
  cooldownSec: number,
): boolean {
  if (!lastRunAt || cooldownSec <= 0) {
    return true;
  }
  const at = Date.parse(lastRunAt);
  if (!Number.isFinite(at)) {
    return true;
  }
  return Date.now() - at >= cooldownSec * 1000;
}
