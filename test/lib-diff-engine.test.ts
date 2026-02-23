import { describe, expect, it } from "vitest";
import { extractFileDiffs } from "../src/lib/diff-engine";
import type { CapturedEventEnvelope } from "../src/lib/core-types";

describe("diff-engine", () => {
  it("extracts file_change item payloads", () => {
    const events: CapturedEventEnvelope[] = [
      {
        eventId: "1",
        source: "codex_sdk",
        repoId: "r",
        actorId: null,
        sessionId: "s",
        threadId: "t",
        ts: new Date().toISOString(),
        eventType: "item.completed",
        reasoningAvailability: "unavailable",
        payload: {
          item: {
            type: "file_change",
            changes: [
              { path: "a.ts", kind: "update" },
              { path: "b.ts", kind: "add" },
            ],
          },
        },
      },
    ];

    const diffs = extractFileDiffs(events);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]?.path).toBe("a.ts");
  });
});
