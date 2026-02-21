import { describe, expect, it } from "vitest";
import { buildArgs, parseExecJsonLine } from "../src/index";

describe("adapter-codex-exec", () => {
  it("parses valid json line", () => {
    const line = '{"type":"turn.started"}';
    const parsed = parseExecJsonLine(line);
    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed json line", () => {
    const parsed = parseExecJsonLine("{this is invalid}");
    expect(parsed.ok).toBe(false);
  });

  it("builds args for normal exec", () => {
    const args = buildArgs({
      prompt: "Hello",
      cwd: "/tmp",
      model: "o3",
    });
    expect(args).toEqual(["exec", "--json", "--cd", "/tmp", "--model", "o3", "Hello"]);
  });

  it("builds args for resume exec", () => {
    const args = buildArgs({
      prompt: "Continue",
      cwd: "/tmp",
      resumeThreadId: "thread-1",
    });
    expect(args.slice(0, 5)).toEqual(["exec", "resume", "thread-1", "--json", "--cd"]);
  });
});
