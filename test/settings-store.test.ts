import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { removeProjectSettings, type CodaphSettings } from "../src/settings-store";

describe("settings-store", () => {
  it("removes a project settings entry using a normalized path key", () => {
    const key = resolve("/tmp/example-project");
    const input: CodaphSettings = {
      projects: {
        [key]: { projectName: "Example" },
        [resolve("/tmp/other")]: { projectName: "Other" },
      },
    };

    const next = removeProjectSettings(input, "/tmp/example-project");
    expect(next.projects?.[key]).toBeUndefined();
    expect(next.projects?.[resolve("/tmp/other")]?.projectName).toBe("Other");
  });

  it("is a no-op when the project path is missing", () => {
    const key = resolve("/tmp/kept");
    const input: CodaphSettings = {
      projects: {
        [key]: { mubitProjectId: "owner/repo" },
      },
    };

    const next = removeProjectSettings(input, "/tmp/missing");
    expect(next.projects).toEqual(input.projects);
  });

  it("preserves global settings while removing a project entry", () => {
    const key = resolve("/tmp/remove-me");
    const input: CodaphSettings = {
      mubitApiKey: "mubit-key",
      openAiApiKey: "openai-key",
      mubitActorId: "anil",
      projects: {
        [key]: { projectName: "Remove Me" },
      },
    };

    const next = removeProjectSettings(input, key);
    expect(next.mubitApiKey).toBe("mubit-key");
    expect(next.openAiApiKey).toBe("openai-key");
    expect(next.mubitActorId).toBe("anil");
    expect(next.projects).toEqual({});
  });
});
