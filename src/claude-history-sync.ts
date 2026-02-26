import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { repoIdFromPath } from "./lib/core-types";
import { IngestPipeline } from "./lib/ingest-pipeline";

type PatchChangeKind = "add" | "delete" | "update";

interface ClaudeHistoryFileCursor {
  lineCount: number;
  sequence: number;
  sessionId: string | null;
  cwd: string | null;
  updatedAt: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

interface ClaudeHistorySyncState {
  files: Record<string, ClaudeHistoryFileCursor>;
}

export interface ClaudeHistorySyncSummary {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  importedSessions: number;
}

export interface ClaudeHistorySyncProgress {
  scannedFiles: number;
  processedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  currentFile: string;
  currentLine: number;
  currentSessionId: string | null;
}

export interface SyncClaudeHistoryOptions {
  projectPath: string;
  pipeline: IngestPipeline;
  repoId?: string;
  actorId?: string | null;
  claudeProjectsRoot?: string;
  mirrorRoot?: string;
  onProgress?: (progress: ClaudeHistorySyncProgress) => void;
}

interface ProjectedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  ts?: string;
}

interface ClaudeHistoryLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  agentId?: string;
  message?: Record<string, unknown>;
  toolUseResult?: Record<string, unknown>;
}

function getClaudeProjectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

function normalizeProjectPath(projectPath: string): string {
  return resolve(projectPath);
}

function projectOwnsPath(projectPath: string, candidatePath: string): boolean {
  const normalizedProject = normalizeProjectPath(projectPath);
  const normalizedCandidate = normalizeProjectPath(candidatePath);
  if (normalizedCandidate === normalizedProject) {
    return true;
  }
  return normalizedCandidate.startsWith(`${normalizedProject}${sep}`);
}

function getStatePath(projectPath: string, mirrorRoot: string): string {
  const repoId = repoIdFromPath(projectPath);
  return join(mirrorRoot, "index", repoId, "claude-history-sync.json");
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeIsoTs(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractText(entry))
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (isRecord(value)) {
    for (const key of [
      "text",
      "content",
      "message",
      "input_text",
      "output_text",
      "stdout",
      "stderr",
      "value",
    ]) {
      const found = extractText(value[key]);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function parsePatchChanges(rawText: string): Array<{ path: string; kind: PatchChangeKind }> {
  const changes: Array<{ path: string; kind: PatchChangeKind }> = [];
  const addRegex = /^\*\*\* Add File: (.+)$/gm;
  const deleteRegex = /^\*\*\* Delete File: (.+)$/gm;
  const updateRegex = /^\*\*\* Update File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = addRegex.exec(rawText)) !== null) {
    changes.push({ path: match[1].trim(), kind: "add" });
  }
  while ((match = deleteRegex.exec(rawText)) !== null) {
    changes.push({ path: match[1].trim(), kind: "delete" });
  }
  while ((match = updateRegex.exec(rawText)) !== null) {
    changes.push({ path: match[1].trim(), kind: "update" });
  }
  const unique = new Map<string, { path: string; kind: PatchChangeKind }>();
  for (const change of changes) {
    unique.set(`${change.kind}:${change.path}`, change);
  }
  return [...unique.values()];
}

function dedupePatchChanges(
  changes: Array<{ path: string; kind: PatchChangeKind }>,
): Array<{ path: string; kind: PatchChangeKind }> {
  const unique = new Map<string, { path: string; kind: PatchChangeKind }>();
  for (const change of changes) {
    if (!change.path) {
      continue;
    }
    unique.set(`${change.kind}:${change.path}`, change);
  }
  return [...unique.values()];
}

function inferClaudeToolUseResultChangeKind(result: Record<string, unknown>): PatchChangeKind | null {
  const type = (asString(result.type) ?? "").toLowerCase();
  if (type === "create") {
    return "add";
  }
  if (type === "delete" || type === "remove") {
    return "delete";
  }
  if (type === "edit" || type === "update" || type === "modify" || type === "rename" || type === "move") {
    return "update";
  }
  if (Array.isArray(result.structuredPatch)) {
    return "update";
  }
  if (typeof result.oldString === "string" || typeof result.newString === "string") {
    return "update";
  }
  if (isRecord(result.fileDiff)) {
    const fileDiff = result.fileDiff;
    const hasOriginal = typeof fileDiff.originalContent === "string";
    const hasNew = typeof fileDiff.newContent === "string";
    const originalContent = hasOriginal ? (fileDiff.originalContent as string) : null;
    const newContent = hasNew ? (fileDiff.newContent as string) : null;
    if (hasOriginal && hasNew) {
      if ((originalContent?.length ?? 0) === 0 && (newContent?.length ?? 0) > 0) {
        return "add";
      }
      if ((originalContent?.length ?? 0) > 0 && (newContent?.length ?? 0) === 0) {
        return "delete";
      }
      return "update";
    }
  }
  return null;
}

function extractClaudeToolUseResultFileChanges(
  toolUseResult: Record<string, unknown> | undefined,
): Array<{ path: string; kind: PatchChangeKind }> {
  if (!toolUseResult) {
    return [];
  }
  const fileDiff = isRecord(toolUseResult.fileDiff) ? toolUseResult.fileDiff : null;
  const path =
    (fileDiff ? asString(fileDiff.filePath) : null) ??
    asString(toolUseResult.filePath) ??
    (isRecord(toolUseResult.file) ? asString(toolUseResult.file.filePath) ?? asString(toolUseResult.file.path) : null);
  if (!path) {
    return [];
  }
  const kind = inferClaudeToolUseResultChangeKind(toolUseResult);
  if (!kind) {
    return [];
  }
  return dedupePatchChanges([{ path, kind }]);
}

function extractClaudeAssistantTextAndReasoning(message: Record<string, unknown> | undefined): {
  text: string | null;
  reasoning: string | null;
} {
  if (!message) {
    return { text: null, reasoning: null };
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return { text: extractText(content ?? message), reasoning: null };
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      const scalar = extractText(part);
      if (scalar) {
        textParts.push(scalar);
      }
      continue;
    }
    const partType = asString(part.type);
    if (partType === "text") {
      const text = extractText(part.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    if (partType === "thinking" || partType === "reasoning") {
      const reasoning = extractText(part.text ?? part.content ?? part.summary);
      if (reasoning) {
        reasoningParts.push(reasoning);
      }
      continue;
    }
    if (partType === "tool_use") {
      const name = asString(part.name);
      const argsText = extractText(part.input) ?? (isRecord(part.input) ? JSON.stringify(part.input) : null);
      const line = [name ? `tool:${name}` : "tool", argsText].filter(Boolean).join("\n");
      if (line) {
        textParts.push(line);
      }
      continue;
    }
    if (partType === "tool_result") {
      const out = extractText(part.content ?? part.output);
      if (out) {
        textParts.push(out);
      }
      continue;
    }
    const fallback = extractText(part);
    if (fallback) {
      textParts.push(fallback);
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join("\n") : null,
    reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n") : null,
  };
}

function isClaudeSyntheticUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  // Claude emits synthetic protocol messages into transcripts that are not user prompts.
  if (/^\[Request interrupted by user\]$/i.test(trimmed)) {
    return true;
  }
  return false;
}

function formatClaudeUserToolProtocolPart(part: Record<string, unknown>): string | null {
  const partType = asString(part.type);
  if (partType === "tool_result") {
    const body = extractText(part.content ?? part.output);
    if (!body) {
      return null;
    }
    const toolUseId = asString(part.tool_use_id);
    const isError = typeof part.is_error === "boolean" ? part.is_error : false;
    const headerParts = ["[tool_result]"];
    if (toolUseId) {
      headerParts.push(toolUseId);
    }
    if (isError) {
      headerParts.push("(error)");
    }
    return `${headerParts.join(" ")}\n${body}`.trim();
  }

  if (partType === "tool_use") {
    const name = asString(part.name);
    const argsText = extractText(part.input) ?? (isRecord(part.input) ? JSON.stringify(part.input) : null);
    const line = ["[tool_use]", name, argsText].filter(Boolean).join("\n");
    return line.trim().length > 0 ? line : null;
  }

  return null;
}

function extractClaudeUserPromptAndToolThoughts(message: Record<string, unknown> | undefined): {
  prompt: string | null;
  toolThoughts: string[];
} {
  if (!message) {
    return { prompt: null, toolThoughts: [] };
  }

  const content = message.content;
  if (!Array.isArray(content)) {
    const fallback = extractText(content ?? message);
    if (!fallback || isClaudeSyntheticUserPrompt(fallback)) {
      return { prompt: null, toolThoughts: [] };
    }
    return { prompt: fallback, toolThoughts: [] };
  }

  const textParts: string[] = [];
  const toolThoughts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      const text = extractText(part);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    const partType = asString(part.type);
    // Anthropic/Claude tool results are represented as `user` messages in the transcript protocol.
    // They should not become prompt.submitted events in Codaph. We surface them as thought-like items instead.
    if (partType === "tool_result" || partType === "tool_use") {
      const toolText = formatClaudeUserToolProtocolPart(part);
      if (toolText) {
        toolThoughts.push(toolText);
      }
      continue;
    }
    if (partType === "text") {
      const text = extractText(part.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }
    const fallback = extractText(part);
    if (fallback) {
      textParts.push(fallback);
    }
  }

  const prompt = textParts.join("\n").trim();
  if (!prompt || isClaudeSyntheticUserPrompt(prompt)) {
    return { prompt: null, toolThoughts };
  }
  return { prompt, toolThoughts };
}

function parseClaudeHistoryLine(rawLine: string): ClaudeHistoryLine | null {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      type: asString(parsed.type) ?? undefined,
      timestamp: asString(parsed.timestamp) ?? undefined,
      sessionId: asString(parsed.sessionId) ?? undefined,
      cwd: asString(parsed.cwd) ?? undefined,
      agentId: asString(parsed.agentId) ?? undefined,
      message: isRecord(parsed.message) ? parsed.message : undefined,
      toolUseResult: isRecord(parsed.toolUseResult) ? parsed.toolUseResult : undefined,
    };
  } catch {
    return null;
  }
}

function projectClaudeLine(line: ClaudeHistoryLine): ProjectedEvent[] {
  const projected: ProjectedEvent[] = [];
  const lineType = line.type ?? "unknown";
  const ts = normalizeIsoTs(line.timestamp);

  if (lineType === "user") {
    const { prompt, toolThoughts } = extractClaudeUserPromptAndToolThoughts(line.message);
    if (prompt) {
      projected.push({
        eventType: "prompt.submitted",
        payload: { prompt, source: "claude_code_history" },
        ts,
      });
    }
    for (const toolText of toolThoughts) {
      projected.push({
        eventType: "item.completed",
        payload: { item: { type: "reasoning", subtype: "tool_protocol", text: toolText } },
        ts,
      });
    }
    const fileChanges = extractClaudeToolUseResultFileChanges(line.toolUseResult);
    if (fileChanges.length > 0) {
      projected.push({
        eventType: "item.completed",
        payload: { item: { type: "file_change", changes: fileChanges } },
        ts,
      });
    }
    return projected;
  }

  if (lineType === "assistant") {
    const { text, reasoning } = extractClaudeAssistantTextAndReasoning(line.message);
    if (reasoning) {
      projected.push({
        eventType: "item.completed",
        payload: { item: { type: "reasoning", text: reasoning } },
        ts,
      });
    }
    if (text) {
      projected.push({
        eventType: "item.completed",
        payload: { item: { type: "agent_message", text } },
        ts,
      });
      const patchChanges = parsePatchChanges(text);
      if (patchChanges.length > 0) {
        projected.push({
          eventType: "item.completed",
          payload: { item: { type: "file_change", changes: patchChanges } },
          ts,
        });
      }
    }
    return projected;
  }

  return projected;
}

async function listClaudeHistoryFiles(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(abs);
      }
    }
  }
  return output.sort((a, b) => a.localeCompare(b));
}

async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function syncClaudeHistory(options: SyncClaudeHistoryOptions): Promise<ClaudeHistorySyncSummary> {
  const normalizedProject = normalizeProjectPath(options.projectPath);
  const repoId = options.repoId ?? repoIdFromPath(normalizedProject);
  const mirrorRoot = resolve(options.mirrorRoot ?? join(normalizedProject, ".codaph"));
  const actorId = options.actorId ?? null;
  const projectsRoot = resolve(options.claudeProjectsRoot ?? getClaudeProjectsRoot());

  const statePath = getStatePath(normalizedProject, mirrorRoot);
  const state = await readJsonOrDefault<ClaudeHistorySyncState>(statePath, { files: {} });
  const files = await listClaudeHistoryFiles(projectsRoot);
  const importedSessions = new Set<string>();
  const summary: ClaudeHistorySyncSummary = {
    scannedFiles: files.length,
    matchedFiles: 0,
    importedEvents: 0,
    importedSessions: 0,
  };

  let processedFiles = 0;
  let lastProgressEmit = 0;
  const emitProgress = (
    progress: Omit<ClaudeHistorySyncProgress, "scannedFiles" | "processedFiles" | "matchedFiles" | "importedEvents">,
  ): void => {
    if (!options.onProgress) {
      return;
    }
    const now = Date.now();
    if (now - lastProgressEmit < 120) {
      return;
    }
    lastProgressEmit = now;
    options.onProgress({
      scannedFiles: summary.scannedFiles,
      processedFiles,
      matchedFiles: summary.matchedFiles,
      importedEvents: summary.importedEvents,
      ...progress,
    });
  };

  for (const filePath of files) {
    processedFiles += 1;
    let fileInfo: Awaited<ReturnType<typeof stat>>;
    try {
      fileInfo = await stat(filePath);
    } catch {
      continue;
    }

    const existing = state.files[filePath];
    if (
      existing &&
      typeof existing.sizeBytes === "number" &&
      typeof existing.mtimeMs === "number" &&
      existing.sizeBytes === fileInfo.size &&
      existing.mtimeMs === fileInfo.mtimeMs
    ) {
      emitProgress({
        currentFile: filePath,
        currentLine: existing.lineCount,
        currentSessionId: existing.sessionId,
      });
      continue;
    }

    let raw = "";
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    let cursor = existing ?? {
      lineCount: 0,
      sequence: 0,
      sessionId: null,
      cwd: null,
      updatedAt: new Date(0).toISOString(),
    };
    if (lines.length < cursor.lineCount) {
      cursor = {
        lineCount: 0,
        sequence: 0,
        sessionId: null,
        cwd: null,
        updatedAt: new Date().toISOString(),
      };
    }

    let sessionId = cursor.sessionId;
    let sessionCwd = cursor.cwd;
    if (!sessionId || !sessionCwd) {
      for (const rawLine of lines) {
        const parsed = parseClaudeHistoryLine(rawLine);
        if (!parsed) {
          continue;
        }
        sessionId = sessionId ?? parsed.sessionId ?? null;
        sessionCwd = sessionCwd ?? parsed.cwd ?? null;
        if (sessionId && sessionCwd) {
          break;
        }
      }
    }

    if (!sessionId || !sessionCwd) {
      state.files[filePath] = {
        ...cursor,
        sessionId: sessionId ?? null,
        cwd: sessionCwd ?? null,
        lineCount: lines.length,
        updatedAt: new Date().toISOString(),
        sizeBytes: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
      };
      emitProgress({ currentFile: filePath, currentLine: lines.length, currentSessionId: sessionId ?? null });
      continue;
    }

    const normalizedSessionCwd = normalizeProjectPath(sessionCwd);
    if (!projectOwnsPath(normalizedProject, normalizedSessionCwd)) {
      state.files[filePath] = {
        ...cursor,
        sessionId,
        cwd: normalizedSessionCwd,
        lineCount: lines.length,
        updatedAt: new Date().toISOString(),
        sizeBytes: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
      };
      emitProgress({ currentFile: filePath, currentLine: lines.length, currentSessionId: sessionId });
      continue;
    }

    summary.matchedFiles += 1;

    let sequence = cursor.sequence;
    let importedForFile = 0;
    let threadStartedEmitted = sequence > 0;
    for (let i = cursor.lineCount; i < lines.length; i += 1) {
      const rawLine = lines[i]?.trim();
      if (!rawLine) {
        continue;
      }
      const parsed = parseClaudeHistoryLine(rawLine);
      if (parsed?.sessionId) {
        sessionId = parsed.sessionId;
      }
      if (parsed?.cwd) {
        sessionCwd = parsed.cwd;
      }

      await options.pipeline.ingestRawLine(sessionId ?? "claude-unknown", rawLine);

      if (!parsed) {
        continue;
      }
      if (!threadStartedEmitted && sessionId) {
        sequence += 1;
        await options.pipeline.ingest(
          "thread.started",
          {
            thread_id: sessionId,
            cwd: sessionCwd ?? normalizedSessionCwd,
            source: "claude_code_history",
            agentId: parsed.agentId ?? null,
          },
          {
            source: "claude_code_history",
            repoId,
            actorId,
            sessionId,
            threadId: sessionId,
            sequence,
            ts: normalizeIsoTs(parsed.timestamp),
          },
        );
        importedForFile += 1;
        summary.importedEvents += 1;
        threadStartedEmitted = true;
      }

      const projected = projectClaudeLine(parsed);
      for (const event of projected) {
        if (!sessionId) {
          continue;
        }
        sequence += 1;
        await options.pipeline.ingest(event.eventType, event.payload, {
          source: "claude_code_history",
          repoId,
          actorId,
          sessionId,
          threadId: sessionId,
          sequence,
          ts: event.ts ?? normalizeIsoTs(parsed.timestamp),
        });
        importedForFile += 1;
        summary.importedEvents += 1;
      }

      if (importedForFile > 0 && importedForFile % 50 === 0) {
        emitProgress({ currentFile: filePath, currentLine: i + 1, currentSessionId: sessionId });
      }
    }

    if (importedForFile > 0 && sessionId) {
      importedSessions.add(sessionId);
    }

    state.files[filePath] = {
      lineCount: lines.length,
      sequence,
      sessionId,
      cwd: normalizedSessionCwd,
      updatedAt: new Date().toISOString(),
      sizeBytes: fileInfo.size,
      mtimeMs: fileInfo.mtimeMs,
    };
    await options.pipeline.flush();
    emitProgress({ currentFile: filePath, currentLine: lines.length, currentSessionId: sessionId });
  }

  summary.importedSessions = importedSessions.size;
  await writeJson(statePath, state);
  return summary;
}
