import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { repoIdFromPath } from "@codaph/core-types";
import { IngestPipeline } from "@codaph/ingest-pipeline";

type PatchChangeKind = "add" | "delete" | "update";

interface CodexHistoryLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ProjectedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  ts?: string;
}

interface CodexHistoryFileCursor {
  lineCount: number;
  sequence: number;
  sessionId: string | null;
  cwd: string | null;
  updatedAt: string;
}

interface CodexHistorySyncState {
  files: Record<string, CodexHistoryFileCursor>;
}

export interface CodexHistorySyncSummary {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  importedSessions: number;
}

export interface CodexHistorySyncProgress {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  currentFile: string;
  currentLine: number;
  currentSessionId: string | null;
}

export interface SyncCodexHistoryOptions {
  projectPath: string;
  pipeline: IngestPipeline;
  repoId?: string;
  actorId?: string | null;
  codexSessionsRoot?: string;
  mirrorRoot?: string;
  onProgress?: (progress: CodexHistorySyncProgress) => void;
}

function getCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
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

function getHistorySyncStatePath(projectPath: string, mirrorRoot: string): string {
  const repoId = repoIdFromPath(projectPath);
  return join(mirrorRoot, "index", repoId, "codex-history-sync.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIsoTs(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }

  return parsed.toISOString();
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
    if (parts.length === 0) {
      return null;
    }

    return parts.join("\n");
  }

  if (isRecord(value)) {
    const candidateKeys = [
      "text",
      "message",
      "input_text",
      "output_text",
      "content",
      "value",
      "prompt",
      "summary_text",
    ];

    for (const key of candidateKeys) {
      const extracted = extractText(value[key]);
      if (extracted) {
        return extracted;
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

function parseChangedFilesFromToolOutput(rawOutput: string): Array<{ path: string; kind: PatchChangeKind }> {
  const changes: Array<{ path: string; kind: PatchChangeKind }> = [];
  const lines = rawOutput.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 3) {
      continue;
    }

    const marker = trimmed[0];
    if (!["M", "A", "D"].includes(marker) || trimmed[1] !== " ") {
      continue;
    }

    const rawPath = trimmed.slice(2).trim();
    if (!rawPath) {
      continue;
    }

    changes.push({
      path: rawPath,
      kind: marker === "A" ? "add" : marker === "D" ? "delete" : "update",
    });
  }

  const unique = new Map<string, { path: string; kind: PatchChangeKind }>();
  for (const change of changes) {
    unique.set(`${change.kind}:${change.path}`, change);
  }

  return [...unique.values()];
}

function extractPatchSource(toolName: string | null, argsRaw: unknown): string | null {
  if (!toolName) {
    return null;
  }

  if (toolName === "apply_patch") {
    return extractText(argsRaw) ?? (typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw));
  }

  if (toolName !== "exec_command") {
    return null;
  }

  if (isRecord(argsRaw) && typeof argsRaw.cmd === "string") {
    return argsRaw.cmd;
  }

  if (typeof argsRaw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (isRecord(parsed) && typeof parsed.cmd === "string") {
      return parsed.cmd;
    }
  } catch {
    // not json arguments; keep raw string
  }

  return argsRaw;
}

function parseHistoryLine(rawLine: string): CodexHistoryLine | null {
  try {
    const parsed = JSON.parse(rawLine) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      timestamp: asString(parsed.timestamp) ?? undefined,
      type: asString(parsed.type) ?? undefined,
      payload: isRecord(parsed.payload) ? parsed.payload : undefined,
    };
  } catch {
    return null;
  }
}

function projectHistoryLine(line: CodexHistoryLine): ProjectedEvent[] {
  const projected: ProjectedEvent[] = [];
  const lineType = line.type ?? "unknown";
  const payload = line.payload ?? {};

  if (lineType === "session_meta") {
    const sessionId = asString(payload.id);
    const cwd = asString(payload.cwd);
    projected.push({
      eventType: "thread.started",
      payload: {
        thread_id: sessionId,
        cwd,
        source: payload.source ?? null,
        originator: payload.originator ?? null,
      },
      ts: normalizeIsoTs(line.timestamp),
    });
    return projected;
  }

  if (lineType === "turn_context") {
    projected.push({
      eventType: "turn.started",
      payload: {
        turnId: asString(payload.turn_id),
        cwd: payload.cwd ?? null,
        model: payload.model ?? null,
      },
      ts: normalizeIsoTs(line.timestamp),
    });
    return projected;
  }

  if (lineType === "event_msg") {
    const eventKind = asString(payload.type);

    if (eventKind === "user_message") {
      const prompt = extractText(payload.message) ?? extractText(payload.text);
      if (prompt) {
        projected.push({
          eventType: "prompt.submitted",
          payload: {
            prompt,
            source: "codex_history",
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
      return projected;
    }

    if (eventKind === "agent_reasoning") {
      const reasoning = extractText(payload.text) ?? extractText(payload.message);
      if (reasoning) {
        projected.push({
          eventType: "item.completed",
          payload: {
            item: {
              type: "reasoning",
              text: reasoning,
            },
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
      return projected;
    }

    if (eventKind === "agent_message") {
      const message = extractText(payload.message) ?? extractText(payload.text);
      if (message) {
        projected.push({
          eventType: "item.completed",
          payload: {
            item: {
              type: "agent_message",
              text: message,
            },
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
      return projected;
    }

    if (eventKind === "task_complete") {
      projected.push({
        eventType: "turn.completed",
        payload: {
          turnId: asString(payload.turn_id),
        },
        ts: normalizeIsoTs(line.timestamp),
      });
      return projected;
    }

    return projected;
  }

  if (lineType !== "response_item") {
    return projected;
  }

  const responseType = asString(payload.type);

  if (responseType === "reasoning") {
    const summary = extractText(payload.summary);
    const content = extractText(payload.content);
    const reasoning = content ?? summary;
    if (reasoning) {
      projected.push({
        eventType: "item.completed",
        payload: {
          item: {
            type: "reasoning",
            text: reasoning,
          },
        },
        ts: normalizeIsoTs(line.timestamp),
      });
    }
    return projected;
  }

  if (responseType === "function_call") {
    const toolName = asString(payload.name);
    projected.push({
      eventType: "item.completed",
      payload: {
        item: {
          type: "tool_call",
          name: toolName,
          arguments: payload.arguments ?? null,
        },
      },
      ts: normalizeIsoTs(line.timestamp),
    });

    const patchSource = extractPatchSource(toolName, payload.arguments);
    if (patchSource && patchSource.includes("*** Begin Patch")) {
      const changes = parsePatchChanges(patchSource);
      if (changes.length > 0) {
        projected.push({
          eventType: "item.completed",
          payload: {
            item: {
              type: "file_change",
              changes,
            },
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
    }

    return projected;
  }

  if (responseType === "function_call_output") {
    const outputText = extractText(payload.output);
    projected.push({
      eventType: "item.completed",
      payload: {
        item: {
          type: "tool_result",
          call_id: payload.call_id ?? null,
          output: outputText ?? payload.output ?? null,
        },
      },
      ts: normalizeIsoTs(line.timestamp),
    });

    if (outputText) {
      const outputChanges = parseChangedFilesFromToolOutput(outputText);
      if (outputChanges.length > 0) {
        projected.push({
          eventType: "item.completed",
          payload: {
            item: {
              type: "file_change",
              changes: outputChanges,
            },
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
    }

    return projected;
  }

  if (responseType === "message") {
    const role = asString(payload.role);
    const phase = asString(payload.phase);

    if (role === "assistant" && phase === "final_answer") {
      const message = extractText(payload.content);
      if (message) {
        projected.push({
          eventType: "item.completed",
          payload: {
            item: {
              type: "agent_message",
              text: message,
            },
          },
          ts: normalizeIsoTs(line.timestamp),
        });
      }
    }

    return projected;
  }

  return projected;
}

function findSessionMeta(lines: string[]): { sessionId: string | null; cwd: string | null } {
  for (const rawLine of lines) {
    const parsed = parseHistoryLine(rawLine);
    if (!parsed || parsed.type !== "session_meta" || !parsed.payload) {
      continue;
    }

    return {
      sessionId: asString(parsed.payload.id),
      cwd: asString(parsed.payload.cwd),
    };
  }

  return {
    sessionId: null,
    cwd: null,
  };
}

async function listCodexSessionFiles(rootDir: string): Promise<string[]> {
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

export async function syncCodexHistory(options: SyncCodexHistoryOptions): Promise<CodexHistorySyncSummary> {
  const normalizedProject = normalizeProjectPath(options.projectPath);
  const repoId = options.repoId ?? repoIdFromPath(normalizedProject);
  const mirrorRoot = resolve(options.mirrorRoot ?? join(normalizedProject, ".codaph"));
  const actorId = options.actorId ?? null;
  const sessionsRoot = resolve(options.codexSessionsRoot ?? getCodexSessionsRoot());

  const statePath = getHistorySyncStatePath(normalizedProject, mirrorRoot);
  const state = await readJsonOrDefault<CodexHistorySyncState>(statePath, { files: {} });

  const files = await listCodexSessionFiles(sessionsRoot);
  const importedSessions = new Set<string>();

  const summary: CodexHistorySyncSummary = {
    scannedFiles: files.length,
    matchedFiles: 0,
    importedEvents: 0,
    importedSessions: 0,
  };
  let lastProgressEmit = 0;

  const emitProgress = (progress: Omit<CodexHistorySyncProgress, "scannedFiles" | "matchedFiles" | "importedEvents">): void => {
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
      matchedFiles: summary.matchedFiles,
      importedEvents: summary.importedEvents,
      ...progress,
    });
  };

  for (const filePath of files) {
    const existing = state.files[filePath];
    if (existing?.cwd && !projectOwnsPath(normalizedProject, existing.cwd)) {
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
      const meta = findSessionMeta(lines);
      sessionId = meta.sessionId;
      sessionCwd = meta.cwd;
    }

    if (!sessionId || !sessionCwd) {
      state.files[filePath] = {
        ...cursor,
        sessionId: sessionId ?? null,
        cwd: sessionCwd ?? null,
        updatedAt: new Date().toISOString(),
      };
      emitProgress({
        currentFile: filePath,
        currentLine: lines.length,
        currentSessionId: sessionId,
      });
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
      };
      emitProgress({
        currentFile: filePath,
        currentLine: lines.length,
        currentSessionId: sessionId,
      });
      continue;
    }

    summary.matchedFiles += 1;

    // Recovery for older cursors advanced before import conditions were correct.
    if (cursor.sequence === 0 && cursor.lineCount > 0) {
      cursor = {
        ...cursor,
        lineCount: 0,
      };
    }

    let sequence = cursor.sequence;
    let importedForFile = 0;

    for (let i = cursor.lineCount; i < lines.length; i += 1) {
      const rawLine = lines[i].trim();
      if (!rawLine) {
        continue;
      }

      await options.pipeline.ingestRawLine(sessionId, rawLine);

      const parsed = parseHistoryLine(rawLine);
      if (!parsed) {
        continue;
      }

      const projected = projectHistoryLine(parsed);
      if (projected.length === 0) {
        continue;
      }

      const lineTs = normalizeIsoTs(parsed.timestamp);
      for (const event of projected) {
        sequence += 1;
        await options.pipeline.ingest(event.eventType, event.payload, {
          source: "codex_exec",
          repoId,
          actorId,
          sessionId,
          threadId: sessionId,
          sequence,
          ts: event.ts ?? lineTs,
        });
        importedForFile += 1;
        if (importedForFile % 50 === 0) {
          emitProgress({
            currentFile: filePath,
            currentLine: i + 1,
            currentSessionId: sessionId,
          });
        }
      }
    }

    if (importedForFile > 0) {
      importedSessions.add(sessionId);
      summary.importedEvents += importedForFile;
    }

    state.files[filePath] = {
      lineCount: lines.length,
      sequence,
      sessionId,
      cwd: normalizedSessionCwd,
      updatedAt: new Date().toISOString(),
    };

    emitProgress({
      currentFile: filePath,
      currentLine: lines.length,
      currentSessionId: sessionId,
    });
  }

  summary.importedSessions = importedSessions.size;
  await writeJson(statePath, state);

  return summary;
}
