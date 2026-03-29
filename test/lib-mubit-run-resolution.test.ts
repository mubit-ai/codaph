import { describe, expect, it } from "vitest";
import { resolveMubitCommandRunId } from "../src/lib/mubit-run-resolution";

describe("mubit-run-resolution", () => {
  it("uses the explicit session run when a session id is provided", () => {
    const runId = resolveMubitCommandRunId({
      repoId: "owner/repo",
      projectId: "owner/repo",
      runScope: "project",
      sessionId: "session-123",
    });

    expect(runId).toBe("codaph:owner/repo:session-123");
  });

  it("still allows callers to force the project run explicitly", () => {
    const runId = resolveMubitCommandRunId({
      repoId: "owner/repo",
      projectId: "owner/repo",
      runScope: "session",
      sessionId: "session-123",
      preferProject: true,
    });

    expect(runId).toBe("codaph:owner/repo");
  });
});
