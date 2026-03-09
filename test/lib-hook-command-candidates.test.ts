import { describe, expect, it } from "vitest";
import { buildHookCommandCandidates } from "../src/lib/hook-command-candidates";

describe("buildHookCommandCandidates", () => {
  it("uses portable bun run syntax for repo-local source installs", () => {
    const commands = buildHookCommandCandidates({
      hookName: "post-commit",
      scriptPath: "/tmp/codaph/src/index.ts",
      moduleUrl: "file:///tmp/codaph/src/index.ts",
    });

    expect(commands[0]).toBe("bun run --cwd '/tmp/codaph' cli hooks run post-commit --quiet");
    expect(commands.some((command) => command.includes("bun --cwd"))).toBe(false);
  });

  it("preserves provider flag for agent-complete hooks", () => {
    const commands = buildHookCommandCandidates({
      hookName: "agent-complete",
      provider: "claude-code",
      scriptPath: "/tmp/codaph/src/index.ts",
      moduleUrl: "file:///tmp/codaph/src/index.ts",
    });

    expect(commands[0]).toContain("--provider 'claude-code'");
  });
});
