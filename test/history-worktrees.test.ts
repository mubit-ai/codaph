import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncCodexHistory } from "../src/codex-history-sync";
import { syncClaudeHistory } from "../src/claude-history-sync";
import { syncGeminiHistory } from "../src/gemini-history-sync";
import { JsonlMirror } from "../src/lib/mirror-jsonl";
import { IngestPipeline } from "../src/lib/ingest-pipeline";

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
});
