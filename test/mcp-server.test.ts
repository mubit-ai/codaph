import { afterEach, describe, expect, it, vi } from "vitest";
import { MubitMemoryEngine } from "../src/lib/memory-mubit";
import { codaphMcpToolSchemasForTest } from "../src/mcp-server";

describe("mcp-server", () => {
  const originalApiKey = process.env.MUBIT_API_KEY;

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.MUBIT_API_KEY;
    } else {
      process.env.MUBIT_API_KEY = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  it("exposes MuBit activity filters through the MCP activity tool", async () => {
    process.env.MUBIT_API_KEY = "mbt_test";
    const calls: Array<Record<string, unknown>> = [];
    const listActivity = vi
      .spyOn(MubitMemoryEngine.prototype, "listActivity")
      .mockImplementation(async (payload) => {
        calls.push(payload as unknown as Record<string, unknown>);
        return { entries: [] };
      });

    const tool = codaphMcpToolSchemasForTest().find((entry) => entry.name === "codaph_mubit_activity");
    expect(tool).toBeTruthy();
    expect(tool?.inputSchema).toMatchObject({
      properties: {
        excludeDerived: { type: "boolean" },
        projection: { type: "string", enum: ["compact", "full"] },
      },
    });

    await tool?.handler(
      {
        cwd: "/Users/shankha/code/codaph",
        limit: 10,
        excludeDerived: true,
        projection: "compact",
      },
      { defaultCwd: "/Users/shankha/code/codaph" },
    );

    expect(listActivity).toHaveBeenCalledOnce();
    expect(calls[0]).toMatchObject({
      runId: "codaph:anilperi/codaph",
      limit: 10,
      excludeDerived: true,
      projection: "compact",
    });
  });
});
