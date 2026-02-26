import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { repoIdFromPath } from "./lib/core-types";
import { IngestPipeline } from "./lib/ingest-pipeline";

interface GeminiHistoryFileCursor {
  entryCount: number;
  sequence: number;
  sessionId: string | null;
  cwd: string | null;
  updatedAt: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

interface GeminiHistorySyncState {
  files: Record<string, GeminiHistoryFileCursor>;
}

export interface GeminiHistorySyncSummary {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  importedSessions: number;
}

export interface GeminiHistorySyncProgress {
  scannedFiles: number;
  processedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  currentFile: string;
  currentLine: number;
  currentSessionId: string | null;
}

export interface SyncGeminiHistoryOptions {
  projectPath: string;
  pipeline: IngestPipeline;
  repoId?: string;
  actorId?: string | null;
  geminiHistoryRoot?: string;
  mirrorRoot?: string;
  onProgress?: (progress: GeminiHistorySyncProgress) => void;
}

interface ProjectedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  ts?: string;
}

interface GeminiEntry {
  role: string | null;
  text: string | null;
  ts?: string;
  sessionId?: string | null;
  cwd?: string | null;
}

function getGeminiHistoryRoot(): string {
  return join(homedir(), ".gemini", "history");
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
  return join(mirrorRoot, "index", repoId, "gemini-history-sync.json");
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
      "value",
      "input",
      "output",
      "prompt",
      "response",
      "parts",
      "data",
    ]) {
      const found = extractText(value[key]);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function extractRole(record: Record<string, unknown>): string | null {
  const direct = asString(record.role) ?? asString(record.author) ?? asString(record.speaker) ?? asString(record.type);
  if (direct) {
    return direct.toLowerCase();
  }
  if (isRecord(record.message)) {
    const nested = asString(record.message.role) ?? asString(record.message.author) ?? asString(record.message.type);
    if (nested) {
      return nested.toLowerCase();
    }
  }
  if (isRecord(record.candidate)) {
    const nested = asString(record.candidate.role) ?? asString(record.candidate.author);
    if (nested) {
      return nested.toLowerCase();
    }
  }
  return null;
}

function extractCwd(record: Record<string, unknown>): string | null {
  for (const key of ["cwd", "projectRoot", "project_root", "projectPath", "project_path"]) {
    const found = asString(record[key]);
    if (found) {
      return found;
    }
  }
  if (isRecord(record.workspace)) {
    const nested =
      asString(record.workspace.root) ??
      asString(record.workspace.cwd) ??
      asString(record.workspace.path);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function collectCandidateRecordsFromJson(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }
  if (!isRecord(parsed)) {
    return [];
  }
  for (const key of ["messages", "turns", "events", "history", "entries", "transcript"]) {
    if (Array.isArray(parsed[key])) {
      return (parsed[key] as unknown[]).filter(isRecord);
    }
  }
  return [parsed];
}

function toGeminiEntry(record: Record<string, unknown>): GeminiEntry | null {
  const role = extractRole(record);
  const text =
    extractText(record.text) ??
    extractText(record.content) ??
    extractText(record.message) ??
    (isRecord(record.message) ? extractText(record.message.content ?? record.message.parts ?? record.message.text) : null) ??
    (isRecord(record.candidate) ? extractText(record.candidate.content ?? record.candidate.parts ?? record.candidate.text) : null);
  const ts =
    asString(record.timestamp) ??
    asString(record.ts) ??
    asString(record.createdAt) ??
    asString(record.created_at) ??
    asString(record.time);
  const sessionId =
    asString(record.sessionId) ??
    asString(record.session_id) ??
    asString(record.chatId) ??
    asString(record.chat_id) ??
    asString(record.conversationId) ??
    asString(record.conversation_id);
  const cwd = extractCwd(record);

  if (!role && !text) {
    return null;
  }
  return { role, text, ts: ts ?? undefined, sessionId, cwd };
}

function projectGeminiEntry(entry: GeminiEntry): ProjectedEvent[] {
  const events: ProjectedEvent[] = [];
  const role = (entry.role ?? "").toLowerCase();
  const ts = normalizeIsoTs(entry.ts);
  if ((role === "user" || role === "human") && entry.text) {
    events.push({
      eventType: "prompt.submitted",
      payload: { prompt: entry.text, source: "gemini_cli_history" },
      ts,
    });
    return events;
  }
  if ((role === "assistant" || role === "model" || role === "gemini") && entry.text) {
    events.push({
      eventType: "item.completed",
      payload: { item: { type: "agent_message", text: entry.text } },
      ts,
    });
    return events;
  }
  return events;
}

interface GeminiProjectDir {
  dirPath: string;
  projectRoot: string | null;
}

async function listGeminiProjectDirs(rootDir: string): Promise<GeminiProjectDir[]> {
  const out: GeminiProjectDir[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = join(rootDir, entry.name);
    const projectRootPath = join(dirPath, ".project_root");
    let projectRoot: string | null = null;
    try {
      const raw = await readFile(projectRootPath, "utf8");
      projectRoot = asString(raw);
    } catch {
      projectRoot = null;
    }
    out.push({ dirPath, projectRoot });
  }
  return out;
}

async function listTranscriptFiles(rootDir: string): Promise<string[]> {
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
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === ".project_root") {
        continue;
      }
      if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")) {
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

async function readGeminiFileEntries(
  filePath: string,
): Promise<{ rawEntries: string[]; parsedEntries: Array<GeminiEntry | null> }> {
  const raw = await readFile(filePath, "utf8");
  if (filePath.endsWith(".jsonl")) {
    const rawEntries = raw.split("\n").filter((line) => line.trim().length > 0);
    const parsedEntries: Array<GeminiEntry | null> = [];
    for (const rawLine of rawEntries) {
      try {
        const parsed = JSON.parse(rawLine) as unknown;
        if (!isRecord(parsed)) {
          parsedEntries.push(null);
          continue;
        }
        const entry = toGeminiEntry(parsed);
        parsedEntries.push(entry);
      } catch {
        parsedEntries.push(null);
      }
    }
    return { rawEntries, parsedEntries };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { rawEntries: [], parsedEntries: [] };
  }
  const candidates = collectCandidateRecordsFromJson(parsedJson);
  const parsedEntries = candidates.map(toGeminiEntry);
  const rawEntries = candidates.map((entry) => JSON.stringify(entry));
  return { rawEntries, parsedEntries };
}

export async function syncGeminiHistory(options: SyncGeminiHistoryOptions): Promise<GeminiHistorySyncSummary> {
  const normalizedProject = normalizeProjectPath(options.projectPath);
  const repoId = options.repoId ?? repoIdFromPath(normalizedProject);
  const mirrorRoot = resolve(options.mirrorRoot ?? join(normalizedProject, ".codaph"));
  const actorId = options.actorId ?? null;
  const historyRoot = resolve(options.geminiHistoryRoot ?? getGeminiHistoryRoot());

  const statePath = getStatePath(normalizedProject, mirrorRoot);
  const state = await readJsonOrDefault<GeminiHistorySyncState>(statePath, { files: {} });
  const projectDirs = await listGeminiProjectDirs(historyRoot);
  const matchingDirs = projectDirs.filter(
    (entry) => entry.projectRoot && projectOwnsPath(normalizedProject, entry.projectRoot),
  );
  const fileLists = await Promise.all(matchingDirs.map((entry) => listTranscriptFiles(entry.dirPath)));
  const files = fileLists.flat();
  const dirByPrefix = new Map<string, string>();
  for (const entry of matchingDirs) {
    if (entry.projectRoot) {
      dirByPrefix.set(entry.dirPath, entry.projectRoot);
    }
  }

  const importedSessions = new Set<string>();
  const summary: GeminiHistorySyncSummary = {
    scannedFiles: files.length,
    matchedFiles: 0,
    importedEvents: 0,
    importedSessions: 0,
  };
  let processedFiles = 0;
  let lastProgressEmit = 0;
  const emitProgress = (
    progress: Omit<GeminiHistorySyncProgress, "scannedFiles" | "processedFiles" | "matchedFiles" | "importedEvents">,
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
      emitProgress({ currentFile: filePath, currentLine: existing.entryCount, currentSessionId: existing.sessionId });
      continue;
    }

    let readResult: { rawEntries: string[]; parsedEntries: Array<GeminiEntry | null> };
    try {
      readResult = await readGeminiFileEntries(filePath);
    } catch {
      continue;
    }
    const { rawEntries, parsedEntries } = readResult;

    let cursor = existing ?? {
      entryCount: 0,
      sequence: 0,
      sessionId: null,
      cwd: null,
      updatedAt: new Date(0).toISOString(),
    };
    if (rawEntries.length < cursor.entryCount) {
      cursor = {
        entryCount: 0,
        sequence: 0,
        sessionId: null,
        cwd: null,
        updatedAt: new Date().toISOString(),
      };
    }

    const dirRoot = [...dirByPrefix.entries()].find(([dirPath]) => filePath.startsWith(`${dirPath}${sep}`))?.[1] ?? null;
    let sessionCwd = cursor.cwd ?? dirRoot;
    let sessionId = cursor.sessionId ?? null;
    if (!sessionId || !sessionCwd) {
      for (const entry of parsedEntries) {
        if (!entry) {
          continue;
        }
        sessionId = sessionId ?? entry.sessionId ?? null;
        sessionCwd = sessionCwd ?? entry.cwd ?? null;
        if (sessionId && sessionCwd) {
          break;
        }
      }
    }
    if (!sessionId) {
      sessionId = filePath.split(/[\\/]/).pop()?.replace(/\.(jsonl|json)$/i, "") ?? "gemini-session";
    }
    if (!sessionCwd) {
      sessionCwd = dirRoot;
    }

    if (!sessionCwd) {
      state.files[filePath] = {
        ...cursor,
        sessionId,
        cwd: null,
        entryCount: rawEntries.length,
        updatedAt: new Date().toISOString(),
        sizeBytes: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
      };
      emitProgress({ currentFile: filePath, currentLine: rawEntries.length, currentSessionId: sessionId });
      continue;
    }

    const normalizedSessionCwd = normalizeProjectPath(sessionCwd);
    if (!projectOwnsPath(normalizedProject, normalizedSessionCwd)) {
      state.files[filePath] = {
        ...cursor,
        sessionId,
        cwd: normalizedSessionCwd,
        entryCount: rawEntries.length,
        updatedAt: new Date().toISOString(),
        sizeBytes: fileInfo.size,
        mtimeMs: fileInfo.mtimeMs,
      };
      emitProgress({ currentFile: filePath, currentLine: rawEntries.length, currentSessionId: sessionId });
      continue;
    }

    summary.matchedFiles += 1;
    let sequence = cursor.sequence;
    let importedForFile = 0;
    let threadStartedEmitted = sequence > 0;
    for (let i = cursor.entryCount; i < rawEntries.length; i += 1) {
      const rawEntry = rawEntries[i];
      const parsedEntry = parsedEntries[i];
      if (!rawEntry) {
        continue;
      }
      await options.pipeline.ingestRawLine(sessionId, rawEntry);
      if (!parsedEntry) {
        continue;
      }
      sessionId = parsedEntry.sessionId ?? sessionId;
      sessionCwd = parsedEntry.cwd ?? sessionCwd;

      if (!threadStartedEmitted) {
        sequence += 1;
        await options.pipeline.ingest(
          "thread.started",
          {
            thread_id: sessionId,
            cwd: sessionCwd,
            source: "gemini_cli_history",
          },
          {
            source: "gemini_cli_history",
            repoId,
            actorId,
            sessionId,
            threadId: sessionId,
            sequence,
            ts: normalizeIsoTs(parsedEntry.ts),
          },
        );
        importedForFile += 1;
        summary.importedEvents += 1;
        threadStartedEmitted = true;
      }

      const projected = projectGeminiEntry(parsedEntry);
      for (const event of projected) {
        sequence += 1;
        await options.pipeline.ingest(event.eventType, event.payload, {
          source: "gemini_cli_history",
          repoId,
          actorId,
          sessionId,
          threadId: sessionId,
          sequence,
          ts: event.ts ?? normalizeIsoTs(parsedEntry.ts),
        });
        importedForFile += 1;
        summary.importedEvents += 1;
      }

      if (importedForFile > 0 && importedForFile % 50 === 0) {
        emitProgress({ currentFile: filePath, currentLine: i + 1, currentSessionId: sessionId });
      }
    }

    if (importedForFile > 0) {
      importedSessions.add(sessionId);
    }

    state.files[filePath] = {
      entryCount: rawEntries.length,
      sequence,
      sessionId,
      cwd: normalizedSessionCwd,
      updatedAt: new Date().toISOString(),
      sizeBytes: fileInfo.size,
      mtimeMs: fileInfo.mtimeMs,
    };
    await options.pipeline.flush();
    emitProgress({ currentFile: filePath, currentLine: rawEntries.length, currentSessionId: sessionId });
  }

  summary.importedSessions = importedSessions.size;
  await writeJson(statePath, state);
  return summary;
}
