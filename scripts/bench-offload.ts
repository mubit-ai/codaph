#!/usr/bin/env bun
//
// Live A/B for the SUBAGENT OFFLOAD lever, with real Claude Code.
//
// Runs the same exploration task two ways:
//   direct  — main agent reads files itself (--allowedTools Read Grep Glob)
//   offload — main agent may ONLY delegate (--allowedTools Task); it hands the
//             investigation to the codaph-explorer subagent (model: haiku), which
//             reads in its OWN context and returns a compact summary.
//
// It measures, per run: total billed $ (incl. the subagent), and the token split
// between the MAIN context (isSidechain:false) and the SUBAGENT context
// (isSidechain:true). The offload win is twofold: (1) the bulk stays in the
// subagent's context, so the MAIN context shrinks; (2) that bulk is processed by
// a cheap haiku subagent instead of the expensive main model — so $ drops even if
// total tokens don't.
//
// Run: bun scripts/bench-offload.ts   (cloud Mubit by default; needs `claude` auth)
// Tune: BENCH_MODEL (main model), BENCH_REPS.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODAPH_EXPLORER_AGENT } from "../src/lib/claude-agents";

const REPO = process.cwd();
const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";
const REPS = Number(process.env.BENCH_REPS ?? "2");
const PER_RUN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? "300000");
const TRANSCRIPT_DIR = join(homedir(), ".claude", "projects", REPO.replaceAll("/", "-"));
const AGENT_PATH = join(REPO, ".claude", "agents", "codaph-explorer.md");
const AGENT_BACKUP = `${AGENT_PATH}.offload-backup`;

const TASK =
  "Explain how Codaph's IngestPipeline writes events to BOTH the local JSONL mirror and Mubit, " +
  "including its batching, concurrency, and fail-open circuit-breaker behavior (the consecutive-error threshold). " +
  "Cite the key files and functions.";

type Mode = "direct" | "offload";

function promptFor(mode: Mode): string {
  if (mode === "offload") {
    return (
      `Use the codaph-explorer subagent (via the Agent tool) to investigate the codebase and return a compact summary, ` +
      `then answer based on its summary. Delegate ALL file reading and searching to the subagent — do not read files yourself.\n\n` +
      `Question: ${TASK}`
    );
  }
  return TASK;
}

function allowedToolsFor(mode: Mode): string[] {
  // The subagent-spawning tool is `Agent` (renamed from `Task` in CC v2.1.63).
  // Offload mode allows ONLY Agent → the main agent must delegate (no direct reads).
  return mode === "offload" ? ["Agent"] : ["Read", "Grep", "Glob"];
}

interface RunResult {
  mode: Mode;
  rep: number;
  ok: boolean;
  error: string | null;
  billedUsd: number;
  mainTokens: number;
  subTokens: number;
  totalTokens: number;
  numTurns: number;
  usedSubagent: boolean;
  subModel: string | null;
}

function installAgent(): void {
  mkdirSync(join(REPO, ".claude", "agents"), { recursive: true });
  if (existsSync(AGENT_PATH)) copyFileSync(AGENT_PATH, AGENT_BACKUP);
  writeFileSync(AGENT_PATH, CODAPH_EXPLORER_AGENT.content, "utf8");
}
function restoreAgent(): void {
  if (existsSync(AGENT_BACKUP)) {
    copyFileSync(AGENT_BACKUP, AGENT_PATH);
    rmSync(AGENT_BACKUP, { force: true });
  } else {
    rmSync(AGENT_PATH, { force: true });
  }
}

function runClaude(mode: Mode): Promise<{ json: any | null; error: string | null }> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      promptFor(mode),
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--max-turns",
      "30",
      "--allowedTools",
      ...allowedToolsFor(mode),
    ];
    const child = spawn("claude", args, { cwd: REPO, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, PER_RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      if (killed) return resolve({ json: null, error: `timed out` });
      try {
        resolve({ json: JSON.parse(out), error: null });
      } catch {
        resolve({ json: null, error: err.trim().slice(0, 200) || "unparseable" });
      }
    });
    child.on("error", (e) => resolve({ json: null, error: String(e) }));
  });
}

// Split transcript token usage between MAIN (isSidechain:false) and SUBAGENT
// (isSidechain:true) turns.
function analyze(sessionId: string): { main: number; sub: number; usedSub: boolean; subModel: string | null } {
  const path = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return { main: 0, sub: 0, usedSub: false, subModel: null };
  let main = 0;
  let sub = 0;
  let usedSub = false;
  let subModel: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    // Delegation in headless mode is detected by an `Agent` tool_use (the
    // subagent's own turns are NOT tagged isSidechain in -p transcripts; their
    // cost folds into total_cost_usd instead — so `sub` stays ~0 here by design).
    const blocks = Array.isArray(o?.message?.content) ? o.message.content : [];
    for (const b of blocks) {
      if (b?.type === "tool_use" && (b.name === "Agent" || b.name === "Task")) {
        usedSub = true;
        if (!subModel && typeof b.input?.subagent_type === "string") subModel = b.input.subagent_type;
      }
    }
    const u = o?.message?.usage;
    if (o?.type === "assistant" && u) {
      const t = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (o.isSidechain === true) {
        sub += t;
      } else {
        main += t;
      }
    }
  }
  return { main, sub, usedSub, subModel };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(mode: Mode, rep: number): Promise<RunResult> {
  const { json, error } = await runClaude(mode);
  const base: RunResult = {
    mode,
    rep,
    ok: false,
    error,
    billedUsd: 0,
    mainTokens: 0,
    subTokens: 0,
    totalTokens: 0,
    numTurns: 0,
    usedSubagent: false,
    subModel: null,
  };
  if (!json || json.is_error || !json.session_id) {
    base.error = error ?? json?.subtype ?? "claude error";
    return base;
  }
  await sleep(750);
  const a = analyze(json.session_id);
  return {
    ...base,
    ok: true,
    error: null,
    billedUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0,
    mainTokens: a.main,
    subTokens: a.sub,
    totalTokens: a.main + a.sub,
    numTurns: typeof json.num_turns === "number" ? json.num_turns : 0,
    usedSubagent: a.usedSub,
    subModel: a.subModel,
  };
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const k = (n: number) => Math.round(n).toLocaleString();
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

async function main() {
  if (!existsSync(TRANSCRIPT_DIR)) mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  installAgent();
  process.on("SIGINT", () => {
    restoreAgent();
    process.exit(130);
  });

  const rows: RunResult[] = [];
  try {
    const total = REPS * 2;
    let n = 0;
    for (let rep = 1; rep <= REPS; rep++) {
      for (const mode of ["direct", "offload"] as Mode[]) {
        n++;
        const r = await runOne(mode, rep);
        rows.push(r);
        const tag = r.ok
          ? `${usd(r.billedUsd)} · main ${k(r.mainTokens)} + sub ${k(r.subTokens)} tok · ${r.numTurns} turns${mode === "offload" ? (r.usedSubagent ? ` · delegated✓ (sub:${r.subModel ?? "?"})` : " · NO-DELEGATE?!") : ""}`
          : `ERROR: ${r.error}`;
        console.log(`[${n}/${total}] ${mode.padEnd(8)} rep${rep}  ${tag}`);
      }
    }
  } finally {
    restoreAgent();
  }

  const ok = rows.filter((r) => r.ok);
  const by = (m: Mode) => ok.filter((r) => r.mode === m);
  const line = "─".repeat(78);
  console.log(`\n${line}`);
  console.log(`  SUBAGENT-OFFLOAD BENCH — main ${MODEL}, subagent codaph-explorer (haiku)`);
  console.log(`  ${ok.length}/${rows.length} ok · ${REPS} rep(s)`);
  console.log(line);
  for (const m of ["direct", "offload"] as Mode[]) {
    const rs = by(m);
    console.log(
      `  ${m.padEnd(8)} billed ${usd(mean(rs.map((r) => r.billedUsd))).padStart(9)} · main-ctx ${k(mean(rs.map((r) => r.mainTokens))).padStart(8)} tok · sub-ctx ${k(mean(rs.map((r) => r.subTokens))).padStart(8)} tok · turns ${mean(rs.map((r) => r.numTurns)).toFixed(1)}`,
    );
  }
  const d = by("direct");
  const o = by("offload");
  if (d.length && o.length) {
    const dCost = mean(d.map((r) => r.billedUsd));
    const oCost = mean(o.map((r) => r.billedUsd));
    const dMain = mean(d.map((r) => r.mainTokens));
    const oMain = mean(o.map((r) => r.mainTokens));
    const costDelta = dCost - oCost;
    console.log(`\n  HEADLINE (offload vs direct):`);
    console.log(`  billed $ saved/session : ${usd(costDelta)} (${dCost > 0 ? ((costDelta / dCost) * 100).toFixed(1) : "0"}%)`);
    console.log(`  MAIN-context tokens     : ${k(dMain)} → ${k(oMain)} (${dMain > 0 ? (((dMain - oMain) / dMain) * 100).toFixed(1) : "0"}% smaller)`);
    if (costDelta < 0) console.log(`  ⚠ offload cost MORE here (subagent overhead > savings on this task size).`);
  }
  console.log(`\n  Caveats: nondeterministic, N=${REPS}, single task. Directional.`);
  console.log(`${line}\n`);
}

main().catch((e) => {
  restoreAgent();
  console.error("offload bench failed:", e);
  process.exit(1);
});
