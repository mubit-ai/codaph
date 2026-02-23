#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import type { CapturedEventEnvelope } from "@codaph/core-types";
import { repoIdFromPath } from "@codaph/core-types";
import { JsonlMirror } from "@codaph/mirror-jsonl";
import { IngestPipeline } from "@codaph/ingest-pipeline";
import { CodexSdkAdapter } from "@codaph/adapter-codex-sdk";
import { CodexExecAdapter } from "@codaph/adapter-codex-exec";
import { QueryService } from "@codaph/query-service";
import { MubitMemoryEngine, mubitRunIdForSession } from "@codaph/memory-mubit";
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
    "  --mubit-write-timeout-ms <ms> (default 15000, set 0 to disable timeout)",
    "",
    "OpenAI agent flags:",
    "  --agent / --no-agent",
    "  --openai-api-key <key>     (preferred: set OPENAI_API_KEY env var)",
    "  --openai-model <model>",
  ].join("\n");
}

function resolveMubitApiKey(flags: Flags): string | null {
  const raw =
    getStringFlag(flags, "mubit-api-key") ??
    process.env.MUBIT_API_KEY ??
    process.env.MUBIT_APIKEY ??
    null;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function resolveOpenAiApiKey(flags: Flags): string | null {
  const raw =
    getStringFlag(flags, "openai-api-key") ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENAI_APIKEY ??
    null;
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  return raw.trim();
}

function shouldUseOpenAiAgent(flags: Flags): boolean {
  const hasKey = resolveOpenAiApiKey(flags) !== null;
  return getBooleanFlag(flags, "agent", hasKey);
}

function shouldEnableMubit(flags: Flags): boolean {
  const envHasKey = resolveMubitApiKey(flags) !== null;
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

function createMubitMemory(flags: Flags): MubitMemoryEngine | null {
  const enabled = shouldEnableMubit(flags);
  if (!enabled) {
    return null;
  }

  const apiKey = resolveMubitApiKey(flags);
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
  });
}

async function doctor(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const requested = shouldEnableMubit(flags);
  const envKeyPresent =
    (typeof process.env.MUBIT_API_KEY === "string" && process.env.MUBIT_API_KEY.trim().length > 0) ||
    (typeof process.env.MUBIT_APIKEY === "string" && process.env.MUBIT_APIKEY.trim().length > 0);
  const keyPresent = resolveMubitApiKey(flags) !== null;
  const memory = createMubitMemory(flags);
  const openAiKeyPresent = resolveOpenAiApiKey(flags) !== null;
  const agentEnabled = shouldUseOpenAiAgent(flags);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());

  console.log(`cwd: ${cwd}`);
  console.log(`env MUBIT_API_KEY present: ${envKeyPresent ? "yes" : "no"}`);
  console.log(`flag/env key resolved: ${keyPresent ? "yes" : "no"}`);
  console.log(`MuBit requested: ${requested ? "yes" : "no"}`);
  console.log(`MuBit runtime: ${memory?.isEnabled() ? "enabled" : "disabled"}`);
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

function createPipeline(cwd: string, flags: Flags): { pipeline: IngestPipeline; memory: MubitMemoryEngine | null } {
  const mirrorRoot = resolve(cwd, ".codaph");
  const mirror = new JsonlMirror(mirrorRoot);
  const memory = createMubitMemory(flags);
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
  const { pipeline, memory } = createPipeline(cwd, flags);

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

  const { pipeline, memory } = createPipeline(cwd, syncFlags);
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
  const mubitRequested = shouldEnableMubit(syncFlags);
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
    return stringFromUnknown(event.payload.prompt);
  }

  const item = getItem(event);
  const itemType = getItemType(event);
  if (item && (itemType === "user_message" || itemType === "input")) {
    return (
      stringFromUnknown(item.content) ??
      stringFromUnknown(item.text) ??
      stringFromUnknown(item.input)
    );
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
  if (!shouldUseOpenAiAgent(flags)) {
    return null;
  }

  const apiKey = resolveOpenAiApiKey(flags);
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
  const repoId = repoIdFromPath(cwd);
  const engine = createMubitMemory(flags);
  if (!engine || !engine.isEnabled()) {
    throw new Error("MuBit is disabled. Set MUBIT_API_KEY (or MUBIT_APIKEY) and use --mubit.");
  }

  const limitRaw = getStringFlag(flags, "limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const rawMode = getBooleanFlag(flags, "raw", false);
  const runId = mubitRunIdForSession(repoId, sessionId);
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
    const openAiKey = resolveOpenAiApiKey(flags);
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
  const sessionId = getStringFlag(flags, "session");
  const verbose = getBooleanFlag(flags, "verbose", false);

  const engine = createMubitMemory(flags);
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

async function pause(rl: ReturnType<typeof createInterface>, message = "Press Enter to continue..."): Promise<void> {
  await rl.question(`${message}\n`);
}

function pickByIndex<T>(items: T[], rawIndex: string): T | null {
  const index = Number.parseInt(rawIndex.trim(), 10);
  if (!Number.isFinite(index) || index < 1 || index > items.length) {
    return null;
  }
  return items[index - 1] ?? null;
}

function ansi(code: string, text: string): string {
  if (!output.isTTY) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function truncateForWidth(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 1)}...`;
}

function makeBox(title: string, lines: string[], width: number): string {
  const usable = Math.max(20, width - 2);
  const cleanTitle = truncateForWidth(title, usable - 4);
  const prefix = ` ${cleanTitle} `;
  const top = `┌${prefix}${"─".repeat(Math.max(0, usable - prefix.length))}┐`;
  const bottom = `└${"─".repeat(usable)}┘`;
  const body =
    lines.length === 0
      ? [`│${" ".repeat(usable)}│`]
      : lines.map((line) => {
          const clipped = truncateForWidth(line, usable);
          const padded = `${clipped}${" ".repeat(Math.max(0, usable - clipped.length))}`;
          return `│${padded}│`;
        });
  return [top, ...body, bottom].join("\n");
}

function buildSessionRows(events: CapturedEventEnvelope[], maxRows = 5): {
  prompts: string[];
  thoughts: string[];
  outputs: string[];
  changes: string[];
} {
  const prompts = events
    .map((event) => ({ ts: event.ts, text: getPromptText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-maxRows)
    .map((row) => `${row.ts}  ${toCompactLine(row.text, 140)}`);
  const thoughts = events
    .map((event) => ({ ts: event.ts, text: getThoughtText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-maxRows)
    .map((row) => `${row.ts}  ${toCompactLine(row.text, 140)}`);
  const outputs = events
    .map((event) => ({ ts: event.ts, text: getAssistantText(event) }))
    .filter((row): row is { ts: string; text: string } => !!row.text)
    .slice(-maxRows)
    .map((row) => `${row.ts}  ${toCompactLine(row.text, 140)}`);
  const changes = events
    .flatMap((event) => getFileChangeList(event).map((change) => ({ ts: event.ts, ...change })))
    .slice(-8)
    .map((row) => `${row.ts}  ${row.kind}:${row.path}`);

  return { prompts, thoughts, outputs, changes };
}

function renderDashboard(params: {
  projectPath: string;
  sessions: Array<{ sessionId: string; eventCount: number; from: string; to: string }>;
  selectedSessionId: string | null;
  mubitEnabled: boolean;
  events: CapturedEventEnvelope[];
  diffs: Array<{ path: string; kinds: string[]; occurrences: number }>;
}): string {
  const width = Math.max(88, Math.min(output.columns ?? 120, 148));
  const innerWidth = width - 2;
  const statusLabel = params.mubitEnabled ? "enabled" : "disabled";
  const rows = buildSessionRows(params.events);
  const diffLines =
    params.diffs.length === 0
      ? ["(none)"]
      : params.diffs.slice(0, 8).map((row) => `${row.path} | ${row.kinds.join(",")} | x${row.occurrences}`);

  const blocks = [
    ansi(
      "36",
      makeBox(
        "Codaph",
        [
          `Project: ${params.projectPath}`,
          `Sessions: ${params.sessions.length}`,
          `Active Session: ${params.selectedSessionId ?? "(none)"}`,
          `MuBit: ${statusLabel}`,
        ],
        innerWidth,
      ),
    ),
    makeBox("Prompts", rows.prompts.length > 0 ? rows.prompts : ["(none)"], innerWidth),
    makeBox("Thoughts", rows.thoughts.length > 0 ? rows.thoughts : ["(none)"], innerWidth),
    makeBox("Assistant Output", rows.outputs.length > 0 ? rows.outputs : ["(none)"], innerWidth),
    makeBox("File Changes", rows.changes.length > 0 ? rows.changes : ["(none)"], innerWidth),
    makeBox("Diff Summary", diffLines, innerWidth),
    ansi(
      "35",
      makeBox(
        "Actions",
        [
          "1) Sync Codex history (mirror + MuBit)",
          "2) Switch session",
          "3) Switch project",
          "4) Add project",
          "5) MuBit query via OpenAI agent",
          "q) Quit",
        ],
        innerWidth,
      ),
    ),
  ];

  return blocks.join("\n\n");
}

async function tui(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwdFlag = getStringFlag(flags, "cwd");
  if (cwdFlag) {
    await addProjectToRegistry(cwdFlag);
  }

  let registry = await loadRegistry();
  if (registry.projects.length === 0) {
    registry = await addProjectToRegistry(process.cwd());
  }

  let selectedProject = registry.lastProjectPath ?? registry.projects[0];
  let selectedSessionId: string | null = null;
  const memory = createMubitMemory(flags);
  const rl = createInterface({ input, output });

  try {
    while (true) {
      const repoId = repoIdFromPath(selectedProject);
      const query = new QueryService(resolve(selectedProject, ".codaph"));
      const sessions = await query.listSessions(repoId);
      if (!selectedSessionId || !sessions.some((session) => session.sessionId === selectedSessionId)) {
        selectedSessionId = sessions[0]?.sessionId ?? null;
      }

      let events: CapturedEventEnvelope[] = [];
      let diffs: Array<{ path: string; kinds: string[]; occurrences: number }> = [];
      if (selectedSessionId) {
        events = await query.getTimeline({ repoId, sessionId: selectedSessionId });
        diffs = await query.getDiffSummary(repoId, selectedSessionId);
      }

      console.clear();
      console.log(
        renderDashboard({
          projectPath: selectedProject,
          sessions,
          selectedSessionId,
          mubitEnabled: memory?.isEnabled() ?? false,
          events,
          diffs,
        }),
      );

      const action = (await rl.question("\ncodaph> ")).trim().toLowerCase();
      if (action === "q" || action === "quit" || action === "exit") {
        return;
      }

      if (action === "1" || action === "s" || action === "sync") {
        const syncFlags: Flags = { ...flags };
        const { pipeline, memory: syncMemory } = createPipeline(selectedProject, syncFlags);
        const mubitMode = syncMemory?.isEnabled() ? "MuBit enabled" : "MuBit disabled";
        console.log(`\nSyncing Codex history (${mubitMode})...`);
        const reporter = createSyncProgressReporter("Syncing");
        try {
          const summary = await syncCodexHistory({
            projectPath: selectedProject,
            pipeline,
            onProgress: reporter.onProgress,
          }).finally(() => reporter.finish());
          console.log(`\n${formatSummary(summary)}`);
          if (syncMemory?.isEnabled()) {
            console.log("MuBit ingest during sync: enabled");
          } else {
            console.log("MuBit ingest during sync: disabled");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\nHistory sync failed: ${message}`);
        }
        await pause(rl);
        continue;
      }

      if (action === "2" || action === "session") {
        if (sessions.length === 0) {
          console.log("\nNo sessions available.");
          await pause(rl);
          continue;
        }
        console.log("");
        sessions.forEach((session, index) => {
          console.log(`${index + 1}) ${session.sessionId} | events=${session.eventCount} | ${session.to}`);
        });
        const rawIndex = await rl.question("Choose session #: ");
        const picked = pickByIndex(sessions, rawIndex);
        if (picked) {
          selectedSessionId = picked.sessionId;
        }
        continue;
      }

      if (action === "3" || action === "project") {
        registry = await loadRegistry();
        if (registry.projects.length === 0) {
          console.log("\nNo projects saved.");
          await pause(rl);
          continue;
        }
        console.log("");
        registry.projects.forEach((project, index) => {
          const marker = project === selectedProject ? "*" : " ";
          console.log(`${index + 1})${marker} ${project}`);
        });
        const rawIndex = await rl.question("Choose project #: ");
        const picked = pickByIndex(registry.projects, rawIndex);
        if (picked) {
          selectedProject = picked;
          selectedSessionId = null;
          await setLastProject(picked);
        }
        continue;
      }

      if (action === "4" || action === "add") {
        const rawPath = await rl.question("Project path: ");
        const trimmed = rawPath.trim();
        if (!trimmed) {
          continue;
        }
        const normalized = resolve(trimmed);
        await addProjectToRegistry(normalized);
        selectedProject = normalized;
        selectedSessionId = null;
        continue;
      }

      if (action === "5" || action === "mubit") {
        if (!memory || !memory.isEnabled()) {
          console.log("\nMuBit disabled. Set MUBIT_API_KEY and restart with --mubit.");
          await pause(rl);
          continue;
        }
        if (!selectedSessionId) {
          console.log("\nSelect a session first.");
          await pause(rl);
          continue;
        }
        const question = (await rl.question("MuBit query: ")).trim();
        if (!question) {
          continue;
        }
        try {
          const runId = mubitRunIdForSession(repoId, selectedSessionId);
          console.log(`\nQuerying MuBit run scope: ${runId}`);
          const response = await withTimeout(
            memory.querySemanticContext({
              runId,
              query: buildMubitQueryPrompt(question),
              limit: 8,
              mode: "direct_bypass",
              directLane: "semantic_search",
            }),
            45000,
            "MuBit query",
          );
          console.log("");
          const openAiKey = resolveOpenAiApiKey(flags);
          const agentRequested = getBooleanFlag(flags, "agent", openAiKey !== null);
          if (agentRequested && !openAiKey) {
            console.log("OpenAI agent requested but OPENAI_API_KEY is missing. Falling back to MuBit response.");
          }
          const agentResult = await runOpenAiAgentFromMubit(question, response, runId, flags);
          if (agentResult) {
            console.log(`OpenAI agent (${agentResult.model}) answer:`);
            console.log(agentResult.text);
          } else {
            printMubitResponse(response, selectedProject, selectedSessionId, false);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`\nMuBit query failed: ${message}`);
        }
        await pause(rl);
        continue;
      }
    }
  } finally {
    rl.close();
  }
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
