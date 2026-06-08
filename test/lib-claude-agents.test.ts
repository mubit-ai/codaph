import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODAPH_EXPLORER_AGENT, CODAPH_MANAGED_AGENTS, CODAPH_AGENT_MARKER } from "../src/lib/claude-agents";
import { installClaudeCodeAgentsBestEffort } from "../src/sync-automation";

const root = mkdtempSync(join(tmpdir(), "codaph-agents-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CODAPH_EXPLORER_AGENT template", () => {
  it("has valid frontmatter, haiku model, read-only + memory tools, and the managed marker", () => {
    const c = CODAPH_EXPLORER_AGENT.content;
    expect(CODAPH_EXPLORER_AGENT.name).toBe("codaph-explorer");
    expect(c.startsWith("---\n")).toBe(true);
    expect(c).toContain("name: codaph-explorer");
    expect(c).toContain("description:");
    expect(c).toContain("model: haiku"); // cheap model for the scout
    expect(c).toContain("tools: Read, Grep, Glob");
    expect(c).toContain("mcp__codaph__codaph_mubit_context"); // memory tool when MCP is set up
    expect(c).toContain(CODAPH_AGENT_MARKER);
    // The whole point: return compact summaries, not file dumps.
    expect(c.toLowerCase()).toContain("compact");
    expect(c).toMatch(/do not paste whole files/i);
  });
});

describe("installClaudeCodeAgentsBestEffort", () => {
  it("writes the subagent definition under .claude/agents/", async () => {
    const dir = repo("fresh");
    const r = await installClaudeCodeAgentsBestEffort(dir, CODAPH_MANAGED_AGENTS);
    expect(r.ok).toBe(true);
    expect(r.installed).toContain("codaph-explorer");
    const path = join(dir, ".claude", "agents", "codaph-explorer.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("name: codaph-explorer");
  });

  it("is idempotent — re-installing the same content writes nothing", async () => {
    const dir = repo("idem");
    await installClaudeCodeAgentsBestEffort(dir, CODAPH_MANAGED_AGENTS);
    const second = await installClaudeCodeAgentsBestEffort(dir, CODAPH_MANAGED_AGENTS);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toContain("codaph-explorer");
  });

  it("updates its own managed file when the template changes", async () => {
    const dir = repo("update");
    const path = join(dir, ".claude", "agents", "codaph-explorer.md");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    // An older codaph-managed version (carries the marker) gets refreshed.
    writeFileSync(path, `old codaph-explorer\n${CODAPH_AGENT_MARKER}\n`);
    const r = await installClaudeCodeAgentsBestEffort(dir, CODAPH_MANAGED_AGENTS);
    expect(r.installed).toContain("codaph-explorer");
    expect(readFileSync(path, "utf8")).toContain("model: haiku");
  });

  it("never clobbers a user-customized agent of the same name (no marker)", async () => {
    const dir = repo("usercustom");
    const path = join(dir, ".claude", "agents", "codaph-explorer.md");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    const userContent = "---\nname: codaph-explorer\n---\nMY custom agent, hands off.";
    writeFileSync(path, userContent);
    const r = await installClaudeCodeAgentsBestEffort(dir, CODAPH_MANAGED_AGENTS);
    expect(r.installed).toEqual([]);
    expect(r.skipped).toContain("codaph-explorer");
    expect(readFileSync(path, "utf8")).toBe(userContent); // untouched
  });
});
