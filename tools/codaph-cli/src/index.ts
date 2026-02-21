#!/usr/bin/env bun
import { resolve } from "node:path";
import { repoIdFromPath } from "@codaph/core-types";
import { JsonlMirror } from "@codaph/mirror-jsonl";
import { IngestPipeline } from "@codaph/ingest-pipeline";
import { CodexSdkAdapter } from "@codaph/adapter-codex-sdk";
import { CodexExecAdapter } from "@codaph/adapter-codex-exec";
import { QueryService } from "@codaph/query-service";

type Flags = Record<string, string | boolean>;

function parseArgs(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positionals, flags };
}

function help(): string {
  return [
    "Codaph CLI",
    "",
    "Commands:",
    "  codaph run \"<prompt>\" [--model <name>] [--cwd <path>] [--resume-thread <id>]",
    "  codaph exec \"<prompt>\" [--model <name>] [--cwd <path>] [--resume-thread <id>]",
    "  codaph sessions list [--cwd <path>]",
    "  codaph timeline --session <id> [--cwd <path>] [--json]",
    "  codaph diff --session <id> [--path <file>] [--cwd <path>]",
  ].join("\n");
}

function getStringFlag(flags: Flags, key: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" ? val : undefined;
}

async function runCapture(command: "run" | "exec", rest: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(rest);
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    throw new Error("Prompt is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const mirrorRoot = resolve(cwd, ".codaph");
  const mirror = new JsonlMirror(mirrorRoot);
  const pipeline = new IngestPipeline(mirror);

  const options = {
    prompt,
    cwd,
    model: getStringFlag(flags, "model"),
    resumeThreadId: getStringFlag(flags, "resume-thread"),
  };

  const adapter = command === "run" ? new CodexSdkAdapter(pipeline) : new CodexExecAdapter(pipeline);

  const result = await adapter.runAndCapture(options, (event) => {
    const itemType = (event.payload.item as { type?: string } | undefined)?.type;
    console.log(`${event.ts} ${event.eventType}${itemType ? `:${itemType}` : ""}`);
  });

  console.log(`sessionId: ${result.sessionId}`);
  console.log(`threadId: ${result.threadId ?? "(none)"}`);
  if (result.finalResponse) {
    console.log("\nfinalResponse:\n");
    console.log(result.finalResponse);
  }
}

async function listSessions(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const repoId = repoIdFromPath(cwd);
  const query = new QueryService(resolve(cwd, ".codaph"));
  const sessions = await query.listSessions(repoId);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  for (const s of sessions) {
    console.log(`${s.sessionId} | ${s.from} -> ${s.to} | events=${s.eventCount} | threads=${s.threadCount}`);
  }
}

async function timeline(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const repoId = repoIdFromPath(cwd);
  const query = new QueryService(resolve(cwd, ".codaph"));
  const events = await query.getTimeline({ repoId, sessionId });

  if (flags.json === true) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  for (const event of events) {
    const itemType = (event.payload.item as { type?: string } | undefined)?.type;
    console.log(`${event.ts} | ${event.eventType}${itemType ? `:${itemType}` : ""}`);
  }
}

async function diff(rest: string[]): Promise<void> {
  const { flags } = parseArgs(rest);
  const sessionId = getStringFlag(flags, "session");
  if (!sessionId) {
    throw new Error("--session is required");
  }

  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd());
  const repoId = repoIdFromPath(cwd);
  const pathFilter = getStringFlag(flags, "path");

  const query = new QueryService(resolve(cwd, ".codaph"));
  const summary = await query.getDiffSummary(repoId, sessionId, pathFilter);

  if (summary.length === 0) {
    console.log("No file changes found.");
    return;
  }

  for (const row of summary) {
    console.log(`${row.path} | kinds=${row.kinds.join(",")} | occurrences=${row.occurrences}`);
  }
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(help());
    return;
  }

  if (cmd === "run") {
    await runCapture("run", [sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "exec") {
    await runCapture("exec", [sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "sessions" && sub === "list") {
    await listSessions(rest);
    return;
  }

  if (cmd === "timeline") {
    await timeline([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  if (cmd === "diff") {
    await diff([sub, ...rest].filter(Boolean) as string[]);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
