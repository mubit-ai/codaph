#!/usr/bin/env bun
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { CapturedEventEnvelope } from "@codaph/core-types";
import { repoIdFromPath } from "@codaph/core-types";
import { JsonlMirror } from "@codaph/mirror-jsonl";
import { IngestPipeline } from "@codaph/ingest-pipeline";
import { CodexSdkAdapter } from "@codaph/adapter-codex-sdk";
import { CodexExecAdapter } from "@codaph/adapter-codex-exec";
import { QueryService } from "@codaph/query-service";
import { MubitMemoryEngine, mubitRunIdForProject, mubitRunIdForSession } from "@codaph/memory-mubit";
import {
  syncCodexHistory,
  type CodexHistorySyncProgress,
  type CodexHistorySyncSummary,
} from "./codex-history-sync";
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

type Flags = Record<string, string | boolean>;
type CaptureMode = "run" | "exec";

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
    "Codaph CLI/TUI (Codex-first, MuBit-enabled)",
    "",
    "Capture:",
    "  codaph run \"<prompt>\" [--model <name>] [--cwd <path>] [--resume-thread <id>]",
    "  codaph exec \"<prompt>\" [--model <name>] [--cwd <path>] [--resume-thread <id>]",
    "",
    "History Import (from ~/.codex/sessions):",
    "  codaph sync [--cwd <path>] [--json] [--no-mubit|--local-only]",
    "",
    "Read / Inspect:",
    "  codaph sessions list [--cwd <path>]",
    "  codaph timeline --session <id> [--cwd <path>] [--json]",
    "  codaph diff --session <id> [--path <file>] [--cwd <path>]",
    "  codaph inspect --session <id> [--cwd <path>]",
    "",
    "MuBit:",
    "  codaph mubit query \"<question>\" --session <id> [--cwd <path>] [--limit <n>]",
    "    --raw to print full JSON response, --no-agent to skip OpenAI synthesis",
    "  codaph mubit backfill [--cwd <path>] [--session <id>] [--verbose]",
    "",
    "Projects (global registry for TUI):",
    "  codaph projects list",
    "  codaph projects add --cwd <path>",
    "  codaph projects remove --cwd <path>",
    "",
    "Interactive TUI:",
    "  codaph tui [--cwd <path>] [--mubit|--no-mubit]",
    "  codaph doctor [--mubit|--no-mubit]",
    "",
    "MuBit flags:",
    "  --mubit / --no-mubit",
    "  --mubit-api-key <key>      (preferred: set MUBIT_API_KEY env var)",
    "  --mubit-transport <auto|http|grpc>",
    "  --mubit-endpoint <url>",
    "  --mubit-http-endpoint <url>",
    "  --mubit-grpc-endpoint <host:port>",
    "  --mubit-agent-id <id>",
    "  --mubit-project-id <shared-project-id> (or CODAPH_PROJECT_ID; auto from git origin owner/repo)",
    "  --mubit-run-scope <session|project>    (default: project when a project id is resolved, else session)",
    "  --mubit-actor-id <contributor-id>      (or CODAPH_ACTOR_ID; auto from gh/git config)",
    "  --mubit-write-timeout-ms <ms> (default 15000, set 0 to disable timeout)",
    "",
    "OpenAI agent flags:",
    "  --agent / --no-agent",
    "  --openai-api-key <key>     (preferred: set OPENAI_API_KEY env var)",
    "  --openai-model <model>",
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
  const repoId = repoIdFromPath(cwd);

  console.log(`cwd: ${cwd}`);
  console.log(`repoId(local): ${repoId}`);
  console.log(`MuBit project id: ${projectId ?? "(not set, uses local repoId)"}`);
  console.log(`MuBit run scope: ${runScope}`);
  console.log(`MuBit actor id: ${actorId ?? "(not set)"}`);
  console.log(`env MUBIT_API_KEY present: ${envKeyPresent ? "yes" : "no"}`);
  console.log(`flag/env key resolved: ${keyPresent ? "yes" : "no"}`);
  console.log(`MuBit requested: ${requested ? "yes" : "no"}`);
  console.log(`MuBit runtime: ${memory?.isEnabled() ? "enabled" : "disabled"}`);
  console.log(`MuBit run scope preview: ${mubitRunIdForContext(flags, repoId, "session-preview", cwd, settings)}`);
  console.log(`MuBit write timeout: ${resolveMubitWriteTimeoutMs(flags)}ms`);
  console.log(`OpenAI key present: ${openAiKeyPresent ? "yes" : "no"}`);
  console.log(`OpenAI agent: ${agentEnabled ? "enabled" : "disabled"}`);

  if (!requested) {
    console.log("Reason: MuBit was not requested (use --mubit to force-enable).");
  } else if (!keyPresent) {
    console.log("Reason: no MuBit key resolved.");
  } else {
    console.log("MuBit setup looks valid from env/flags.");
  }
}

function createPipeline(
  cwd: string,
  flags: Flags,
  settings?: CodaphSettings,
): { pipeline: IngestPipeline; memory: MubitMemoryEngine | null } {
  const mirrorRoot = resolve(cwd, ".codaph");
  const mirror = new JsonlMirror(mirrorRoot);
  const memory = createMubitMemory(flags, cwd, settings);
  const memoryWriteTimeoutMs = resolveMubitWriteTimeoutMs(flags);
  const pipeline = new IngestPipeline(mirror, {
    memoryEngine: memory ?? undefined,
    memoryWriteTimeoutMs,
    onMemoryError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`MuBit write failed: ${message}`);
    },
  });
  return { pipeline, memory };
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

function createSyncProgressReporter(prefix: string): {
  onProgress: (progress: CodexHistorySyncProgress) => void;
  finish: () => void;
} {
  let lastInlineLength = 0;
  let lastPrintAt = 0;

  return {
    onProgress(progress) {
      const session = progress.currentSessionId ? progress.currentSessionId.slice(0, 8) : "unknown";
      const line = `${prefix} files ${progress.matchedFiles}/${progress.scannedFiles} | events ${progress.importedEvents} | line ${progress.currentLine} | session ${session} | ${shortenPath(progress.currentFile)}`;

      if (output.isTTY) {
        const padding = " ".repeat(Math.max(0, lastInlineLength - line.length));
        output.write(`\r${line}${padding}`);
        lastInlineLength = line.length;
        return;
      }

      const now = Date.now();
      if (now - lastPrintAt < 1500) {
        return;
      }
      lastPrintAt = now;
      console.log(line);
    },
    finish() {
      if (output.isTTY && lastInlineLength > 0) {
        output.write("\n");
      }
    },
  };
}

async function runCapture(command: CaptureMode, rest: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(rest);
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const { pipeline, memory } = createPipeline(cwd, flags, settings);

  const options = {
    prompt,
    cwd,
    model: getStringFlag(flags, "model"),
    resumeThreadId: getStringFlag(flags, "resume-thread"),
  };

  const adapter = command === "run" ? new CodexSdkAdapter(pipeline) : new CodexExecAdapter(pipeline);

  const result = await adapter.runAndCapture(options, (event) => {
    const itemType = (event.payload.item as { type?: string } | undefined)?.type;
    console.log(`${event.ts} ${event.eventType}${itemType ? `:${itemType}` : ""}`);
  });

  console.log(`sessionId: ${result.sessionId}`);
  console.log(`threadId: ${result.threadId ?? "(none)"}`);
  if (memory?.isEnabled()) {
    console.log("MuBit: enabled");
  } else {
    console.log("MuBit: disabled (set MUBIT_API_KEY or pass --mubit-api-key)");
  }
  if (result.finalResponse) {
    console.log("\nfinalResponse:\n");
    console.log(result.finalResponse);
  }
}

async function listSessions(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const repoId = repoIdFromPath(cwd);
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
  const repoId = repoIdFromPath(cwd);
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
  const repoId = repoIdFromPath(cwd);
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

async function syncHistory(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const localOnly = getBooleanFlag(flags, "local-only", false);
  const legacySyncMubit = getBooleanFlag(flags, "sync-mubit", false);
  const syncFlags: Flags = { ...flags };
  if (legacySyncMubit) {
    syncFlags.mubit = true;
  }
  if (localOnly) {
    syncFlags.mubit = false;
  }

  const settings = loadCodaphSettings();
  const { pipeline, memory } = createPipeline(cwd, syncFlags, settings);
  const reporter = createSyncProgressReporter("Syncing Codex history");
  const summary = await syncCodexHistory({
    projectPath: cwd,
    pipeline,
    onProgress: flags.json === true ? undefined : reporter.onProgress,
  }).finally(() => {
    if (flags.json !== true) {
      reporter.finish();
    }
  });

  if (flags.json === true) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(formatSummary(summary));
  const mubitRequested = shouldEnableMubit(syncFlags, settings);
  if (memory?.isEnabled()) {
    console.log("MuBit ingest during sync: enabled");
  } else if (mubitRequested) {
    console.log("MuBit ingest during sync: requested but unavailable (check MUBIT_API_KEY / endpoint)");
  } else {
    console.log("MuBit ingest during sync: disabled (--no-mubit or --local-only)");
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
    .map((event) => ({ ts: event.ts, text: getPromptText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-5);
  const thoughts = events
    .map((event) => ({ ts: event.ts, text: getThoughtText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-5);
  const outputs = events
    .map((event) => ({ ts: event.ts, text: getAssistantText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-5);
  const changes = events
    .flatMap((event) => getFileChangeList(event).map((change) => ({ ts: event.ts, ...change })))
    .slice(-8);

  console.log("\nPrompts");
  if (prompts.length === 0) {
    console.log("  (none)");
  }
  for (const row of prompts) {
    console.log(`  - ${row.ts}: ${toCompactLine(row.text)}`);
  }

  console.log("\nThoughts");
  if (thoughts.length === 0) {
    console.log("  (none)");
  }
  for (const row of thoughts) {
    console.log(`  - ${row.ts}: ${toCompactLine(row.text)}`);
  }

  console.log("\nAssistant Output");
  if (outputs.length === 0) {
    console.log("  (none)");
  }
  for (const row of outputs) {
    console.log(`  - ${row.ts}: ${toCompactLine(row.text)}`);
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
  const repoId = repoIdFromPath(cwd);
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
        !/^(Codaph TUI|Project:|Sessions:|Active Session:|MuBit:|Prompts|Thoughts|Assistant Output|Diff Summary|Actions)/i.test(
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
  console.log(`MuBit returned no answer/evidence for session ${sessionId}.`);
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
                  "You are Codaph Analyst. Answer the user question using MuBit evidence. Keep it concise and actionable. Do not dump raw logs. Return at most 6 bullets.",
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
    console.log("MuBit answer:");
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
  console.log(`MuBit returned ${evidenceCount} evidence items, but no final answer.`);
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
    throw new Error("--session is required to resolve MuBit run scope.");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const settings = loadCodaphSettings();
  const repoId = repoIdFromPath(cwd);
  const engine = createMubitMemory(flags, cwd, settings);
  if (!engine || !engine.isEnabled()) {
    throw new Error("MuBit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
  }

  const limitRaw = getStringFlag(flags, "limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const rawMode = getBooleanFlag(flags, "raw", false);
  const runId = mubitRunIdForContext(flags, repoId, sessionId, cwd, settings);
  console.log(`Querying MuBit run scope: ${runId}`);

  const response = await withTimeout(
    engine.querySemanticContext({
      runId,
      query: buildMubitQueryPrompt(question),
      limit,
      mode: "direct_bypass",
      directLane: "semantic_search",
    }),
    45000,
    "MuBit query",
  );

  if (!rawMode) {
    const openAiKey = resolveOpenAiApiKey(flags, settings);
    const agentRequested = getBooleanFlag(flags, "agent", openAiKey !== null);
    if (agentRequested && !openAiKey) {
      console.log("OpenAI agent requested but OPENAI_API_KEY is missing. Falling back to MuBit response.");
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
    throw new Error("MuBit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
  }

  const repoId = repoIdFromPath(cwd);
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
    for (const event of events) {
      attempted += 1;
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
  text: string;
  diffLines: string[];
}

interface PromptSlice {
  id: number;
  ts: string;
  prompt: string;
  thoughts: string[];
  thoughtSlices: ThoughtSlice[];
  outputs: string[];
  files: Map<string, FileStatRow>;
  diffLines: string[];
}

interface SessionAnalysis {
  sessionId: string;
  prompts: PromptSlice[];
  files: FileStatRow[];
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
  helpOpen: boolean;
  settingsOpen: boolean;
  busy: boolean;
  statusLine: string;
  inputMode: InputMode;
  inputBuffer: string;
  chatBySession: Map<string, ChatMessage[]>;
}

const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;
const TUI_COLORS = {
  brand: "38;2;255;69;0",
  activeBorder: "97",
  inactiveBorder: "90",
  selected: "48;2;255;69;0;30",
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
    const promptText = getPromptText(event);
    if (promptText) {
      const created: PromptSlice = {
        id: nextPromptId,
        ts: event.ts,
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
          text: "(No exposed reasoning text)",
          diffLines: pending.slice(0, 220),
        });
      }
    }

    for (const thoughtSlice of prompt.thoughtSlices) {
      thoughtSlice.diffLines = thoughtSlice.diffLines.slice(0, 220);
    }
  }

  return {
    sessionId,
    prompts,
    files: toSortedFileStats(sessionFiles),
    tokenEstimate: Math.max(0, Math.round(tokenChars / 4)),
  };
}

function selectedPromptFromAnalysis(analysis: SessionAnalysis, selectedPromptIndex: number): PromptSlice {
  const safeIndex = Math.max(0, Math.min(selectedPromptIndex, analysis.prompts.length - 1));
  return analysis.prompts[safeIndex] as PromptSlice;
}

function thoughtEntriesForPrompt(prompt: PromptSlice): ThoughtSlice[] {
  if (prompt.thoughtSlices.length > 0) {
    return prompt.thoughtSlices;
  }

  if (prompt.outputs.length > 0) {
    return prompt.outputs.map((output, index) => ({
      id: index + 1,
      ts: prompt.ts,
      text: output,
      diffLines: index === prompt.outputs.length - 1 ? prompt.diffLines : [],
    }));
  }

  return [{
    id: 1,
    ts: prompt.ts,
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

  return `MuBit returned no answer/evidence for session ${sessionId}. Try refining query for ${cwd}.`;
}

function headerLine(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleLength(left) - visibleLength(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

function renderBrowseView(
  state: TuiState,
  projectLabel: string,
  mubitEnabled: boolean,
  width: number,
  height: number,
): string {
  const leftHeader = `${paint("codaph", TUI_COLORS.brand)}  >  ${projectLabel}`;
  const rightHeader = `${paint(mubitEnabled ? "MuBit:on" : "MuBit:off", mubitEnabled ? TUI_COLORS.cyan : TUI_COLORS.yellow)}   ${paint("[o] settings  [?] help", TUI_COLORS.dim)}`;
  const header = headerLine(leftHeader, rightHeader, width);

  const tableHeight = Math.max(10, height - 6);
  const bodyRows = Math.max(3, tableHeight - 4);
  const start = windowStart(state.rows.length, state.selectedSessionIndex, bodyRows);
  const rows = state.rows.slice(start, start + bodyRows);

  const sessionLines: PaneLine[] = [
    { text: "  #   Date              Prompts   Files Changed   Tokens    Status", color: TUI_COLORS.muted },
    { text: " -------------------------------------------------------------------", color: TUI_COLORS.muted },
  ];

  if (rows.length === 0) {
    sessionLines.push({ text: "  (no sessions yet) press [s] to sync Codex history", color: TUI_COLORS.muted });
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
  const footer = "[up/down] navigate   [enter] inspect   [s] sync   [p] switch project   [a] add project   [o] settings   [q] quit";
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
  const prompt = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex);
  const thoughtSelection = selectedThoughtFromPrompt(prompt, state.selectedThoughtIndex);
  let rawDiffLines = thoughtSelection.selected.diffLines.length > 0
    ? thoughtSelection.selected.diffLines
    : diffPreviewLines(prompt, analysis.files);
  let usedLiveFallback = false;
  if (!hasCodeLevelDiffLines(rawDiffLines)) {
    const files = collectDiffFiles(state.projectPath, rawDiffLines, prompt, analysis.files);
    const liveDiff = getLiveGitDiffLines(state.projectPath, files);
    if (liveDiff.length > 0) {
      rawDiffLines = liveDiff;
      usedLiveFallback = true;
    }
  }

  const diffLines = formatFullDiffLines(rawDiffLines);
  if (usedLiveFallback) {
    diffLines.unshift("(Live git diff fallback from current working tree)");
    diffLines.unshift("");
  }
  const contentHeight = Math.max(8, height - 4);
  const bodyHeight = Math.max(1, contentHeight - 2);
  const maxScroll = Math.max(0, diffLines.length - bodyHeight);
  const scroll = Math.max(0, Math.min(state.fullDiffScroll, maxScroll));
  const visible = diffLines.slice(scroll, scroll + bodyHeight);

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
    `Session ${selectedSession.sessionId.slice(0, 8)} - Prompt ${prompt.id} - Thought ${thoughtSelection.index + 1}`,
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

  const prompt = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex);
  const splitMode = width >= 104;
  const threePaneMode = width >= 126;
  const chatHeight = state.chatOpen ? Math.max(10, Math.floor(height * 0.32)) : 0;
  const baseHeight = Math.max(14, height - 4 - (state.chatOpen ? chatHeight + 1 : 0));

  const topHeader = headerLine(
    `${paint("codaph", TUI_COLORS.brand)}  >  ${projectLabel}  >  Session ${selectedSession.sessionId.slice(0, 8)} - ${formatDateCell(selectedSession.to)}`,
    `${paint(mubitEnabled ? "MuBit:on" : "MuBit:off", mubitEnabled ? TUI_COLORS.cyan : TUI_COLORS.yellow)}   ${paint("[left] back  [?] help", TUI_COLORS.dim)}`,
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
    const promptStart = windowStart(analysis.prompts.length, state.selectedPromptIndex, promptBody);
    const visiblePrompts = analysis.prompts.slice(promptStart, promptStart + promptBody);
    for (let i = 0; i < visiblePrompts.length; i += 1) {
      const absoluteIndex = promptStart + i;
      const row = visiblePrompts[i] as PromptSlice;
      lines.push({
        text: `${absoluteIndex === state.selectedPromptIndex ? ">" : " "} ${row.id.toString().padStart(2, " ")}  ${promptPreview(row.prompt, Math.max(10, paneWidth - 10))}`,
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
      lines.push({
        text: `${absoluteIndex === state.selectedThoughtIndex ? ">" : " "} ${row.id.toString().padStart(2, " ")}  ${promptPreview(row.text, Math.max(10, paneWidth - 10))}`,
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
    const selectedThoughtDiff = thoughtSelection.selected.diffLines;
    const source = selectedThoughtDiff.length > 0 ? selectedThoughtDiff : diffPreviewLines(prompt, analysis.files);
    const rows: PaneLine[] = [];
    if (selectedThoughtDiff.length === 0 && thoughtSelection.entries.length > 0) {
      rows.push({
        text: `(No diff directly tied to thought ${thoughtSelection.index + 1}; showing prompt-level diff)`,
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
    const promptsBox = boxLines("Prompts", leftWidth, paneHeight, buildPromptLines(leftWidth, paneHeight), state.inspectPane === "prompts");
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

    const promptsBox = boxLines("Prompts", leftWidth, topHeight, buildPromptLines(leftWidth, topHeight), state.inspectPane === "prompts");
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

    composed.push(...boxLines("Prompts", paneWidth, promptsHeight, buildPromptLines(paneWidth, promptsHeight), state.inspectPane === "prompts"));
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
    composed.push(...boxLines("MuBit", width, chatHeight, chatLines, state.inspectPane === "chat"));
  }

  const footer = state.chatOpen
    ? "[tab] focus pane   [esc] close chat   [up/down] navigate/scroll   [left] back"
    : threePaneMode
      ? "[enter] prompt -> thoughts   [up/down] select/scroll   [tab] focus pane   [d] full diff   [m] MuBit chat   [o] settings   [left] back"
      : "[up/down] prompts/scroll pane   [tab] focus pane   [d] full diff   [m] MuBit chat   [o] settings   [left] back";

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
    { text: "s       sync Codex history" },
    { text: "" },
    { text: "Inspect", color: TUI_COLORS.muted },
    { text: "enter   from prompts -> focus thoughts" },
    { text: "up/down navigate prompts/thoughts or scroll pane" },
    { text: "tab     cycle pane focus" },
    { text: "d       toggle full diff overlay" },
    { text: "m       toggle MuBit chat" },
    { text: "left/esc back to browse" },
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
    { text: `MuBit runtime: ${memoryEnabled ? "enabled" : "disabled"}` },
    { text: "" },
    { text: `Current project name: ${projectName}` },
    { text: `Current project id: ${projectId ?? "(auto detection failed)"}` },
    { text: `Current actor id: ${actorId ?? "(auto detection failed)"}` },
    { text: `Current run scope: ${runScope}` },
    { text: `MuBit API key: ${maskSecret(mubitKey)}` },
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
    { text: "2  set MuBit project id (this folder)" },
    { text: "3  set actor id (global)" },
    { text: "4  set MuBit API key (global)" },
    { text: "5  set OpenAI API key (global)" },
    { text: "6  auto-fill project+actor from git/GitHub" },
    { text: "7  toggle MuBit run scope (session/project) for this folder" },
    { text: "8  clear MuBit API key" },
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
    helpOpen: false,
    settingsOpen: false,
    busy: false,
    statusLine: "",
    inputMode: null,
    inputBuffer: "",
    chatBySession: new Map<string, ChatMessage[]>(),
  };

  let query = new QueryService(resolve(state.projectPath, ".codaph"));
  let repoId = repoIdFromPath(state.projectPath);
  let settings = loadCodaphSettings();
  let memory = createMubitMemory(flags, state.projectPath, settings);
  const analysisCache = new Map<string, CachedSessionAnalysis>();
  let screenReady = false;

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
  };

  const refreshSettingsAndMemory = (): void => {
    settings = loadCodaphSettings();
    memory = createMubitMemory(flags, state.projectPath, settings);
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
    repoId = repoIdFromPath(state.projectPath);

    const sessions = await query.listSessions(repoId) as QuerySessionSummary[];
    const rows: SessionBrowseRow[] = [];

    for (let i = 0; i < sessions.length; i += 1) {
      const session = sessions[i] as QuerySessionSummary;
      state.statusLine = `${progressLabel} (${i + 1}/${sessions.length})`;
      if (i === 0 || i % 3 === 0) {
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

  const syncProject = async (): Promise<void> => {
    refreshSettingsAndMemory();
    const { pipeline, memory: syncMemory } = createPipeline(state.projectPath, flags, settings);
    let lastRefresh = 0;
    const summary = await syncCodexHistory({
      projectPath: state.projectPath,
      pipeline,
      onProgress: (progress) => {
        state.statusLine = `Sync ${progress.matchedFiles}/${progress.scannedFiles} | events ${progress.importedEvents} | line ${progress.currentLine} | ${shortenPath(progress.currentFile, 42)}`;
        const now = Date.now();
        if (now - lastRefresh > 120) {
          lastRefresh = now;
          render();
        }
      },
    });
    analysisCache.clear();
    await refreshRows("Refreshing sessions");
    state.statusLine = `${formatSummary(summary)} | MuBit ${syncMemory?.isEnabled() ? "enabled" : "disabled"}`;
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
    state.chatOpen = false;
    state.chatDraft = "";
    state.chatScroll = 0;
    state.fullDiffOpen = false;
    resetInspectScroll();
    analysisCache.clear();
    refreshSettingsAndMemory();
    await setLastProject(state.projectPath);
    await refreshRows(`Loading ${basename(state.projectPath)}`);
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
        text: "MuBit is disabled. Set MUBIT_API_KEY and restart with --mubit.",
        ts: new Date().toISOString(),
      });
      state.statusLine = "MuBit is disabled.";
      return;
    }

    const runId = mubitRunIdForContext(flags, repoId, session.sessionId, state.projectPath, settings);
    const prompt = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex);
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
      "MuBit query",
    );

    const openAiKey = resolveOpenAiApiKey(flags, settings);
    const agentRequested = getBooleanFlag(flags, "agent", openAiKey !== null);
    if (agentRequested && !openAiKey) {
      chat.push({
        role: "mubit",
        text: "OpenAI agent requested but OPENAI_API_KEY is missing. Falling back to MuBit answer.",
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
      : "MuBit responded";
  };

  emitKeypressEvents(input);
  input.setRawMode(true);
  output.write("\u001b[?1049h");
  output.write("\u001b[?7l");
  output.write("\u001b[?25l");
  output.write("\u001b[2J\u001b[H");
  screenReady = true;

  await refreshRows("Indexing sessions");
  state.statusLine = `Project: ${state.projectPath}`;

  const onResize = (): void => {
    render();
  };
  output.on("resize", onResize);
  render();

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
      return "Set MuBit project id for this folder: ";
    }
    if (mode === "set_mubit_actor_id") {
      return "Set MuBit actor id (global): ";
    }
    if (mode === "set_mubit_api_key") {
      return "Set MuBit API key (global): ";
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
      state.chatOpen = false;
      state.fullDiffOpen = false;
      resetInspectScroll();
      analysisCache.clear();
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
      state.statusLine = `MuBit project id set to ${candidate}`;
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
      state.statusLine = `MuBit actor id set to ${candidate}`;
      return;
    }

    if (mode === "set_mubit_api_key") {
      settings = updateGlobalSettings(settings, {
        mubitApiKey: candidate,
      });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.statusLine = "MuBit API key saved.";
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
      state.statusLine = `MuBit run scope set to ${next} for this folder.`;
      render();
      return;
    }
    if (action === "clear_mubit_key") {
      settings = updateGlobalSettings(settings, { mubitApiKey: null });
      saveCodaphSettings(settings);
      refreshSettingsAndMemory();
      state.settingsOpen = false;
      state.statusLine = "Cleared MuBit API key from Codaph settings.";
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
          state.chatOpen = false;
          state.fullDiffOpen = false;
          state.chatScroll = 0;
          resetInspectScroll();
          render();
        }
        return;
      }
      if (str === "s") {
        runTask("Syncing Codex history...", syncProject);
        return;
      }
      return;
    }

    const analysis = selectedAnalysis();
    if (!analysis) {
      state.view = "browse";
      render();
      return;
    }

    if (state.fullDiffOpen) {
      const prompt = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex);
      const fullDiff = diffPreviewLines(prompt, analysis.files);
      const bodyHeight = Math.max(1, getSize().height - 6);
      const maxScroll = Math.max(0, fullDiff.length - bodyHeight);

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
        state.fullDiffScroll = 0;
        render();
      }
      return;
    }

    if (key.name === "left" || key.name === "escape") {
      if (state.chatOpen) {
        state.chatOpen = false;
        state.inspectPane = "thoughts";
      } else {
        state.view = "browse";
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
      state.fullDiffOpen = true;
      state.fullDiffScroll = 0;
      render();
      return;
    }

    if (key.name === "return" && state.inspectPane === "prompts") {
      state.inspectPane = "thoughts";
      state.selectedThoughtIndex = 0;
      state.diffScroll = 0;
      render();
      return;
    }

    if (key.name === "up") {
      if (state.inspectPane === "prompts") {
        const nextIndex = Math.max(0, state.selectedPromptIndex - 1);
        if (nextIndex !== state.selectedPromptIndex) {
          state.selectedPromptIndex = nextIndex;
          resetInspectScroll();
        }
      } else if (state.inspectPane === "thoughts") {
        state.selectedThoughtIndex = Math.max(0, state.selectedThoughtIndex - 1);
        state.diffScroll = 0;
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
        const nextIndex = Math.min(analysis.prompts.length - 1, state.selectedPromptIndex + 1);
        if (nextIndex !== state.selectedPromptIndex) {
          state.selectedPromptIndex = nextIndex;
          resetInspectScroll();
        }
      } else if (state.inspectPane === "thoughts") {
        const prompt = selectedPromptFromAnalysis(analysis, state.selectedPromptIndex);
        const thoughtCount = thoughtEntriesForPrompt(prompt).length;
        state.selectedThoughtIndex = Math.min(thoughtCount - 1, state.selectedThoughtIndex + 1);
        state.diffScroll = 0;
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
        runTask("Querying MuBit...", sendChatQuestion);
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

  if (cmd === "sync") {
    await syncHistory([sub, ...rest].filter(Boolean) as string[]);
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
