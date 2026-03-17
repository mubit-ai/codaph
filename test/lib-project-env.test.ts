import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findNearestEnvDirectory, loadProjectEnv, parseEnvFile } from "../src/lib/project-env";

describe("project-env", () => {
  it("parses basic dotenv syntax", () => {
    expect(
      parseEnvFile([
        "# comment",
        "MUBIT_REGION=EU",
        "export MUBIT_HTTP_ENDPOINT=https://api.eu.mubit.ai",
        "QUOTED='hello world'",
        "DOUBLE=\"line\\nvalue\"",
        "INLINE=value # trailing comment",
      ].join("\n")),
    ).toEqual({
      MUBIT_REGION: "EU",
      MUBIT_HTTP_ENDPOINT: "https://api.eu.mubit.ai",
      QUOTED: "hello world",
      DOUBLE: "line\nvalue",
      INLINE: "value",
    });
  });

  it("loads the nearest project .env without overriding exported vars", async () => {
    const root = await mkdtemp(join(tmpdir(), "codaph-project-env-"));
    const nested = join(root, "packages", "cli");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, ".env"),
      [
        "MUBIT_REGION=EU",
        "MUBIT_HTTP_ENDPOINT=https://api.eu.mubit.ai",
        "MUBIT_GRPC_ENDPOINT=grpc.api.eu.mubit.ai:443",
      ].join("\n"),
    );
    await writeFile(
      join(root, ".env.local"),
      "MUBIT_HTTP_ENDPOINT=https://override.example",
    );

    const env: Record<string, string | undefined> = {
      MUBIT_GRPC_ENDPOINT: "grpc.exported.example:443",
    };

    try {
      expect(findNearestEnvDirectory(nested)).toBe(root);
      const loaded = loadProjectEnv(nested, env);
      expect(loaded).toEqual([join(root, ".env"), join(root, ".env.local")]);
      expect(env.MUBIT_REGION).toBe("EU");
      expect(env.MUBIT_HTTP_ENDPOINT).toBe("https://override.example");
      expect(env.MUBIT_GRPC_ENDPOINT).toBe("grpc.exported.example:443");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
