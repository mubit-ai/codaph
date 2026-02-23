import { describe, expect, it } from "vitest";
import { extractFinalResponse } from "../src/lib/adapter-codex-sdk";

describe("adapter-codex-sdk helpers", () => {
  it("extracts final response from completed agent message", () => {
    const event = {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "Done",
      },
    } as const;

    expect(extractFinalResponse(event as never)).toBe("Done");
  });

  it("returns null for non-agent-message events", () => {
    const event = {
      type: "item.completed",
      item: {
        type: "file_change",
      },
    } as const;

    expect(extractFinalResponse(event as never)).toBeNull();
  });
});
