#!/usr/bin/env bun
//
// Rough A/B bench: "Codaph + Mubit memory injection ON" vs "OFF".
//
// Runs the SAME exploration tasks twice — once with the SessionStart memory
// digest injected (CODAPH_INJECT=1), once with injection killed
// (CODAPH_INJECT=0) — against the real `claude` CLI in this repo, then compares
// the ACTUAL billed cost/tokens per task. Pairing by task removes the confound
// that plagues `codaph tokens --compare` (which averages over whatever unrelated
// sessions happen to exist).
//
// Why this is honest about its limits:
//   - Agent runs are nondeterministic; with few reps the numbers are directional.
//   - Injection's net effect (digest tokens added vs exploration tokens avoided)
//     is captured directly in the ON arm's cost — no hand-waving.
//   - It benchmarks ONLY what's configured ON for this project (SessionStart
//     digest; UserPrompt/PreToolUse are off here).
//
// Run:  bun scripts/bench-injection.ts
// Tune: BENCH_MODEL, BENCH_REPS, BENCH_TIMEOUT_MS env vars.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseTranscriptUsage,
  estimateTranscriptCost,
  emptyUsage,
  addUsage,
  totalTokens,
  DEFAULT_PRICE_TABLE,
  type TokenUsage,
} from "../src/lib/token-accounting";
import { INJECTION_TRUST_HEADER } from "../src/lib/context-injection";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO = process.cwd();
const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";
const REPS = Number(process.env.BENCH_REPS ?? "2");
const PER_RUN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? "300000"); // 5 min
const MAX_TURNS = "30";
const ALLOWED_TOOLS = ["Read", "Grep", "Glob"]; // read-only: safe to repeat, maximizes the exploration signal
const TRANSCRIPT_DIR = join(homedir(), ".claude", "projects", REPO.replaceAll("/", "-"));
const SETTINGS_PATH = join(REPO, ".claude", "settings.json");
const SETTINGS_BACKUP = join(REPO, ".claude", "settings.json.bench-backup");
const RESULTS_DIR = join(REPO, "bench-results");
// Codaph project settings hold injection.timeoutMs (default 2500ms) — too tight
// for the ~3.5s Mubit digest query, so the SessionStart hook silently no-ops.
// Raise it for the bench so injection actually fires, then restore.
const CODAPH_SETTINGS_PATH = join(homedir(), ".codaph", "settings.json");
const CODAPH_SETTINGS_BACKUP = join(homedir(), ".codaph", "settings.json.bench-backup");
const INJECT_TIMEOUT_MS = Number(process.env.BENCH_INJECT_TIMEOUT_MS ?? "8000");

// Exploration questions about THIS codebase — the kind of "where does X live /
// how does Y work" a digest can plausibly answer without re-reading the tree.
const ALL_TASKS: { id: string; prompt: string }[] = [
  {
    // Resumption — the digest's "where work left off / next actions" sweet spot.
    id: "resume-focus",
    prompt:
      "Without modifying anything, summarize in a few bullets what the most recent work on this project has focused on and what the logical next steps would be.",
  },
  {
    // Code-specific: requires reading ingest-pipeline.ts; not in CLAUDE.md.
    id: "circuit-threshold",
    prompt:
      "What triggers Codaph's Mubit fail-open circuit to open (the consecutive-error threshold), and what does the ingest pipeline do while the circuit is open? Cite the function and file.",
  },
  {
    // Code-specific: requires reading mirror-jsonl.ts; not in CLAUDE.md.
    id: "dedup-index",
    prompt:
      "How does the JSONL mirror deduplicate events using the eventId index? Name the functions and the file that implement it.",
  },
  {
    // Code-specific: requires reading ingest-pipeline.ts defaults; not in CLAUDE.md.
    id: "ingest-batching",
    prompt:
      "What batching and concurrency settings does the IngestPipeline use for Mubit writes, and where are their default values defined?",
  },
  {
    // Control: fully covered by CLAUDE.md, ~1 turn. Tests injection OVERHEAD when
    // it can't help (does adding the digest cost more than it saves here?).
    id: "arch-overview",
    prompt:
      "Give a 3-bullet overview of Codaph's architecture: the dual store, the ingest flow, and identity resolution. Cite the key files.",
  },
];

// Optional smoke filter: BENCH_TASKS=dual-store,identity restricts the run.
const TASK_FILTER = (process.env.BENCH_TASKS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TASKS = TASK_FILTER.length ? ALL_TASKS.filter((t) => TASK_FILTER.includes(t.id)) : ALL_TASKS;

type Arm = "off" | "on";

interface RunResult {
  task: string;
  arm: Arm;
  rep: number;
  sessionId: string | null;
  ok: boolean;
  error: string | null;
  billedUsd: number; // claude's authoritative total_cost_usd
  codaphUsd: number; // codaph-priced from parsed transcript
  usage: TokenUsage; // summed across all assistant turns
  numTurns: number;
  durationMs: number;
  injected: boolean; // did the SessionStart digest actually land in the transcript?
}

// ---------------------------------------------------------------------------
// Hooks isolation — swap .claude/settings.json to a minimal config for the run
// so we don't fire the per-session Stop->agent-complete sync (autoReflect would
// pollute Mubit with 20 reflections) or the per-tool-call PreToolUse spawn. Keep
// SessionStart (the thing we toggle) and SessionEnd (records to the mirror so
// `codaph tokens --compare` also reflects this bench). Restored in finally.
// ---------------------------------------------------------------------------

function extractFirstCommand(hooks: any, event: string): string | null {
  const entries = hooks?.[event];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    for (const h of entry?.hooks ?? []) {
      if (typeof h?.command === "string") return h.command;
    }
  }
  return null;
}

function installBenchSettings(): void {
  const original = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  copyFileSync(SETTINGS_PATH, SETTINGS_BACKUP);
  const sessionStart =
    extractFirstCommand(original.hooks, "SessionStart") ??
    `bun run --cwd '${REPO}' cli hooks run session-start --quiet`;
  const sessionEnd =
    extractFirstCommand(original.hooks, "SessionEnd") ??
    `bun run --cwd '${REPO}' cli hooks run session-end --quiet`;
  const minimal = {
    ...original,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: sessionStart }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: sessionEnd }] }],
    },
  };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(minimal, null, 2)}\n`);

  // Raise injection.timeoutMs for this project so the digest query can complete.
  if (existsSync(CODAPH_SETTINGS_PATH)) {
    copyFileSync(CODAPH_SETTINGS_PATH, CODAPH_SETTINGS_BACKUP);
    const codaph = JSON.parse(readFileSync(CODAPH_SETTINGS_PATH, "utf8"));
    const proj = (codaph.projects ??= {})[REPO] ?? (codaph.projects[REPO] = {});
    proj.injection = { ...(proj.injection ?? {}), enabled: true, timeoutMs: INJECT_TIMEOUT_MS };
    writeFileSync(CODAPH_SETTINGS_PATH, `${JSON.stringify(codaph, null, 2)}\n`);
  }
}

function restoreSettings(): void {
  if (existsSync(SETTINGS_BACKUP)) {
    copyFileSync(SETTINGS_BACKUP, SETTINGS_PATH);
    rmSync(SETTINGS_BACKUP, { force: true });
  }
  if (existsSync(CODAPH_SETTINGS_BACKUP)) {
    copyFileSync(CODAPH_SETTINGS_BACKUP, CODAPH_SETTINGS_PATH);
    rmSync(CODAPH_SETTINGS_BACKUP, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Run one claude session
// ---------------------------------------------------------------------------

function runClaude(prompt: string, arm: Arm): Promise<{ json: any | null; error: string | null }> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--max-turns",
      MAX_TURNS,
      "--allowedTools",
      ...ALLOWED_TOOLS,
    ];
    const child = spawn("claude", args, {
      cwd: REPO,
      env: { ...process.env, CODAPH_INJECT: arm === "on" ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      if (killed) return resolve({ json: null, error: `timed out after ${PER_RUN_TIMEOUT_MS}ms` });
      try {
        resolve({ json: JSON.parse(out), error: null });
      } catch {
        resolve({ json: null, error: err.trim().slice(0, 200) || "unparseable claude output" });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ json: null, error: String(e) });
    });
  });
}

// Read the session transcript and sum token usage across every assistant turn,
// then price it with codaph's table. Also confirm the digest actually injected.
function analyzeTranscript(sessionId: string): { usage: TokenUsage; codaphUsd: number; injected: boolean } {
  const path = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return { usage: emptyUsage(), codaphUsd: 0, injected: false };
  const content = readFileSync(path, "utf8");
  const parsed = parseTranscriptUsage(content);
  const cost = estimateTranscriptCost(parsed, DEFAULT_PRICE_TABLE);
  const injected =
    content.includes("# Codaph project memory") || content.includes(INJECTION_TRUST_HEADER.slice(0, 40));
  return { usage: parsed.totals, codaphUsd: cost.totalUsd, injected };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(task: { id: string; prompt: string }, arm: Arm, rep: number): Promise<RunResult> {
  const { json, error } = await runClaude(task.prompt, arm);
  const base: RunResult = {
    task: task.id,
    arm,
    rep,
    sessionId: json?.session_id ?? null,
    ok: false,
    error,
    billedUsd: 0,
    codaphUsd: 0,
    usage: emptyUsage(),
    numTurns: 0,
    durationMs: 0,
    injected: false,
  };
  if (!json || json.is_error || !json.session_id) {
    base.error = error ?? json?.subtype ?? "claude reported an error";
    return base;
  }
  // Transcript is flushed at session end; give the SessionEnd hook a beat.
  await sleep(750);
  const analysis = analyzeTranscript(json.session_id);
  return {
    ...base,
    ok: true,
    error: null,
    billedUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0,
    codaphUsd: analysis.codaphUsd,
    usage: analysis.usage,
    numTurns: typeof json.num_turns === "number" ? json.num_turns : 0,
    durationMs: typeof json.duration_ms === "number" ? json.duration_ms : 0,
    injected: arm === "on" ? analysis.injected : false,
  };
}

// ---------------------------------------------------------------------------
// Aggregation + report
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function summarize(rows: RunResult[]) {
  const ok = rows.filter((r) => r.ok);
  const byArm = (arm: Arm) => ok.filter((r) => r.arm === arm);
  const armStats = (arm: Arm) => {
    const rs = byArm(arm);
    const usage = rs.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
    return {
      runs: rs.length,
      meanBilledUsd: mean(rs.map((r) => r.billedUsd)),
      meanCodaphUsd: mean(rs.map((r) => r.codaphUsd)),
      meanTokens: mean(rs.map((r) => totalTokens(r.usage))),
      meanCacheRead: mean(rs.map((r) => r.usage.cacheRead)),
      meanOutput: mean(rs.map((r) => r.usage.output)),
      meanTurns: mean(rs.map((r) => r.numTurns)),
      meanDurationMs: mean(rs.map((r) => r.durationMs)),
      injectedRate: rs.length ? rs.filter((r) => r.injected).length / rs.length : 0,
      usage,
    };
  };
  const off = armStats("off");
  const on = armStats("on");
  const savedPerSession = off.meanBilledUsd - on.meanBilledUsd;
  const savedPct = off.meanBilledUsd > 0 ? savedPerSession / off.meanBilledUsd : 0;
  const savedTokens = off.meanTokens - on.meanTokens;
  const savedTokensPct = off.meanTokens > 0 ? savedTokens / off.meanTokens : 0;

  // Per-task paired deltas (mean over reps within each arm).
  const perTask = TASKS.map((t) => {
    const ofR = ok.filter((r) => r.task === t.id && r.arm === "off");
    const onR = ok.filter((r) => r.task === t.id && r.arm === "on");
    const offTok = mean(ofR.map((r) => totalTokens(r.usage)));
    const onTok = mean(onR.map((r) => totalTokens(r.usage)));
    const offCost = mean(ofR.map((r) => r.billedUsd));
    const onCost = mean(onR.map((r) => r.billedUsd));
    return { task: t.id, offTok, onTok, tokDelta: offTok - onTok, offCost, onCost, costDelta: offCost - onCost };
  });

  return { off, on, savedPerSession, savedPct, savedTokens, savedTokensPct, perTask, okRuns: ok.length, totalRuns: rows.length };
}

function printReport(rows: RunResult[]) {
  const s = summarize(rows);
  const line = "─".repeat(78);
  console.log(`\n${line}`);
  console.log(`  CODAPH + MUBIT INJECTION BENCH — ${MODEL}`);
  console.log(`  ${s.okRuns}/${s.totalRuns} runs ok · ${REPS} rep(s)/arm · injected on ${pct(s.on.injectedRate)} of ON runs`);
  console.log(line);

  const k = (n: number) => Math.round(n).toLocaleString();
  console.log(`\n  Per-task (mean over reps) — tokens are the robust signal, $ is cache-order-sensitive:`);
  console.log(
    `  ${"task".padEnd(18)}${"OFF tok".padStart(10)}${"ON tok".padStart(10)}${"Δtok".padStart(10)}${"OFF $".padStart(10)}${"ON $".padStart(10)}`,
  );
  for (const t of s.perTask) {
    console.log(
      `  ${t.task.padEnd(18)}${k(t.offTok).padStart(10)}${k(t.onTok).padStart(10)}${k(t.tokDelta).padStart(10)}${usd(t.offCost).padStart(10)}${usd(t.onCost).padStart(10)}`,
    );
  }

  console.log(`\n  Aggregate (mean per session):`);
  const tbl = (label: string, a: any) =>
    console.log(
      `  ${label.padEnd(4)} tokens ${k(a.meanTokens).padStart(9)} · cache-read ${k(a.meanCacheRead).padStart(9)} · output ${k(a.meanOutput).padStart(6)} · turns ${a.meanTurns.toFixed(1)} · billed ${usd(a.meanBilledUsd).padStart(9)} · ${(a.meanDurationMs / 1000).toFixed(0)}s`,
    );
  tbl("OFF", s.off);
  tbl("ON", s.on);

  console.log(`\n  HEADLINE`);
  console.log(`  Tokens saved / session : ${k(s.savedTokens)}  (${pct(s.savedTokensPct)})   ← robust`);
  console.log(`  Billed $ saved / session : ${usd(s.savedPerSession)}  (${pct(s.savedPct)})   ← money, but noisy at this N`);
  console.log(`  Extrapolated /100 sessions : ${usd(s.savedPerSession * 100)}`);
  if (s.savedTokens < 0) {
    console.log(`  ⚠ NEGATIVE on tokens: the injected digest added more context than it saved here.`);
  }
  console.log(
    `\n  Caveats: nondeterministic agent runs, N=${REPS}/arm, single project, read-only tasks (Read/Grep/Glob),\n  SessionStart-digest-only (UserPrompt/PreToolUse off), digest is narration-heavy. Directional, not precise.`,
  );
  console.log(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(TRANSCRIPT_DIR)) mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const total = TASKS.length * REPS * 2;
  console.log(`Running ${total} claude sessions (${MODEL}) — ${TASKS.length} tasks × ${REPS} reps × 2 arms`);

  installBenchSettings();
  const cleanup = () => restoreSettings();
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  const rows: RunResult[] = [];
  let n = 0;
  try {
    for (let ti = 0; ti < TASKS.length; ti++) {
      const task = TASKS[ti]!;
      for (let rep = 1; rep <= REPS; rep++) {
        // Counterbalance: alternate which arm runs first so neither systematically
        // inherits the other's warm Anthropic prompt-cache (cache-read is ~12.5x
        // cheaper than cache-write, which would otherwise fake a cost gain).
        const order: Arm[] = (ti + rep) % 2 === 0 ? ["off", "on"] : ["on", "off"];
        for (const arm of order) {
          n++;
          const r = await runOne(task, arm, rep);
          rows.push(r);
          const tag = r.ok
            ? `${usd(r.billedUsd)} · ${Math.round(totalTokens(r.usage)).toLocaleString()} tok · ${r.numTurns} turns${arm === "on" ? (r.injected ? " · injected" : " · NO-INJECT?!") : ""}`
            : `ERROR: ${r.error}`;
          console.log(`[${n}/${total}] ${task.id.padEnd(18)} ${arm.toUpperCase().padEnd(3)} rep${rep}  ${tag}`);
        }
      }
    }
  } finally {
    cleanup();
  }

  const summary = summarize(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `injection-bench-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ model: MODEL, reps: REPS, rows, summary }, null, 2));
  printReport(rows);
  console.log(`Raw results → ${outPath}`);
}

main().catch((e) => {
  restoreSettings();
  console.error("bench failed:", e);
  process.exit(1);
});
