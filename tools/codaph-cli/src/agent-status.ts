import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AgentStatusSnapshot } from "@codaph/core-types";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function parseGitStatusPorcelain(status: string): {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  changedFiles: string[];
} {
  const lines = status.split("\n").filter(Boolean);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  const changedFiles = new Set<string>();

  for (const line of lines) {
    if (line.startsWith("??")) {
      untrackedCount += 1;
      const p = line.slice(3).trim();
      if (p) {
        changedFiles.add(p);
      }
      continue;
    }

    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const p = line.slice(3).trim();

    if (x !== " ") {
      stagedCount += 1;
    }
    if (y !== " ") {
      unstagedCount += 1;
    }
    if (p) {
      changedFiles.add(p);
    }
  }

  return {
    stagedCount,
    unstagedCount,
    untrackedCount,
    changedFiles: [...changedFiles].sort(),
  };
}

export function formatSnapshot(snapshot: AgentStatusSnapshot): string {
  const files = snapshot.changedFiles.length > 0 ? snapshot.changedFiles.join(", ") : "(none)";
  return [
    `## Status Snapshot — ${snapshot.ts}`,
    `- source: ${snapshot.source}`,
    `- repo: ${snapshot.repoPath}`,
    `- branch: ${snapshot.branch ?? "(none)"}`,
    `- head: ${snapshot.headSha ?? "(none)"}`,
    `- staged: ${snapshot.stagedCount}`,
    `- unstaged: ${snapshot.unstagedCount}`,
    `- untracked: ${snapshot.untrackedCount}`,
    `- files: ${files}`,
  ].join("\n");
}

export async function collectSnapshot(source: AgentStatusSnapshot["source"]): Promise<AgentStatusSnapshot> {
  const cwd = process.cwd();
  const repoPath = runGit(["rev-parse", "--show-toplevel"], cwd);

  let branch: string | null = null;
  let headSha: string | null = null;

  try {
    branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  } catch {
    branch = null;
  }

  try {
    headSha = runGit(["rev-parse", "--short", "HEAD"], repoPath);
  } catch {
    headSha = null;
  }

  const status = runGit(["status", "--porcelain"], repoPath);
  const parsed = parseGitStatusPorcelain(status);

  return {
    ts: new Date().toISOString(),
    repoPath: resolve(repoPath),
    branch,
    headSha,
    stagedCount: parsed.stagedCount,
    unstagedCount: parsed.unstagedCount,
    untrackedCount: parsed.untrackedCount,
    changedFiles: parsed.changedFiles,
    source,
  };
}

export async function appendSnapshotToAgentMd(snapshot: AgentStatusSnapshot): Promise<void> {
  const target = resolve(snapshot.repoPath, "AGENT.md");

  if (!existsSync(target)) {
    const header = [
      "# AGENT.md",
      "",
      "Append-only status log for Codaph repository changes.",
      "Do not rewrite history; append a new snapshot each run.",
      "",
    ].join("\n");
    await writeFile(target, header, "utf8");
  }

  const existing = await readFile(target, "utf8");
  const prefix = existing.endsWith("\n") ? "\n" : "\n\n";
  await appendFile(target, `${prefix}${formatSnapshot(snapshot)}\n`, "utf8");
}
