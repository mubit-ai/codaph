import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installClaudeCodeAgentCompleteHookBestEffort,
  installGeminiCliAgentCompleteHookBestEffort,
  normalizeSyncAutomationSettings,
} from "../src/sync-automation";

describe("sync-automation provider hooks", () => {
  it("normalizes legacy agentComplete=true to Codex provider", () => {
    const normalized = normalizeSyncAutomationSettings({ agentComplete: true });
    expect(normalized.agentComplete).toBe(true);
    expect(normalized.agentCompleteProviders).toEqual(["codex"]);
  });

  it("installs Claude Code agent-complete hook into .claude/settings.json idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-claude-hook-"));
    try {
      const first = await installClaudeCodeAgentCompleteHookBestEffort(root);
      expect(first.ok).toBe(true);

      const second = await installClaudeCodeAgentCompleteHookBestEffort(root);
      expect(second.ok).toBe(true);

      const settingsPath = join(root, ".claude", "settings.json");
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      const hooks = parsed.hooks as Record<string, unknown>;
      const stopEntries = hooks.Stop as Array<Record<string, unknown>>;
      expect(Array.isArray(stopEntries)).toBe(true);
      expect(stopEntries).toHaveLength(1);
      expect((stopEntries[0]?.hooks as Array<Record<string, unknown>>)?.[0]?.command).toContain(
        "--provider claude-code",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a warning when Claude settings JSON is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-claude-hook-invalid-"));
    try {
      await mkdir(join(root, ".claude"), { recursive: true });
      await writeFile(join(root, ".claude", "settings.json"), "{not-json", "utf8");
      const result = await installClaudeCodeAgentCompleteHookBestEffort(root);
      expect(result.ok).toBe(false);
      expect(result.warning).toMatch(/invalid json/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs Gemini CLI agent-complete hook and preserves existing hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-gemini-hook-"));
    try {
      const settingsPath = join(root, ".gemini", "settings.json");
      await mkdir(join(root, ".gemini"), { recursive: true });
      await writeFile(
        settingsPath,
        `${JSON.stringify({ hooks: { AfterAgent: ["echo existing"] }, userSetting: true }, null, 2)}\n`,
        "utf8",
      );
      const first = await installGeminiCliAgentCompleteHookBestEffort(root);
      expect(first.ok).toBe(true);
      const second = await installGeminiCliAgentCompleteHookBestEffort(root);
      expect(second.ok).toBe(true);

      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
      expect(parsed.userSetting).toBe(true);
      const hooks = parsed.hooks as Record<string, unknown>;
      const afterAgent = hooks.AfterAgent as unknown[];
      expect(Array.isArray(afterAgent)).toBe(true);
      expect(afterAgent).toContain("echo existing");
      const codaphEntries = afterAgent.filter(
        (entry) => typeof entry === "string" && entry.includes("codaph hooks run agent-complete --provider gemini-cli"),
      );
      expect(codaphEntries).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
