import { stat } from "node:fs/promises";
import { stderr as err, stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { QueryService } from "./lib/query-service";
import { redactUnknown } from "./lib/redactor";
import { detectAgentProvidersForRepo, normalizeAgentProviderList } from "./lib/agent-providers";
import { repoIdFromPath, type TimelineFilter } from "./lib/core-types";
import { detectGitHubDefaults, getProjectSettings, loadCodaphSettings, type CodaphSettings } from "./settings-store";
import { normalizeSyncAutomationSettings } from "./sync-automation";
import { loadRegistry, addProjectToRegistry, setLastProject } from "./project-registry";
import { getLocalPushStatePath, readLocalPushState } from "./local-push-state";
import { getMubitRemoteSyncStatePath, readMubitRemoteSyncState } from "./mubit-remote-sync-state";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_TIMELINE_LIMIT = 1000;
const DEFAULT_TIMELINE_LIMIT = 200;
const MAX_TEXT_RESULT_BYTES = 64 * 1024;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

interface McpServerOptions {
  defaultCwd?: string;
}

interface ToolCallContext {
  defaultCwd: string;
}

interface ResolvedProjectContext {
  cwd: string;
  repoId: string;
  settings: CodaphSettings;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<unknown>;
}

function logDebug(message: string, meta?: unknown): void {
  const suffix = meta === undefined ? "" : ` ${safeJson(meta)}`;
  err.write(`[codaph-mcp] ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRequiredString(value: unknown, name: string): string {
  const parsed = asOptionalString(value);
  if (!parsed) {
    throw new Error(`"${name}" is required`);
  }
  return parsed;
}

function asOptionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`"${name}" must be a number`);
  }
  return Math.trunc(value);
}

function asOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`"${name}" must be a boolean`);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveProjectRepoId(cwd: string, settings: CodaphSettings, explicitRepoId?: string): string {
  if (explicitRepoId && explicitRepoId.trim().length > 0) {
    return explicitRepoId.trim();
  }
  const projectSettings = getProjectSettings(settings, cwd);
  const fromProject = typeof projectSettings.mubitProjectId === "string" && projectSettings.mubitProjectId.trim().length > 0
    ? projectSettings.mubitProjectId.trim()
    : null;
  if (fromProject) {
    return fromProject;
  }
  const detected = detectGitHubDefaults(cwd).projectId;
  if (detected && detected.trim().length > 0) {
    return detected.trim();
  }
  return repoIdFromPath(cwd);
}

async function resolveProjectContext(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ResolvedProjectContext> {
  const registry = await loadRegistry();
  const cwdArg =
    asOptionalString(args.cwd) ??
    asOptionalString(args.project_path) ??
    asOptionalString(args.projectPath) ??
    registry.lastProjectPath ??
    registry.projects[0] ??
    ctx.defaultCwd;
  const cwd = resolve(cwdArg);
  const settings = loadCodaphSettings();
  const repoId = resolveProjectRepoId(cwd, settings, asOptionalString(args.repoId) ?? asOptionalString(args.repo_id));
  return { cwd, repoId, settings };
}

async function maybeReadProjectStatus(cwd: string, repoId: string, settings: CodaphSettings): Promise<Record<string, unknown>> {
  const project = getProjectSettings(settings, cwd);
  const savedAgentProviders = normalizeAgentProviderList(project.agentProviders ?? []);
  const recognizedAgentProviders = await detectAgentProvidersForRepo(cwd).catch(() => []);
  const agentProviders = savedAgentProviders.length > 0 ? savedAgentProviders : (recognizedAgentProviders.length > 0 ? recognizedAgentProviders : ["codex"]);
  const automation = normalizeSyncAutomationSettings(project.syncAutomation ?? null);
  const mirrorRoot = resolve(cwd, ".codaph");
  const localPushPath = getLocalPushStatePath(mirrorRoot, repoId);
  const remoteStatePath = getMubitRemoteSyncStatePath(mirrorRoot, repoId);
  const localPush = await pathExists(localPushPath) ? await readLocalPushState(localPushPath).catch(() => null) : null;
  const remote = await pathExists(remoteStatePath) ? await readMubitRemoteSyncState(remoteStatePath).catch(() => null) : null;

  return {
    cwd,
    repoId,
    agentProviders,
    recognizedAgentProviders,
    automation,
    localPush,
    remote,
  };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function buildTimelineFilter(args: Record<string, unknown>, repoId: string): TimelineFilter {
  const filter: TimelineFilter = { repoId };
  const sessionId = asOptionalString(args.sessionId) ?? asOptionalString(args.session_id);
  const threadId = asOptionalString(args.threadId) ?? asOptionalString(args.thread_id);
  const actorId = asOptionalString(args.actorId) ?? asOptionalString(args.actor_id);
  const from = asOptionalString(args.from);
  const to = asOptionalString(args.to);
  const itemType = asOptionalString(args.itemType) ?? asOptionalString(args.item_type);
  if (sessionId) {
    filter.sessionId = sessionId;
  }
  if (threadId) {
    filter.threadId = threadId;
  }
  if (actorId) {
    filter.actorId = actorId;
  }
  if (from) {
    filter.from = from;
  }
  if (to) {
    filter.to = to;
  }
  if (itemType) {
    filter.itemType = itemType;
  }
  return filter;
}

function toolSchemas(): McpTool[] {
  return [
    {
      name: "codaph_projects_list",
      description: "List Codaph projects in the local registry with saved provider/automation settings.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      handler: async () => {
        const registry = await loadRegistry();
        const settings = loadCodaphSettings();
        const projects = await Promise.all(
          registry.projects.map(async (projectPath) => {
            const cwd = resolve(projectPath);
            const exists = await pathExists(cwd);
            const projectSettings = getProjectSettings(settings, cwd);
            const recognizedAgentProviders = exists ? await detectAgentProvidersForRepo(cwd).catch(() => []) : [];
            const savedAgentProviders = normalizeAgentProviderList(projectSettings.agentProviders ?? []);
            const agentProviders =
              savedAgentProviders.length > 0
                ? savedAgentProviders
                : (recognizedAgentProviders.length > 0 ? recognizedAgentProviders : []);
            const automation = normalizeSyncAutomationSettings(projectSettings.syncAutomation ?? null);
            const initialized = exists ? await pathExists(resolve(cwd, ".codaph", "project.json")) : false;
            const repoId = resolveProjectRepoId(cwd, settings);
            return {
              cwd,
              repoId,
              initialized,
              exists,
              isLast: registry.lastProjectPath === cwd,
              mubitProjectId: projectSettings.mubitProjectId ?? null,
              mubitRunScope: projectSettings.mubitRunScope ?? null,
              projectName: projectSettings.projectName ?? null,
              agentProviders,
              recognizedAgentProviders,
              automation,
            };
          }),
        );
        return {
          count: projects.length,
          lastProjectPath: registry.lastProjectPath,
          projects,
        };
      },
    },
    {
      name: "codaph_projects_add",
      description: "Add a project path to the Codaph local project registry and set it as current.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute or relative path to a project directory." },
        },
      },
      handler: async (args) => {
        const rawPath = asRequiredString(args.path, "path");
        const registry = await addProjectToRegistry(rawPath);
        return {
          addedPath: resolve(rawPath),
          count: registry.projects.length,
          lastProjectPath: registry.lastProjectPath,
          projects: registry.projects,
        };
      },
    },
    {
      name: "codaph_projects_set_last",
      description: "Set the current/last project used by Codaph MCP tool defaults.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Absolute or relative path to a tracked project." },
        },
      },
      handler: async (args) => {
        const rawPath = asRequiredString(args.path, "path");
        const registry = await setLastProject(rawPath);
        return {
          lastProjectPath: registry.lastProjectPath,
          projects: registry.projects,
        };
      },
    },
    {
      name: "codaph_status",
      description: "Return Codaph sync/automation status for a project (same data as `codaph status --json`).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cwd: { type: "string" },
          project_path: { type: "string" },
          repoId: { type: "string" },
          repo_id: { type: "string" },
        },
      },
      handler: async (args, ctx) => {
        const project = await resolveProjectContext(args, ctx);
        return maybeReadProjectStatus(project.cwd, project.repoId, project.settings);
      },
    },
    {
      name: "codaph_sessions_list",
      description: "List captured sessions from the local Codaph mirror for a project/repo.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cwd: { type: "string" },
          project_path: { type: "string" },
          repoId: { type: "string" },
          repo_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 5000 },
        },
      },
      handler: async (args, ctx) => {
        const project = await resolveProjectContext(args, ctx);
        const limit = clamp(asOptionalInteger(args.limit, "limit"), 200, 1, 5000);
        const query = new QueryService(resolve(project.cwd, ".codaph"));
        const sessions = await query.listSessions(project.repoId);
        return {
          cwd: project.cwd,
          repoId: project.repoId,
          total: sessions.length,
          sessions: sessions.slice(0, limit),
          truncated: sessions.length > limit,
        };
      },
    },
    {
      name: "codaph_contributors_list",
      description: "List contributors/actors in the local Codaph mirror, optionally filtered to a session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cwd: { type: "string" },
          project_path: { type: "string" },
          repoId: { type: "string" },
          repo_id: { type: "string" },
          sessionId: { type: "string" },
          session_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 5000 },
        },
      },
      handler: async (args, ctx) => {
        const project = await resolveProjectContext(args, ctx);
        const sessionId = asOptionalString(args.sessionId) ?? asOptionalString(args.session_id);
        const limit = clamp(asOptionalInteger(args.limit, "limit"), 200, 1, 5000);
        const query = new QueryService(resolve(project.cwd, ".codaph"));
        const contributors = await query.listContributors(project.repoId, sessionId);
        return {
          cwd: project.cwd,
          repoId: project.repoId,
          sessionId: sessionId ?? null,
          total: contributors.length,
          contributors: contributors.slice(0, limit),
          truncated: contributors.length > limit,
        };
      },
    },
    {
      name: "codaph_timeline_get",
      description: "Read timeline events from the local Codaph mirror (supports repo/session/thread/actor/time filters).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          cwd: { type: "string" },
          project_path: { type: "string" },
          repoId: { type: "string" },
          repo_id: { type: "string" },
          sessionId: { type: "string" },
          session_id: { type: "string" },
          threadId: { type: "string" },
          thread_id: { type: "string" },
          actorId: { type: "string" },
          actor_id: { type: "string" },
          from: { type: "string", description: "ISO timestamp lower bound" },
          to: { type: "string", description: "ISO timestamp upper bound" },
          itemType: { type: "string" },
          item_type: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: MAX_TIMELINE_LIMIT },
          includePayload: { type: "boolean", description: "If false, strips event.payload to reduce response size." },
        },
      },
      handler: async (args, ctx) => {
        const project = await resolveProjectContext(args, ctx);
        const query = new QueryService(resolve(project.cwd, ".codaph"));
        const filter = buildTimelineFilter(args, project.repoId);
        const offset = clamp(asOptionalInteger(args.offset, "offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = clamp(asOptionalInteger(args.limit, "limit"), DEFAULT_TIMELINE_LIMIT, 1, MAX_TIMELINE_LIMIT);
        const includePayload = asOptionalBoolean(args.includePayload, "includePayload") ?? true;
        const allEvents = await query.getTimeline(filter);
        const page = allEvents.slice(offset, offset + limit).map((event) => includePayload ? event : { ...event, payload: {} });
        return {
          cwd: project.cwd,
          repoId: project.repoId,
          filter,
          offset,
          limit,
          total: allEvents.length,
          returned: page.length,
          truncated: offset + page.length < allEvents.length,
          events: page,
        };
      },
    },
    {
      name: "codaph_diff_summary",
      description: "Summarize file changes for a Codaph session from the local mirror.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId"],
        properties: {
          cwd: { type: "string" },
          project_path: { type: "string" },
          repoId: { type: "string" },
          repo_id: { type: "string" },
          sessionId: { type: "string" },
          session_id: { type: "string" },
          pathFilter: { type: "string" },
          path_filter: { type: "string" },
        },
      },
      handler: async (args, ctx) => {
        const project = await resolveProjectContext(args, ctx);
        const sessionId = asOptionalString(args.sessionId) ?? asOptionalString(args.session_id);
        if (!sessionId) {
          throw new Error("\"sessionId\" is required");
        }
        const pathFilter = asOptionalString(args.pathFilter) ?? asOptionalString(args.path_filter);
        const query = new QueryService(resolve(project.cwd, ".codaph"));
        const files = await query.getDiffSummary(project.repoId, sessionId, pathFilter);
        return {
          cwd: project.cwd,
          repoId: project.repoId,
          sessionId,
          pathFilter: pathFilter ?? null,
          count: files.length,
          files,
        };
      },
    },
  ];
}

function formatToolResultText(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_RESULT_BYTES) {
    return text;
  }
  const truncated = text.slice(0, MAX_TEXT_RESULT_BYTES);
  return `${truncated}\n... (truncated; inspect structuredContent for full payload if your client supports it)`;
}

function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorPayload {
  return data === undefined ? { code, message } : { code, message, data };
}

function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

function normalizeToolsList(tools: McpTool[]): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function findHeaderEnd(buffer: Buffer): { index: number; delimiterLength: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return { index: crlf, delimiterLength: 4 };
  }
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) {
    return { index: lf, delimiterLength: 2 };
  }
  return null;
}

function parseContentLength(headerText: string): number {
  const lines = headerText.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key !== "content-length") {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`Invalid Content-Length header: ${value}`);
    }
    return parsed;
  }
  throw new Error("Missing Content-Length header");
}

export class CodaphMcpServer {
  private readonly tools = toolSchemas();
  private readonly toolMap = new Map<string, McpTool>(this.tools.map((tool) => [tool.name, tool]));
  private readonly ctx: ToolCallContext;
  private readBuffer = Buffer.alloc(0);
  private closed = false;
  private sawInput = false;
  private sawParsedRequest = false;
  private ioMode: "auto" | "framed" | "plain" = "auto";

  constructor(options: McpServerOptions = {}) {
    this.ctx = { defaultCwd: resolve(options.defaultCwd ?? process.cwd()) };
  }

  start(): Promise<void> {
    return new Promise((resolveDone) => {
      logDebug("stdio server started", { cwd: this.ctx.defaultCwd, pid: process.pid });
      const noInputTimer = setTimeout(() => {
        if (!this.sawInput) {
          logDebug("no stdin bytes received after 5s");
        }
      }, 5000);

      const onData = (chunk: Buffer | string) => {
        const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!this.sawInput) {
          this.sawInput = true;
          logDebug("received first stdin chunk", {
            bytes: asBuffer.length,
            preview: asBuffer.toString("utf8", 0, Math.min(asBuffer.length, 120)).replace(/\r/g, "\\r").replace(/\n/g, "\\n"),
          });
        }
        this.readBuffer = Buffer.concat([this.readBuffer, asBuffer]);
        this.drainBuffer();
      };

      const onEnd = () => {
        cleanup();
        resolveDone();
      };

      const onError = (error: Error) => {
        logDebug("stdin error", { message: error.message });
        cleanup();
        resolveDone();
      };

      const cleanup = () => {
        if (this.closed) {
          return;
        }
        this.closed = true;
        clearTimeout(noInputTimer);
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };

      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      input.resume();
    });
  }

  private drainBuffer(): void {
    for (;;) {
      const headerEnd = findHeaderEnd(this.readBuffer);
      if (!headerEnd) {
        if (!this.drainPlainJsonBuffer()) {
          return;
        }
        continue;
      }
      const headerText = this.readBuffer.slice(0, headerEnd.index).toString("utf8");
      let contentLength: number;
      try {
        contentLength = parseContentLength(headerText);
      } catch (error) {
        this.readBuffer = this.readBuffer.slice(headerEnd.index + headerEnd.delimiterLength);
        this.sendJsonRpcError(null, jsonRpcError(-32700, error instanceof Error ? error.message : String(error)));
        continue;
      }

      const messageStart = headerEnd.index + headerEnd.delimiterLength;
      const messageEnd = messageStart + contentLength;
      if (this.readBuffer.length < messageEnd) {
        return;
      }

      const body = this.readBuffer.slice(messageStart, messageEnd).toString("utf8");
      this.readBuffer = this.readBuffer.slice(messageEnd);
      if (this.ioMode === "auto") {
        this.ioMode = "framed";
        logDebug("detected stdio mode", { mode: this.ioMode });
      }
      void this.handleRawMessage(body);
    }
  }

  private drainPlainJsonBuffer(): boolean {
    if (this.readBuffer.length === 0) {
      return false;
    }

    const text = this.readBuffer.toString("utf8");
    const trimmed = text.trimStart();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return false;
    }

    // First try line-delimited JSON (common stdio MCP variant used by some clients).
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex >= 0) {
      const line = text.slice(0, newlineIndex).trim();
      this.readBuffer = Buffer.from(text.slice(newlineIndex + 1), "utf8");
      if (line.length === 0) {
        return true;
      }
      if (this.ioMode === "auto") {
        this.ioMode = "plain";
        logDebug("detected stdio mode", { mode: this.ioMode });
      }
      void this.handleRawMessage(line);
      return true;
    }

    // If there is no newline delimiter, try parsing the entire buffer as one JSON message.
    // If parsing fails, assume the message is incomplete and wait for more bytes.
    try {
      JSON.parse(text);
    } catch {
      return false;
    }
    if (this.ioMode === "auto") {
      this.ioMode = "plain";
      logDebug("detected stdio mode", { mode: this.ioMode });
    }
    this.readBuffer = Buffer.alloc(0);
    void this.handleRawMessage(text);
    return true;
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      this.sendJsonRpcError(null, jsonRpcError(-32700, "Parse error", error instanceof Error ? error.message : String(error)));
      return;
    }

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        await this.handleRequestObject(entry);
      }
      return;
    }
    await this.handleRequestObject(parsed);
  }

  private async handleRequestObject(value: unknown): Promise<void> {
    const request = asRecord(value) as JsonRpcRequest | null;
    if (!request) {
      this.sendJsonRpcError(null, jsonRpcError(-32600, "Invalid Request"));
      return;
    }

    const method = typeof request.method === "string" ? request.method : null;
    if (!method) {
      if (!isNotification(request)) {
        this.sendJsonRpcError(request.id ?? null, jsonRpcError(-32600, "Invalid Request: method must be a string"));
      }
      return;
    }
    if (!this.sawParsedRequest) {
      this.sawParsedRequest = true;
      logDebug("parsed first request", { method });
    }

    try {
      if (method === "initialize") {
        await this.handleInitialize(request);
        return;
      }
      if (method === "notifications/initialized") {
        return;
      }
      if (method === "ping") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, {});
        }
        return;
      }
      if (method === "logging/setLevel") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, {});
        }
        return;
      }
      if (method === "shutdown") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, {});
        }
        return;
      }
      if (method === "exit" || method === "notifications/cancelled") {
        return;
      }
      if (method === "tools/list") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, { tools: normalizeToolsList(this.tools) });
        }
        return;
      }
      if (method === "tools/call") {
        await this.handleToolCall(request);
        return;
      }
      if (method === "resources/list") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, { resources: [] });
        }
        return;
      }
      if (method === "prompts/list") {
        if (!isNotification(request)) {
          this.sendJsonRpcResult(request.id ?? null, { prompts: [] });
        }
        return;
      }

      if (!isNotification(request)) {
        this.sendJsonRpcError(request.id ?? null, jsonRpcError(-32601, `Method not found: ${method}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNotification(request)) {
        this.sendJsonRpcError(request.id ?? null, jsonRpcError(-32603, message));
      } else {
        logDebug("notification handler error", { method, message });
      }
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    if (isNotification(request)) {
      return;
    }
    const params = asRecord(request.params) ?? {};
    const requestedProtocol = asOptionalString(params.protocolVersion) ?? MCP_PROTOCOL_VERSION;
    const result = {
      protocolVersion: requestedProtocol,
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: "codaph",
        version: process.env.npm_package_version?.trim() || "dev",
      },
      instructions:
        "Codaph MCP exposes local Codaph project registry, status, sessions, timeline, and diff summaries. Pass `cwd` or `project_path` to target a repo.",
    };
    this.sendJsonRpcResult(request.id ?? null, result);
  }

  private async handleToolCall(request: JsonRpcRequest): Promise<void> {
    if (isNotification(request)) {
      return;
    }
    const params = asRecord(request.params);
    if (!params) {
      this.sendJsonRpcError(request.id ?? null, jsonRpcError(-32602, "tools/call params must be an object"));
      return;
    }

    const toolName = asOptionalString(params.name);
    if (!toolName) {
      this.sendJsonRpcError(request.id ?? null, jsonRpcError(-32602, "\"name\" is required"));
      return;
    }
    const tool = this.toolMap.get(toolName);
    if (!tool) {
      this.sendJsonRpcResult(request.id ?? null, {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      });
      return;
    }

    const args = asRecord(params.arguments) ?? {};
    try {
      const rawResult = await tool.handler(args, this.ctx);
      const structured = redactUnknown(rawResult);
      this.sendJsonRpcResult(request.id ?? null, {
        content: [
          {
            type: "text",
            text: formatToolResultText(structured),
          },
        ],
        structuredContent: structured,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJsonRpcResult(request.id ?? null, {
        isError: true,
        content: [{ type: "text", text: message }],
      });
    }
  }

  private sendJsonRpcResult(id: unknown, result: unknown): void {
    if (id !== undefined && id !== null) {
      logDebug("sending jsonrpc result", { id });
    }
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private sendJsonRpcError(id: unknown, error: JsonRpcErrorPayload): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error,
    });
  }

  private writeMessage(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (this.ioMode === "plain") {
      output.write(body);
      output.write("\n");
      return;
    }
    // Use the minimal MCP stdio framing. Some clients are stricter than others
    // about extra headers and may hang instead of surfacing a parse error.
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    output.write(header);
    output.write(body);
  }
}

export async function startCodaphMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = new CodaphMcpServer(options);
  await server.start();
}
