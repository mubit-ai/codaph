#!/usr/bin/env bun
import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CapturedEventEnvelope } from "./lib/core-types";
import { repoIdFromPath } from "./lib/core-types";
import { JsonlMirror } from "./lib/mirror-jsonl";
import { IngestPipeline } from "./lib/ingest-pipeline";
import { CodexSdkAdapter } from "./lib/adapter-codex-sdk";
import { CodexExecAdapter } from "./lib/adapter-codex-exec";
import { QueryService } from "./lib/query-service";
import { MubitMemoryEngine, mubitPromptRunIdForProject, mubitRunIdForProject, mubitRunIdForSession } from "./lib/memory-mubit";
import {
  syncCodexHistory,
  type CodexHistorySyncProgress,
  type CodexHistorySyncSummary,
} from "./codex-history-sync";
import {
  defaultCodexLocalPushState,
  getCodexLocalPushStatePath,
  readCodexLocalPushState,
  writeCodexLocalPushState,
  type CodexLocalPushState,
} from "./codex-local-push-state";
import { syncMubitRemoteActivity, type MubitRemoteSyncSummary } from "./mubit-remote-sync";
import { getMubitRemoteSyncStatePath, readMubitRemoteSyncState } from "./mubit-remote-sync-state";
import {
  addProjectToRegistry,
  loadRegistry,
  removeProjectFromRegistry,
  setLastProject,
} from "./project-registry";
import {
  detectGitHubDefaults,
  getProjectSettings,
  loadCodaphSettings,
  saveCodaphSettings,
  updateGlobalSettings,
  updateProjectSettings,
  type CodaphSettings,
  type MubitRunScope,
} from "./settings-store";
import {
  SYNC_AUTOMATION_SETUP_VERSION,
  acquireSyncLock,
  appendSyncAutomationLog,
  detectHookManagerWarnings,
  getSyncAutomationLogPath,
  getSyncLockPath,
  installAgentCompleteHookBestEffort,
  installGitPostCommitHook,
  installGitPostPushHook,
  markPendingSyncTrigger,
  normalizeSyncAutomationSettings,
  releaseSyncLock,
  shouldRunRemotePullNow,
  type SyncTriggerSource,
} from "./sync-automation";

type Flags = Record<string, string | boolean>;
type CaptureMode = "run" | "exec";

interface CodaphProjectFile {
  schema: "codaph.project.v1";
  projectPath: string;
  repoId: string;
  projectLabel: string;
  mubitProjectId: string | null;
  mubitRunScope: MubitRunScope;
  syncAutomation: {
    enabled: boolean;
    gitPostCommit: boolean;
    agentComplete: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function hookCommandCandidates(hookName: "post-commit" | "post-push" | "agent-complete"): string[] {
  const out = [`codaph hooks run ${hookName} --quiet`];

  const scriptPath = process.argv[1];
  const runtimePath = typeof process.execPath === "string" && process.execPath.length > 0 ? process.execPath : null;
  if (runtimePath && scriptPath && isAbsolute(scriptPath)) {
    out.push(`${shellQuote(runtimePath)} ${shellQuote(scriptPath)} hooks run ${hookName} --quiet`);
  }

  if (scriptPath && /(?:^|\/)(?:src\/index\.ts|dist\/index\.js)$/.test(scriptPath)) {
    const codaphRoot = resolve(dirname(scriptPath), "..");
    out.push(`bun --cwd ${shellQuote(codaphRoot)} run cli hooks run ${hookName} --quiet`);
  } else {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const codaphRoot = resolve(dirname(thisFile), "..");
      out.push(`bun --cwd ${shellQuote(codaphRoot)} run cli hooks run ${hookName} --quiet`);
    } catch {
      // best-effort fallback not available
    }
  }

  return [...new Set(out)];
}

function parseArgs(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      flags[token.slice("--no-".length)] = false;
      continue;
    }

    if (token.includes("=")) {
      const [key, value] = token.slice(2).split("=", 2);
      flags[key] = value.length > 0 ? value : true;
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

function getStringFlag(flags: Flags, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

function getBooleanFlag(flags: Flags, key: string, fallback: boolean): boolean {
  const val = flags[key];
  if (typeof val === "boolean") {
    return val;
  }
  if (typeof val === "string") {
    const lowered = val.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(lowered)) {
      return false;
    }
  }
  return fallback;
}

function help(): string {
  return [
    "Codaph CLI/TUI (Mubit-first project memory)",
    "",
    "Onboarding:",
    "  codaph setup [--mubit-api-key <key>] [--mubit-actor-id <id>] [--json]",
    "  codaph init [--cwd <path>] [--yes] [--force] [--no-auto-sync] [--json]",
    "",
    "Daily Use:",
    "  codaph sync [--cwd <path>] [--json]           (fast Mubit-first sync)",
    "  codaph status [--cwd <path>] [--json]         (repo sync + automation status)",
    "  codaph tui [--cwd <path>]",
    "",
    "Optional Backfill:",
    "  codaph import [--cwd <path>] [--json] [--local-only]",
    "    Replays historical Codex sessions from ~/.codex/sessions into Codaph + Mubit.",
    "",
    "Advanced / Compatibility (still supported):",
    "  codaph sync pull|status|setup ...",
    "  codaph sync push ...      (compat alias for `codaph import`)",
    "  codaph run|exec ...       (Codex capture wrappers)",
    "  codaph sessions|timeline|diff|inspect ...",
    "  codaph doctor, codaph hooks run ..., codaph mubit query ...",
    "",
    "Tip: run `codaph init`, then `codaph sync` and `codaph tui`.",
  ].join("\n");
}

function loadSettingsOrDefault(settings?: CodaphSettings): CodaphSettings {
  return settings ?? loadCodaphSettings();
}

function resolveMubitApiKey(flags: Flags, settings?: CodaphSettings): string | null {
  const loaded = loadSettingsOrDefault(settings);
  const raw =
    getStringFlag(flags, "mubit-api-key") ??
    process.env.MUBIT_API_KEY ??
    process.env.MUBIT_APIKEY ??
    loaded.mubitApiKey ??
    null;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function resolveMubitProjectId(flags: Flags, cwd: string, settings?: CodaphSettings): string | null {
  const loaded = loadSettingsOrDefault(settings);
  const projectSettings = getProjectSettings(loaded, cwd);
  const explicit =
    getStringFlag(flags, "mubit-project-id") ??
    process.env.CODAPH_PROJECT_ID ??
    process.env.MUBIT_PROJECT_ID ??
    projectSettings.mubitProjectId ??
    null;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const detected = detectGitHubDefaults(cwd).projectId;
  return detected && detected.trim().length > 0 ? detected.trim() : null;
}

function resolveMubitActorId(flags: Flags, cwd: string, settings?: CodaphSettings): string | null {
  const loaded = loadSettingsOrDefault(settings);
  const explicit =
    getStringFlag(flags, "mubit-actor-id") ??
    process.env.CODAPH_ACTOR_ID ??
    loaded.mubitActorId ??
    null;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }

  const detected = detectGitHubDefaults(cwd).actorId;
  if (detected && detected.trim().length > 0) {
    return detected.trim();
  }

  const fallback = process.env.USER ?? process.env.USERNAME ?? null;
  return fallback && fallback.trim().length > 0 ? fallback.trim() : null;
}

function resolveMubitRunScope(flags: Flags, cwd: string, settings?: CodaphSettings): MubitRunScope {
  const loaded = loadSettingsOrDefault(settings);
  const projectSettings = getProjectSettings(loaded, cwd);
  const explicit =
    getStringFlag(flags, "mubit-run-scope") ??
    process.env.CODAPH_MUBIT_RUN_SCOPE ??
    projectSettings.mubitRunScope ??
    null;
  if (explicit) {
    return explicit.toLowerCase() === "project" ? "project" : "session";
  }
  return resolveMubitProjectId(flags, cwd, loaded) ? "project" : "session";
}

function resolveProjectLabel(flags: Flags, cwd: string, settings?: CodaphSettings): string {
  const loaded = loadSettingsOrDefault(settings);
  const projectSettings = getProjectSettings(loaded, cwd);
  const explicitName = projectSettings.projectName;
  if (explicitName && explicitName.trim().length > 0) {
    return explicitName.trim();
  }
  const projectId = resolveMubitProjectId(flags, cwd, loaded);
  if (projectId && projectId.trim().length > 0) {
    return projectId.trim();
  }
  return basename(cwd) || cwd;
}

function resolveRepoIdForProject(flags: Flags, cwd: string, settings?: CodaphSettings): string {
  const loaded = loadSettingsOrDefault(settings);
  return resolveMubitProjectId(flags, cwd, loaded) ?? repoIdFromPath(cwd);
}

function resolveOpenAiApiKey(flags: Flags, settings?: CodaphSettings): string | null {
  const loaded = loadSettingsOrDefault(settings);
  const raw =
    getStringFlag(flags, "openai-api-key") ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENAI_APIKEY ??
    loaded.openAiApiKey ??
    null;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function shouldUseOpenAiAgent(flags: Flags, settings?: CodaphSettings): boolean {
  const hasKey = resolveOpenAiApiKey(flags, settings) !== null;
  return getBooleanFlag(flags, "agent", hasKey);
}

function shouldEnableMubit(flags: Flags, settings?: CodaphSettings): boolean {
  const envHasKey = resolveMubitApiKey(flags, settings) !== null;
  return getBooleanFlag(flags, "mubit", envHasKey);
}

function resolveMubitWriteTimeoutMs(flags: Flags): number {
  const raw = getStringFlag(flags, "mubit-write-timeout-ms");
  if (!raw) {
    return 15000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 15000;
  }
  return parsed;
}

function createMubitMemory(flags: Flags, cwd: string, settings?: CodaphSettings): MubitMemoryEngine | null {
  const loaded = loadSettingsOrDefault(settings);
  const enabled = shouldEnableMubit(flags, loaded);
  if (!enabled) {
    return null;
  }

  const apiKey = resolveMubitApiKey(flags, loaded);
  if (!apiKey) {
    return null;
  }

  const transport = getStringFlag(flags, "mubit-transport");
  const maybeTransport =
    transport === "auto" || transport === "http" || transport === "grpc" ? transport : undefined;

  return new MubitMemoryEngine({
    apiKey,
    transport: maybeTransport,
    endpoint: getStringFlag(flags, "mubit-endpoint"),
    httpEndpoint: getStringFlag(flags, "mubit-http-endpoint"),
    grpcEndpoint: getStringFlag(flags, "mubit-grpc-endpoint"),
    agentId: getStringFlag(flags, "mubit-agent-id") ?? "codaph-cli",
    projectId: resolveMubitProjectId(flags, cwd, loaded) ?? undefined,
    actorId: resolveMubitActorId(flags, cwd, loaded) ?? undefined,
    runScope: resolveMubitRunScope(flags, cwd, loaded),
  });
}

function mubitRunIdForContext(
  flags: Flags,
  repoId: string,
  sessionId: string,
  cwd: string,
  settings?: CodaphSettings,
): string {
  const loaded = loadSettingsOrDefault(settings);
  const projectId = resolveMubitProjectId(flags, cwd, loaded) ?? repoId;
  if (resolveMubitRunScope(flags, cwd, loaded) === "project") {
    return mubitRunIdForProject(projectId);
  }
  return mubitRunIdForSession(projectId, sessionId);
}

async function doctor(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const settings = loadCodaphSettings();
  const requested = shouldEnableMubit(flags, settings);
  const envKeyPresent =
    (typeof process.env.MUBIT_API_KEY === "string" && process.env.MUBIT_API_KEY.trim().length > 0) ||
    (typeof process.env.MUBIT_APIKEY === "string" && process.env.MUBIT_APIKEY.trim().length > 0);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const keyPresent = resolveMubitApiKey(flags, settings) !== null;
  const memory = createMubitMemory(flags, cwd, settings);
  const openAiKeyPresent = resolveOpenAiApiKey(flags, settings) !== null;
  const agentEnabled = shouldUseOpenAiAgent(flags, settings);
  const projectId = resolveMubitProjectId(flags, cwd, settings);
  const actorId = resolveMubitActorId(flags, cwd, settings);
  const runScope = resolveMubitRunScope(flags, cwd, settings);
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const auto = resolveSyncAutomationConfig(settings, cwd);
  const remoteState = await maybeReadRemoteSyncStateForProject(cwd, repoId).catch(() => null);

  console.log(`cwd: ${cwd}`);
  console.log(`repoId(local): ${repoId}`);
  console.log(`Mubit project id: ${projectId ?? "(not set, uses local repoId)"}`);
  console.log(`Mubit run scope: ${runScope}`);
  console.log(`Mubit actor id: ${actorId ?? "(not set)"}`);
  console.log(`env MUBIT_API_KEY present: ${envKeyPresent ? "yes" : "no"}`);
  console.log(`flag/env key resolved: ${keyPresent ? "yes" : "no"}`);
  console.log(`Mubit requested: ${requested ? "yes" : "no"}`);
  console.log(`Mubit runtime: ${memory?.isEnabled() ? "enabled" : "disabled"}`);
  console.log(`Mubit run scope preview: ${mubitRunIdForContext(flags, repoId, "session-preview", cwd, settings)}`);
  console.log(`Mubit write timeout: ${resolveMubitWriteTimeoutMs(flags)}ms`);
  console.log(
    `Sync automation: ${auto.enabled ? "enabled" : "disabled"} (post-commit:${auto.gitPostCommit ? "on" : "off"}, agent-complete:${auto.agentComplete ? "on" : "off"}, autoPull:${auto.autoPullOnSync ? "on" : "off"}, tuiWarm:${auto.autoWarmTuiOnOpen ? "on" : "off"}, cooldown=${auto.remotePullCooldownSec}s)`,
  );
  if (remoteState) {
    console.log(
      `Remote sync state: lastSuccess=${remoteState.lastSuccessAt ?? "(never)"} received=${remoteState.receivedTimelineCount ?? 0} imported=${remoteState.lastImported ?? 0} dedup=${remoteState.lastDeduplicated ?? 0} sameSnapshot=${remoteState.consecutiveSameSnapshotCount} capped=${remoteState.suspectedServerCap ? "yes" : "no"} pending=${remoteState.pendingTrigger.pending ? "yes" : "no"}`,
    );
    if (remoteState.lastError) {
      console.log(`Remote sync last error: ${remoteState.lastError}`);
    }
  } else {
    console.log("Remote sync state: none yet");
  }
  console.log(`OpenAI key present: ${openAiKeyPresent ? "yes" : "no"}`);
  console.log(`OpenAI agent: ${agentEnabled ? "enabled" : "disabled"}`);

  if (!requested) {
    console.log("Reason: Mubit was not requested (use --mubit to force-enable).");
  } else if (!keyPresent) {
    console.log("Reason: no Mubit key resolved.");
  } else {
    console.log("Mubit setup looks valid from env/flags.");
  }
}

function createPipeline(
  cwd: string,
  flags: Flags,
  settings?: CodaphSettings,
  options: {
    bulkSync?: boolean;
  } = {},
): { pipeline: IngestPipeline; memory: MubitMemoryEngine | null; mirror: JsonlMirror } {
  const loaded = loadSettingsOrDefault(settings);
  const mirrorRoot = resolve(cwd, ".codaph");
  const mirror = new JsonlMirror(mirrorRoot, {
    indexWriteMode: "batch",
    autoFlushEveryEvents: 0,
  });
  const memory = createMubitMemory(flags, cwd, loaded);
  const memoryWriteTimeoutMs = resolveMubitWriteTimeoutMs(flags);
  const defaultActorId = resolveMubitActorId(flags, cwd, loaded);
  let lastMemoryErrorMessage: string | null = null;
  let lastMemoryErrorAt = 0;
  const pipeline = new IngestPipeline(mirror, {
    memoryEngine: memory ?? undefined,
    memoryWriteTimeoutMs,
    memoryWriteConcurrency: options.bulkSync ? 2 : 1,
    memoryBatchSize: options.bulkSync ? 24 : 1,
    defaultActorId,
    onMemoryError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      if (message === lastMemoryErrorMessage && now - lastMemoryErrorAt < 2000) {
        return;
      }
      lastMemoryErrorMessage = message;
      lastMemoryErrorAt = now;
      console.warn(`Mubit write failed: ${message}`);
    },
  });
  return { pipeline, memory, mirror };
}

function formatSummary(summary: CodexHistorySyncSummary): string {
  return `Synced ${summary.importedEvents} events from ${summary.matchedFiles}/${summary.scannedFiles} Codex session files (sessions: ${summary.importedSessions}).`;
}

function shortenPath(path: string, maxChars = 58): string {
  if (path.length <= maxChars) {
    return path;
  }
  if (maxChars <= 3) {
    return path.slice(0, maxChars);
  }
  return `...${path.slice(-(maxChars - 3))}`;
}

function fitTtyLine(text: string): string {
  if (!output.isTTY) {
    return text;
  }
  const columns = typeof output.columns === "number" ? output.columns : 0;
  if (!Number.isFinite(columns) || columns <= 8 || text.length < columns) {
    return text;
  }
  const max = Math.max(8, columns - 1);
  if (text.length <= max) {
    return text;
  }
  if (max <= 3) {
    return text.slice(0, max);
  }
  return `${text.slice(0, max - 3)}...`;
}

function renderInlineProgressBar(current: number, total: number, width = 14): string {
  const safeTotal = Math.max(0, total);
  const safeCurrent = Math.max(0, Math.min(current, safeTotal));
  if (safeTotal <= 0) {
    return `[${"-".repeat(width)}]`;
  }
  const filled = Math.round((safeCurrent / safeTotal) * width);
  return `[${"#".repeat(Math.max(0, filled))}${"-".repeat(Math.max(0, width - filled))}]`;
}

function formatElapsedMs(startedAtMs: number): string {
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const seconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m${String(remSeconds).padStart(2, "0")}s`;
  }
  return `${remSeconds}s`;
}

function createSyncProgressReporter(prefix: string): {
  start: () => void;
  onProgress: (progress: CodexHistorySyncProgress) => void;
  finish: () => void;
} {
  let lastInlineLength = 0;
  let lastPrintAt = 0;
  let startedAtMs = Date.now();
  let spinnerAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastProgress: CodexHistorySyncProgress | null = null;
  let announced = false;
  const spinnerFrames = ["-", "\\", "|", "/"];

  const render = (force = false) => {
    const progress = lastProgress;
    const spinner = spinnerFrames[spinnerAt % spinnerFrames.length] ?? "-";
    spinnerAt += 1;
    const elapsed = formatElapsedMs(startedAtMs);
    const line = progress
      ? (() => {
        const session = progress.currentSessionId ? progress.currentSessionId.slice(0, 8) : "unknown";
        const processed = Math.max(0, Math.min(progress.processedFiles ?? progress.matchedFiles, progress.scannedFiles));
        const progressBar = renderInlineProgressBar(processed, progress.scannedFiles, 14);
        return `${spinner} ${prefix} ${progressBar} ${elapsed} | scan ${processed}/${progress.scannedFiles} | match ${progress.matchedFiles} | events ${progress.importedEvents} | line ${progress.currentLine} | session ${session} | ${shortenPath(progress.currentFile)}`;
      })()
      : `${spinner} ${prefix} [${"-".repeat(14)}] ${elapsed} | starting...`;

    if (output.isTTY) {
      const ttyLine = fitTtyLine(line);
      const padding = " ".repeat(Math.max(0, lastInlineLength - ttyLine.length));
      output.write(`\r${ttyLine}${padding}`);
      lastInlineLength = ttyLine.length;
      announced = true;
      return;
    }

    const now = Date.now();
    if (!force && now - lastPrintAt < 1500) {
      return;
    }
    lastPrintAt = now;
    console.log(line);
    announced = true;
  };

  return {
    start() {
      startedAtMs = Date.now();
      spinnerAt = 0;
      lastProgress = null;
      if (output.isTTY && !timer) {
        render(true);
        timer = setInterval(() => render(false), 120);
      } else if (!output.isTTY) {
        render(true);
      }
    },
    onProgress(progress) {
      lastProgress = progress;
      render(false);
    },
    finish() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!announced) {
        return;
      }
      if (output.isTTY && lastInlineLength > 0) {
        output.write("\n");
      }
    },
  };
}

interface SyncPushPhaseResult {
  repoId: string;
  actorId: string | null;
  summary: CodexHistorySyncSummary;
  mubitRequested: boolean;
  mubitEnabled: boolean;
}

interface SyncPullPhaseResult {
  repoId: string;
  projectId: string;
  actorId: string | null;
  statePath: string;
  summary: MubitRemoteSyncSummary;
}

interface SyncPullPhaseSkipped {
  skipped: true;
  reason: string;
}

type SyncPushMode = "queue" | "history";

type SyncPullPhaseOutcome = SyncPullPhaseResult | SyncPullPhaseSkipped;

interface SyncWorkflowSummary {
  schema: "codaph.sync.v2";
  mode: "all" | "push" | "pull";
  trigger: SyncTriggerSource;
  push: (SyncPushPhaseResult & { skipped?: false }) | { skipped: true; reason: string };
  pull: (SyncPullPhaseResult & { skipped?: false }) | { skipped: true; reason: string };
  automation: {
    enabled: boolean;
    gitPostCommit: boolean;
    agentComplete: boolean;
    autoWarmTuiOnOpen: boolean;
    autoPullOnSync: boolean;
    remotePullCooldownSec: number;
  };
  timing: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
  };
  lockWaited: boolean;
  lockBusy: boolean;
}

function isSyncPullPhaseSkipped(value: SyncPullPhaseOutcome): value is SyncPullPhaseSkipped {
  return (value as SyncPullPhaseSkipped).skipped === true;
}

function isSyncPushPhaseSkipped(
  value: SyncPushPhaseResult | { skipped: true; reason: string },
): value is { skipped: true; reason: string } {
  return (value as { skipped?: boolean }).skipped === true;
}

async function runSyncQueuePushPhase(options: {
  cwd: string;
  flags: Flags;
  settings: CodaphSettings;
}): Promise<{ skipped: true; reason: string }> {
  const repoId = resolveRepoIdForProject(options.flags, options.cwd, options.settings);
  const localPush = await maybeReadLocalPushStateForProject(options.cwd, repoId).catch(() => null);
  if (!localPush?.lastSuccessAt) {
    return {
      skipped: true,
      reason: "No repo-local push queue. Use `codaph import` once to backfill Codex history into Mubit.",
    };
  }
  return {
    skipped: true,
    reason: "No repo-local push queue pending (captures write to Mubit inline).",
  };
}

function resolveMirrorRoot(cwd: string): string {
  return resolve(cwd, ".codaph");
}

function resolveRemoteSyncStatePath(cwd: string, repoId: string): string {
  return getMubitRemoteSyncStatePath(resolveMirrorRoot(cwd), repoId);
}

function resolveLocalProjectConfigPath(cwd: string): string {
  return join(resolveMirrorRoot(cwd), "project.json");
}

function resolveGitRepoRootOrCwd(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

async function writeLocalProjectConfigSnapshot(cwd: string, flags: Flags, settings: CodaphSettings): Promise<string> {
  const projectPath = resolve(cwd);
  const repoId = resolveRepoIdForProject(flags, projectPath, settings);
  const automation = resolveSyncAutomationConfig(settings, projectPath);
  const payload: CodaphProjectFile = {
    schema: "codaph.project.v1",
    projectPath,
    repoId,
    projectLabel: resolveProjectLabel(flags, projectPath, settings),
    mubitProjectId: resolveMubitProjectId(flags, projectPath, settings),
    mubitRunScope: resolveMubitRunScope(flags, projectPath, settings),
    syncAutomation: {
      enabled: automation.enabled,
      gitPostCommit: automation.gitPostCommit,
      agentComplete: automation.agentComplete,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const path = resolveLocalProjectConfigPath(projectPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

function resolveLocalPushStatePath(cwd: string, repoId: string): string {
  return getCodexLocalPushStatePath(resolveMirrorRoot(cwd), repoId);
}

async function maybeReadLocalPushStateForProject(cwd: string, repoId: string) {
  return readCodexLocalPushState(resolveLocalPushStatePath(cwd, repoId));
}

async function persistLocalPushState(
  cwd: string,
  repoId: string,
  updater: (current: CodexLocalPushState) => CodexLocalPushState,
): Promise<void> {
  const path = resolveLocalPushStatePath(cwd, repoId);
  const current = await readCodexLocalPushState(path).catch(() => defaultCodexLocalPushState());
  await writeCodexLocalPushState(path, updater(current));
}

async function persistLocalPushSuccessState(
  cwd: string,
  result: SyncPushPhaseResult,
  triggerSource: SyncTriggerSource,
): Promise<void> {
  const now = new Date().toISOString();
  await persistLocalPushState(cwd, result.repoId, (current) => ({
    ...current,
    lastRunAt: now,
    lastSuccessAt: now,
    lastTriggerSource: triggerSource,
    lastScannedFiles: result.summary.scannedFiles,
    lastMatchedFiles: result.summary.matchedFiles,
    lastImportedEvents: result.summary.importedEvents,
    lastImportedSessions: result.summary.importedSessions,
    mubitRequested: result.mubitRequested,
    mubitEnabled: result.mubitEnabled,
    lastError: null,
  }));
}

async function persistLocalPushErrorState(
  cwd: string,
  repoId: string,
  triggerSource: SyncTriggerSource,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  await persistLocalPushState(cwd, repoId, (current) => ({
    ...current,
    lastRunAt: now,
    lastTriggerSource: triggerSource,
    lastError: errorMessage,
  }));
}

function resolveSyncAutomationConfig(settings: CodaphSettings, cwd: string) {
  const project = getProjectSettings(settings, cwd);
  return normalizeSyncAutomationSettings(project.syncAutomation ?? null);
}

function formatTimeAgo(ts: string | null): string | null {
  if (!ts) {
    return null;
  }
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const deltaMs = Date.now() - parsed;
  if (deltaMs < 0) {
    return "just now";
  }
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isInteractiveTerminal(): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

function cliOnOff(value: boolean): string {
  return paint(value ? "on" : "off", value ? TUI_COLORS.green : TUI_COLORS.red);
}

function cliEnabledOff(value: boolean): string {
  return paint(value ? "enabled" : "off", value ? TUI_COLORS.green : TUI_COLORS.yellow);
}

function cliStatusWord(text: string, tone: "ok" | "warn" | "dim" = "dim"): string {
  const color =
    tone === "ok" ? TUI_COLORS.green :
    tone === "warn" ? TUI_COLORS.yellow :
    TUI_COLORS.dim;
  return paint(text, color);
}

function formatAutoSyncSummaryLine(
  label: string,
  auto: { enabled: boolean; gitPostCommit: boolean; agentComplete: boolean },
): string {
  return `${paint(label, TUI_COLORS.dim)} ${cliEnabledOff(auto.enabled)} (${paint("post-commit", TUI_COLORS.dim)}:${cliOnOff(auto.gitPostCommit)}, ${paint("agent-complete", TUI_COLORS.dim)}:${cliOnOff(auto.agentComplete)})`;
}

async function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise<string>((resolve) => rl.question(`${question} `, resolve));
  } finally {
    rl.close();
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

async function maybePromptForMubitApiKeyDuringInit(
  cwd: string,
  flags: Flags,
  settings: CodaphSettings,
): Promise<CodaphSettings> {
  if (resolveMubitApiKey(flags, settings)) {
    return settings;
  }

  if (flags.json === true || getBooleanFlag(flags, "yes", false) || !isInteractiveTerminal()) {
    return settings;
  }

  console.log("Mubit API key not found.");
  console.log("Codaph is Mubit-first. Without a Mubit API key, cloud sync/shared memory are disabled.");
  console.log("Get one from: https://console.mubit.ai");

  let entered = "";
  for (;;) {
    entered = (await promptInput("Paste Mubit API key (or type 'skip' for local-only):")).trim();
    const normalized = entered.toLowerCase();
    if (entered.length > 0 && normalized !== "skip") {
      break;
    }
    if (normalized === "skip") {
      const confirmSkip = await promptYesNo(
        "Continue without Mubit cloud sync? (`codaph sync` will stay local until you add a key)",
      );
      if (confirmSkip) {
        console.log("Continuing local-only. Add a key later with `codaph setup --mubit-api-key <key>`.");
        return settings;
      }
      continue;
    }
    console.log("Mubit API key is recommended for Codaph setup. Paste a key, or type `skip` to continue local-only.");
  }

  const next = updateGlobalSettings(settings, { mubitApiKey: entered });
  saveCodaphSettings(next);
  console.log("Saved Mubit API key to ~/.codaph/settings.json");

  if (!next.mubitActorId) {
    const actor = detectGitHubDefaults(cwd).actorId ?? resolveMubitActorId(flags, cwd, next);
    if (actor) {
      const withActor = updateGlobalSettings(next, { mubitActorId: actor });
      saveCodaphSettings(withActor);
      console.log(`Detected actor id: ${actor}`);
      return withActor;
    }
  }

  return next;
}

function resolveTimelineLimit(flags: Flags, fallback = 1200): number {
  const raw = getStringFlag(flags, "timeline-limit") ?? getStringFlag(flags, "limit");
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePullRefresh(flags: Flags, fallback = true): boolean {
  return getBooleanFlag(flags, "refresh", fallback);
}

async function runSyncPushPhase(options: {
  cwd: string;
  flags: Flags;
  settings: CodaphSettings;
  onProgress?: (progress: CodexHistorySyncProgress) => void;
}): Promise<SyncPushPhaseResult> {
  const { cwd, flags, settings, onProgress } = options;
  const localOnly = getBooleanFlag(flags, "local-only", false);
  const legacySyncMubit = getBooleanFlag(flags, "sync-mubit", false);
  const syncFlags: Flags = { ...flags };
  if (legacySyncMubit) {
    syncFlags.mubit = true;
  }
  if (localOnly) {
    syncFlags.mubit = false;
  }

  const repoId = resolveRepoIdForProject(syncFlags, cwd, settings);
  const actorId = resolveMubitActorId(syncFlags, cwd, settings);
  const { pipeline, memory } = createPipeline(cwd, syncFlags, settings, { bulkSync: true });
  let summary: CodexHistorySyncSummary;
  try {
    summary = await syncCodexHistory({
      projectPath: cwd,
      pipeline,
      repoId,
      actorId,
      onProgress,
    });
  } finally {
    await pipeline.flush();
  }

  return {
    repoId,
    actorId,
    summary,
    mubitRequested: shouldEnableMubit(syncFlags, settings),
    mubitEnabled: Boolean(memory?.isEnabled()),
  };
}

async function runSyncPullPhase(options: {
  cwd: string;
  flags: Flags;
  settings: CodaphSettings;
  triggerSource: SyncTriggerSource;
  requireMubit?: boolean;
  onProgress?: (progress: { current: number; total: number; imported: number; deduplicated: number; skipped: number }) => void;
}): Promise<SyncPullPhaseOutcome> {
  const { cwd, flags, settings, triggerSource, requireMubit = true, onProgress } = options;
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const projectId = resolveMubitProjectId(flags, cwd, settings) ?? repoId;
  const actorId = resolveMubitActorId(flags, cwd, settings);
  const engine = createMubitMemory(flags, cwd, settings);
  if (!engine || !engine.isEnabled()) {
    if (requireMubit) {
      throw new Error("Mubit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
    }
    return { skipped: true, reason: "Mubit is disabled or not configured." };
  }

  const mirror = new JsonlMirror(resolveMirrorRoot(cwd), {
    indexWriteMode: "batch",
    autoFlushEveryEvents: 0,
  });
  let summary: MubitRemoteSyncSummary;
  try {
    summary = await syncMubitRemoteActivity({
      mirror,
      memory: engine,
      runId: mubitRunIdForProject(projectId),
      promptRunId: mubitPromptRunIdForProject(projectId),
      repoId,
      fallbackActorId: actorId,
      timelineLimit: resolveTimelineLimit(flags),
      refresh: resolvePullRefresh(flags, true),
      statePath: resolveRemoteSyncStatePath(cwd, repoId),
      triggerSource,
      onProgress,
    });
  } finally {
    await mirror.flush();
  }

  return {
    repoId,
    projectId,
    actorId,
    statePath: resolveRemoteSyncStatePath(cwd, repoId),
    summary,
  };
}

function formatPushPhaseLine(result: SyncPushPhaseResult | { skipped: true; reason: string }): string {
  if (isSyncPushPhaseSkipped(result)) {
    if (result.reason.includes("No repo-local push queue")) {
      return `Push (local->cloud): no queued local uploads (fast path). Use \`codaph import\` for Codex history backfill.`;
    }
    return `Push (local->cloud): skipped (${result.reason})`;
  }
  const { summary } = result;
  if (summary.matchedFiles === 0) {
    return `Push (local->cloud): No Codex history for this repo (matched 0 of ${summary.scannedFiles} local Codex session files).`;
  }
  if (summary.importedEvents === 0) {
    return `Push (local->cloud): no new local events for this repo (matched files=${summary.matchedFiles}/${summary.scannedFiles}, sessions=${summary.importedSessions}).`;
  }
  return `Push (local->cloud): local events imported=${summary.importedEvents}, files=${summary.matchedFiles}/${summary.scannedFiles}, sessions=${summary.importedSessions}, Mubit=${result.mubitEnabled ? "on" : result.mubitRequested ? "requested-unavailable" : "off"}`;
}

function formatPullPhaseLine(result: SyncPullPhaseOutcome): string {
  if (isSyncPullPhaseSkipped(result)) {
    return `Pull (cloud->local): skipped (${result.reason})`;
  }
  const s = result.summary;
  const cap = s.suspectedServerCap ? ", capped?" : "";
  const noChange = s.noRemoteChangesDetected ? ", no remote changes" : "";
  const promptStream = (s.promptTimelineEvents ?? 0) > 0 ? `, prompt-stream=${s.promptTimelineEvents}` : "";
  return `Pull (cloud->local): snapshot received=${s.timelineEvents} (requested=${s.requestedTimelineLimit}${cap}${promptStream}), imported=${s.imported}, dedup=${s.deduplicated}, skipped=${s.skipped}${noChange}`;
}

async function maybeReadRemoteSyncStateForProject(cwd: string, repoId: string) {
  return readMubitRemoteSyncState(resolveRemoteSyncStatePath(cwd, repoId));
}

async function runCapture(command: CaptureMode, rest: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(rest);
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const { pipeline, memory } = createPipeline(cwd, flags, settings);

  const options = {
    prompt,
    cwd,
    repoId,
    model: getStringFlag(flags, "model"),
    resumeThreadId: getStringFlag(flags, "resume-thread"),
  };

  const adapter = command === "run" ? new CodexSdkAdapter(pipeline) : new CodexExecAdapter(pipeline);

  const result = await (async () => {
    try {
      return await adapter.runAndCapture(options, (event) => {
        const itemType = (event.payload.item as { type?: string } | undefined)?.type;
        console.log(`${event.ts} ${event.eventType}${itemType ? `:${itemType}` : ""}`);
      });
    } finally {
      await pipeline.flush();
    }
  })();

  console.log(`sessionId: ${result.sessionId}`);
  console.log(`threadId: ${result.threadId ?? "(none)"}`);
  if (memory?.isEnabled()) {
    console.log("Mubit: enabled");
  } else {
    console.log("Mubit: disabled (set MUBIT_API_KEY or pass --mubit-api-key)");
  }
  if (result.finalResponse) {
    console.log("\nfinalResponse:\n");
    console.log(result.finalResponse);
  }
}

async function listSessions(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const query = new QueryService(resolve(cwd, ".codaph"));
  const sessions = await query.listSessions(repoId);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const s of sessions) {
    console.log(`${s.sessionId} | ${s.from} -> ${s.to} | events=${s.eventCount} | threads=${s.threadCount}`);
  }
}

async function timeline(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const query = new QueryService(resolve(cwd, ".codaph"));
  const events = await query.getTimeline({ repoId, sessionId });

  if (flags.json === true) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  for (const event of events) {
    const itemType = (event.payload.item as { type?: string } | undefined)?.type;
    console.log(`${event.ts} | ${event.eventType}${itemType ? `:${itemType}` : ""}`);
  }
}

async function diff(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const pathFilter = getStringFlag(flags, "path");

  const query = new QueryService(resolve(cwd, ".codaph"));
  const summary = await query.getDiffSummary(repoId, sessionId, pathFilter);

  if (summary.length === 0) {
    console.log("No file changes found.");
    return;
  }

  for (const row of summary) {
    console.log(`${row.path} | kinds=${row.kinds.join(",")} | occurrences=${row.occurrences}`);
  }
}

async function enableSyncAutomationForProject(cwd: string, settings: CodaphSettings): Promise<{
  settings: CodaphSettings;
  installed: {
    gitPostCommit: boolean;
    agentComplete: boolean;
    partial: boolean;
    warnings: string[];
    manualSteps: string[];
  };
}> {
  let repoRoot = cwd;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || cwd;
  } catch {
    repoRoot = cwd;
  }

  const warnings = await detectHookManagerWarnings(repoRoot);
  const manualSteps: string[] = [];

  const postCommitCommands = hookCommandCandidates("post-commit");
  const gitPostCommit = await installGitPostCommitHook(repoRoot, postCommitCommands);
  if (!gitPostCommit.ok) {
    warnings.push(`Git post-commit hook automation was not installed: ${gitPostCommit.warning ?? "unknown error"}`);
  }
  const postPushCommands = hookCommandCandidates("post-push");
  const gitPostPush = await installGitPostPushHook(repoRoot, postPushCommands);
  if (!gitPostPush.ok) {
    warnings.push(`Git post-push hook automation was not installed: ${gitPostPush.warning ?? "unknown error"}`);
  }

  const agentCompleteCommands = hookCommandCandidates("agent-complete");
  const agentComplete = await installAgentCompleteHookBestEffort(repoRoot, agentCompleteCommands);
  if (!agentComplete.ok) {
    warnings.push(agentComplete.warning ?? "Agent-complete hook auto-install was not possible.");
    manualSteps.push(`Attach this command to your agent-complete hook: ${agentComplete.manualSnippet}`);
  }

  const currentProject = getProjectSettings(settings, cwd);
  const mergedAutomation = normalizeSyncAutomationSettings(currentProject.syncAutomation ?? null);
  const nextSettings = updateProjectSettings(settings, cwd, {
    ...currentProject,
    syncAutomation: {
      ...mergedAutomation,
      enabled: true,
      gitPostCommit: gitPostCommit.ok,
      agentComplete: agentComplete.ok,
      autoPullOnSync: mergedAutomation.autoPullOnSync,
      autoWarmTuiOnOpen: mergedAutomation.autoWarmTuiOnOpen,
      remotePullCooldownSec: mergedAutomation.remotePullCooldownSec,
      lastSetupVersion: SYNC_AUTOMATION_SETUP_VERSION,
    },
  });
  saveCodaphSettings(nextSettings);

  return {
    settings: nextSettings,
    installed: {
      gitPostCommit: gitPostCommit.ok,
      agentComplete: agentComplete.ok,
      partial: !gitPostCommit.ok || !agentComplete.ok,
      warnings,
      manualSteps,
    },
  };
}

async function maybeOfferSyncAutomationSetup(
  cwd: string,
  flags: Flags,
  settings: CodaphSettings,
  mode: "all" | "push" | "pull",
): Promise<void> {
  if (mode !== "all" && mode !== "push") {
    return;
  }
  if (getBooleanFlag(flags, "no-auto-enable", false)) {
    return;
  }

  const auto = resolveSyncAutomationConfig(settings, cwd);
  const forceEnable = getBooleanFlag(flags, "enable-auto", false);
  if (auto.enabled && !forceEnable) {
    return;
  }

  const confirmBypass = getBooleanFlag(flags, "yes", false);
  if (!forceEnable && auto.enabled) {
    return;
  }

  if (!isInteractiveTerminal()) {
    if (forceEnable && !confirmBypass) {
      console.log("Automation install requires confirmation in non-interactive mode. Re-run with `codaph sync --enable-auto --yes`.");
      return;
    }
    if (!forceEnable) {
      console.log("Automation is not enabled for this repo.");
      console.log("Run `codaph sync --enable-auto --yes` to install post-commit and agent-complete sync triggers.");
      return;
    }
  }

  let approved = forceEnable && confirmBypass;
  if (!approved) {
    approved = await promptYesNo("Enable Codaph sync automation for this repo (post-commit + agent-complete hooks)?");
  }
  if (!approved) {
    return;
  }

  const result = await enableSyncAutomationForProject(cwd, settings);
  await writeLocalProjectConfigSnapshot(cwd, flags, result.settings).catch(() => {});
  console.log(
    `${paint("Updated auto-sync:", TUI_COLORS.dim)} ${cliStatusWord("enabled", "ok")} (${paint("post-commit", TUI_COLORS.dim)}:${result.installed.gitPostCommit ? cliStatusWord("installed", "ok") : cliStatusWord("unavailable", "warn")}, ${paint("agent-complete", TUI_COLORS.dim)}:${result.installed.agentComplete ? cliStatusWord("installed", "ok") : cliStatusWord("partial", "warn")})`,
  );
  for (const warning of result.installed.warnings) {
    console.log(`${cliStatusWord("Warning:", "warn")} ${warning}`);
  }
  for (const step of result.installed.manualSteps) {
    console.log(step);
  }
}

async function runSyncWorkflow(options: {
  mode: "all" | "push" | "pull";
  pushMode?: SyncPushMode;
  cwd: string;
  flags: Flags;
  settings: CodaphSettings;
  triggerSource: SyncTriggerSource;
  hookMode?: boolean;
  quiet?: boolean;
  onPushProgress?: (progress: CodexHistorySyncProgress) => void;
  onPullProgress?: (progress: { current: number; total: number; imported: number; deduplicated: number; skipped: number }) => void;
}): Promise<SyncWorkflowSummary> {
  const startedAt = new Date().toISOString();
  const { mode, cwd, flags, settings, triggerSource } = options;
  const pushMode = options.pushMode ?? "queue";
  const hookMode = options.hookMode === true;
  const quiet = options.quiet === true;
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const mirrorRoot = resolveMirrorRoot(cwd);
  const statePath = resolveRemoteSyncStatePath(cwd, repoId);
  const lockPath = getSyncLockPath(mirrorRoot);
  const logPath = getSyncAutomationLogPath(mirrorRoot);
  const automation = resolveSyncAutomationConfig(settings, cwd);
  const lockHandle = await acquireSyncLock(lockPath, {
    waitMs: hookMode ? 0 : 30_000,
    pollMs: 250,
    metadata: { triggerSource, mode, cwd },
  });

  if (!lockHandle) {
    if (hookMode) {
      await markPendingSyncTrigger(statePath, triggerSource).catch(() => {});
      await appendSyncAutomationLog(logPath, "lock busy; marked pending trigger", { triggerSource, mode }).catch(() => {});
      return {
        schema: "codaph.sync.v2",
        mode,
        trigger: triggerSource,
        push: { skipped: true, reason: "Sync lock busy" },
        pull: { skipped: true, reason: "Sync lock busy" },
        automation,
        timing: {
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        },
        lockWaited: false,
        lockBusy: true,
      };
    }
    throw new Error("Another Codaph sync is already running for this repo. Try again in a few seconds.");
  }

  try {
    let pushOutcome: SyncWorkflowSummary["push"];
    if (mode === "pull") {
      pushOutcome = { skipped: true, reason: "Push phase not requested." };
    } else {
      try {
        if (pushMode === "queue") {
          pushOutcome = await runSyncQueuePushPhase({ cwd, flags, settings });
        } else {
          const push = await runSyncPushPhase({ cwd, flags, settings, onProgress: options.onPushProgress });
          await persistLocalPushSuccessState(cwd, push, triggerSource).catch(() => {});
          pushOutcome = { ...push } as SyncPushPhaseResult;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await persistLocalPushErrorState(cwd, repoId, triggerSource, message).catch(() => {});
        throw error;
      }
    }

    let pullOutcome: SyncWorkflowSummary["pull"];
    if (mode === "push") {
      pullOutcome = { skipped: true, reason: "Pull phase not requested." };
    } else {
      const remoteState = await maybeReadRemoteSyncStateForProject(cwd, repoId).catch(() => null);
      const isCooldownSensitive =
        triggerSource === "hook-agent-complete" ||
        triggerSource === "hook-post-commit" ||
        triggerSource === "hook-post-push" ||
        triggerSource === "tui-startup";
      const cooldownBlocks =
        mode === "all" &&
        isCooldownSensitive &&
        automation.enabled &&
        !shouldRunRemotePullNow(remoteState?.lastRunAt ?? null, automation.remotePullCooldownSec);
      const autoPullDisabled =
        mode === "all" &&
        (
          triggerSource === "tui-sync" ||
          triggerSource === "sync-manual" ||
          triggerSource === "tui-startup" ||
          triggerSource === "hook-agent-complete" ||
          triggerSource === "hook-post-push"
        ) &&
        automation.enabled &&
        !automation.autoPullOnSync;

      if (cooldownBlocks) {
        pullOutcome = { skipped: true, reason: `Cooldown active (${automation.remotePullCooldownSec}s).` };
      } else if (autoPullDisabled) {
        pullOutcome = { skipped: true, reason: "Per-project auto pull is disabled." };
      } else {
        const pull = await runSyncPullPhase({
          cwd,
          flags,
          settings,
          triggerSource,
          requireMubit: mode === "pull",
          onProgress: options.onPullProgress,
        });
        pullOutcome = isSyncPullPhaseSkipped(pull) ? pull : ({ ...pull } as SyncPullPhaseResult);
      }
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    return {
      schema: "codaph.sync.v2",
      mode,
      trigger: triggerSource,
      push: pushOutcome,
      pull: pullOutcome,
      automation,
      timing: { startedAt, finishedAt, durationMs },
      lockWaited: !hookMode,
      lockBusy: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendSyncAutomationLog(logPath, "sync workflow error", { triggerSource, mode, error: message }).catch(() => {});
    if (hookMode) {
      return {
        schema: "codaph.sync.v2",
        mode,
        trigger: triggerSource,
        push: { skipped: true, reason: `Hook sync error: ${message}` },
        pull: { skipped: true, reason: `Hook sync error: ${message}` },
        automation,
        timing: {
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        },
        lockWaited: false,
        lockBusy: false,
      };
    }
    throw error;
  } finally {
    await releaseSyncLock(lockHandle);
    await appendSyncAutomationLog(logPath, "sync workflow finished", { triggerSource, mode }).catch(() => {});
  }
}

function printSyncWorkflowSummary(summary: SyncWorkflowSummary): void {
  console.log(formatPushPhaseLine(summary.push));
  console.log(formatPullPhaseLine(summary.pull as SyncPullPhaseOutcome));
  const pull = summary.pull;
  if (!isSyncPullPhaseSkipped(pull as SyncPullPhaseOutcome)) {
    const note = (pull as SyncPullPhaseResult).summary.diagnosticNote;
    if (note) {
      console.log(note);
    }
  }
  console.log(
    `Automation: ${summary.automation.enabled ? "enabled" : "off"} (post-commit:${summary.automation.gitPostCommit ? "on" : "off"}, agent-complete:${summary.automation.agentComplete ? "on" : "off"})`,
  );
  const pushNoQueue =
    isSyncPushPhaseSkipped(summary.push) && summary.push.reason.includes("No repo-local push queue");
  if (summary.mode === "all" && pushNoQueue) {
    console.log("Fast sync: Mubit-first remote pull + repo-local queue (no global Codex history replay).");
    console.log("Backfill history: run `codaph import` (one-time/occasional).");
  }
  if (!summary.automation.enabled) {
    console.log("Tip: run `codaph sync setup` to enable auto-sync hooks for this repo.");
  }
}

async function importCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const reporter = createSyncProgressReporter("Scanning Codex history");
  if (flags.json !== true) {
    reporter.start();
  }
  let result: SyncPushPhaseResult;
  try {
    result = await runSyncPushPhase({
      cwd,
      flags,
      settings,
      onProgress: flags.json === true ? undefined : reporter.onProgress,
    });
    await persistLocalPushSuccessState(cwd, result, "sync-manual").catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repoId = resolveRepoIdForProject(flags, cwd, settings);
    await persistLocalPushErrorState(cwd, repoId, "sync-manual", message).catch(() => {});
    throw error;
  } finally {
    if (flags.json !== true) {
      reporter.finish();
    }
  }

  if (flags.json === true) {
    console.log(JSON.stringify(result.summary, null, 2));
    return;
  }
  console.log(formatPushPhaseLine(result));
  console.log("Import complete. Daily `codaph sync` no longer replays Codex history by default.");
}

async function syncPushCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  if (flags.json !== true) {
    console.log("Note: `codaph sync push` is a compatibility alias for `codaph import` (Codex history backfill).");
  }
  await importCommand(rest);
}

async function syncPullCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const reporter = createSyncProgressReporter("Syncing Mubit remote");
  if (flags.json !== true) {
    reporter.start();
  }
  const pull = await runSyncPullPhase({
    cwd,
    flags,
    settings,
    triggerSource: "sync-manual",
    requireMubit: true,
    onProgress:
      flags.json === true
        ? undefined
        : (progress) => {
          reporter.onProgress({
            scannedFiles: progress.total,
            processedFiles: progress.current,
            matchedFiles: progress.current,
            importedEvents: progress.imported,
            currentFile: `dedup=${progress.deduplicated} skipped=${progress.skipped}`,
            currentLine: progress.current,
            currentSessionId: null,
          });
        },
  }).finally(() => {
    if (flags.json !== true) {
      reporter.finish();
    }
  });

  if (isSyncPullPhaseSkipped(pull)) {
    throw new Error(pull.reason);
  }

  if (flags.json === true) {
    console.log(JSON.stringify(pull.summary, null, 2));
    return;
  }
  console.log(formatPullPhaseLine(pull));
  if (pull.summary.diagnosticNote) {
    console.log(pull.summary.diagnosticNote);
  }
  console.log(`Remote sync run: ${pull.summary.runId}`);
}

async function syncStatus(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const automation = resolveSyncAutomationConfig(settings, cwd);
  const localPushState = await maybeReadLocalPushStateForProject(cwd, repoId).catch(() => null);
  const remoteState = await maybeReadRemoteSyncStateForProject(cwd, repoId).catch(() => null);
  const payload = {
    cwd,
    repoId,
    automation,
    localPush: localPushState,
    remote: remoteState,
  };

  if (flags.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Repo: ${repoId}`);
  console.log(formatAutoSyncSummaryLine("Auto-sync:", automation));
  if (!automation.enabled) {
    console.log("Onboarding: run `codaph sync setup` to install auto-sync hooks for this repo.");
  }
  console.log(
    `${paint("Auto pull on sync", TUI_COLORS.dim)}:${cliOnOff(automation.autoPullOnSync)} | ${paint("TUI warm", TUI_COLORS.dim)}:${cliOnOff(automation.autoWarmTuiOnOpen)} | ${paint("cooldown", TUI_COLORS.dim)}=${automation.remotePullCooldownSec}s`,
  );
  if (!localPushState) {
    console.log("Local push state: none");
  } else {
    console.log(
      `Local push: last=${localPushState.lastSuccessAt ?? "(never)"}${formatTimeAgo(localPushState.lastSuccessAt) ? ` (${formatTimeAgo(localPushState.lastSuccessAt)})` : ""} | files=${localPushState.lastMatchedFiles ?? 0}/${localPushState.lastScannedFiles ?? 0} | events=${localPushState.lastImportedEvents ?? 0} | sessions=${localPushState.lastImportedSessions ?? 0}`,
    );
    if (localPushState.lastError) {
      console.log(`Local push last error: ${localPushState.lastError}`);
    }
    if (!localPushState.lastSuccessAt) {
      console.log("Backfill: run `codaph import` if you want historical Codex sessions in Mubit.");
    }
  }
  if (!remoteState) {
    console.log("Remote sync state: none");
    console.log("Fast sync note: `codaph sync` now skips Codex history replay; use `codaph import` for backfill.");
    return;
  }
  console.log(
    `Remote pull: last=${remoteState.lastSuccessAt ?? "(never)"}${formatTimeAgo(remoteState.lastSuccessAt) ? ` (${formatTimeAgo(remoteState.lastSuccessAt)})` : ""} | received=${remoteState.receivedTimelineCount ?? 0} | imported=${remoteState.lastImported ?? 0} | dedup=${remoteState.lastDeduplicated ?? 0}`,
  );
  console.log(
    `Snapshot: ${remoteState.lastSnapshotFingerprint ? `fp=${remoteState.lastSnapshotFingerprint}` : "none"} | same-count=${remoteState.consecutiveSameSnapshotCount} | capped=${remoteState.suspectedServerCap ? "yes" : "no"} | pending=${remoteState.pendingTrigger.pending ? "yes" : "no"}`,
  );
  if (remoteState.lastError) {
    console.log(`Last error: ${remoteState.lastError}`);
  }
}

async function syncSetupCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const auto = resolveSyncAutomationConfig(settings, cwd);
  const force = getBooleanFlag(flags, "force", false);

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          cwd,
          automation: auto,
          suggestedCommand: auto.enabled ? null : "codaph sync setup --yes",
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Repo: ${cwd}`);
  console.log(formatAutoSyncSummaryLine("Current auto-sync:", auto));
  console.log("This installs repo-scoped hooks so sync runs automatically after commits and agent completion.");
  if (auto.enabled && !force) {
    console.log("Auto-sync is already enabled for this repo. Re-run with `codaph sync setup --force` to reinstall hooks.");
    return;
  }

  const setupFlags: Flags = {
    ...flags,
    "enable-auto": true,
  };
  await maybeOfferSyncAutomationSetup(cwd, setupFlags, settings, "all");
}

async function setupCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  let settings = loadCodaphSettings();
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  let changed = false;

  const mubitApiKey = getStringFlag(flags, "mubit-api-key");
  const openAiApiKey = getStringFlag(flags, "openai-api-key");
  let mubitActorId: string | undefined = getStringFlag(flags, "mubit-actor-id");
  if (!mubitActorId && getBooleanFlag(flags, "yes", false) && !settings.mubitActorId) {
    mubitActorId = detectGitHubDefaults(cwd).actorId ?? resolveMubitActorId(flags, cwd, settings) ?? undefined;
  }

  if (mubitApiKey !== undefined || openAiApiKey !== undefined || mubitActorId !== undefined) {
    settings = updateGlobalSettings(settings, {
      mubitApiKey: mubitApiKey ?? settings.mubitApiKey ?? null,
      openAiApiKey: openAiApiKey ?? settings.openAiApiKey ?? null,
      mubitActorId: mubitActorId ?? settings.mubitActorId ?? null,
    });
    saveCodaphSettings(settings);
    changed = true;
  }

  const effectiveMubitKey = resolveMubitApiKey(flags, settings);
  const effectiveActor = resolveMubitActorId(flags, cwd, settings);
  const payload = {
    changed,
    globalConfigPath: "~/.codaph/settings.json",
    mubit: {
      configured: effectiveMubitKey !== null,
      actorId: effectiveActor,
    },
    openai: {
      configured: resolveOpenAiApiKey(flags, settings) !== null,
    },
    next: {
      init: "codaph init",
    },
  };

  if (flags.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Codaph setup (global)");
  console.log(`Config: ${payload.globalConfigPath}`);
  console.log(`Mubit: ${payload.mubit.configured ? "configured" : "missing API key"} | actor=${payload.mubit.actorId ?? "(auto-detect on use)"}`);
  console.log(`OpenAI agent: ${payload.openai.configured ? "configured" : "off"}`);
  if (!payload.mubit.configured) {
    console.log("Set Mubit globally: `codaph setup --mubit-api-key <key>`");
  }
  console.log("Next: run `codaph init` inside a repo to create `.codaph/` and enable repo automation.");
}

async function initCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const requestedCwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const cwd = resolveGitRepoRootOrCwd(requestedCwd);
  let settings = loadCodaphSettings();
  settings = await maybePromptForMubitApiKeyDuringInit(cwd, flags, settings);
  const detected = detectGitHubDefaults(cwd);
  const currentProject = getProjectSettings(settings, cwd);
  const explicitName = getStringFlag(flags, "name");
  const explicitProjectId = getStringFlag(flags, "mubit-project-id");
  const explicitRunScopeRaw = getStringFlag(flags, "mubit-run-scope");
  const explicitRunScope = explicitRunScopeRaw === "project" || explicitRunScopeRaw === "session" ? explicitRunScopeRaw : null;

  const inferredProjectId = explicitProjectId ?? currentProject.mubitProjectId ?? detected.projectId ?? null;
  const inferredRunScope: MubitRunScope =
    explicitRunScope ?? currentProject.mubitRunScope ?? (inferredProjectId ? "project" : "session");

  settings = updateProjectSettings(settings, cwd, {
    projectName: explicitName ?? currentProject.projectName ?? basename(cwd),
    mubitProjectId: inferredProjectId,
    mubitRunScope: inferredRunScope,
    syncAutomation: currentProject.syncAutomation ?? null,
  });
  if (!settings.mubitActorId && detected.actorId) {
    settings = updateGlobalSettings(settings, { mubitActorId: detected.actorId });
  }
  saveCodaphSettings(settings);

  await addProjectToRegistry(cwd);

  let automationInstalled:
    | {
      gitPostCommit: boolean;
      agentComplete: boolean;
      partial: boolean;
      warnings: string[];
      manualSteps: string[];
    }
    | null = null;
  const noAutoSync = getBooleanFlag(flags, "no-auto-sync", false);
  const force = getBooleanFlag(flags, "force", false);
  const auto = resolveSyncAutomationConfig(settings, cwd);
  if (!noAutoSync && (!auto.enabled || force)) {
    const enabled = await enableSyncAutomationForProject(cwd, settings);
    settings = enabled.settings;
    automationInstalled = enabled.installed;
  }

  const projectConfigPath = await writeLocalProjectConfigSnapshot(cwd, flags, settings);
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const payload = {
    cwd,
    repoId,
    projectConfigPath,
    mubitConfigured: resolveMubitApiKey(flags, settings) !== null,
    mubitProjectId: resolveMubitProjectId(flags, cwd, settings),
    mubitRunScope: resolveMubitRunScope(flags, cwd, settings),
    automation: resolveSyncAutomationConfig(settings, cwd),
    automationInstall: automationInstalled,
    recommendedNext: [
      "codaph sync",
      "codaph import (optional one-time Codex history backfill)",
      "codaph tui",
    ],
  };

  if (flags.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Initialized Codaph for ${cwd}`);
  console.log(`Repo id: ${repoId}`);
  console.log(`Mubit API: ${payload.mubitConfigured ? "configured" : "not configured (set with \`codaph setup --mubit-api-key <key>\` or rerun \`codaph init\`)"}`
  );
  console.log(`Mubit project: ${payload.mubitProjectId ?? "(auto-detect unavailable)"} | run scope: ${payload.mubitRunScope}`);
  console.log(`Local project config: ${projectConfigPath}`);
  const autoAfter = resolveSyncAutomationConfig(settings, cwd);
  console.log(
    `Auto-sync: ${autoAfter.enabled ? "enabled" : "off"} (post-commit:${autoAfter.gitPostCommit ? "on" : "off"}, agent-complete:${autoAfter.agentComplete ? "on" : "off"})`,
  );
  if (automationInstalled) {
    for (const warning of automationInstalled.warnings) {
      console.log(`Warning: ${warning}`);
    }
    for (const step of automationInstalled.manualSteps) {
      console.log(step);
    }
  } else if (noAutoSync) {
    console.log("Auto-sync install skipped (`--no-auto-sync`).");
  }
  console.log("Next:");
  console.log("  1. `codaph sync` (fast Mubit-first sync)");
  console.log("  2. `codaph import` (optional one-time Codex history backfill)");
  console.log("  3. `codaph tui`");
}

async function statusCommand(rest: string[]): Promise<void> {
  await syncStatus(rest);
}

async function syncCommand(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const forcePushOnly = getBooleanFlag(flags, "local-only", false);
  const mode: "all" | "push" = forcePushOnly ? "push" : "all";
  const pushMode: SyncPushMode = forcePushOnly ? "history" : "queue";

  const pushReporter = createSyncProgressReporter("Scanning Codex history");
  const pullReporter = createSyncProgressReporter("Syncing Mubit remote");
  let pullReporterStarted = false;
  const usePushReporter = pushMode === "history";
  if (flags.json !== true) {
    if (usePushReporter) {
      pushReporter.start();
    } else if (mode === "all") {
      pullReporter.start();
      pullReporterStarted = true;
    }
  }
  const summary = await runSyncWorkflow({
    mode,
    pushMode,
    cwd,
    flags,
    settings,
    triggerSource: "sync-manual",
    onPushProgress: flags.json === true ? undefined : pushReporter.onProgress,
    onPullProgress:
      flags.json === true
        ? undefined
        : (progress) => {
          if (!pullReporterStarted) {
            if (usePushReporter) {
              pushReporter.finish();
            }
            pullReporter.start();
            pullReporterStarted = true;
          }
          pullReporter.onProgress({
            scannedFiles: progress.total,
            processedFiles: progress.current,
            matchedFiles: progress.current,
            importedEvents: progress.imported,
            currentFile: `dedup=${progress.deduplicated} skipped=${progress.skipped}`,
            currentLine: progress.current,
            currentSessionId: null,
          });
        },
  }).finally(() => {
    if (flags.json !== true) {
      if (usePushReporter) {
        pushReporter.finish();
      }
      pullReporter.finish();
    }
  });

  if (flags.json === true) {
    const legacyPush = summary.push && !(summary.push as { skipped?: boolean }).skipped ? (summary.push as SyncPushPhaseResult) : null;
    console.log(
      JSON.stringify(
        {
          scannedFiles: legacyPush?.summary.scannedFiles ?? 0,
          matchedFiles: legacyPush?.summary.matchedFiles ?? 0,
          importedEvents: legacyPush?.summary.importedEvents ?? 0,
          importedSessions: legacyPush?.summary.importedSessions ?? 0,
          ...summary,
        },
        null,
        2,
      ),
    );
  } else {
    if (forcePushOnly) {
      console.log("Note: `--local-only` is a compatibility alias and will be deprecated. Prefer `codaph import`.");
    }
    printSyncWorkflowSummary(summary);
  }

  if (flags.json !== true) {
    await maybeOfferSyncAutomationSetup(cwd, flags, settings, mode);
  }
}

async function syncHistory(rest: string[]): Promise<void> {
  await importCommand(rest);
}

async function syncRemote(rest: string[]): Promise<void> {
  await syncPullCommand(rest);
}

async function readOptionalStdinJson(): Promise<Record<string, unknown> | null> {
  if (input.isTTY) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(buffer);
    if (Buffer.concat(chunks).length > 512 * 1024) {
      break;
    }
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function cwdFromHookPayload(payload: Record<string, unknown> | null): string | null {
  if (!payload) {
    return null;
  }
  const keys = ["cwd", "project_path", "projectPath", "repo_root", "repoRoot", "worktree", "worktreePath"] as const;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

async function hooksRun(rest: string[]): Promise<void> {
  const [hookName, ...args] = rest;
  if (!hookName) {
    throw new Error("Hook name is required (post-commit | post-push | agent-complete)");
  }
  const { flags } = parseArgs(args);
  const payload = await readOptionalStdinJson();
  const requestedCwd = resolve(getStringFlag(flags, "cwd") ?? cwdFromHookPayload(payload) ?? process.cwd());
  const cwd = hookName === "post-commit" || hookName === "post-push" ? resolveGitRepoRootOrCwd(requestedCwd) : requestedCwd;
  const settings = loadCodaphSettings();
  const quiet = getBooleanFlag(flags, "quiet", false);

  let mode: "all" | "push";
  let pushMode: SyncPushMode | undefined;
  let triggerSource: SyncTriggerSource;
  if (hookName === "post-commit") {
    mode = "push";
    pushMode = "queue";
    triggerSource = "hook-post-commit";
  } else if (hookName === "post-push") {
    mode = "all";
    pushMode = "queue";
    triggerSource = "hook-post-push";
  } else if (hookName === "agent-complete") {
    mode = "all";
    // Until the repo-local queue capture path is implemented, agent completion needs
    // the Codex history ingest path to publish newly finished prompts/thoughts.
    pushMode = "history";
    triggerSource = "hook-agent-complete";
  } else {
    throw new Error(`Unknown hook trigger: ${hookName}`);
  }

  const summary = await runSyncWorkflow({
    mode,
    pushMode,
    cwd,
    flags,
    settings,
    triggerSource,
    hookMode: true,
    quiet,
  });

  if (flags.json === true && !quiet) {
    console.log(JSON.stringify(summary, null, 2));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => stringFromUnknown(entry))
      .filter((entry): entry is string => !!entry);
    if (parts.length === 0) {
      return null;
    }
    return parts.join("\n");
  }

  if (isRecord(value)) {
    const candidates = [
      value.text,
      value.prompt,
      value.message,
      value.input,
      value.content,
      value.reasoning,
      value.summary,
      value.value,
      value.input_text,
      value.output_text,
      value.stdout,
      value.stderr,
      value.stdout_text,
      value.stderr_text,
    ];

    for (const candidate of candidates) {
      const text = stringFromUnknown(candidate);
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function getItem(event: CapturedEventEnvelope): Record<string, unknown> | null {
  const maybeItem = event.payload.item;
  return isRecord(maybeItem) ? maybeItem : null;
}

function getItemType(event: CapturedEventEnvelope): string | null {
  const item = getItem(event);
  if (!item) {
    return null;
  }

  return typeof item.type === "string" ? item.type : null;
}

function getPromptText(event: CapturedEventEnvelope): string | null {
  if (event.eventType === "prompt.submitted") {
    return stringFromUnknown(event.payload.prompt) ?? stringFromUnknown(event.payload.input);
  }

  const item = getItem(event);
  const itemType = getItemType(event);
  if (item && itemType === "user_message") {
    const role = typeof item.role === "string" ? item.role.toLowerCase() : null;
    if (role && role !== "user") {
      return null;
    }
    return stringFromUnknown(item.content) ?? stringFromUnknown(item.text);
  }

  return null;
}

function getThoughtText(event: CapturedEventEnvelope): string | null {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (itemType === "reasoning") {
    return (
      stringFromUnknown(item?.text) ??
      stringFromUnknown(item?.summary) ??
      stringFromUnknown(item?.content) ??
      "(Reasoning event without exposed text)"
    );
  }

  if (event.reasoningAvailability !== "unavailable") {
    return stringFromUnknown(item?.text) ?? "(Partial reasoning available)";
  }

  return null;
}

function getAssistantText(event: CapturedEventEnvelope): string | null {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (itemType !== "agent_message") {
    return null;
  }
  return stringFromUnknown(item?.text) ?? stringFromUnknown(item?.content);
}

function getFileChangeList(event: CapturedEventEnvelope): Array<{ path: string; kind: string }> {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (itemType !== "file_change") {
    return [];
  }
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  return changes
    .filter(
      (change): change is { path: string; kind: string } =>
        isRecord(change) && typeof change.path === "string" && typeof change.kind === "string",
    )
    .map((change) => ({
      path: change.path,
      kind: change.kind,
    }));
}

function clipText(text: string, maxChars = 220): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 1)}...`;
}

function stripTranscriptDump(text: string): string {
  const lower = text.toLowerCase();
  const candidates = [
    lower.indexOf("codaph tui"),
    lower.indexOf("\nprompts\n"),
    lower.indexOf("\nthoughts\n"),
    lower.indexOf("\nassistant output\n"),
    lower.indexOf("\nfile changes\n"),
    lower.indexOf("\ndiff summary\n"),
    lower.indexOf("\nactions\n"),
  ].filter((idx) => idx >= 0);
  const cutAt = candidates.length > 0 ? Math.min(...candidates) : -1;

  if (cutAt <= 0) {
    return text;
  }
  return text.slice(0, cutAt).trim();
}

function toCompactLine(text: string, maxChars = 220): string {
  return clipText(stripTranscriptDump(text).replace(/\s+/g, " ").trim(), maxChars);
}

function promptPreview(text: string, maxChars = 180): string {
  const compact = toCompactLine(text, maxChars).replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : "(empty prompt)";
}

function printSessionDetails(events: CapturedEventEnvelope[]): void {
  const prompts = events
    .map((event) => ({ ts: event.ts, actor: actorLabel(event.actorId), text: getPromptText(event) }))
    .filter((row): row is { ts: string; actor: string; text: string } => !!row.text)
    .slice(-5);
  const thoughts = events
    .map((event) => ({ ts: event.ts, actor: actorLabel(event.actorId), text: getThoughtText(event) }))
    .filter((row): row is { ts: string; actor: string; text: string } => !!row.text)
    .slice(-5);
  const outputs = events
    .map((event) => ({ ts: event.ts, actor: actorLabel(event.actorId), text: getAssistantText(event) }))
    .filter((row): row is { ts: string; actor: string; text: string } => !!row.text)
    .slice(-5);
  const changes = events
    .flatMap((event) => getFileChangeList(event).map((change) => ({ ts: event.ts, ...change })))
    .slice(-8);

  console.log("\nPrompts");
  if (prompts.length === 0) {
    console.log("  (none)");
  }
  for (const row of prompts) {
    console.log(`  - ${row.ts} [${row.actor}]: ${toCompactLine(row.text)}`);
  }

  console.log("\nThoughts");
  if (thoughts.length === 0) {
    console.log("  (none)");
  }
  for (const row of thoughts) {
    console.log(`  - ${row.ts} [${row.actor}]: ${toCompactLine(row.text)}`);
  }

  console.log("\nAssistant Output");
  if (outputs.length === 0) {
    console.log("  (none)");
  }
  for (const row of outputs) {
    console.log(`  - ${row.ts} [${row.actor}]: ${toCompactLine(row.text)}`);
  }

  console.log("\nFile Changes");
  if (changes.length === 0) {
    console.log("  (none)");
  }
  for (const row of changes) {
    console.log(`  - ${row.ts}: ${row.kind}:${row.path}`);
  }
}

async function inspect(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const query = new QueryService(resolve(cwd, ".codaph"));

  const events = await query.getTimeline({ repoId, sessionId });
  const diffs = await query.getDiffSummary(repoId, sessionId);

  console.log(`Session: ${sessionId}`);
  console.log(`Project: ${cwd}`);
  console.log(`Events: ${events.length}`);
  printSessionDetails(events);

  console.log("\nDiff Summary");
  if (diffs.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of diffs) {
      console.log(`  - ${row.path} | kinds=${row.kinds.join(",")} | occurrences=${row.occurrences}`);
    }
  }
}

function getEvidenceCount(response: Record<string, unknown>): number {
  const raw = response.evidence;
  return Array.isArray(raw) ? raw.length : 0;
}

function getConfidence(response: Record<string, unknown>): number | null {
  return typeof response.confidence === "number" ? response.confidence : null;
}

function sanitizeMubitAnswer(answer: string): string {
  const filtered = stripTranscriptDump(answer)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        !/^(Codaph TUI|Project:|Sessions:|Active Session:|Mubit:|Prompts|Thoughts|Assistant Output|Diff Summary|Actions)/i.test(
          line,
        ),
    );

  if (filtered.length === 0) {
    return toCompactLine(answer, 500);
  }

  const compact = filtered.slice(0, 8).map((line) => clipText(line, 200));
  return clipText(compact.join("\n"), 900);
}

function summarizeEvidence(response: Record<string, unknown>): string[] {
  const raw = response.evidence;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .slice(0, 3)
    .map((entry) => {
      const content = typeof entry.content === "string" ? entry.content : "";
      const source = typeof entry.source === "string" ? entry.source : "unknown";
      const score =
        typeof entry.score === "number" && Number.isFinite(entry.score)
          ? ` score=${entry.score.toFixed(2)}`
          : "";
      return `- [${source}${score}] ${toCompactLine(content, 220)}`;
    });
}

function buildMubitQueryPrompt(question: string): string {
  return `${question}\n\nReturn a concise answer in up to 6 bullet points. Avoid raw terminal dumps or repeated transcript blocks.`;
}

function printMubitNoDataHint(cwd: string, sessionId: string): void {
  console.log(`Mubit returned no answer/evidence for session ${sessionId}.`);
  console.log(`Try refining your query or checking run scope: ${cwd}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function extractOpenAiText(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }

  if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
    return response.output_text.trim();
  }

  const outputItems = Array.isArray(response.output) ? response.output : [];
  const textParts: string[] = [];
  for (const item of outputItems) {
    if (!isRecord(item)) {
      continue;
    }

    if (typeof item.content === "string") {
      const trimmed = item.content.trim();
      if (trimmed.length > 0) {
        textParts.push(trimmed);
      }
      continue;
    }

    if (!Array.isArray(item.content)) {
      continue;
    }

    for (const contentPart of item.content) {
      if (!isRecord(contentPart)) {
        continue;
      }
      const candidate =
        (typeof contentPart.text === "string" && contentPart.text.trim().length > 0
          ? contentPart.text
          : typeof contentPart.output_text === "string" && contentPart.output_text.trim().length > 0
            ? contentPart.output_text
            : null);
      if (candidate) {
        textParts.push(candidate.trim());
      }
    }
  }

  if (textParts.length === 0) {
    return null;
  }

  return textParts.join("\n").trim();
}

function buildOpenAiContext(
  question: string,
  mubitResponse: Record<string, unknown>,
  runId: string,
): string {
  const evidence = Array.isArray(mubitResponse.evidence)
    ? mubitResponse.evidence
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .slice(0, 12)
        .map((entry) => ({
          source: typeof entry.source === "string" ? entry.source : "unknown",
          score: typeof entry.score === "number" ? entry.score : null,
          content:
            typeof entry.content === "string" && entry.content.trim().length > 0
              ? clipText(entry.content.trim(), 600)
              : "",
        }))
    : [];

  const payload = {
    runId,
    question,
    mubit_final_answer:
      typeof mubitResponse.final_answer === "string" ? clipText(mubitResponse.final_answer, 1500) : null,
    evidence,
    confidence: typeof mubitResponse.confidence === "number" ? mubitResponse.confidence : null,
  };

  return JSON.stringify(payload, null, 2);
}

async function runOpenAiAgentFromMubit(
  question: string,
  mubitResponse: Record<string, unknown>,
  runId: string,
  flags: Flags,
): Promise<{ text: string; model: string } | null> {
  const settings = loadCodaphSettings();
  if (!shouldUseOpenAiAgent(flags, settings)) {
    return null;
  }

  const apiKey = resolveOpenAiApiKey(flags, settings);
  if (!apiKey) {
    return null;
  }

  const model = getStringFlag(flags, "openai-model") ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const contextPayload = buildOpenAiContext(question, mubitResponse, runId);

  const response = await withTimeout(
    fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  "You are Codaph Analyst. Answer the user question using Mubit evidence. Keep it concise and actionable. Do not dump raw logs. Return at most 6 bullets.",
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: contextPayload,
              },
            ],
          },
        ],
      }),
    }),
    45000,
    "OpenAI agent",
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${clipText(errorBody, 500)}`);
  }

  const parsed = (await response.json()) as unknown;

  const text = extractOpenAiText(parsed);
  if (!text || text.trim().length === 0) {
    return null;
  }

  return {
    text: clipText(text.trim(), 1400),
    model,
  };
}

function printMubitResponse(
  response: Record<string, unknown>,
  cwd: string,
  sessionId: string,
  raw: boolean,
): void {
  if (raw) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const finalAnswer =
    typeof response.final_answer === "string" && response.final_answer.trim().length > 0
      ? response.final_answer
      : null;
  const evidenceCount = getEvidenceCount(response);
  const confidence = getConfidence(response);

  if (finalAnswer) {
    console.log("Mubit answer:");
    console.log(sanitizeMubitAnswer(finalAnswer));
    const confidenceText =
      typeof confidence === "number" ? ` | confidence=${confidence.toFixed(2)}` : "";
    console.log(`evidence=${evidenceCount}${confidenceText}`);
    return;
  }

  if (evidenceCount === 0) {
    printMubitNoDataHint(cwd, sessionId);
    return;
  }

  const snippets = summarizeEvidence(response);
  console.log(`Mubit returned ${evidenceCount} evidence items, but no final answer.`);
  for (const snippet of snippets) {
    console.log(snippet);
  }
}

async function mubitQuery(rest: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(rest);
  const question = positionals.join(" ").trim();
  if (!question) {
    throw new Error("A query string is required.");
  }

  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required to resolve Mubit run scope.");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const engine = createMubitMemory(flags, cwd, settings);
  if (!engine || !engine.isEnabled()) {
    throw new Error("Mubit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
  }

  const limitRaw = getStringFlag(flags, "limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const rawMode = getBooleanFlag(flags, "raw", false);
  const runId = mubitRunIdForContext(flags, repoId, sessionId, cwd, settings);
  console.log(`Querying Mubit run scope: ${runId}`);

  const response = await withTimeout(
    engine.querySemanticContext({
      runId,
      query: buildMubitQueryPrompt(question),
      limit,
      mode: "direct_bypass",
      directLane: "semantic_search",
    }),
    45000,
    "Mubit query",
  );

  if (!rawMode) {
    const openAiKey = resolveOpenAiApiKey(flags, settings);
    const agentRequested = getBooleanFlag(flags, "agent", openAiKey !== null);
    if (agentRequested && !openAiKey) {
      console.log("OpenAI agent requested but OPENAI_API_KEY is missing. Falling back to Mubit response.");
    }
    const agentResult = await runOpenAiAgentFromMubit(question, response, runId, flags);
    if (agentResult) {
      console.log(`OpenAI agent (${agentResult.model}) answer:`);
      console.log(agentResult.text);
      return;
    }
  }

  printMubitResponse(response, cwd, sessionId, rawMode);
}

async function mubitBackfill(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const sessionId = getStringFlag(flags, "session");
  const verbose = getBooleanFlag(flags, "verbose", false);

  const engine = createMubitMemory(flags, cwd, settings);
  if (!engine || !engine.isEnabled()) {
    throw new Error("Mubit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
  }

  const repoId = resolveRepoIdForProject(flags, cwd, settings);
  const query = new QueryService(resolve(cwd, ".codaph"));
  const sessions = sessionId
    ? [{ sessionId, from: "", to: "", eventCount: 0, threadCount: 0 }]
    : await query.listSessions(repoId);

  if (sessions.length === 0) {
    console.log("No sessions found to backfill.");
    return;
  }

  let attempted = 0;
  let accepted = 0;
  let deduplicated = 0;
  let failed = 0;
  let scannedSessions = 0;

  for (const session of sessions) {
    const events = await query.getTimeline({ repoId, sessionId: session.sessionId });
    if (events.length === 0) {
      continue;
    }

    scannedSessions += 1;
    console.log(`Backfilling session ${session.sessionId} (${events.length} events)...`);
    let sessionAttempted = 0;
    for (const event of events) {
      attempted += 1;
      sessionAttempted += 1;
      try {
        const result = await engine.writeEvent(event);
        if (result.accepted) {
          accepted += 1;
        }
        if (result.deduplicated) {
          deduplicated += 1;
        }
      } catch (error) {
        failed += 1;
        if (verbose) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`write failed for ${event.eventId}: ${message}`);
        }
      }

      if (sessionAttempted % 100 === 0 || sessionAttempted === events.length) {
        console.log(`  progress ${sessionAttempted}/${events.length} events`);
      }
    }
  }

  console.log(`Backfill complete. sessions=${scannedSessions} attempted=${attempted} accepted=${accepted} deduplicated=${deduplicated} failed=${failed}`);
}

async function projects(rest: string[]): Promise<void> {
  const [subcmd, ...tail] = rest;
  const { flags } = parseArgs(tail);

  if (subcmd === "list") {
    const registry = await loadRegistry();
    if (registry.projects.length === 0) {
      console.log("No projects saved.");
      return;
    }
    for (const project of registry.projects) {
      const marker = project === registry.lastProjectPath ? "*" : " ";
      console.log(`${marker} ${project}`);
    }
    return;
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  if (subcmd === "add") {
    const registry = await addProjectToRegistry(cwd);
    console.log(`Added project: ${cwd}`);
    console.log(`Projects: ${registry.projects.length}`);
    return;
  }

  if (subcmd === "remove") {
    const registry = await removeProjectFromRegistry(cwd);
    console.log(`Removed project: ${cwd}`);
    console.log(`Projects: ${registry.projects.length}`);
    return;
  }

  throw new Error("Usage: codaph projects <list|add|remove> [--cwd <path>]");
}

interface QuerySessionSummary {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  threadCount: number;
}

interface FileStatRow {
  path: string;
  plus: number;
  minus: number;
}

interface ThoughtSlice {
  id: number;
  ts: string;
  actorId: string | null;
  text: string;
  diffLines: string[];
}

interface PromptSlice {
  id: number;
  ts: string;
  actorId: string | null;
  prompt: string;
  thoughts: string[];
  thoughtSlices: ThoughtSlice[];
  outputs: string[];
  files: Map<string, FileStatRow>;
  diffLines: string[];
}

interface ContributorPromptTrace {
  promptId: number;
  ts: string;
  prompt: string;
  thoughtCount: number;
  files: string[];
}

interface ContributorSlice {
  actorId: string;
  promptCount: number;
  thoughtCount: number;
  fileCount: number;
  lastTs: string;
  traces: ContributorPromptTrace[];
}

interface SessionAnalysis {
  sessionId: string;
  prompts: PromptSlice[];
  files: FileStatRow[];
  contributors: ContributorSlice[];
  tokenEstimate: number;
}

interface SessionBrowseRow {
  sessionId: string;
  from: string;
  to: string;
  eventCount: number;
  threadCount: number;
  promptCount: number;
  fileCount: number;
  tokenEstimate: number;
  status: "synced" | "no_files";
}

interface CachedSessionAnalysis {
  eventCount: number;
  analysis: SessionAnalysis;
}

interface FullDiffOverlayData {
  key: string;
  title: string;
  lines: string[];
}

interface PaneLine {
  text: string;
  color?: string;
  highlight?: boolean;
}

interface ChatMessage {
  role: "you" | "mubit";
  text: string;
  ts: string;
}

type TuiView = "browse" | "inspect";
type InspectPane = "prompts" | "thoughts" | "files" | "diff" | "chat";
type InputMode =
  | null
  | "add_project"
  | "set_project_name"
  | "set_mubit_project_id"
  | "set_mubit_actor_id"
  | "set_mubit_api_key"
  | "set_openai_api_key";

interface TuiState {
  projectPath: string;
  view: TuiView;
  inspectPane: InspectPane;
  rows: SessionBrowseRow[];
  selectedSessionIndex: number;
  selectedPromptIndex: number;
  selectedThoughtIndex: number;
  chatOpen: boolean;
  chatDraft: string;
  chatScroll: number;
  thoughtsScroll: number;
  filesScroll: number;
  diffScroll: number;
  fullDiffOpen: boolean;
  fullDiffScroll: number;
  fullDiffData: FullDiffOverlayData | null;
  helpOpen: boolean;
  settingsOpen: boolean;
  contributorsOpen: boolean;
  selectedContributorIndex: number;
  busy: boolean;
  statusLine: string;
  actorFilter: string | null;
  inputMode: InputMode;
  inputBuffer: string;
  chatBySession: Map<string, ChatMessage[]>;
  autoSyncEnabled: boolean;
  autoSyncLastPullAgo: string | null;
  autoSyncCloudStatus: string;
  autoSyncPending: boolean;
  lastLocalSyncAt: string | null;
}

const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;
const TUI_COLORS = {
  brand: "38;2;122;162;247",
  activeBorder: "97",
  inactiveBorder: "90",
  selected: "48;2;122;162;247;30",
  dim: "2",
  muted: "90",
  cyan: "36",
  yellow: "33",
  green: "32",
  red: "31",
} as const;

function paint(text: string, colorCode?: string): string {
  if (!colorCode || !output.isTTY) {
    return text;
  }
  return `\u001b[${colorCode}m${text}\u001b[0m`;
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function charDisplayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (!codePoint) {
    return 0;
  }
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return 0;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charDisplayWidth(char);
  }
  return width;
}

function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  let width = 0;
  let out = "";
  for (const char of text) {
    const w = charDisplayWidth(char);
    if (width + w > maxWidth) {
      break;
    }
    out += char;
    width += w;
  }
  return out;
}

function visibleLength(text: string): number {
  return displayWidth(text.replace(ANSI_ESCAPE_REGEX, ""));
}

function clipPlain(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (displayWidth(text) <= width) {
    return text;
  }
  if (width <= 3) {
    return truncateToWidth(text, width);
  }
  return `${truncateToWidth(text, width - 3)}...`;
}

function padPlain(text: string, width: number): string {
  const clipped = clipPlain(text, width);
  const missing = Math.max(0, width - visibleLength(clipped));
  return `${clipped}${" ".repeat(missing)}`;
}

function splitByWidth(text: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  const out: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const char of text) {
    const w = charDisplayWidth(char);
    if (lineWidth + w > width && line.length > 0) {
      out.push(line);
      line = "";
      lineWidth = 0;
    }
    line += char;
    lineWidth += w;
  }
  if (line.length > 0) {
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

function wrapPlain(text: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }

  const out: string[] = [];
  const paragraphs = text.split("\n");

  for (const paragraph of paragraphs) {
    const clean = paragraph.trimEnd();
    if (clean.length === 0) {
      out.push("");
      continue;
    }

    const words = clean.split(/\s+/).filter((word) => word.length > 0);
    let line = "";

    for (const word of words) {
      if (displayWidth(line) === 0) {
        if (displayWidth(word) <= width) {
          line = word;
        } else {
          const chunks = splitByWidth(word, width);
          out.push(...chunks.slice(0, -1));
          line = chunks[chunks.length - 1] ?? "";
        }
        continue;
      }

      const candidate = `${line} ${word}`;
      if (displayWidth(candidate) <= width) {
        line = candidate;
        continue;
      }

      out.push(line);
      if (displayWidth(word) <= width) {
        line = word;
      } else {
        const chunks = splitByWidth(word, width);
        out.push(...chunks.slice(0, -1));
        line = chunks[chunks.length - 1] ?? "";
      }
    }

    if (line.length > 0) {
      out.push(line);
    }
  }

  return out.length > 0 ? out : [""];
}

function boxLines(
  title: string,
  width: number,
  height: number,
  lines: PaneLine[],
  active = false,
): string[] {
  const safeWidth = Math.max(16, width);
  const innerWidth = safeWidth - 2;
  const bodyHeight = Math.max(1, height - 2);
  const borderColor = active ? TUI_COLORS.activeBorder : TUI_COLORS.inactiveBorder;

  const cleanTitle = clipPlain(title, Math.max(1, innerWidth - 3));
  const topPadding = Math.max(0, innerWidth - (visibleLength(cleanTitle) + 2));
  const top = paint(`+ ${cleanTitle} ${"-".repeat(topPadding)}+`, borderColor);
  const bottom = paint(`+${"-".repeat(innerWidth)}+`, borderColor);

  const body: string[] = [];
  for (let i = 0; i < bodyHeight; i += 1) {
    const line = lines[i] ?? { text: "" };
    const rawLine = line.text.replace(/[\r\n\t]+/g, " ");
    const plain = padPlain(rawLine, innerWidth);
    let rendered = plain;
    if (line.highlight) {
      rendered = paint(rendered, TUI_COLORS.selected);
    } else if (line.color) {
      rendered = paint(rendered, line.color);
    }
    body.push(`${paint("|", borderColor)}${rendered}${paint("|", borderColor)}`);
  }

  return [top, ...body, bottom];
}

function joinColumns(left: string[], right: string[], gap = 2): string[] {
  const count = Math.max(left.length, right.length);
  const leftWidth = visibleLength(left[0] ?? "");
  const rightWidth = visibleLength(right[0] ?? "");
  const leftBlank = " ".repeat(leftWidth);
  const rightBlank = " ".repeat(rightWidth);

  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(`${left[i] ?? leftBlank}${" ".repeat(gap)}${right[i] ?? rightBlank}`);
  }
  return rows;
}

function joinThreeColumns(left: string[], middle: string[], right: string[], gap = 2): string[] {
  const count = Math.max(left.length, middle.length, right.length);
  const leftWidth = visibleLength(left[0] ?? "");
  const middleWidth = visibleLength(middle[0] ?? "");
  const rightWidth = visibleLength(right[0] ?? "");
  const leftBlank = " ".repeat(leftWidth);
  const middleBlank = " ".repeat(middleWidth);
  const rightBlank = " ".repeat(rightWidth);

  const rows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      `${left[i] ?? leftBlank}${" ".repeat(gap)}${middle[i] ?? middleBlank}${" ".repeat(gap)}${right[i] ?? rightBlank}`,
    );
  }
  return rows;
}

function windowStart(total: number, selected: number, visible: number): number {
  if (total <= visible) {
    return 0;
  }
  const half = Math.floor(visible / 2);
  let start = Math.max(0, selected - half);
  if (start + visible > total) {
    start = total - visible;
  }
  return start;
}

function scrollPaneLines(
  lines: PaneLine[],
  paneHeight: number,
  scroll: number,
): { lines: PaneLine[]; scroll: number; maxScroll: number } {
  const bodyHeight = Math.max(1, paneHeight - 2);
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const safeScroll = Math.max(0, Math.min(scroll, maxScroll));
  return {
    lines: lines.slice(safeScroll, safeScroll + bodyHeight),
    scroll: safeScroll,
    maxScroll,
  };
}

function formatDateCell(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day} ${hh}:${mm}`;
}

function formatTokenEstimate(tokens: number): string {
  if (tokens >= 1000) {
    const asK = tokens / 1000;
    return asK >= 10 ? `${Math.round(asK)}k` : `${asK.toFixed(1)}k`;
  }
  return `${tokens}`;
}

function applyFileChange(stats: Map<string, FileStatRow>, path: string, kind: string): void {
  const row = stats.get(path) ?? { path, plus: 0, minus: 0 };
  if (kind === "add") {
    row.plus += 1;
  } else if (kind === "delete") {
    row.minus += 1;
  } else {
    row.plus += 1;
    row.minus += 1;
  }
  stats.set(path, row);
}

function toSortedFileStats(stats: Map<string, FileStatRow>): FileStatRow[] {
  return [...stats.values()].sort((a, b) => {
    const weightA = a.plus + a.minus;
    const weightB = b.plus + b.minus;
    if (weightA !== weightB) {
      return weightB - weightA;
    }
    return a.path.localeCompare(b.path);
  });
}

function normalizeActorId(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function actorLabel(actorId: string | null | undefined): string {
  return normalizeActorId(actorId) ?? "unknown";
}

function promptIndicesForActor(analysis: SessionAnalysis, actorFilter: string | null): number[] {
  if (!actorFilter) {
    return analysis.prompts.map((_, index) => index);
  }
  const filtered: number[] = [];
  for (let i = 0; i < analysis.prompts.length; i += 1) {
    const prompt = analysis.prompts[i] as PromptSlice;
    if (actorLabel(prompt.actorId) === actorFilter) {
      filtered.push(i);
    }
  }
  return filtered.length > 0 ? filtered : analysis.prompts.map((_, index) => index);
}

function extractPatchDiffLines(event: CapturedEventEnvelope): string[] {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (!item || itemType !== "tool_call") {
    return [];
  }

  const toolName = typeof item.name === "string" ? item.name : null;
  if (toolName !== "apply_patch") {
    return [];
  }

  const argsText =
    stringFromUnknown(item.arguments) ??
    (typeof item.arguments === "string"
      ? item.arguments
      : isRecord(item.arguments)
        ? JSON.stringify(item.arguments)
        : null);
  if (!argsText) {
    return [];
  }

  const out: string[] = [];
  for (const raw of argsText.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      out.push(`--- a/${path}`);
      out.push(`+++ b/${path}`);
    } else if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      out.push(`+++ b/${path}`);
    } else if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      out.push(`--- a/${path}`);
    } else if (line.startsWith("@@")) {
      out.push(line);
    } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      out.push(line);
    }

    if (out.length >= 280) {
      break;
    }
  }

  return out;
}

function extractUnifiedDiffLines(rawText: string, maxLines = 2000): string[] {
  const out: string[] = [];
  for (const raw of rawText.split("\n")) {
    const line = raw.trimEnd();
    const isHeader =
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      line.startsWith("Binary files ");
    const isBody =
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---");

    if (isHeader || isBody) {
      out.push(line);
    }

    if (out.length >= maxLines) {
      break;
    }
  }

  return out;
}

function extractToolResultDiffLines(event: CapturedEventEnvelope): string[] {
  const item = getItem(event);
  const itemType = getItemType(event);
  if (!item || itemType !== "tool_result") {
    return [];
  }

  const rawOutput =
    stringFromUnknown(item.output) ??
    (typeof item.output === "string" ? item.output : null);
  if (!rawOutput) {
    return [];
  }

  return extractUnifiedDiffLines(rawOutput, 1200);
}

function buildSessionAnalysis(sessionId: string, events: CapturedEventEnvelope[]): SessionAnalysis {
  const prompts: PromptSlice[] = [];
  const sessionFiles = new Map<string, FileStatRow>();
  const pendingDiffByPrompt = new WeakMap<PromptSlice, string[]>();
  let nextPromptId = 1;
  let tokenChars = 0;

  const ensureCurrentPrompt = (): PromptSlice => {
    if (prompts.length === 0) {
      const created: PromptSlice = {
        id: nextPromptId,
        ts: events[0]?.ts ?? new Date().toISOString(),
        actorId: null,
        prompt: "(No prompt captured)",
        thoughts: [],
        thoughtSlices: [],
        outputs: [],
        files: new Map<string, FileStatRow>(),
        diffLines: [],
      };
      prompts.push(created);
      pendingDiffByPrompt.set(created, []);
      nextPromptId += 1;
    }
    return prompts[prompts.length - 1] as PromptSlice;
  };

  for (const event of events) {
    const eventActor = normalizeActorId(event.actorId);
    const promptText = getPromptText(event);
    if (promptText) {
      const created: PromptSlice = {
        id: nextPromptId,
        ts: event.ts,
        actorId: eventActor,
        prompt: promptText,
        thoughts: [],
        thoughtSlices: [],
        outputs: [],
        files: new Map<string, FileStatRow>(),
        diffLines: [],
      };
      prompts.push(created);
      pendingDiffByPrompt.set(created, []);
      nextPromptId += 1;
      tokenChars += promptText.length;
      continue;
    }

    const current = ensureCurrentPrompt();
    const thought = getThoughtText(event);
    if (thought) {
      current.thoughts.push(thought);
      const pending = pendingDiffByPrompt.get(current) ?? [];
      current.thoughtSlices.push({
        id: current.thoughtSlices.length + 1,
        ts: event.ts,
        actorId: eventActor,
        text: thought,
        diffLines: pending.slice(0, 220),
      });
      pendingDiffByPrompt.set(current, []);
      tokenChars += thought.length;
    }

    const outputText = getAssistantText(event);
    if (outputText) {
      current.outputs.push(outputText);
      tokenChars += outputText.length;
    }

    const eventDiffLines: string[] = [];
    for (const change of getFileChangeList(event)) {
      applyFileChange(current.files, change.path, change.kind);
      applyFileChange(sessionFiles, change.path, change.kind);
      const marker = change.kind === "delete" ? "-" : "+";
      eventDiffLines.push(`FILE ${marker} ${change.path}`);
    }

    const patchLines = extractPatchDiffLines(event);
    if (patchLines.length > 0) {
      eventDiffLines.push(...patchLines);
    }

    const toolResultDiffLines = extractToolResultDiffLines(event);
    if (toolResultDiffLines.length > 0) {
      eventDiffLines.push(...toolResultDiffLines);
    }

    if (eventDiffLines.length > 0) {
      current.diffLines.push(...eventDiffLines);
      const lastThought = current.thoughtSlices[current.thoughtSlices.length - 1];
      if (lastThought) {
        lastThought.diffLines.push(...eventDiffLines);
      } else {
        const pending = pendingDiffByPrompt.get(current) ?? [];
        pending.push(...eventDiffLines);
        pendingDiffByPrompt.set(current, pending);
      }
    }
  }

  if (prompts.length === 0) {
    const created: PromptSlice = {
      id: 1,
      ts: events[0]?.ts ?? new Date().toISOString(),
      actorId: null,
      prompt: "(No prompt captured)",
      thoughts: [],
      thoughtSlices: [],
      outputs: [],
      files: new Map<string, FileStatRow>(),
      diffLines: [],
    };
    prompts.push(created);
    pendingDiffByPrompt.set(created, []);
  }

  for (const prompt of prompts) {
    prompt.diffLines = prompt.diffLines.slice(0, 280);
    const pending = pendingDiffByPrompt.get(prompt) ?? [];
    if (pending.length > 0) {
      const lastThought = prompt.thoughtSlices[prompt.thoughtSlices.length - 1];
      if (lastThought) {
        lastThought.diffLines.push(...pending);
      } else {
        prompt.thoughtSlices.push({
          id: 1,
          ts: prompt.ts,
          actorId: prompt.actorId,
          text: "(No exposed reasoning text)",
          diffLines: pending.slice(0, 220),
        });
      }
    }

    for (const thoughtSlice of prompt.thoughtSlices) {
      thoughtSlice.diffLines = thoughtSlice.diffLines.slice(0, 220);
    }
  }

  const contributorMap = new Map<string, ContributorSlice>();
  const ensureContributor = (actor: string): ContributorSlice => {
    const existing = contributorMap.get(actor);
    if (existing) {
      return existing;
    }
    const created: ContributorSlice = {
      actorId: actor,
      promptCount: 0,
      thoughtCount: 0,
      fileCount: 0,
      lastTs: "",
      traces: [],
    };
    contributorMap.set(actor, created);
    return created;
  };

  for (const prompt of prompts) {
    const actor = actorLabel(prompt.actorId);
    const contributor = ensureContributor(actor);
    const fileStats = toSortedFileStats(prompt.files);
    const fileNames = fileStats.map((file) => file.path);
    contributor.promptCount += 1;
    contributor.thoughtCount += prompt.thoughtSlices.length;
    contributor.fileCount += fileNames.length;
    if (!contributor.lastTs || prompt.ts > contributor.lastTs) {
      contributor.lastTs = prompt.ts;
    }
    contributor.traces.push({
      promptId: prompt.id,
      ts: prompt.ts,
      prompt: prompt.prompt,
      thoughtCount: prompt.thoughtSlices.length,
      files: fileNames,
    });
  }

  const contributors = [...contributorMap.values()].sort((a, b) => {
    if (a.promptCount !== b.promptCount) {
      return b.promptCount - a.promptCount;
    }
    return b.lastTs.localeCompare(a.lastTs);
  });

  return {
    sessionId,
    prompts,
    files: toSortedFileStats(sessionFiles),
    contributors,
    tokenEstimate: Math.max(0, Math.round(tokenChars / 4)),
  };
}

function selectedPromptFromAnalysis(
  analysis: SessionAnalysis,
  selectedPromptIndex: number,
  actorFilter: string | null,
): { prompt: PromptSlice; index: number; indices: number[] } {
  const indices = promptIndicesForActor(analysis, actorFilter);
  const inRange = indices.includes(selectedPromptIndex)
    ? selectedPromptIndex
    : (indices[0] ?? 0);
  const safePrompt = analysis.prompts[inRange] ?? analysis.prompts[0];
  return {
    prompt: safePrompt as PromptSlice,
    index: inRange,
    indices,
  };
}

function thoughtEntriesForPrompt(prompt: PromptSlice): ThoughtSlice[] {
  if (prompt.thoughtSlices.length > 0) {
    return prompt.thoughtSlices;
  }

  if (prompt.outputs.length > 0) {
    return prompt.outputs.map((output, index) => ({
      id: index + 1,
      ts: prompt.ts,
      actorId: prompt.actorId,
      text: output,
      diffLines: index === prompt.outputs.length - 1 ? prompt.diffLines : [],
    }));
  }

  return [{
    id: 1,
    ts: prompt.ts,
    actorId: prompt.actorId,
    text: "(No exposed reasoning text)",
    diffLines: prompt.diffLines,
  }];
}

function selectedThoughtFromPrompt(
  prompt: PromptSlice,
  selectedThoughtIndex: number,
): { entries: ThoughtSlice[]; selected: ThoughtSlice; index: number } {
  const entries = thoughtEntriesForPrompt(prompt);
  const safeIndex = Math.max(0, Math.min(selectedThoughtIndex, entries.length - 1));
  return {
    entries,
    selected: entries[safeIndex] as ThoughtSlice,
    index: safeIndex,
  };
}

function diffPreviewLines(prompt: PromptSlice, fallbackFiles: FileStatRow[]): string[] {
  if (prompt.diffLines.length > 0) {
    return prompt.diffLines;
  }

  const files = toSortedFileStats(prompt.files);
  if (files.length > 0) {
    return files.map((row) => `+ ${row.path} (+${row.plus} -${row.minus})`);
  }

  if (fallbackFiles.length > 0) {
    return fallbackFiles.map((row) => `+ ${row.path} (+${row.plus} -${row.minus})`);
  }

  return ["(No diff captured)"];
}

function preferredDiffLinesForThought(
  prompt: PromptSlice,
  thought: ThoughtSlice,
  fallbackFiles: FileStatRow[],
): { lines: string[]; source: "thought" | "prompt"; thoughtHadOnlySummary: boolean } {
  const thoughtLines = thought.diffLines;
  const promptLines = diffPreviewLines(prompt, fallbackFiles);

  if (thoughtLines.length === 0) {
    return { lines: promptLines, source: "prompt", thoughtHadOnlySummary: false };
  }

  if (hasCodeLevelDiffLines(thoughtLines)) {
    return { lines: thoughtLines, source: "thought", thoughtHadOnlySummary: false };
  }

  if (hasCodeLevelDiffLines(promptLines)) {
    return { lines: promptLines, source: "prompt", thoughtHadOnlySummary: true };
  }

  return { lines: thoughtLines, source: "thought", thoughtHadOnlySummary: true };
}

function diffLineColor(line: string): string | undefined {
  if (line.startsWith("=== ")) {
    return TUI_COLORS.cyan;
  }
  if (line.startsWith("FILE ") || line.startsWith("index ")) {
    return TUI_COLORS.muted;
  }
  if (line.startsWith("+")) {
    return TUI_COLORS.green;
  }
  if (line.startsWith("-")) {
    return TUI_COLORS.red;
  }
  if (
    line.startsWith("@@") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("diff --git ")
  ) {
    return TUI_COLORS.muted;
  }
  return undefined;
}

function fileLabelFromDiffLine(line: string): string | null {
  if (line.startsWith("FILE ")) {
    const maybePath = line.slice("FILE ".length).replace(/^[+-]\s+/, "").trim();
    return maybePath.length > 0 ? maybePath : null;
  }

  if (line.startsWith("diff --git ")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!match) {
      return null;
    }
    return (match[2] ?? match[1])?.trim() ?? null;
  }

  if (line.startsWith("+++ b/")) {
    const maybePath = line.slice("+++ b/".length).trim();
    return maybePath.length > 0 ? maybePath : null;
  }

  if (line.startsWith("--- a/")) {
    const maybePath = line.slice("--- a/".length).trim();
    return maybePath.length > 0 ? maybePath : null;
  }

  const summaryMatch = /^[+-]\s+(.+)\s+\(\+\d+\s+-\d+\)$/.exec(line);
  if (summaryMatch?.[1]) {
    return summaryMatch[1];
  }

  return null;
}

function isSummaryOnlyDiffLine(line: string): boolean {
  return /^FILE [+-]\s+.+$/.test(line) || /^[+-]\s+.+\s+\(\+\d+\s+-\d+\)$/.test(line);
}

function hasCodeLevelDiffLines(lines: string[]): boolean {
  return lines.some((line) =>
    line.startsWith("@@") ||
    line.startsWith("diff --git ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    (
      (line.startsWith("+") || line.startsWith("-")) &&
      !line.startsWith("+++") &&
      !line.startsWith("---") &&
      !isSummaryOnlyDiffLine(line)
    ),
  );
}

function toGitPathspec(projectPath: string, filePath: string): string | null {
  const cleaned = filePath
    .replace(/^FILE [+-]\s+/, "")
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .trim();

  if (cleaned.length === 0) {
    return null;
  }

  if (isAbsolute(cleaned)) {
    const rel = relative(projectPath, cleaned);
    if (!rel || rel.startsWith("..")) {
      return null;
    }
    return rel;
  }

  return cleaned;
}

function collectDiffFiles(
  projectPath: string,
  preferredDiffLines: string[],
  prompt: PromptSlice,
  fallbackFiles: FileStatRow[],
): string[] {
  const fromDiff = preferredDiffLines
    .map((line) => fileLabelFromDiffLine(line))
    .filter((value): value is string => !!value)
    .map((path) => toGitPathspec(projectPath, path))
    .filter((value): value is string => !!value);

  if (fromDiff.length > 0) {
    return [...new Set(fromDiff)];
  }

  const promptFiles = toSortedFileStats(prompt.files)
    .map((row) => toGitPathspec(projectPath, row.path))
    .filter((value): value is string => !!value);
  if (promptFiles.length > 0) {
    return [...new Set(promptFiles)];
  }

  return [...new Set(
    fallbackFiles
      .map((row) => toGitPathspec(projectPath, row.path))
      .filter((value): value is string => !!value),
  )];
}

function getLiveGitDiffLines(projectPath: string, files: string[]): string[] {
  if (files.length === 0) {
    return [];
  }

  const limitedFiles = files.slice(0, 40);
  const args = [
    "-C",
    projectPath,
    "--no-pager",
    "diff",
    "--no-ext-diff",
    "--unified=3",
    "--",
    ...limitedFiles,
  ];

  try {
    const raw = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return extractUnifiedDiffLines(raw, 2200);
  } catch (error) {
    const maybeError = error as { stdout?: string };
    if (typeof maybeError.stdout === "string" && maybeError.stdout.trim().length > 0) {
      return extractUnifiedDiffLines(maybeError.stdout, 2200);
    }
    return [];
  }
}

function formatFullDiffLines(lines: string[]): string[] {
  if (lines.length === 0) {
    return ["(No diff captured)"];
  }

  const out: string[] = [];
  let currentFile: string | null = null;
  let sectionHasContent = false;
  let hasAnyHeader = false;

  const flushEmptySection = (): void => {
    if (currentFile && !sectionHasContent) {
      out.push("  (No code-level diff captured)");
    }
    sectionHasContent = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const label = fileLabelFromDiffLine(line);
    if (label && label !== currentFile) {
      flushEmptySection();
      if (out.length > 0) {
        out.push("");
      }
      out.push(`=== ${label} ===`);
      hasAnyHeader = true;
      currentFile = label;
      sectionHasContent = false;
    }

    if (line.startsWith("FILE ") || line.startsWith("diff --git ")) {
      continue;
    }

    if (line.length > 0) {
      out.push(line);
      sectionHasContent = true;
    }
  }

  flushEmptySection();

  if (out.length === 0 && hasAnyHeader) {
    return ["(No code-level diff captured)"];
  }
  return out.length > 0 ? out : ["(No diff captured)"];
}

function composeMubitAnswer(
  response: Record<string, unknown>,
  cwd: string,
  sessionId: string,
): string {
  const finalAnswer =
    typeof response.final_answer === "string" && response.final_answer.trim().length > 0
      ? response.final_answer
      : null;
  if (finalAnswer) {
    return sanitizeMubitAnswer(finalAnswer);
  }

  const snippets = summarizeEvidence(response);
  if (snippets.length > 0) {
    return snippets.map((line) => line.replace(/^- /, "")).join("\n");
  }

  return `Mubit returned no answer/evidence for session ${sessionId}. Try refining query for ${cwd}.`;
}

function headerLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function buildFullDiffOverlayData(
  state: TuiState,
  selectedSession: SessionBrowseRow,
  analysis: SessionAnalysis,
): FullDiffOverlayData {
  const promptSelection = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex, state.actorFilter);
  const prompt = promptSelection.prompt;
  state.selectedPromptIndex = promptSelection.index;
  const thoughtSelection = selectedThoughtFromPrompt(prompt, state.selectedThoughtIndex);
  const key = `${selectedSession.sessionId}:${prompt.id}:${thoughtSelection.index}:${state.projectPath}`;

  const preferred = preferredDiffLinesForThought(prompt, thoughtSelection.selected, analysis.files);
  let rawDiffLines = preferred.lines;

  let usedLiveFallback = false;
  if (!hasCodeLevelDiffLines(rawDiffLines)) {
    const files = collectDiffFiles(state.projectPath, rawDiffLines, prompt, analysis.files);
    const liveDiff = getLiveGitDiffLines(state.projectPath, files);
    if (liveDiff.length > 0) {
      rawDiffLines = liveDiff;
      usedLiveFallback = true;
    }
  }

  const lines = formatFullDiffLines(rawDiffLines);
  if (preferred.source === "prompt" && preferred.thoughtHadOnlySummary) {
    lines.unshift(`(Selected thought ${thoughtSelection.index + 1} only had file summaries; showing prompt-level diff)`);
    lines.unshift("");
  }
  if (usedLiveFallback) {
    lines.unshift("(Live git diff fallback from current working tree)");
    lines.unshift("");
  }

  return {
    key,
    title: `Session ${selectedSession.sessionId.slice(0, 8)} - Prompt ${prompt.id} - Thought ${thoughtSelection.index + 1}`,
    lines,
  };
}

function ensureFullDiffOverlayData(
  state: TuiState,
  selectedSession: SessionBrowseRow,
  analysis: SessionAnalysis,
): FullDiffOverlayData {
  const promptSelection = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex, state.actorFilter);
  const prompt = promptSelection.prompt;
  state.selectedPromptIndex = promptSelection.index;
  const thoughtSelection = selectedThoughtFromPrompt(prompt, state.selectedThoughtIndex);
  const key = `${selectedSession.sessionId}:${prompt.id}:${thoughtSelection.index}:${state.projectPath}`;
  if (state.fullDiffData?.key === key) {
    return state.fullDiffData;
  }

  const next = buildFullDiffOverlayData(state, selectedSession, analysis);
  state.fullDiffData = next;
  state.fullDiffScroll = 0;
  return next;
}

function renderBrowseView(
  state: TuiState,
  projectLabel: string,
  mubitEnabled: boolean,
  width: number,
  height: number,
): string {
  const leftHeader = `${paint("codaph", TUI_COLORS.brand)}  >  ${projectLabel}`;
  const syncBits = `AutoSync:${state.autoSyncEnabled ? "on" : "off"}  Cloud:${state.autoSyncCloudStatus}${state.autoSyncPending ? "*" : ""}  Push:${formatTimeAgo(state.lastLocalSyncAt) ?? "never"}  Pull:${state.autoSyncLastPullAgo ?? "never"}`;
  const rightHeader = `${paint(mubitEnabled ? "Mubit:on" : "Mubit:off", mubitEnabled ? TUI_COLORS.cyan : TUI_COLORS.yellow)}   ${paint(syncBits, TUI_COLORS.dim)}`;
  const fallbackRightHeader = `${paint(mubitEnabled ? "Mubit:on" : "Mubit:off", mubitEnabled ? TUI_COLORS.cyan : TUI_COLORS.yellow)}   ${paint("[o] settings  [?] help", TUI_COLORS.dim)}`;
  const header = headerLine(leftHeader, visibleLength(rightHeader) < Math.floor(width * 0.7) ? rightHeader : fallbackRightHeader, width);

  const tableHeight = Math.max(10, height - 6);
  const bodyRows = Math.max(3, tableHeight - 4);
  const start = windowStart(state.rows.length, state.selectedSessionIndex, bodyRows);
  const rows = state.rows.slice(start, start + bodyRows);

  const sessionLines: PaneLine[] = [
    { text: "  #   Date              Prompts   Files Changed   Tokens    Status", color: TUI_COLORS.muted },
    { text: " -------------------------------------------------------------------", color: TUI_COLORS.muted },
  ];

  if (rows.length === 0) {
    sessionLines.push({ text: "  (no sessions yet) press [s] to sync now", color: TUI_COLORS.muted });
  } else {
    for (let i = 0; i < rows.length; i += 1) {
      const absoluteIndex = start + i;
      const row = rows[i] as SessionBrowseRow;
      const marker = absoluteIndex === state.selectedSessionIndex ? ">" : " ";
      const idx = String(absoluteIndex + 1).padStart(2, " ");
      const dateCell = padPlain(formatDateCell(row.to), 16);
      const prompts = String(row.promptCount).padStart(4, " ");
      const files = String(row.fileCount).padStart(6, " ");
      const tokens = padPlain(formatTokenEstimate(row.tokenEstimate), 7);
      const statusText = row.status === "synced" ? "ok synced" : "! no files";

      sessionLines.push({
        text: `${marker} ${idx}  ${dateCell}    ${prompts}         ${files}         ${tokens}   ${statusText}`,
        color: row.status === "no_files" ? TUI_COLORS.yellow : undefined,
        highlight: absoluteIndex === state.selectedSessionIndex,
      });
    }
  }

  const sessionsBox = boxLines("Sessions", width, tableHeight, sessionLines, true);
  const footer = "[up/down] navigate   [enter] inspect   [s] sync now   [r] pull cloud   [p] switch project   [a] add project   [o] settings   [q] quit";
  return [header, "", ...sessionsBox, "", paint(clipPlain(footer, width), TUI_COLORS.dim)].join("\n");
}

function renderDiffOverlay(
  state: TuiState,
  projectLabel: string,
  selectedSession: SessionBrowseRow,
  analysis: SessionAnalysis,
  width: number,
  height: number,
): string {
  const fullDiff = ensureFullDiffOverlayData(state, selectedSession, analysis);
  const contentHeight = Math.max(8, height - 4);
  const bodyHeight = Math.max(1, contentHeight - 2);
  const maxScroll = Math.max(0, fullDiff.lines.length - bodyHeight);
  const scroll = Math.max(0, Math.min(state.fullDiffScroll, maxScroll));
  const visible = fullDiff.lines.slice(scroll, scroll + bodyHeight);

  const lineRows: PaneLine[] = visible.map((line) => ({
    text: line,
    color: line.startsWith("(Live git diff fallback") ? TUI_COLORS.yellow : diffLineColor(line),
  }));

  const top = headerLine(
    `${paint("codaph", TUI_COLORS.brand)}  >  ${projectLabel}  >  Full Diff`,
    paint("[d/esc] close", TUI_COLORS.dim),
    width,
  );
  const box = boxLines(
    fullDiff.title,
    width,
    contentHeight,
    lineRows,
    true,
  );
  return [
    top,
    "",
    ...box,
    "",
    paint(`[up/down] scroll (${scroll}/${maxScroll})`, TUI_COLORS.dim),
  ].join("\n");
}

function renderInspectView(
  state: TuiState,
  projectLabel: string,
  selectedSession: SessionBrowseRow,
  analysis: SessionAnalysis,
  mubitEnabled: boolean,
  width: number,
  height: number,
): string {
  if (state.fullDiffOpen) {
    return renderDiffOverlay(state, projectLabel, selectedSession, analysis, width, height);
  }

  const promptSelection = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex, state.actorFilter);
  const prompt = promptSelection.prompt;
  state.selectedPromptIndex = promptSelection.index;
  const filteredPromptIndices = promptSelection.indices;
  const splitMode = width >= 104;
  const threePaneMode = width >= 126;
  const chatHeight = state.chatOpen ? Math.max(10, Math.floor(height * 0.32)) : 0;
  const baseHeight = Math.max(14, height - 4 - (state.chatOpen ? chatHeight + 1 : 0));

  const inspectRightText = clipPlain(
    `AutoSync:${state.autoSyncEnabled ? "on" : "off"} Cloud:${state.autoSyncCloudStatus}${state.autoSyncPending ? "*" : ""} Push:${formatTimeAgo(state.lastLocalSyncAt) ?? "never"} Pull:${state.autoSyncLastPullAgo ?? "never"}  [f] actor:${state.actorFilter ?? "all"}  [c] contributors  [esc] back  [?] help`,
    Math.max(18, Math.floor(width * 0.58)),
  );
  const topHeader = headerLine(
    `${paint("codaph", TUI_COLORS.brand)}  >  ${projectLabel}  >  Session ${selectedSession.sessionId.slice(0, 8)} - ${formatDateCell(selectedSession.to)}`,
    `${paint(mubitEnabled ? "Mubit:on" : "Mubit:off", mubitEnabled ? TUI_COLORS.cyan : TUI_COLORS.yellow)}   ${paint(inspectRightText, TUI_COLORS.dim)}`,
    width,
  );

  if (threePaneMode && state.inspectPane === "files") {
    state.inspectPane = "thoughts";
  }

  const thoughtSelection = selectedThoughtFromPrompt(prompt, state.selectedThoughtIndex);
  state.selectedThoughtIndex = thoughtSelection.index;
  const promptFiles = toSortedFileStats(prompt.files);
  const filesToRender = promptFiles.length > 0 ? promptFiles : analysis.files;
  const buildPromptLines = (paneWidth: number, paneHeight: number): PaneLine[] => {
    const lines: PaneLine[] = [];
    const promptBody = Math.max(1, paneHeight - 2);
    const selectedFilteredIndex = Math.max(0, filteredPromptIndices.indexOf(state.selectedPromptIndex));
    const promptStart = windowStart(filteredPromptIndices.length, selectedFilteredIndex, promptBody);
    const visibleIndices = filteredPromptIndices.slice(promptStart, promptStart + promptBody);
    for (let i = 0; i < visibleIndices.length; i += 1) {
      const absoluteIndex = visibleIndices[i] as number;
      const row = analysis.prompts[absoluteIndex] as PromptSlice;
      const actorBadge = actorLabel(row.actorId);
      lines.push({
        text: `${absoluteIndex === state.selectedPromptIndex ? ">" : " "} ${row.id.toString().padStart(2, " ")}  [${actorBadge}] ${promptPreview(row.prompt, Math.max(10, paneWidth - 18))}`,
        highlight: absoluteIndex === state.selectedPromptIndex,
      });
    }
    return lines;
  };

  const buildThoughtLines = (paneWidth: number, paneHeight: number): PaneLine[] => {
    const lines: PaneLine[] = [];
    const thoughtBody = Math.max(1, paneHeight - 2);
    const thoughtStart = windowStart(thoughtSelection.entries.length, state.selectedThoughtIndex, thoughtBody);
    const visibleThoughts = thoughtSelection.entries.slice(thoughtStart, thoughtStart + thoughtBody);
    for (let i = 0; i < visibleThoughts.length; i += 1) {
      const absoluteIndex = thoughtStart + i;
      const row = visibleThoughts[i] as ThoughtSlice;
      const actorBadge = actorLabel(row.actorId);
      lines.push({
        text: `${absoluteIndex === state.selectedThoughtIndex ? ">" : " "} ${row.id.toString().padStart(2, " ")}  [${actorBadge}] ${promptPreview(row.text, Math.max(10, paneWidth - 18))}`,
        highlight: absoluteIndex === state.selectedThoughtIndex,
      });
    }
    return lines;
  };

  const buildFileLines = (paneWidth: number): PaneLine[] =>
    filesToRender.length === 0
      ? [{ text: "(No files changed)", color: TUI_COLORS.muted }]
      : filesToRender.map((file) => ({
          text: `${padPlain(file.path, Math.max(10, paneWidth - 18))}  +${file.plus}  -${file.minus}`,
        }));

  const buildDiffLines = (): PaneLine[] => {
    const preferred = preferredDiffLinesForThought(prompt, thoughtSelection.selected, analysis.files);
    const source = preferred.lines;
    const rows: PaneLine[] = [];
    if (preferred.source === "prompt" && thoughtSelection.entries.length > 0) {
      rows.push({
        text: preferred.thoughtHadOnlySummary
          ? `(Thought ${thoughtSelection.index + 1} only had file summaries; showing prompt-level diff)`
          : `(No diff directly tied to thought ${thoughtSelection.index + 1}; showing prompt-level diff)`,
        color: TUI_COLORS.muted,
      });
    }
    for (const line of source) {
      rows.push({
        text: line,
        color: diffLineColor(line),
      });
    }
    return rows;
  };

  const withPaneScroll = (pane: "files" | "diff", paneHeight: number, lines: PaneLine[]): PaneLine[] => {
    const current =
      pane === "files" ? state.filesScroll :
      state.diffScroll;
    const scrolled = scrollPaneLines(lines, paneHeight, current);
    if (pane === "files") {
      state.filesScroll = scrolled.scroll;
    } else {
      state.diffScroll = scrolled.scroll;
    }
    return scrolled.lines;
  };

  const composed: string[] = [topHeader, ""];
  if (threePaneMode) {
    const minPane = 22;
    const innerWidth = width - 4;
    let leftWidth = Math.max(minPane, Math.floor(innerWidth * 0.3));
    let middleWidth = Math.max(minPane, Math.floor(innerWidth * 0.33));
    let rightWidth = innerWidth - leftWidth - middleWidth;
    if (rightWidth < minPane) {
      const deficit = minPane - rightWidth;
      const takeLeft = Math.min(deficit, Math.max(0, leftWidth - minPane));
      leftWidth -= takeLeft;
      const takeMiddle = Math.min(deficit - takeLeft, Math.max(0, middleWidth - minPane));
      middleWidth -= takeMiddle;
      rightWidth = innerWidth - leftWidth - middleWidth;
    }

    const paneHeight = Math.max(8, baseHeight);
    const promptsBox = boxLines(
      `Prompts (${filteredPromptIndices.length}/${analysis.prompts.length})`,
      leftWidth,
      paneHeight,
      buildPromptLines(leftWidth, paneHeight),
      state.inspectPane === "prompts",
    );
    const thoughtsBox = boxLines(
      `Thoughts (${thoughtSelection.index + 1}/${thoughtSelection.entries.length})`,
      middleWidth,
      paneHeight,
      buildThoughtLines(middleWidth, paneHeight),
      state.inspectPane === "thoughts",
    );
    const diffBox = boxLines(
      `Diff (thought ${thoughtSelection.index + 1})`,
      rightWidth,
      paneHeight,
      withPaneScroll("diff", paneHeight, buildDiffLines()),
      state.inspectPane === "diff",
    );
    composed.push(...joinThreeColumns(promptsBox, thoughtsBox, diffBox));
  } else if (splitMode) {
    const minPane = 24;
    const leftWidth = Math.max(minPane, Math.min(Math.floor((width - 2) * 0.36), width - minPane - 2));
    const rightWidth = Math.max(minPane, width - leftWidth - 2);
    const topHeight = Math.max(7, Math.floor(baseHeight * 0.5));
    const bottomHeight = Math.max(7, baseHeight - topHeight);

    const promptsBox = boxLines(
      `Prompts (${filteredPromptIndices.length}/${analysis.prompts.length})`,
      leftWidth,
      topHeight,
      buildPromptLines(leftWidth, topHeight),
      state.inspectPane === "prompts",
    );
    const thoughtsBox = boxLines(
      "Thoughts",
      rightWidth,
      topHeight,
      buildThoughtLines(rightWidth, topHeight),
      state.inspectPane === "thoughts",
    );
    const filesBox = boxLines(
      "Files Changed",
      leftWidth,
      bottomHeight,
      withPaneScroll("files", bottomHeight, buildFileLines(leftWidth)),
      state.inspectPane === "files",
    );
    const diffBox = boxLines(
      "Diff",
      rightWidth,
      bottomHeight,
      withPaneScroll("diff", bottomHeight, buildDiffLines()),
      state.inspectPane === "diff",
    );

    composed.push(...joinColumns(promptsBox, thoughtsBox));
    composed.push(...joinColumns(filesBox, diffBox));
  } else {
    const paneWidth = width;
    const promptsHeight = Math.max(6, Math.floor(baseHeight * 0.26));
    const thoughtsHeight = Math.max(6, Math.floor(baseHeight * 0.23));
    const filesHeight = Math.max(6, Math.floor(baseHeight * 0.23));
    const diffHeight = Math.max(6, baseHeight - promptsHeight - thoughtsHeight - filesHeight);

    composed.push(
      ...boxLines(
        `Prompts (${filteredPromptIndices.length}/${analysis.prompts.length})`,
        paneWidth,
        promptsHeight,
        buildPromptLines(paneWidth, promptsHeight),
        state.inspectPane === "prompts",
      ),
    );
    composed.push("");
    composed.push(
      ...boxLines(
        "Thoughts",
        paneWidth,
        thoughtsHeight,
        buildThoughtLines(paneWidth, thoughtsHeight),
        state.inspectPane === "thoughts",
      ),
    );
    composed.push("");
    composed.push(
      ...boxLines(
        "Files Changed",
        paneWidth,
        filesHeight,
        withPaneScroll("files", filesHeight, buildFileLines(paneWidth)),
        state.inspectPane === "files",
      ),
    );
    composed.push("");
    composed.push(
      ...boxLines(
        "Diff",
        paneWidth,
        diffHeight,
        withPaneScroll("diff", diffHeight, buildDiffLines()),
        state.inspectPane === "diff",
      ),
    );
  }

  if (state.chatOpen) {
    const transcriptWidth = Math.max(20, width - 6);
    const sessionChat = state.chatBySession.get(selectedSession.sessionId) ?? [];
    const transcript: PaneLine[] = [];

    for (const message of sessionChat) {
      const label = message.role === "you" ? "you>" : "mubit>";
      const tone = message.role === "you" ? TUI_COLORS.yellow : TUI_COLORS.cyan;
      const wrapped = wrapPlain(message.text, transcriptWidth);
      transcript.push({ text: `${label}  ${wrapped[0] ?? ""}`, color: tone });
      for (const line of wrapped.slice(1)) {
        transcript.push({ text: `      ${line}`, color: tone });
      }
      transcript.push({ text: "", color: TUI_COLORS.muted });
    }

    const chatBodyHeight = Math.max(3, chatHeight - 2);
    const transcriptHeight = Math.max(1, chatBodyHeight - 2);
    const maxScroll = Math.max(0, transcript.length - transcriptHeight);
    const scroll = Math.max(0, Math.min(state.chatScroll, maxScroll));
    const start = Math.max(0, transcript.length - transcriptHeight - scroll);
    const visibleTranscript = transcript.slice(start, start + transcriptHeight);
    const inputLine = `> ${state.chatDraft}`;

    const chatLines = [
      ...visibleTranscript,
      { text: clipPlain(inputLine, transcriptWidth), highlight: state.inspectPane === "chat" },
      { text: "[enter] send   [esc] close chat", color: TUI_COLORS.muted },
    ];
    composed.push("");
    composed.push(...boxLines("Mubit", width, chatHeight, chatLines, state.inspectPane === "chat"));
  }

  const footer = state.chatOpen
    ? "[tab/left/right] focus pane   [esc] close chat   [up/down] navigate/scroll"
    : threePaneMode
      ? "[enter] prompt -> thoughts   [up/down] select/scroll   [tab/left/right] focus pane   [d] full diff   [m] Mubit chat   [f] actor filter   [c] contributors   [o] settings   [esc] back"
      : "[up/down] prompts/scroll pane   [tab/left/right] focus pane   [d] full diff   [m] Mubit chat   [f] actor filter   [c] contributors   [o] settings   [esc] back";

  composed.push("");
  composed.push(paint(clipPlain(footer, width), TUI_COLORS.dim));
  return composed.join("\n");
}

function renderHelpOverlay(width: number, height: number): string {
  const lines: PaneLine[] = [
    { text: "Global", color: TUI_COLORS.muted },
    { text: "q       quit" },
    { text: "?       toggle help" },
    { text: "o       settings" },
    { text: "p       switch project" },
    { text: "a       add/switch project path" },
    { text: "" },
    { text: "Browse", color: TUI_COLORS.muted },
    { text: "up/down navigate sessions" },
    { text: "enter   open session inspect view" },
    { text: "s       sync now (local->cloud, then cloud->local when available)" },
    { text: "r       pull cloud (Mubit remote activity fallback/manual)" },
    { text: "" },
    { text: "Inspect", color: TUI_COLORS.muted },
    { text: "enter   from prompts -> focus thoughts" },
    { text: "up/down navigate prompts/thoughts or scroll pane" },
    { text: "tab     cycle pane focus" },
    { text: "d       toggle full diff overlay" },
    { text: "m       toggle Mubit chat" },
    { text: "f       cycle actor filter" },
    { text: "c       contributors overlay (enter to apply filter)" },
    { text: "left/right move pane focus" },
    { text: "esc     back to browse" },
    { text: "" },
    { text: "Chat", color: TUI_COLORS.muted },
    { text: "type    edit prompt" },
    { text: "enter   send question" },
    { text: "esc     close chat" },
  ];

  const boxWidth = Math.max(56, Math.min(width - 8, 92));
  const boxHeight = Math.max(14, Math.min(height - 6, 28));
  const box = boxLines("Help", boxWidth, boxHeight, lines, true);
  const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
  const padded = box.map((line) => `${" ".repeat(leftPad)}${line}`);
  const topPad = Math.max(0, Math.floor((height - boxHeight) / 2) - 1);

  return [
    ...Array.from({ length: topPad }, () => ""),
    ...padded,
    "",
    `${" ".repeat(leftPad)}${paint("[esc/?] close", TUI_COLORS.dim)}`,
  ].join("\n");
}

function lastGitAuthorForFile(
  projectPath: string,
  filePath: string,
  cache: Map<string, string | null>,
): string | null {
  const key = `${projectPath}::${filePath}`;
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }
  try {
    const raw = execFileSync(
      "git",
      ["-C", projectPath, "log", "-1", "--format=%an", "--", filePath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024 * 1024,
      },
    );
    const author = raw.trim();
    const value = author.length > 0 ? author : null;
    cache.set(key, value);
    return value;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function renderContributorOverlay(
  state: TuiState,
  analysis: SessionAnalysis,
  width: number,
  height: number,
  gitAuthorCache: Map<string, string | null>,
): string {
  const contributors = analysis.contributors;
  if (contributors.length === 0) {
    return [
      "",
      paint("No contributors found for this session.", TUI_COLORS.muted),
    ].join("\n");
  }

  const selected = Math.max(0, Math.min(state.selectedContributorIndex, contributors.length - 1));
  state.selectedContributorIndex = selected;
  const selectedContributor = contributors[selected] as ContributorSlice;

  const leftLines: PaneLine[] = [];
  for (let i = 0; i < contributors.length; i += 1) {
    const contributor = contributors[i] as ContributorSlice;
    leftLines.push({
      text: `${i === selected ? ">" : " "} ${contributor.actorId}  p:${contributor.promptCount}  t:${contributor.thoughtCount}  f:${contributor.fileCount}`,
      highlight: i === selected,
    });
  }

  const rightLines: PaneLine[] = [
    { text: `Actor: ${selectedContributor.actorId}` },
    { text: `Prompts: ${selectedContributor.promptCount}  Thoughts: ${selectedContributor.thoughtCount}  Files: ${selectedContributor.fileCount}`, color: TUI_COLORS.muted },
    { text: "" },
  ];

  for (const trace of selectedContributor.traces.slice(0, 14)) {
    rightLines.push({
      text: `#${trace.promptId} ${formatDateCell(trace.ts)}  ${promptPreview(trace.prompt, 60)}`,
      color: TUI_COLORS.cyan,
    });
    rightLines.push({
      text: `  thoughts:${trace.thoughtCount}  files:${trace.files.length}`,
      color: TUI_COLORS.muted,
    });
    if (trace.files.length > 0) {
      rightLines.push({
        text: `  files: ${trace.files.slice(0, 4).join(", ")}`,
      });
      const authors = trace.files
        .slice(0, 4)
        .map((file) => lastGitAuthorForFile(state.projectPath, file, gitAuthorCache))
        .filter((author): author is string => typeof author === "string" && author.length > 0);
      if (authors.length > 0) {
        rightLines.push({
          text: `  git: ${[...new Set(authors)].join(", ")}`,
          color: TUI_COLORS.muted,
        });
      }
    }
    rightLines.push({ text: "" });
  }

  const overlayWidth = Math.max(84, Math.min(width - 4, 146));
  const overlayHeight = Math.max(16, Math.min(height - 4, 36));
  const leftWidth = Math.max(28, Math.floor(overlayWidth * 0.36));
  const rightWidth = Math.max(36, overlayWidth - leftWidth - 2);

  const leftBox = boxLines("Contributors", leftWidth, overlayHeight, leftLines, true);
  const rightBox = boxLines("Trace (prompt -> thoughts -> files)", rightWidth, overlayHeight, rightLines, true);
  const joined = joinColumns(leftBox, rightBox);

  const leftPad = Math.max(0, Math.floor((width - overlayWidth) / 2));
  const topPad = Math.max(0, Math.floor((height - overlayHeight) / 2) - 1);
  return [
    ...Array.from({ length: topPad }, () => ""),
    ...joined.map((line) => `${" ".repeat(leftPad)}${line}`),
    "",
    `${" ".repeat(leftPad)}${paint("[up/down] select contributor  [enter] filter prompts  [esc/c] close", TUI_COLORS.dim)}`,
  ].join("\n");
}

function maskSecret(value: string | null): string {
  if (!value) {
    return "(not set)";
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function renderSettingsOverlay(
  flags: Flags,
  settings: CodaphSettings,
  state: TuiState,
  memoryEnabled: boolean,
  width: number,
  height: number,
): string {
  const projectSettings = getProjectSettings(settings, state.projectPath);
  const projectName = resolveProjectLabel(flags, state.projectPath, settings);
  const projectId = resolveMubitProjectId(flags, state.projectPath, settings);
  const actorId = resolveMubitActorId(flags, state.projectPath, settings);
  const runScope = resolveMubitRunScope(flags, state.projectPath, settings);
  const openAiKey = resolveOpenAiApiKey(flags, settings);
  const mubitKey = resolveMubitApiKey(flags, settings);
  const detected = detectGitHubDefaults(state.projectPath);

  const lines: PaneLine[] = [
    { text: `Project: ${state.projectPath}`, color: TUI_COLORS.muted },
    { text: `Mubit runtime: ${memoryEnabled ? "enabled" : "disabled"}` },
    { text: "" },
    { text: `Current project name: ${projectName}` },
    { text: `Current project id: ${projectId ?? "(auto detection failed)"}` },
    { text: `Current actor id: ${actorId ?? "(auto detection failed)"}` },
    { text: `Current run scope: ${runScope}` },
    { text: `Mubit API key: ${maskSecret(mubitKey)}` },
    { text: `OpenAI API key: ${maskSecret(openAiKey)}` },
    { text: "" },
    { text: `Detected GitHub project: ${detected.projectId ?? "(none)"}`, color: TUI_COLORS.muted },
    { text: `Detected GitHub actor: ${detected.actorId ?? "(none)"}`, color: TUI_COLORS.muted },
    {
      text: `Saved project name override: ${projectSettings.projectName && projectSettings.projectName.trim().length > 0 ? projectSettings.projectName.trim() : "(none)"}`,
      color: TUI_COLORS.muted,
    },
    { text: "" },
    { text: "Actions", color: TUI_COLORS.muted },
    { text: "1  set project name (this folder)" },
    { text: "2  set Mubit project id (this folder)" },
    { text: "3  set actor id (global)" },
    { text: "4  set Mubit API key (global)" },
    { text: "5  set OpenAI API key (global)" },
    { text: "6  auto-fill project+actor from git/GitHub" },
    { text: "7  toggle Mubit run scope (session/project) for this folder" },
    { text: "8  clear Mubit API key" },
    { text: "9  clear OpenAI API key" },
    { text: "" },
    { text: "esc/o close settings", color: TUI_COLORS.muted },
  ];

  const boxWidth = Math.max(72, Math.min(width - 6, 116));
  const boxHeight = Math.max(18, Math.min(height - 4, 34));
  const box = boxLines("Settings", boxWidth, boxHeight, lines, true);
  const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
  const padded = box.map((line) => `${" ".repeat(leftPad)}${line}`);
  const topPad = Math.max(0, Math.floor((height - boxHeight) / 2) - 1);

  return [
    ...Array.from({ length: topPad }, () => ""),
    ...padded,
  ].join("\n");
}

function inspectPaneCycle(chatOpen: boolean, includeFilesPane: boolean): InspectPane[] {
  if (includeFilesPane) {
    return chatOpen ? ["prompts", "thoughts", "files", "diff", "chat"] : ["prompts", "thoughts", "files", "diff"];
  }
  return chatOpen ? ["prompts", "thoughts", "diff", "chat"] : ["prompts", "thoughts", "diff"];
}

async function tui(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  if (!input.isTTY || !output.isTTY) {
    throw new Error("TUI requires an interactive terminal.");
  }

  const cwdFlag = getStringFlag(flags, "cwd");
  if (cwdFlag) {
    await addProjectToRegistry(cwdFlag);
  }

  const registry = await loadRegistry();
  const fallbackProject = registry.lastProjectPath ?? registry.projects[0] ?? process.cwd();
  if (registry.projects.length === 0) {
    await addProjectToRegistry(fallbackProject);
  }

  const state: TuiState = {
    projectPath: resolve(fallbackProject),
    view: "browse",
    inspectPane: "prompts",
    rows: [],
    selectedSessionIndex: 0,
    selectedPromptIndex: 0,
    selectedThoughtIndex: 0,
    chatOpen: false,
    chatDraft: "",
    chatScroll: 0,
    thoughtsScroll: 0,
    filesScroll: 0,
    diffScroll: 0,
    fullDiffOpen: false,
    fullDiffScroll: 0,
    fullDiffData: null,
    helpOpen: false,
    settingsOpen: false,
    contributorsOpen: false,
    selectedContributorIndex: 0,
    busy: false,
    statusLine: "",
    actorFilter: null,
    inputMode: null,
    inputBuffer: "",
    chatBySession: new Map<string, ChatMessage[]>(),
    autoSyncEnabled: false,
    autoSyncLastPullAgo: null,
    autoSyncCloudStatus: "unknown",
    autoSyncPending: false,
    lastLocalSyncAt: null,
  };

  let query = new QueryService(resolve(state.projectPath, ".codaph"));
  let settings = loadCodaphSettings();
  let repoId = resolveRepoIdForProject(flags, state.projectPath, settings);
  let memory = createMubitMemory(flags, state.projectPath, settings);
  const analysisCache = new Map<string, CachedSessionAnalysis>();
  const gitAuthorCache = new Map<string, string | null>();
  let screenReady = false;
  let lastRenderedFrame = "";

  const getSize = (): { width: number; height: number } => ({
    width: Math.max(20, Math.min(180, Math.max(20, (output.columns ?? 120) - 4))),
    height: Math.max(2, Math.max(2, (output.rows ?? 40) - 2)),
  });

  const selectedRow = (): SessionBrowseRow | null => {
    if (state.rows.length === 0) {
      return null;
    }
    const idx = Math.max(0, Math.min(state.selectedSessionIndex, state.rows.length - 1));
    return state.rows[idx] ?? null;
  };

  const selectedAnalysis = (): SessionAnalysis | null => {
    const row = selectedRow();
    if (!row) {
      return null;
    }
    return analysisCache.get(row.sessionId)?.analysis ?? null;
  };

  const resetInspectScroll = (): void => {
    state.selectedThoughtIndex = 0;
    state.thoughtsScroll = 0;
    state.filesScroll = 0;
    state.diffScroll = 0;
    state.fullDiffScroll = 0;
    state.fullDiffData = null;
  };

  const refreshSettingsAndMemory = (): void => {
    settings = loadCodaphSettings();
    memory = createMubitMemory(flags, state.projectPath, settings);
    void refreshSyncIndicators().then(() => {
      if (!state.busy) {
        render();
      }
    });
  };

  const refreshSyncIndicators = async (): Promise<void> => {
    const auto = resolveSyncAutomationConfig(settings, state.projectPath);
    state.autoSyncEnabled = auto.enabled;
    const currentRepoId = resolveRepoIdForProject(flags, state.projectPath, settings);
    const localPush = await maybeReadLocalPushStateForProject(state.projectPath, currentRepoId).catch(() => null);
    state.lastLocalSyncAt = localPush?.lastSuccessAt ?? null;
    const remote = await maybeReadRemoteSyncStateForProject(state.projectPath, currentRepoId).catch(() => null);
    if (!remote) {
      state.autoSyncLastPullAgo = null;
      state.autoSyncPending = false;
      state.autoSyncCloudStatus = auto.enabled ? "none" : "off";
      return;
    }
    state.autoSyncLastPullAgo = formatTimeAgo(remote.lastSuccessAt);
    state.autoSyncPending = remote.pendingTrigger.pending;
    if (remote.lastError) {
      state.autoSyncCloudStatus = "error";
    } else if (remote.suspectedServerCap) {
      state.autoSyncCloudStatus = "capped?";
    } else if (remote.pendingTrigger.pending) {
      state.autoSyncCloudStatus = "pending";
    } else if (remote.consecutiveSameSnapshotCount > 0) {
      state.autoSyncCloudStatus = "no-change";
    } else if (remote.lastSuccessAt) {
      state.autoSyncCloudStatus = "ok";
    } else {
      state.autoSyncCloudStatus = "none";
    }
  };

  const render = (): void => {
    if (!screenReady) {
      return;
    }

    const { width, height } = getSize();
    let screen = "";
    const projectLabel = resolveProjectLabel(flags, state.projectPath, settings);

    if (state.helpOpen) {
      screen = renderHelpOverlay(width, height);
    } else if (state.settingsOpen) {
      screen = renderSettingsOverlay(flags, settings, state, memory?.isEnabled() ?? false, width, height);
    } else if (state.view === "browse") {
      screen = renderBrowseView(state, projectLabel, memory?.isEnabled() ?? false, width, height);
    } else {
      const row = selectedRow();
      const analysis = selectedAnalysis();
      if (!row || !analysis) {
        screen = renderBrowseView(state, projectLabel, memory?.isEnabled() ?? false, width, height);
      } else {
        screen = renderInspectView(state, projectLabel, row, analysis, memory?.isEnabled() ?? false, width, height);
        if (state.contributorsOpen) {
          screen = renderContributorOverlay(state, analysis, width, height, gitAuthorCache);
        }
      }
    }

    const statusText = state.statusLine.trim().length > 0
      ? clipPlain(state.statusLine, width)
      : "";
    const status = statusText.length > 0
      ? paint(statusText, state.busy ? TUI_COLORS.yellow : TUI_COLORS.dim)
      : "";

    const bodyHeight = Math.max(1, height - 1);
    const frameLines = screen.split("\n").slice(0, bodyHeight);
    while (frameLines.length < bodyHeight) {
      frameLines.push("");
    }
    frameLines.push(status);

    const frameKey = `${width}x${height}\n${frameLines.join("\n")}`;
    if (frameKey === lastRenderedFrame) {
      return;
    }
    lastRenderedFrame = frameKey;

    output.write("\u001b[H");
    for (let i = 0; i < frameLines.length; i += 1) {
      output.write(frameLines[i] ?? "");
      output.write("\u001b[K");
      if (i < frameLines.length - 1) {
        output.write("\n");
      }
    }
  };

  const ensureAnalysis = async (session: QuerySessionSummary): Promise<SessionAnalysis> => {
    const cached = analysisCache.get(session.sessionId);
    if (cached && cached.eventCount === session.eventCount) {
      return cached.analysis;
    }

    const events = await query.getTimeline({ repoId, sessionId: session.sessionId });
    const analysis = buildSessionAnalysis(session.sessionId, events);
    analysisCache.set(session.sessionId, { eventCount: session.eventCount, analysis });
    return analysis;
  };

  const refreshRows = async (progressLabel: string): Promise<void> => {
    query = new QueryService(resolve(state.projectPath, ".codaph"));
    repoId = resolveRepoIdForProject(flags, state.projectPath, settings);

    const sessions = await query.listSessions(repoId) as QuerySessionSummary[];
    const rows: SessionBrowseRow[] = [];
    let lastRefreshAt = 0;

    for (let i = 0; i < sessions.length; i += 1) {
      const session = sessions[i] as QuerySessionSummary;
      state.statusLine = `${progressLabel} (${i + 1}/${sessions.length})`;
      const now = Date.now();
      if (i === 0 || now - lastRefreshAt > 180) {
        lastRefreshAt = now;
        render();
      }

      const analysis = await ensureAnalysis(session);
      const promptCount = analysis.prompts.filter((entry) => entry.prompt !== "(No prompt captured)").length;
      rows.push({
        sessionId: session.sessionId,
        from: session.from,
        to: session.to,
        eventCount: session.eventCount,
        threadCount: session.threadCount,
        promptCount,
        fileCount: analysis.files.length,
        tokenEstimate: analysis.tokenEstimate,
        status: analysis.files.length > 0 ? "synced" : "no_files",
      });
    }

    state.rows = rows;
    if (state.rows.length === 0) {
      state.selectedSessionIndex = 0;
      state.selectedPromptIndex = 0;
      resetInspectScroll();
      state.view = "browse";
      return;
    }

    if (state.selectedSessionIndex >= state.rows.length) {
      state.selectedSessionIndex = state.rows.length - 1;
    }
    state.selectedPromptIndex = 0;
    resetInspectScroll();
  };

  const runTask = (label: string, task: () => Promise<void>): void => {
    if (state.busy) {
      return;
    }
    state.busy = true;
    state.statusLine = label;
    render();
    void task()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        state.statusLine = `Error: ${message}`;
      })
      .finally(() => {
        state.busy = false;
        render();
      });
  };

  const ensureChat = (sessionId: string): ChatMessage[] => {
    const existing = state.chatBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: ChatMessage[] = [];
    state.chatBySession.set(sessionId, created);
    return created;
  };

  const syncProject = async (triggerSource: SyncTriggerSource = "tui-sync"): Promise<void> => {
    refreshSettingsAndMemory();
    let lastRefresh = 0;
    const summary = await runSyncWorkflow({
      mode: "all",
      cwd: state.projectPath,
      flags,
      settings,
      triggerSource,
      onPushProgress: (progress) => {
        state.statusLine = `Push ${progress.matchedFiles}/${progress.scannedFiles} | events ${progress.importedEvents} | line ${progress.currentLine} | ${shortenPath(progress.currentFile, 42)}`;
        const now = Date.now();
        if (now - lastRefresh > 180) {
          lastRefresh = now;
          render();
        }
      },
      onPullProgress: (progress) => {
        state.statusLine = `Pull ${progress.current}/${progress.total} | imported ${progress.imported} | dedup ${progress.deduplicated} | skipped ${progress.skipped}`;
        const now = Date.now();
        if (now - lastRefresh > 180) {
          lastRefresh = now;
          render();
        }
      },
    });
    state.lastLocalSyncAt = new Date().toISOString();
    analysisCache.clear();
    await refreshRows("Refreshing sessions");
    await refreshSyncIndicators();
    const pushLine = formatPushPhaseLine(summary.push);
    const pullLine = formatPullPhaseLine(summary.pull as SyncPullPhaseOutcome);
    state.statusLine = `${clipPlain(pushLine, 120)} | ${clipPlain(pullLine, 120)}`;
  };

  const syncRemoteProject = async (triggerSource: SyncTriggerSource = "tui-pull"): Promise<void> => {
    refreshSettingsAndMemory();
    let lastRefresh = 0;
    const workflow = await runSyncWorkflow({
      mode: "pull",
      cwd: state.projectPath,
      flags,
      settings,
      triggerSource,
      onPullProgress: (progress) => {
        state.statusLine = `Remote sync ${progress.current}/${progress.total} | imported ${progress.imported} | dedup ${progress.deduplicated} | skipped ${progress.skipped}`;
        const now = Date.now();
        if (now - lastRefresh > 180) {
          lastRefresh = now;
          render();
        }
      },
    });
    analysisCache.clear();
    await refreshRows("Refreshing sessions");
    await refreshSyncIndicators();
    state.statusLine = formatPullPhaseLine(workflow.pull as SyncPullPhaseOutcome);
    if (!isSyncPullPhaseSkipped(workflow.pull as SyncPullPhaseOutcome)) {
      const note = (workflow.pull as SyncPullPhaseResult).summary.diagnosticNote;
      if (note) {
        state.statusLine = note;
      }
    }
  };

  const cycleProject = async (): Promise<void> => {
    const current = await loadRegistry();
    if (current.projects.length === 0) {
      state.statusLine = "No projects in registry. Press [a] to add one.";
      return;
    }

    const at = current.projects.indexOf(state.projectPath);
    const next = current.projects[(at + 1 + current.projects.length) % current.projects.length] ?? current.projects[0];
    state.projectPath = resolve(next);
    state.view = "browse";
    state.selectedSessionIndex = 0;
    state.selectedPromptIndex = 0;
    state.actorFilter = null;
    state.contributorsOpen = false;
    state.chatOpen = false;
    state.chatDraft = "";
    state.chatScroll = 0;
    state.fullDiffOpen = false;
    resetInspectScroll();
    analysisCache.clear();
    gitAuthorCache.clear();
    refreshSettingsAndMemory();
    await setLastProject(state.projectPath);
    await refreshRows(`Loading ${basename(state.projectPath)}`);
    await refreshSyncIndicators();
    state.statusLine = `Project: ${state.projectPath}`;
  };

  const sendChatQuestion = async (): Promise<void> => {
    const session = selectedRow();
    const analysis = selectedAnalysis();
    if (!session || !analysis) {
      state.statusLine = "No session selected.";
      return;
    }

    const question = state.chatDraft.trim();
    if (question.length === 0) {
      return;
    }

    const chat = ensureChat(session.sessionId);
    chat.push({ role: "you", text: question, ts: new Date().toISOString() });
    state.chatDraft = "";
    state.chatScroll = 0;
    render();

    if (!memory || !memory.isEnabled()) {
      chat.push({
        role: "mubit",
        text: "Mubit is disabled. Set MUBIT_API_KEY and restart with --mubit.",
        ts: new Date().toISOString(),
      });
      state.statusLine = "Mubit is disabled.";
      return;
    }

    const runId = mubitRunIdForContext(flags, repoId, session.sessionId, state.projectPath, settings);
    const promptSelection = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex, state.actorFilter);
    const prompt = promptSelection.prompt;
    state.selectedPromptIndex = promptSelection.index;
    const contextualQuery = `${question}\n\nCurrent prompt context:\n${clipText(prompt.prompt, 400)}`;

    const response = await withTimeout(
      memory.querySemanticContext({
        runId,
        query: buildMubitQueryPrompt(contextualQuery),
        limit: 8,
        mode: "direct_bypass",
        directLane: "semantic_search",
      }),
      45000,
      "Mubit query",
    );

    const openAiKey = resolveOpenAiApiKey(flags, settings);
    const agentRequested = getBooleanFlag(flags, "agent", openAiKey !== null);
    if (agentRequested && !openAiKey) {
      chat.push({
        role: "mubit",
        text: "OpenAI agent requested but OPENAI_API_KEY is missing. Falling back to Mubit answer.",
        ts: new Date().toISOString(),
      });
    }

    const agentResult = await runOpenAiAgentFromMubit(question, response, runId, flags);
    const answer = agentResult?.text ?? composeMubitAnswer(response, state.projectPath, session.sessionId);
    chat.push({
      role: "mubit",
      text: answer,
      ts: new Date().toISOString(),
    });
    state.chatScroll = 0;
    state.statusLine = agentResult
      ? `OpenAI agent (${agentResult.model}) responded`
      : "Mubit responded";
  };

  const cycleActorFilter = (): void => {
    const analysis = selectedAnalysis();
    if (!analysis) {
      state.statusLine = "No session selected.";
      return;
    }
    const contributors = analysis.contributors.map((entry) => entry.actorId);
    const sequence: Array<string | null> = [null, ...contributors];
    const currentIndex = sequence.findIndex((entry) => entry === state.actorFilter);
    const nextIndex = (currentIndex + 1 + sequence.length) % sequence.length;
    state.actorFilter = sequence[nextIndex] ?? null;
    const indices = promptIndicesForActor(analysis, state.actorFilter);
    state.selectedPromptIndex = indices[0] ?? 0;
    state.selectedThoughtIndex = 0;
    state.thoughtsScroll = 0;
    state.diffScroll = 0;
    state.fullDiffData = null;
    state.statusLine = `Actor filter: ${state.actorFilter ?? "all"}`;
  };

  const toggleContributors = (): void => {
    if (state.view !== "inspect") {
      state.statusLine = "Open a session first.";
      return;
    }
    const analysis = selectedAnalysis();
    if (!analysis) {
      state.statusLine = "No session selected.";
      return;
    }
    if (!state.contributorsOpen) {
      const contributorIds = analysis.contributors.map((entry) => entry.actorId);
      const current = state.actorFilter ? contributorIds.indexOf(state.actorFilter) : -1;
      state.selectedContributorIndex = current >= 0 ? current : 0;
    }
    state.contributorsOpen = !state.contributorsOpen;
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  output.write("\u001b[?1049h");
  output.write("\u001b[?7l");
  output.write("\u001b[?25l");
  output.write("\u001b[2J\u001b[H");
  screenReady = true;

  await refreshRows("Indexing sessions");
  await refreshSyncIndicators();
  state.statusLine = `Project: ${state.projectPath}`;

  const onResize = (): void => {
    render();
  };
  output.on("resize", onResize);
  render();

  const maybeWarmTuiOnStartup = async (): Promise<void> => {
    const auto = resolveSyncAutomationConfig(settings, state.projectPath);
    if (!auto.enabled || !auto.autoWarmTuiOnOpen) {
      return;
    }
    const currentRepoId = resolveRepoIdForProject(flags, state.projectPath, settings);
    const remote = await maybeReadRemoteSyncStateForProject(state.projectPath, currentRepoId).catch(() => null);
    const stale =
      !remote ||
      remote.pendingTrigger.pending ||
      shouldRunRemotePullNow(remote.lastSuccessAt, auto.remotePullCooldownSec);
    if (!stale || state.busy) {
      return;
    }
    runTask("Auto syncing project...", async () => {
      await syncProject("tui-startup");
    });
  };
  void maybeWarmTuiOnStartup();

  let closed = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    input.off("keypress", onKey);
    output.off("resize", onResize);
    input.setRawMode(false);
    output.write("\u001b[?25h");
    output.write("\u001b[?7h");
    output.write("\u001b[?1049l");
    if (resolveDone) {
      resolveDone();
    }
  };

  const inputPrompt = (mode: Exclude<InputMode, null>): string => {
    if (mode === "add_project") {
      return "Add project path: ";
    }
    if (mode === "set_project_name") {
      return "Set project name for this folder: ";
    }
    if (mode === "set_mubit_project_id") {
      return "Set Mubit project id for this folder: ";
    }
    if (mode === "set_mubit_actor_id") {
      return "Set Mubit actor id (global): ";
    }
    if (mode === "set_mubit_api_key") {
      return "Set Mubit API key (global): ";
    }
    return "Set OpenAI API key (global): ";
  };

  const renderInputValue = (mode: Exclude<InputMode, null>, value: string): string =>
    mode === "set_mubit_api_key" || mode === "set_openai_api_key"
      ? "*".repeat(Math.min(32, value.length))
      : value;

  const beginInputMode = (mode: Exclude<InputMode, null>): void => {
    state.inputMode = mode;
    state.inputBuffer = "";
    state.statusLine = inputPrompt(mode);
    state.settingsOpen = false;
    render();
  };

  const applyInputMode = async (mode: Exclude<InputMode, null>, candidate: string): Promise<void> => {
    if (mode === "add_project") {
      const normalized = resolve(candidate);
      await addProjectToRegistry(normalized);
      state.projectPath = normalized;
      await setLastProject(normalized);
      state.selectedSessionIndex = 0;
      state.selectedPromptIndex = 0;
      state.view = "browse";
      state.actorFilter = null;
      state.contributorsOpen = false;
      state.chatOpen = false;
      state.fullDiffOpen = false;
      resetInspectScroll();
      analysisCache.clear();
      gitAuthorCache.clear();
      refreshSettingsAndMemory();
      await refreshRows(`Loading ${basename(normalized)}`);
      state.statusLine = `Project: ${normalized}`;
      return;
    }

    if (mode === "set_mubit_project_id") {
      settings = updateProjectSettings(settings, state.projectPath, {
        mubitProjectId: candidate,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.statusLine = `Mubit project id set to ${candidate}`;
      return;
    }

    if (mode === "set_project_name") {
      settings = updateProjectSettings(settings, state.projectPath, {
        projectName: candidate,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.statusLine = `Project name set to ${candidate}`;
      return;
    }

    if (mode === "set_mubit_actor_id") {
      settings = updateGlobalSettings(settings, {
        mubitActorId: candidate,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.statusLine = `Mubit actor id set to ${candidate}`;
      return;
    }

    if (mode === "set_mubit_api_key") {
      settings = updateGlobalSettings(settings, {
        mubitApiKey: candidate,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.statusLine = "Mubit API key saved.";
      return;
    }

    settings = updateGlobalSettings(settings, {
      openAiApiKey: candidate,
    });
    saveCodaphSettings(settings);
    refreshSettingsAndMemory();
    state.statusLine = "OpenAI API key saved.";
  };

  const runSettingsAction = (action: string): void => {
    if (action === "close") {
      state.settingsOpen = false;
      render();
      return;
    }
    if (action === "auto") {
      const detected = detectGitHubDefaults(state.projectPath);
      if (!detected.projectId && !detected.actorId) {
        state.statusLine = "GitHub auto-detection failed for this folder.";
        state.settingsOpen = false;
        render();
        return;
      }
      if (detected.projectId) {
        settings = updateProjectSettings(settings, state.projectPath, {
          mubitProjectId: detected.projectId,
        });
      }
      if (detected.actorId) {
        settings = updateGlobalSettings(settings, {
          mubitActorId: detected.actorId,
        });
      }
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.settingsOpen = false;
      state.statusLine = `Auto-filled: project=${detected.projectId ?? "n/a"} actor=${detected.actorId ?? "n/a"}`;
      render();
      return;
    }
    if (action === "toggle_scope") {
      const current = resolveMubitRunScope(flags, state.projectPath, settings);
      const next: MubitRunScope = current === "project" ? "session" : "project";
      settings = updateProjectSettings(settings, state.projectPath, {
        mubitRunScope: next,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.settingsOpen = false;
      state.statusLine = `Mubit run scope set to ${next} for this folder.`;
      render();
      return;
    }
    if (action === "clear_mubit_key") {
      settings = updateGlobalSettings(settings, { mubitApiKey: null });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.settingsOpen = false;
      state.statusLine = "Cleared Mubit API key from Codaph settings.";
      render();
      return;
    }
    if (action === "clear_openai_key") {
      settings = updateGlobalSettings(settings, { openAiApiKey: null });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.settingsOpen = false;
      state.statusLine = "Cleared OpenAI API key from Codaph settings.";
      render();
      return;
    }
  };

  const onKey = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): void => {
    if (key.ctrl && key.name === "c") {
      close();
      return;
    }

    if (state.helpOpen) {
      if (str === "?" || key.name === "escape" || key.name === "q") {
        state.helpOpen = false;
        render();
      }
      return;
    }

    if (state.settingsOpen) {
      if (str === "q" || key.name === "q") {
        close();
        return;
      }
      if (str === "?") {
        state.settingsOpen = false;
        state.helpOpen = true;
        render();
        return;
      }
      if (key.name === "escape" || str === "o") {
        runSettingsAction("close");
        return;
      }
      if (str === "1") {
        beginInputMode("set_project_name");
        return;
      }
      if (str === "2") {
        beginInputMode("set_mubit_project_id");
        return;
      }
      if (str === "3") {
        beginInputMode("set_mubit_actor_id");
        return;
      }
      if (str === "4") {
        beginInputMode("set_mubit_api_key");
        return;
      }
      if (str === "5") {
        beginInputMode("set_openai_api_key");
        return;
      }
      if (str === "6") {
        runSettingsAction("auto");
        return;
      }
      if (str === "7") {
        runSettingsAction("toggle_scope");
        return;
      }
      if (str === "8") {
        runSettingsAction("clear_mubit_key");
        return;
      }
      if (str === "9") {
        runSettingsAction("clear_openai_key");
        return;
      }
      return;
    }

    if (state.inputMode) {
      const mode = state.inputMode;
      if (key.name === "escape") {
        state.inputMode = null;
        state.inputBuffer = "";
        state.statusLine = "Input cancelled.";
        render();
        return;
      }
      if (key.name === "backspace") {
        state.inputBuffer = state.inputBuffer.slice(0, -1);
        state.statusLine = `${inputPrompt(mode)}${renderInputValue(mode, state.inputBuffer)}`;
        render();
        return;
      }
      if (key.name === "return") {
        const candidate = state.inputBuffer.trim();
        state.inputMode = null;
        state.inputBuffer = "";
        if (candidate.length === 0) {
          state.statusLine = "Empty input. Cancelled.";
          render();
          return;
        }
        runTask("Applying setting...", async () => {
          await applyInputMode(mode, candidate);
        });
        return;
      }
      if (!key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        state.inputBuffer += str;
        state.statusLine = `${inputPrompt(mode)}${renderInputValue(mode, state.inputBuffer)}`;
        render();
      }
      return;
    }

    if (state.contributorsOpen) {
      if (key.name === "escape" || str === "c") {
        state.contributorsOpen = false;
        render();
        return;
      }
      if (key.name === "up") {
        const analysis = selectedAnalysis();
        const count = analysis?.contributors.length ?? 0;
        if (count > 0) {
          state.selectedContributorIndex = Math.max(0, state.selectedContributorIndex - 1);
          render();
        }
        return;
      }
      if (key.name === "down") {
        const analysis = selectedAnalysis();
        const count = analysis?.contributors.length ?? 0;
        if (count > 0) {
          state.selectedContributorIndex = Math.min(count - 1, state.selectedContributorIndex + 1);
          render();
        }
        return;
      }
      if (key.name === "return") {
        const analysis = selectedAnalysis();
        const contributor = analysis?.contributors[state.selectedContributorIndex];
        state.actorFilter = contributor?.actorId ?? null;
        const indices = analysis ? promptIndicesForActor(analysis, state.actorFilter) : [0];
        state.selectedPromptIndex = indices[0] ?? 0;
        state.selectedThoughtIndex = 0;
        state.diffScroll = 0;
        state.fullDiffData = null;
        state.contributorsOpen = false;
        state.statusLine = `Actor filter: ${state.actorFilter ?? "all"}`;
        render();
        return;
      }
      return;
    }

    if (str === "q" || key.name === "q") {
      close();
      return;
    }

    if (str === "?") {
      state.helpOpen = true;
      render();
      return;
    }

    if (str === "o") {
      state.settingsOpen = true;
      render();
      return;
    }

    if (str === "f") {
      cycleActorFilter();
      render();
      return;
    }

    if (str === "c") {
      toggleContributors();
      render();
      return;
    }

    if (str === "p") {
      runTask("Switching project...", cycleProject);
      return;
    }

    if (str === "a") {
      beginInputMode("add_project");
      return;
    }

    if (state.busy) {
      return;
    }

    if (state.view === "browse") {
      if (key.name === "up") {
        if (state.rows.length > 0) {
          state.selectedSessionIndex = Math.max(0, state.selectedSessionIndex - 1);
        }
        render();
        return;
      }
      if (key.name === "down") {
        if (state.rows.length > 0) {
          state.selectedSessionIndex = Math.min(state.rows.length - 1, state.selectedSessionIndex + 1);
        }
        render();
        return;
      }
      if (key.name === "return") {
        if (state.rows.length > 0) {
          state.view = "inspect";
          state.inspectPane = "prompts";
          state.selectedPromptIndex = 0;
          state.actorFilter = null;
          state.contributorsOpen = false;
          state.chatOpen = false;
          state.fullDiffOpen = false;
          state.chatScroll = 0;
          resetInspectScroll();
          render();
        }
        return;
      }
      if (str === "s") {
        runTask("Syncing project...", () => syncProject("tui-sync"));
        return;
      }
      if (str === "r") {
        runTask("Pulling cloud activity...", () => syncRemoteProject("tui-pull"));
        return;
      }
      return;
    }

    const analysis = selectedAnalysis();
    if (!analysis) {
      state.view = "browse";
      state.fullDiffOpen = false;
      state.fullDiffData = null;
      render();
      return;
    }

    if (state.fullDiffOpen) {
      const row = selectedRow();
      if (!row) {
        state.fullDiffOpen = false;
        state.fullDiffData = null;
        state.fullDiffScroll = 0;
        render();
        return;
      }
      const fullDiff = ensureFullDiffOverlayData(state, row, analysis);
      const bodyHeight = Math.max(1, getSize().height - 6);
      const maxScroll = Math.max(0, fullDiff.lines.length - bodyHeight);

      if (key.name === "up") {
        state.fullDiffScroll = Math.max(0, state.fullDiffScroll - 1);
        render();
        return;
      }
      if (key.name === "down") {
        state.fullDiffScroll = Math.min(maxScroll, state.fullDiffScroll + 1);
        render();
        return;
      }
      if (str === "d" || key.name === "escape" || key.name === "left") {
        state.fullDiffOpen = false;
        state.fullDiffData = null;
        state.fullDiffScroll = 0;
        render();
      }
      return;
    }

    if (key.name === "left") {
      const includeFilesPane = getSize().width < 126;
      const panes = inspectPaneCycle(state.chatOpen, includeFilesPane);
      const current = Math.max(0, panes.indexOf(state.inspectPane));
      const prev = panes[Math.max(0, current - 1)] ?? panes[0];
      state.inspectPane = prev ?? "prompts";
      render();
      return;
    }

    if (key.name === "right") {
      const includeFilesPane = getSize().width < 126;
      const panes = inspectPaneCycle(state.chatOpen, includeFilesPane);
      const current = Math.max(0, panes.indexOf(state.inspectPane));
      const next = panes[Math.min(panes.length - 1, current + 1)] ?? panes[panes.length - 1];
      state.inspectPane = next ?? "diff";
      render();
      return;
    }

    if (key.name === "escape") {
      if (state.chatOpen) {
        state.chatOpen = false;
        state.inspectPane = "thoughts";
      } else {
        state.view = "browse";
        state.contributorsOpen = false;
        state.fullDiffOpen = false;
        state.fullDiffData = null;
      }
      render();
      return;
    }

    if (key.name === "tab") {
      const includeFilesPane = getSize().width < 126;
      const panes = inspectPaneCycle(state.chatOpen, includeFilesPane);
      const current = panes.indexOf(state.inspectPane);
      const next = panes[(current + 1) % panes.length] ?? panes[0];
      state.inspectPane = next ?? "prompts";
      render();
      return;
    }

    if (str === "m") {
      state.chatOpen = !state.chatOpen;
      state.inspectPane = state.chatOpen ? "chat" : "thoughts";
      state.chatScroll = 0;
      render();
      return;
    }

    if (str === "d") {
      const row = selectedRow();
      if (!row) {
        state.statusLine = "No session selected.";
        render();
        return;
      }
      ensureFullDiffOverlayData(state, row, analysis);
      state.fullDiffOpen = true;
      state.fullDiffScroll = 0;
      render();
      return;
    }

    if (key.name === "return" && state.inspectPane === "prompts") {
      state.inspectPane = "thoughts";
      state.selectedThoughtIndex = 0;
      state.diffScroll = 0;
      state.fullDiffData = null;
      render();
      return;
    }

    if (key.name === "up") {
      if (state.inspectPane === "prompts") {
        const indices = promptIndicesForActor(analysis, state.actorFilter);
        const current = indices.indexOf(state.selectedPromptIndex);
        const currentPos = current >= 0 ? current : 0;
        const nextPos = Math.max(0, currentPos - 1);
        const nextIndex = indices[nextPos] ?? state.selectedPromptIndex;
        if (nextIndex !== state.selectedPromptIndex) {
          state.selectedPromptIndex = nextIndex;
          resetInspectScroll();
          state.fullDiffData = null;
        }
      } else if (state.inspectPane === "thoughts") {
        state.selectedThoughtIndex = Math.max(0, state.selectedThoughtIndex - 1);
        state.diffScroll = 0;
        state.fullDiffData = null;
      } else if (state.inspectPane === "files") {
        state.filesScroll = Math.max(0, state.filesScroll - 1);
      } else if (state.inspectPane === "diff") {
        state.diffScroll = Math.max(0, state.diffScroll - 1);
      } else if (state.inspectPane === "chat") {
        const row = selectedRow();
        const chat = row ? ensureChat(row.sessionId) : [];
        state.chatScroll = Math.min(chat.length, state.chatScroll + 1);
      }
      render();
      return;
    }

    if (key.name === "down") {
      if (state.inspectPane === "prompts") {
        const indices = promptIndicesForActor(analysis, state.actorFilter);
        const current = indices.indexOf(state.selectedPromptIndex);
        const currentPos = current >= 0 ? current : 0;
        const nextPos = Math.min(indices.length - 1, currentPos + 1);
        const nextIndex = indices[nextPos] ?? state.selectedPromptIndex;
        if (nextIndex !== state.selectedPromptIndex) {
          state.selectedPromptIndex = nextIndex;
          resetInspectScroll();
          state.fullDiffData = null;
        }
      } else if (state.inspectPane === "thoughts") {
        const promptSelection = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex, state.actorFilter);
        const prompt = promptSelection.prompt;
        state.selectedPromptIndex = promptSelection.index;
        const thoughtCount = thoughtEntriesForPrompt(prompt).length;
        state.selectedThoughtIndex = Math.min(thoughtCount - 1, state.selectedThoughtIndex + 1);
        state.diffScroll = 0;
        state.fullDiffData = null;
      } else if (state.inspectPane === "files") {
        state.filesScroll += 1;
      } else if (state.inspectPane === "diff") {
        state.diffScroll += 1;
      } else if (state.inspectPane === "chat") {
        state.chatScroll = Math.max(0, state.chatScroll - 1);
      }
      render();
      return;
    }

    if (state.chatOpen && state.inspectPane === "chat") {
      if (key.name === "backspace") {
        state.chatDraft = state.chatDraft.slice(0, -1);
        render();
        return;
      }
      if (key.name === "return") {
        runTask("Querying Mubit...", sendChatQuestion);
        return;
      }
      if (!key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        state.chatDraft += str;
        render();
      }
    }
  };

  input.on("keypress", onKey);
  await done;
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(help());
    return;
  }

  if (cmd === "run") {
    await runCapture("run", [sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "exec") {
    await runCapture("exec", [sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "setup") {
    await setupCommand([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "init") {
    await initCommand([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "import") {
    await importCommand([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "status") {
    await statusCommand([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "sync") {
    if (!sub) {
      await syncCommand(rest);
      return;
    }
    if (sub === "all") {
      await syncCommand(rest);
      return;
    }
    if (sub === "push") {
      await syncPushCommand(rest);
      return;
    }
    if (sub === "import") {
      await importCommand(rest);
      return;
    }
    if (sub === "pull" || sub === "remote") {
      await syncPullCommand(rest);
      return;
    }
    if (sub === "status") {
      await syncStatus(rest);
      return;
    }
    if (sub === "setup") {
      await syncSetupCommand(rest);
      return;
    }
    await syncCommand([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "hooks" && sub === "run") {
    await hooksRun(rest);
    return;
  }

  if (cmd === "sessions" && sub === "list") {
    await listSessions(rest);
    return;
  }

  if (cmd === "timeline") {
    await timeline([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "diff") {
    await diff([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "inspect") {
    await inspect([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "mubit" && sub === "query") {
    await mubitQuery(rest);
    return;
  }

  if (cmd === "mubit" && sub === "backfill") {
    await mubitBackfill(rest);
    return;
  }

  if (cmd === "projects") {
    await projects([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "tui") {
    await tui([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "doctor") {
    await doctor([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
