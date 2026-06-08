import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installClaudeCodeHooksBestEffort,
  installCodexHooksBestEffort,
  installGeminiHooksBestEffort,
  type ClaudeHookSpec,
} from "../src/sync-automation";

const root = mkdtempSync(join(tmpdir(), "codaph-xagent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const specs: ClaudeHookSpec[] = [
  { event: "SessionStart", matcher: "*", command: "codaph hooks run session-start --provider X --quiet" },
  { event: "PreToolUse", matcher: "*", command: "codaph hooks run pre-tool-use --provider X --quiet" },
];

describe("cross-agent hook installers", () => {
  it("writes Codex hooks.json with the shared entry shape", async () => {
    const dir = repo("codex");
    const result = await installCodexHooksBestEffort(dir, specs);
    expect(result.ok).toBe(true);
    expect(result.installedPath).toBe(join(dir, ".codex", "hooks.json"));
    const json = JSON.parse(readFileSync(result.installedPath!, "utf8"));
    expect(json.hooks.SessionStart[0].hooks[0]).toEqual({
      type: "command",
      command: "codaph hooks run session-start --provider X --quiet",
    });
    expect(json.hooks.PreToolUse[0].matcher).toBe("*");
  });

  it("writes Gemini settings.json and preserves the user's existing hooks + keys", async () => {
    const dir = repo("gemini");
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(
      join(dir, ".gemini", "settings.json"),
      JSON.stringify({ theme: "dark", hooks: { BeforeTool: [{ matcher: "*", hooks: [{ type: "command", command: "user-hook" }] }] } }),
    );
    const result = await installGeminiHooksBestEffort(dir, [
      { event: "BeforeAgent", matcher: "*", command: "codaph hooks run user-prompt-submit --provider gemini-cli --quiet" },
    ]);
    expect(result.ok).toBe(true);
    const json = JSON.parse(readFileSync(result.installedPath!, "utf8"));
    expect(json.theme).toBe("dark"); // unrelated keys preserved
    expect(json.hooks.BeforeTool[0].hooks[0].command).toBe("user-hook"); // user hook preserved
    expect(json.hooks.BeforeAgent[0].hooks[0].command).toContain("user-prompt-submit");
  });

  it("is idempotent: re-installing the same specs adds nothing", async () => {
    const dir = repo("idem");
    const first = await installClaudeCodeHooksBestEffort(dir, specs);
    expect(first.installedEvents.length).toBe(2);
    const second = await installClaudeCodeHooksBestEffort(dir, specs);
    expect(second.installedEvents.length).toBe(0); // already present
    const json = JSON.parse(readFileSync(second.installedPath!, "utf8"));
    expect(json.hooks.SessionStart).toHaveLength(1); // not duplicated
  });
});
