import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  repoIdFromPath,
  type AdapterRunOptions,
  type AdapterRunResult,
  type CapturedEventEnvelope,
  type CodexAdapter,
} from "@codaph/core-types";
import { IngestPipeline } from "@codaph/ingest-pipeline";

export type ParsedExecLine =
  | { ok: true; event: Record<string, unknown> }
  | { ok: false; error: string };

export function parseExecJsonLine(line: string): ParsedExecLine {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed.type || typeof parsed.type !== "string") {
      return { ok: false, error: "Missing event type" };
    }
    return { ok: true, event: parsed };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON line",
    };
  }
}

function buildArgs(options: AdapterRunOptions): string[] {
  if (options.resumeThreadId) {
    const args = ["exec", "resume", options.resumeThreadId, "--json", "--cd", options.cwd];
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push(options.prompt);
    return args;
  }

  const args = ["exec", "--json", "--cd", options.cwd];
  if (options.model) {
    args.push("--model", options.model);
  }
  args.push(options.prompt);
  return args;
}

export class CodexExecAdapter implements CodexAdapter {
  constructor(private readonly pipeline: IngestPipeline) {}

  async runAndCapture(
    options: AdapterRunOptions,
    onEvent?: (event: CapturedEventEnvelope) => Promise<void> | void,
  ): Promise<AdapterRunResult> {
    const sessionId = randomUUID();
    const repoId = options.repoId ?? repoIdFromPath(options.cwd);
    const args = buildArgs(options);

    let sequence = 0;
    let threadId: string | null = options.resumeThreadId ?? null;
    let finalResponse: string | null = null;

    sequence += 1;
    const promptEvent = await this.pipeline.ingest(
      "prompt.submitted",
      {
        prompt: options.prompt,
        model: options.model ?? null,
        resumeThreadId: options.resumeThreadId ?? null,
      },
      {
        source: "codex_exec",
        repoId,
        sessionId,
        threadId,
        sequence,
      },
    );
    if (onEvent) {
      await onEvent(promptEvent);
    }

    const child = spawn("codex", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });

    const reader = readline.createInterface({ input: child.stdout });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      await this.pipeline.ingestRawLine(sessionId, trimmed);
      const parsed = parseExecJsonLine(trimmed);

      if (!parsed.ok) {
        sequence += 1;
        const captured = await this.pipeline.ingest(
          "error",
          {
            message: parsed.error,
            raw: trimmed,
          },
          {
            source: "codex_exec",
            repoId,
            sessionId,
            threadId,
            sequence,
          },
        );
        if (onEvent) {
          await onEvent(captured);
        }
        continue;
      }

      const eventType = parsed.event.type as string;
      if (eventType === "thread.started" && typeof parsed.event.thread_id === "string") {
        threadId = parsed.event.thread_id;
      }

      sequence += 1;
      const captured = await this.pipeline.ingest(eventType, parsed.event, {
        source: "codex_exec",
        repoId,
        sessionId,
        threadId,
        sequence,
      });

      if (
        eventType === "item.completed" &&
        (parsed.event.item as { type?: string; text?: string } | undefined)?.type === "agent_message"
      ) {
        finalResponse = (parsed.event.item as { text?: string }).text ?? finalResponse;
      }

      if (onEvent) {
        await onEvent(captured);
      }
    }

    const exitCode: number = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (exitCode !== 0) {
      sequence += 1;
      await this.pipeline.ingest(
        "error",
        {
          message: `codex exec exited with code ${exitCode}`,
          stderr: stderrChunks.join(""),
        },
        {
          source: "codex_exec",
          repoId,
          sessionId,
          threadId,
          sequence,
        },
      );
      throw new Error(`codex exec failed with code ${exitCode}`);
    }

    return {
      sessionId,
      threadId,
      finalResponse,
    };
  }
}

export { buildArgs };
