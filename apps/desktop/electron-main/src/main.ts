import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import {
  repoIdFromPath,
  type AdapterRunOptions,
  type AdapterRunResult,
} from "@codaph/core-types";
import { QueryService } from "@codaph/query-service";
import { JsonlMirror } from "@codaph/mirror-jsonl";
import { IngestPipeline } from "@codaph/ingest-pipeline";
import { CodexSdkAdapter } from "@codaph/adapter-codex-sdk";
import { CodexExecAdapter } from "@codaph/adapter-codex-exec";

const __dirname = dirname(fileURLToPath(import.meta.url));

type CaptureMode = "codex_sdk" | "codex_exec";

type PatchChangeKind = "add" | "delete" | "update";

interface ProjectRecord {
  path: string;
  repoId: string;
  addedAt: string;
}

interface CodaphDesktopState {
  projects: ProjectRecord[];
  lastProjectPath: string | null;
}

interface CaptureRequest {
  projectPath: string;
  prompt: string;
  mode: CaptureMode;
  model?: string;
  resumeThreadId?: string;
}

interface CaptureResponse extends AdapterRunResult {
  eventCount: number;
  mode: CaptureMode;
}

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

interface CodexHistorySyncSummary {
  scannedFiles: number;
  matchedFiles: number;
  importedEvents: number;
  importedSessions: number;
}

interface GitStatusSummary {
  insideRepo: boolean;
  branch: string | null;
  head: string | null;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedFiles: string[];
}

interface GitCommitSummary {
  hash: string;
  author: string;
  ts: string;
  message: string;
  files: string[];
}

const defaultState: CodaphDesktopState = {
  projects: [],
  lastProjectPath: null,
};

let desktopState: CodaphDesktopState = { ...defaultState };

function getStatePath(): string {
  return join(app.getPath("userData"), "codaph-state.json");
}

function getCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

function getHistorySyncStatePath(projectPath: string): string {
  const repoId = repoIdFromPath(projectPath);
  return join(getMirrorRoot(projectPath), "index", repoId, "codex-history-sync.json");
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

  // eslint-disable-next-line no-cond-assign
  while ((match = addRegex.exec(rawText)) !== null) {
    changes.push({ path: match[1].trim(), kind: "add" });
  }

  // eslint-disable-next-line no-cond-assign
  while ((match = deleteRegex.exec(rawText)) !== null) {
    changes.push({ path: match[1].trim(), kind: "delete" });
  }

  // eslint-disable-next-line no-cond-assign
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

async function readState(): Promise<CodaphDesktopState> {
  return readJsonOrDefault<CodaphDesktopState>(getStatePath(), { ...defaultState });
}

async function writeState(nextState: CodaphDesktopState): Promise<void> {
  const statePath = getStatePath();
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
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

async function addProject(projectPath: string): Promise<ProjectRecord> {
  const normalized = normalizeProjectPath(projectPath);
  const existing = desktopState.projects.find((project) => project.path === normalized);
  if (existing) {
    desktopState.lastProjectPath = existing.path;
    await writeState(desktopState);
    return existing;
  }

  const nextProject: ProjectRecord = {
    path: normalized,
    repoId: repoIdFromPath(normalized),
    addedAt: new Date().toISOString(),
  };

  desktopState.projects = [nextProject, ...desktopState.projects].sort((a, b) =>
    b.addedAt.localeCompare(a.addedAt),
  );
  desktopState.lastProjectPath = nextProject.path;
  await writeState(desktopState);
  return nextProject;
}

async function removeProject(projectPath: string): Promise<ProjectRecord[]> {
  const normalized = normalizeProjectPath(projectPath);
  desktopState.projects = desktopState.projects.filter((project) => project.path !== normalized);

  if (desktopState.lastProjectPath === normalized) {
    desktopState.lastProjectPath = desktopState.projects[0]?.path ?? null;
  }

  await writeState(desktopState);
  return desktopState.projects;
}

function getMirrorRoot(projectPath: string): string {
  return join(normalizeProjectPath(projectPath), ".codaph");
}

function createQueryService(projectPath: string): QueryService {
  return new QueryService(getMirrorRoot(projectPath));
}

async function runProcess(
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    child.once("error", (error: Error) => {
      resolvePromise({
        code: 1,
        stdout: "",
        stderr: error.message,
      });
    });

    child.once("close", (code: number | null) => {
      resolvePromise({
        code: code ?? 1,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });
  });
}

function parseGitStatusPorcelain(porcelain: string): {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedFiles: string[];
} {
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  const changed = new Set<string>();

  const lines = porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.startsWith("##")) {
      continue;
    }

    if (line.startsWith("?? ")) {
      untrackedCount += 1;
      changed.add(line.slice(3).trim());
      continue;
    }

    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const pathPart = line.slice(3).trim();
    const finalPath = pathPart.includes(" -> ")
      ? pathPart.split(" -> ").at(-1)?.trim() ?? pathPart
      : pathPart;

    if (x !== " " && x !== "?") {
      stagedCount += 1;
    }
    if (y !== " " && y !== "?") {
      unstagedCount += 1;
    }
    if (finalPath) {
      changed.add(finalPath);
    }
  }

  return {
    stagedCount,
    unstagedCount,
    untrackedCount,
    changedFiles: [...changed].sort((a, b) => a.localeCompare(b)),
  };
}

async function getGitStatus(projectPath: string): Promise<GitStatusSummary> {
  const normalized = normalizeProjectPath(projectPath);

  const insideCheck = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], normalized);
  if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== "true") {
    return {
      insideRepo: false,
      branch: null,
      head: null,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      changedFiles: [],
    };
  }

  const [statusRes, headRes] = await Promise.all([
    runProcess("git", ["status", "--porcelain=1", "-b"], normalized),
    runProcess("git", ["rev-parse", "--short", "HEAD"], normalized),
  ]);

  const statusInfo = parseGitStatusPorcelain(statusRes.stdout);
  const firstLine = statusRes.stdout.split("\n")[0]?.trim() ?? "";
  const branchToken = firstLine.startsWith("## ") ? firstLine.slice(3).split("...")[0] : "";
  const branch = branchToken.length > 0 ? branchToken : null;

  return {
    insideRepo: true,
    branch,
    head: headRes.code === 0 ? headRes.stdout.trim() || null : null,
    ...statusInfo,
  };
}

async function getGitCommits(projectPath: string, limit: number): Promise<GitCommitSummary[]> {
  const normalized = normalizeProjectPath(projectPath);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;

  const insideCheck = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], normalized);
  if (insideCheck.code !== 0 || insideCheck.stdout.trim() !== "true") {
    return [];
  }

  const logRes = await runProcess(
    "git",
    ["log", `-n${safeLimit}`, "--date=iso-strict", "--name-only", "--pretty=format:__COMMIT__%H|%an|%aI|%s"],
    normalized,
  );
  if (logRes.code !== 0) {
    return [];
  }

  const commits: GitCommitSummary[] = [];
  const lines = logRes.stdout.split("\n");
  let current: GitCommitSummary | null = null;

  for (const line of lines) {
    if (line.startsWith("__COMMIT__")) {
      if (current) {
        commits.push({
          ...current,
          files: [...new Set(current.files)].sort((a, b) => a.localeCompare(b)),
        });
      }

      const raw = line.slice("__COMMIT__".length);
      const [hash, author, ts, ...messageParts] = raw.split("|");
      current = {
        hash: hash ?? "",
        author: author ?? "",
        ts: ts ?? "",
        message: messageParts.join("|"),
        files: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.length > 0) {
      current.files.push(trimmed);
    }
  }

  if (current) {
    commits.push({
      ...current,
      files: [...new Set(current.files)].sort((a, b) => a.localeCompare(b)),
    });
  }

  return commits;
}

async function runCodexLoginStatus(): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("codex", ["login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    child.once("error", (error: Error) => {
      resolvePromise({ ok: false, message: error.message });
    });

    child.once("close", (code: number) => {
      const stdout = stdoutChunks.join("").trim();
      const stderr = stderrChunks.join("").trim();
      if (code === 0) {
        resolvePromise({ ok: true, message: stdout || "Codex auth available" });
        return;
      }

      resolvePromise({
        ok: false,
        message: stderr || stdout || `codex login status exited with code ${code}`,
      });
    });
  });
}

function createCaptureAdapter(mode: CaptureMode, pipeline: IngestPipeline): CodexSdkAdapter | CodexExecAdapter {
  return mode === "codex_sdk" ? new CodexSdkAdapter(pipeline) : new CodexExecAdapter(pipeline);
}

async function captureWithCodex(request: CaptureRequest): Promise<CaptureResponse> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const projectPath = normalizeProjectPath(request.projectPath);
  const repoId = repoIdFromPath(projectPath);

  const mirror = new JsonlMirror(getMirrorRoot(projectPath));
  const pipeline = new IngestPipeline(mirror);
  const adapter = createCaptureAdapter(request.mode, pipeline);

  const options: AdapterRunOptions = {
    prompt,
    cwd: projectPath,
    model: request.model,
    resumeThreadId: request.resumeThreadId,
  };

  let eventCount = 0;
  const result = await adapter.runAndCapture(options, () => {
    eventCount += 1;
  });

  if (!desktopState.projects.some((project) => project.repoId === repoId && project.path === projectPath)) {
    await addProject(projectPath);
  }

  return {
    ...result,
    eventCount,
    mode: request.mode,
  };
}

async function syncCodexHistory(projectPath: string): Promise<CodexHistorySyncSummary> {
  const normalizedProject = normalizeProjectPath(projectPath);
  const repoId = repoIdFromPath(normalizedProject);
  const mirror = new JsonlMirror(getMirrorRoot(normalizedProject));
  const pipeline = new IngestPipeline(mirror);

  const statePath = getHistorySyncStatePath(normalizedProject);
  const state = await readJsonOrDefault<CodexHistorySyncState>(statePath, { files: {} });

  const files = await listCodexSessionFiles(getCodexSessionsRoot());
  const importedSessions = new Set<string>();

  const summary: CodexHistorySyncSummary = {
    scannedFiles: files.length,
    matchedFiles: 0,
    importedEvents: 0,
    importedSessions: 0,
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
      continue;
    }

    summary.matchedFiles += 1;

    // Recovery for older cursors that were advanced before import conditions were correct.
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

      await pipeline.ingestRawLine(sessionId, rawLine);

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
        await pipeline.ingest(event.eventType, event.payload, {
          source: "codex_exec",
          repoId,
          sessionId,
          threadId: sessionId,
          sequence,
          ts: event.ts ?? lineTs,
        });
        importedForFile += 1;
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
  }

  summary.importedSessions = importedSessions.size;
  await writeJson(statePath, state);

  return summary;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../electron-preload/preload.cjs"),
    },
  });

  const rendererHtml = join(__dirname, "../renderer/index.html");
  void win.loadFile(rendererHtml);
}

ipcMain.handle("codaph:projects:list", async () => {
  return {
    projects: desktopState.projects,
    lastProjectPath: desktopState.lastProjectPath,
  };
});

ipcMain.handle("codaph:projects:add", async (_event, projectPath?: string) => {
  if (projectPath && projectPath.trim().length > 0) {
    return addProject(projectPath);
  }

  const picked = await dialog.showOpenDialog({
    title: "Choose project folder",
    properties: ["openDirectory", "createDirectory"],
  });

  if (picked.canceled || picked.filePaths.length === 0) {
    return null;
  }

  return addProject(picked.filePaths[0]);
});

ipcMain.handle("codaph:projects:remove", async (_event, projectPath: string) => {
  return removeProject(projectPath);
});

ipcMain.handle("codaph:projects:set-last", async (_event, projectPath: string) => {
  desktopState.lastProjectPath = normalizeProjectPath(projectPath);
  await writeState(desktopState);
  return desktopState.lastProjectPath;
});

ipcMain.handle("codaph:codex:auth-status", async () => {
  return runCodexLoginStatus();
});

ipcMain.handle("codaph:history:sync", async (_event, params: { projectPath: string }) => {
  return syncCodexHistory(params.projectPath);
});

ipcMain.handle("codaph:git:status", async (_event, params: { projectPath: string }) => {
  return getGitStatus(params.projectPath);
});

ipcMain.handle("codaph:git:commits", async (_event, params: { projectPath: string; limit?: number }) => {
  return getGitCommits(params.projectPath, params.limit ?? 20);
});

ipcMain.handle("codaph:sessions", async (_event, params: { projectPath: string }) => {
  const projectPath = normalizeProjectPath(params.projectPath);
  const service = createQueryService(projectPath);
  const repoId = repoIdFromPath(projectPath);
  return service.listSessions(repoId);
});

ipcMain.handle(
  "codaph:timeline",
  async (_event, params: { projectPath: string; sessionId: string }) => {
    const projectPath = normalizeProjectPath(params.projectPath);
    const service = createQueryService(projectPath);
    const repoId = repoIdFromPath(projectPath);
    return service.getTimeline({ repoId, sessionId: params.sessionId });
  },
);

ipcMain.handle(
  "codaph:diff",
  async (_event, params: { projectPath: string; sessionId: string; path?: string }) => {
    const projectPath = normalizeProjectPath(params.projectPath);
    const service = createQueryService(projectPath);
    const repoId = repoIdFromPath(projectPath);
    return service.getDiffSummary(repoId, params.sessionId, params.path);
  },
);

ipcMain.handle("codaph:capture", async (_event, request: CaptureRequest) => {
  return captureWithCodex(request);
});

app.whenReady().then(async () => {
  desktopState = await readState();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
