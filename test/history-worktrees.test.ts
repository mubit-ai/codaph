import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncCodexHistory } from "../src/codex-history-sync";
import { syncClaudeHistory } from "../src/claude-history-sync";
import { syncGeminiHistory } from "../src/gemini-history-sync";
import { repoIdFromPath } from "../src/lib/core-types";
import { JsonlMirror } from "../src/lib/mirror-jsonl";
import { IngestPipeline } from "../src/lib/ingest-pipeline";
import { createProjectRootMatcher } from "../src/lib/project-roots";
import { QueryService } from "../src/lib/query-service";

function createPipeline(mirrorRoot: string): IngestPipeline {
  return new IngestPipeline(new JsonlMirror(mirrorRoot));
}

async function writeJsonl(filePath: string, lines: string[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

describe("history sync worktrees", () => {
  it("includes codex sessions from sibling worktrees when projectPaths are provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-codex-worktree-"));
    const projectPath = join(root, "repo-main");
    const siblingWorktree = join(root, "repo-wt");
    const codexSessionsRoot = join(root, "codex-sessions");
    const codexSessionFile = join(codexSessionsRoot, "2026", "03", "session-1.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await mkdir(siblingWorktree, { recursive: true });
      await writeJsonl(codexSessionFile, [
        JSON.stringify({
          timestamp: "2026-03-01T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-1", cwd: siblingWorktree },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", text: "hello from codex" },
        }),
      ]);

      const withoutWorktrees = await syncCodexHistory({
        projectPath,
        codexSessionsRoot,
        mirrorRoot: join(root, "mirror-codex-no-worktrees"),
        pipeline: createPipeline(join(root, "mirror-codex-no-worktrees")),
      });
      expect(withoutWorktrees.matchedFiles).toBe(0);

      const withWorktrees = await syncCodexHistory({
        projectPath,
        projectPaths: [projectPath, siblingWorktree],
        codexSessionsRoot,
        mirrorRoot: join(root, "mirror-codex-with-worktrees"),
        pipeline: createPipeline(join(root, "mirror-codex-with-worktrees")),
      });
      expect(withWorktrees.matchedFiles).toBe(1);
      expect(withWorktrees.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes claude transcripts from sibling worktrees when projectPaths are provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-claude-worktree-"));
    const projectPath = join(root, "repo-main");
    const siblingWorktree = join(root, "repo-wt");
    const claudeProjectsRoot = join(root, "claude-projects");
    const claudeFile = join(claudeProjectsRoot, "session-1.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await mkdir(siblingWorktree, { recursive: true });
      await writeJsonl(claudeFile, [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-01T10:00:00.000Z",
          sessionId: "claude-session-1",
          cwd: siblingWorktree,
          message: {
            content: [{ type: "text", text: "hello from claude" }],
          },
        }),
      ]);

      const withoutWorktrees = await syncClaudeHistory({
        projectPath,
        claudeProjectsRoot,
        mirrorRoot: join(root, "mirror-claude-no-worktrees"),
        pipeline: createPipeline(join(root, "mirror-claude-no-worktrees")),
      });
      expect(withoutWorktrees.matchedFiles).toBe(0);

      const withWorktrees = await syncClaudeHistory({
        projectPath,
        projectPaths: [projectPath, siblingWorktree],
        claudeProjectsRoot,
        mirrorRoot: join(root, "mirror-claude-with-worktrees"),
        pipeline: createPipeline(join(root, "mirror-claude-with-worktrees")),
      });
      expect(withWorktrees.matchedFiles).toBe(1);
      expect(withWorktrees.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes gemini transcripts from sibling worktrees when projectPaths are provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-gemini-worktree-"));
    const projectPath = join(root, "repo-main");
    const siblingWorktree = join(root, "repo-wt");
    const geminiHistoryRoot = join(root, "gemini-history");
    const projectDir = join(geminiHistoryRoot, "project-1");
    const transcriptFile = join(projectDir, "session-1.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await mkdir(siblingWorktree, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, ".project_root"), `${siblingWorktree}\n`, "utf8");
      await writeJsonl(transcriptFile, [
        JSON.stringify({
          role: "user",
          text: "hello from gemini",
          sessionId: "gemini-session-1",
          cwd: siblingWorktree,
          timestamp: "2026-03-01T10:00:00.000Z",
        }),
      ]);

      const withoutWorktrees = await syncGeminiHistory({
        projectPath,
        geminiHistoryRoot,
        mirrorRoot: join(root, "mirror-gemini-no-worktrees"),
        pipeline: createPipeline(join(root, "mirror-gemini-no-worktrees")),
      });
      expect(withoutWorktrees.matchedFiles).toBe(0);

      const withWorktrees = await syncGeminiHistory({
        projectPath,
        projectPaths: [projectPath, siblingWorktree],
        geminiHistoryRoot,
        mirrorRoot: join(root, "mirror-gemini-with-worktrees"),
        pipeline: createPipeline(join(root, "mirror-gemini-with-worktrees")),
      });
      expect(withWorktrees.matchedFiles).toBe(1);
      expect(withWorktrees.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-evaluates unchanged codex files when the project root set changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-codex-stale-roots-"));
    const projectPath = join(root, "repo-main");
    const siblingWorktree = join(root, "repo-wt");
    const codexSessionsRoot = join(root, "codex-sessions");
    const mirrorRoot = join(root, "mirror");
    const codexSessionFile = join(codexSessionsRoot, "2026", "03", "session-1.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await mkdir(siblingWorktree, { recursive: true });
      await writeJsonl(codexSessionFile, [
        JSON.stringify({
          timestamp: "2026-03-01T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-stale", cwd: siblingWorktree },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", text: "stale roots replay" },
        }),
      ]);

      const firstRun = await syncCodexHistory({
        projectPath,
        codexSessionsRoot,
        mirrorRoot,
        pipeline: createPipeline(mirrorRoot),
      });
      expect(firstRun.matchedFiles).toBe(0);
      expect(firstRun.importedEvents).toBe(0);

      const secondRun = await syncCodexHistory({
        projectPath,
        projectPaths: [projectPath, siblingWorktree],
        codexSessionsRoot,
        mirrorRoot,
        pipeline: createPipeline(mirrorRoot),
      });
      expect(secondRun.matchedFiles).toBe(1);
      expect(secondRun.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores imported codex history events with the codex_history source", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-codex-source-"));
    const projectPath = join(root, "repo-main");
    const codexSessionsRoot = join(root, "codex-sessions");
    const mirrorRoot = join(root, "mirror");
    const codexSessionFile = join(codexSessionsRoot, "2026", "03", "session-source.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await writeJsonl(codexSessionFile, [
        JSON.stringify({
          timestamp: "2026-03-01T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-session-source", cwd: projectPath },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", text: "hello from codex history" },
        }),
      ]);

      const summary = await syncCodexHistory({
        projectPath,
        codexSessionsRoot,
        mirrorRoot,
        pipeline: createPipeline(mirrorRoot),
      });
      expect(summary.importedEvents).toBeGreaterThan(0);

      const query = new QueryService(mirrorRoot);
      const events = await query.getTimeline({
        repoId: repoIdFromPath(projectPath),
        sessionId: "codex-session-source",
      });

      expect(events.some((event) => event.eventType === "prompt.submitted" && event.source === "codex_history")).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads unchanged Claude files when the saved cursor lacks session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-claude-stale-cursor-"));
    const projectPath = join(root, "repo-main");
    const claudeProjectsRoot = join(root, "claude-projects");
    const mirrorRoot = join(root, "mirror");
    const claudeFile = join(claudeProjectsRoot, "session-stale.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await writeJsonl(claudeFile, [
        JSON.stringify({
          type: "user",
          timestamp: "2026-03-01T10:00:00.000Z",
          sessionId: "claude-session-stale",
          cwd: projectPath,
          message: {
            content: [{ type: "text", text: "hello from claude" }],
          },
        }),
      ]);

      const fileInfo = await stat(claudeFile);
      const repoId = repoIdFromPath(projectPath);
      const statePath = join(mirrorRoot, "index", repoId, "claude-history-sync.json");
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            files: {
              [claudeFile]: {
                lineCount: 1,
                sequence: 0,
                sessionId: null,
                cwd: null,
                projectRootsKey: createProjectRootMatcher(projectPath).projectRootsKey,
                updatedAt: "2026-03-01T10:01:00.000Z",
                sizeBytes: fileInfo.size,
                mtimeMs: fileInfo.mtimeMs,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const summary = await syncClaudeHistory({
        projectPath,
        claudeProjectsRoot,
        mirrorRoot,
        pipeline: createPipeline(mirrorRoot),
      });

      expect(summary.matchedFiles).toBe(1);
      expect(summary.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads unchanged Gemini files when the saved cursor lacks session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-gemini-stale-cursor-"));
    const projectPath = join(root, "repo-main");
    const geminiHistoryRoot = join(root, "gemini-history");
    const mirrorRoot = join(root, "mirror");
    const projectDir = join(geminiHistoryRoot, "project-1");
    const transcriptFile = join(projectDir, "session-stale.jsonl");

    try {
      await mkdir(projectPath, { recursive: true });
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, ".project_root"), `${projectPath}\n`, "utf8");
      await writeJsonl(transcriptFile, [
        JSON.stringify({
          role: "user",
          text: "hello from gemini",
          sessionId: "gemini-session-stale",
          cwd: projectPath,
          timestamp: "2026-03-01T10:00:00.000Z",
        }),
      ]);

      const fileInfo = await stat(transcriptFile);
      const repoId = repoIdFromPath(projectPath);
      const statePath = join(mirrorRoot, "index", repoId, "gemini-history-sync.json");
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            files: {
              [transcriptFile]: {
                entryCount: 1,
                sequence: 0,
                sessionId: null,
                cwd: null,
                projectRootsKey: createProjectRootMatcher(projectPath).projectRootsKey,
                updatedAt: "2026-03-01T10:01:00.000Z",
                sizeBytes: fileInfo.size,
                mtimeMs: fileInfo.mtimeMs,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const summary = await syncGeminiHistory({
        projectPath,
        geminiHistoryRoot,
        mirrorRoot,
        pipeline: createPipeline(mirrorRoot),
      });

      expect(summary.matchedFiles).toBe(1);
      expect(summary.importedEvents).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
