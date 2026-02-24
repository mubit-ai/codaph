import { open, readFile, writeFile, mkdir, appendFile, chmod, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  | "hook-agent-complete";

export interface SyncAutomationLockHandle {
  path: string;
  token: string;
}

export interface SyncAutomationSettingsResolved {
  enabled: boolean;
  gitPostCommit: boolean;
  agentComplete: boolean;
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
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : defaults.enabled,
    gitPostCommit: typeof raw?.gitPostCommit === "boolean" ? raw.gitPostCommit : defaults.gitPostCommit,
    agentComplete: typeof raw?.agentComplete === "boolean" ? raw.agentComplete : defaults.agentComplete,
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

function isLikelyTextFile(content: string): boolean {
  return !content.includes("\u0000");
}

function buildManagedHookBlock(commandLine: string): string {
  return `${CODAPH_HOOK_BEGIN}
if command -v codaph >/dev/null 2>&1; then
  ${commandLine}
fi
${CODAPH_HOOK_END}`;
}

export async function upsertManagedShellHook(
  hookPath: string,
  commandLine: string,
): Promise<{ updated: boolean; created: boolean; reason?: string }> {
  await mkdir(dirname(hookPath), { recursive: true });
  const existing = await readTextFile(hookPath);
  const block = buildManagedHookBlock(commandLine);

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
  commandLine = "codaph hooks run post-commit --quiet",
): Promise<{ ok: boolean; warning?: string }> {
  const hookPath = join(repoRoot, ".git", "hooks", "post-commit");
  const result = await upsertManagedShellHook(hookPath, commandLine);
  if (!result.updated) {
    return { ok: false, warning: result.reason ?? "unable to update post-commit hook" };
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

async function detectExistingCodexHookDir(repoRoot: string): Promise<string | null> {
  const candidates = [join(repoRoot, ".codex", "hooks"), join(repoRoot, ".codex", "commands", "hooks")];
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
  commandLine = "codaph hooks run agent-complete --quiet",
): Promise<{ ok: boolean; installedPath?: string; warning?: string; manualSnippet: string }> {
  const hookDir = await detectExistingCodexHookDir(repoRoot);
  const manualSnippet = commandLine;
  if (!hookDir) {
    return {
      ok: false,
      warning: "No repo-local Codex hook directory detected; install the agent-complete hook manually.",
      manualSnippet,
    };
  }

  const hookPath = join(hookDir, "agent-complete");
  const result = await upsertManagedShellHook(hookPath, commandLine);
  if (!result.updated) {
    return {
      ok: false,
      warning: result.reason ?? "unable to update repo-local Codex agent-complete hook",
      manualSnippet,
    };
  }
  return { ok: true, installedPath: hookPath, manualSnippet };
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
