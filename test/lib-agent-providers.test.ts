import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROVIDER_ORDER,
  detectAgentProvidersForRepo,
  formatAgentProviderList,
  normalizeAgentProviderList,
  parseProvidersFlag,
} from "../src/lib/agent-providers";

describe("agent-providers", () => {
  it("normalizes aliases and preserves canonical provider order", () => {
    const normalized = normalizeAgentProviderList(["gemini", "codex", "claudecode", "geminicli"]);
    expect(normalized).toEqual(["codex", "claude-code", "gemini-cli"]);
  });

  it("parses provider flag variants", () => {
    expect(parseProvidersFlag("auto")).toEqual({ kind: "auto" });
    expect(parseProvidersFlag("all")).toEqual({ kind: "all" });
    expect(parseProvidersFlag("codex,claude,geminicli")).toEqual({
      kind: "providers",
      providers: ["codex", "claude-code", "gemini-cli"],
    });
    expect(() => parseProvidersFlag("unknown")).toThrow(/Supported providers/i);
  });

  it("detects recognized provider marker folders in fixed order", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-provider-detect-"));
    try {
      await mkdir(join(root, ".gemini"), { recursive: true });
      await mkdir(join(root, ".claude"), { recursive: true });
      const detected = await detectAgentProvidersForRepo(root);
      expect(detected).toEqual(["claude-code", "gemini-cli"]);
      expect(AGENT_PROVIDER_ORDER).toEqual(["codex", "claude-code", "gemini-cli"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formats provider labels for CLI output", () => {
    expect(formatAgentProviderList(["codex", "claude-code"])).toBe("Codex, Claude Code");
    expect(formatAgentProviderList([])).toBe("(none)");
  });
});
