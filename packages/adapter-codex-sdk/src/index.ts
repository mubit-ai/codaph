import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import {
  repoIdFromPath,
  type AdapterRunOptions,
  type AdapterRunResult,
  type CapturedEventEnvelope,
  type CodexAdapter,
} from "@codaph/core-types";
import { IngestPipeline } from "@codaph/ingest-pipeline";

export interface CodexSdkAdapterInit {
  pipeline: IngestPipeline;
  codex?: Codex;
}

function resolveCodexPathOverride(): string | undefined {
  const envOverride = process.env.CODAPH_CODEX_PATH ?? process.env.CODEX_PATH;
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim();
  }

  const lookupCmd = process.platform === "win32" ? "where" : "which";
  const lookup = spawnSync(lookupCmd, ["codex"], { encoding: "utf8" });
  if (lookup.status !== 0) {
    return undefined;
  }

  const firstLine = lookup.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine;
}

function extractFinalResponse(event: ThreadEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }

  const item = event.item as { type?: string; text?: string };
  if (item?.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }

  return null;
}

function toThreadOptions(options: AdapterRunOptions): ThreadOptions {
  return {
    model: options.model,
    workingDirectory: options.cwd,
  };
}

export class CodexSdkAdapter implements CodexAdapter {
  private readonly codex: Codex;

  constructor(private readonly pipeline: IngestPipeline, codex?: Codex) {
    if (codex) {
      this.codex = codex;
      return;
    }

    const codexPathOverride = resolveCodexPathOverride();
    this.codex = codexPathOverride
      ? new Codex({ codexPathOverride })
      : new Codex();
  }

  async runAndCapture(
    options: AdapterRunOptions,
    onEvent?: (event: CapturedEventEnvelope) => Promise<void> | void,
  ): Promise<AdapterRunResult> {
    const sessionId = randomUUID();
    const repoId = repoIdFromPath(options.cwd);
    let sequence = 0;
    let threadId: string | null = options.resumeThreadId ?? null;
    let finalResponse: string | null = null;

    try {
      sequence += 1;
      const promptEvent = await this.pipeline.ingest(
        "prompt.submitted",
        {
          prompt: options.prompt,
          model: options.model ?? null,
          resumeThreadId: options.resumeThreadId ?? null,
        },
        {
          source: "codex_sdk",
          repoId,
          sessionId,
          threadId,
          sequence,
        },
      );
      if (onEvent) {
        await onEvent(promptEvent);
      }

      const thread = options.resumeThreadId
        ? this.codex.resumeThread(options.resumeThreadId, toThreadOptions(options))
        : this.codex.startThread(toThreadOptions(options));

      const streamed = await thread.runStreamed(options.prompt);

      for await (const event of streamed.events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
        }

        sequence += 1;
        await this.pipeline.ingestRawLine(sessionId, JSON.stringify(event));
        const captured = await this.pipeline.ingest(
          event.type,
          event as unknown as Record<string, unknown>,
          {
            source: "codex_sdk",
            repoId,
            sessionId,
            threadId,
            sequence,
          },
        );

        const maybeFinal = extractFinalResponse(event);
        if (maybeFinal) {
          finalResponse = maybeFinal;
        }

        if (onEvent) {
          await onEvent(captured);
        }
      }

      return {
        sessionId,
        threadId,
        finalResponse,
      };
    } catch (error) {
      sequence += 1;
      await this.pipeline.ingest(
        "error",
        {
          message: error instanceof Error ? error.message : String(error),
          source: "sdk-run",
        },
        {
          source: "codex_sdk",
          repoId,
          sessionId,
          threadId,
          sequence,
        },
      );
      throw error;
    }
  }
}

export { extractFinalResponse };
