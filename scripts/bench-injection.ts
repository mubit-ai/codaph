#!/usr/bin/env bun
//
// A/B bench for Codaph + Mubit memory injection, isolated PER PHASE.
//
// Runs the SAME exploration tasks across several arms — each arm enables exactly
// ONE injection phase — against the real `claude` CLI in this repo, then compares
// the ACTUAL billed cost/tokens per task vs the OFF baseline. Pairing by task
// removes the confound that plagues `codaph tokens --compare` (which averages
// over whatever unrelated sessions happen to exist).
//
// Arms (select a subset with BENCH_ARMS=off,session-only,...):
//   off                   injection disabled (baseline)
//   session-only          SessionStart digest only          (CODAPH_INJECT_PHASES=session)
//   prompt-only           UserPromptSubmit retrieval only   (CODAPH_INJECT_PHASES=prompt)
//   pretool-augment       PreToolUse augment only           (CODAPH_INJECT_PHASES=pretool-augment)
//   pretool-shortcircuit  PreToolUse shortcircuit only       (CODAPH_INJECT_PHASES=pretool-shortcircuit)
//
// Why this is honest about its limits:
//   - Agent runs are nondeterministic; with few reps the numbers are directional.
//   - Each arm's net effect (injected tokens added vs exploration avoided) is
//     captured directly in its billed cost — no hand-waving.
//
// Run:  bun scripts/bench-injection.ts
// Tune: BENCH_MODEL, BENCH_REPS, BENCH_TIMEOUT_MS, BENCH_TASKS, BENCH_ARMS.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
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
// for the ~3.5s Mubit digest query, so the hook silently no-ops. Raise it for
// the bench so injection actually fires, then restore.
const CODAPH_SETTINGS_PATH = join(homedir(), ".codaph", "settings.json");
const CODAPH_SETTINGS_BACKUP = join(homedir(), ".codaph", "settings.json.bench-backup");
const INJECT_TIMEOUT_MS = Number(process.env.BENCH_INJECT_TIMEOUT_MS ?? "8000");

// ---------------------------------------------------------------------------
// Arms — each isolates one injection phase via CODAPH_INJECT_PHASES.
// ---------------------------------------------------------------------------

type Arm = "off" | "session-only" | "prompt-only" | "pretool-augment" | "pretool-shortcircuit";

interface ArmSpec {
  id: Arm;
  label: string; // short column label
  env: Record<string, string>; // per-arm env overlay for the claude child
}

const ALL_ARMS: ArmSpec[] = [
  { id: "off", label: "OFF", env: { CODAPH_INJECT: "0" } },
  { id: "session-only", label: "SESSION", env: { CODAPH_INJECT_PHASES: "session" } },
  { id: "prompt-only", label: "PROMPT", env: { CODAPH_INJECT_PHASES: "prompt" } },
  { id: "pretool-augment", label: "PT-AUG", env: { CODAPH_INJECT_PHASES: "pretool-augment" } },
  { id: "pretool-shortcircuit", label: "PT-SC", env: { CODAPH_INJECT_PHASES: "pretool-shortcircuit" } },
];

// Default arm set: off baseline + the three augment-safe phases. The riskier
// pretool-shortcircuit is opt-in (BENCH_ARMS=...,pretool-shortcircuit) — per the
// staged "augment before deny" plan, you graduate to it once augment proves out.
const DEFAULT_ARM_IDS: Arm[] = ["off", "session-only", "prompt-only", "pretool-augment"];
const ARM_FILTER = (process.env.BENCH_ARMS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ARMS: ArmSpec[] = ARM_FILTER.length
  ? ALL_ARMS.filter((a) => ARM_FILTER.includes(a.id))
  : ALL_ARMS.filter((a) => DEFAULT_ARM_IDS.includes(a.id));
const BASELINE: Arm = "off";

// Exploration questions about THIS codebase — the kind of "where does X live /
// how does Y work" that injection can plausibly answer without re-reading the tree.
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
    // it can't help (does adding context cost more than it saves here?).
    id: "arch-overview",
    prompt:
      "Give a 3-bullet overview of Codaph's architecture: the dual store, the ingest flow, and identity resolution. Cite the key files.",
  },
];

const TASK_FILTER = (process.env.BENCH_TASKS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TASKS = TASK_FILTER.length ? ALL_TASKS.filter((t) => TASK_FILTER.includes(t.id)) : ALL_TASKS;

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
  injected: boolean; // did any Codaph injection land in the transcript?
}

// ---------------------------------------------------------------------------
// Hooks isolation — swap .claude/settings.json to a config that installs all the
// injection hooks (so any arm's phase can fire) plus SessionEnd (records token
// usage to the mirror), but NOT the per-session agent-complete sync (autoReflect
// would pollute Mubit). Restored in finally.
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

function hookCommand(original: any, event: string, codaphHook: string): string {
  return extractFirstCommand(original.hooks, event) ?? `bun run --cwd '${REPO}' cli hooks run ${codaphHook} --quiet`;
}

function installBenchSettings(): void {
  const original = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  copyFileSync(SETTINGS_PATH, SETTINGS_BACKUP);
  const minimal = {
    ...original,
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: hookCommand(original, "SessionStart", "session-start") }] }],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: hookCommand(original, "UserPromptSubmit", "user-prompt-submit") }] },
      ],
      PreToolUse: [{ hooks: [{ type: "command", command: hookCommand(original, "PreToolUse", "pre-tool-use") }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: hookCommand(original, "SessionEnd", "session-end") }] }],
    },
  };
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(minimal, null, 2)}\n`);

  // Raise injection.timeoutMs for this project so the digest query can complete.
  if (existsSync(CODAPH_SETTINGS_PATH)) {
    copyFileSync(CODAPH_SETTINGS_PATH, CODAPH_SETTINGS_BACKUP);
    const codaph = JSON.parse(readFileSync(CODAPH_SETTINGS_PATH, "utf8"));
    const proj = (codaph.projects ??= {})[REPO] ?? (codaph.projects[REPO] = {});
    // enabled here is a baseline; the per-arm CODAPH_INJECT_PHASES env decides
    // which phases actually run. timeoutMs is raised so queries don't time out.
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

function runClaude(prompt: string, spec: ArmSpec): Promise<{ json: any | null; error: string | null }> {
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
    // Clear both injection env vars first, then apply this arm's overlay, so an
    // arm never inherits another arm's CODAPH_INJECT* from the parent env.
    const env: Record<string, string | undefined> = {
      ...process.env,
      CODAPH_INJECT: undefined,
      CODAPH_INJECT_PHASES: undefined,
      ...spec.env,
    };
    const child = spawn("claude", args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
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

// Markers any injection phase leaves in the transcript (SessionStart/UserPrompt
// digests, PreToolUse augment hints, PreToolUse deny reasons).
const INJECT_MARKERS = [
  "# Codaph project memory",
  INJECTION_TRUST_HEADER.slice(0, 40),
  "Codaph memory (hint, verify)",
  "Codaph memory (verify before relying)",
];

function analyzeTranscript(sessionId: string): { usage: TokenUsage; codaphUsd: number; injected: boolean } {
  const path = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  if (!existsSync(path)) return { usage: emptyUsage(), codaphUsd: 0, injected: false };
  const content = readFileSync(path, "utf8");
  const parsed = parseTranscriptUsage(content);
  const cost = estimateTranscriptCost(parsed, DEFAULT_PRICE_TABLE);
  const injected = INJECT_MARKERS.some((m) => content.includes(m));
  return { usage: parsed.totals, codaphUsd: cost.totalUsd, injected };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(task: { id: string; prompt: string }, spec: ArmSpec, rep: number): Promise<RunResult> {
  const { json, error } = await runClaude(task.prompt, spec);
  const base: RunResult = {
    task: task.id,
    arm: spec.id,
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
  await sleep(750); // transcript flushed at session end; give SessionEnd a beat
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
    injected: spec.id === BASELINE ? false : analysis.injected,
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

interface ArmStats {
  arm: Arm;
  runs: number;
  meanBilledUsd: number;
  meanTokens: number;
  meanCacheRead: number;
  meanOutput: number;
  meanTurns: number;
  meanDurationMs: number;
  injectedRate: number;
  // vs the OFF baseline (positive = injection saved):
  savedTokens: number;
  savedTokensPct: number;
  savedPerSession: number;
  savedPct: number;
}

function summarize(rows: RunResult[]) {
  const ok = rows.filter((r) => r.ok);
  const byArm = (arm: Arm) => ok.filter((r) => r.arm === arm);
  const rawStats = (arm: Arm) => {
    const rs = byArm(arm);
    return {
      runs: rs.length,
      meanBilledUsd: mean(rs.map((r) => r.billedUsd)),
      meanTokens: mean(rs.map((r) => totalTokens(r.usage))),
      meanCacheRead: mean(rs.map((r) => r.usage.cacheRead)),
      meanOutput: mean(rs.map((r) => r.usage.output)),
      meanTurns: mean(rs.map((r) => r.numTurns)),
      meanDurationMs: mean(rs.map((r) => r.durationMs)),
      injectedRate: rs.length ? rs.filter((r) => r.injected).length / rs.length : 0,
    };
  };

  const baseline = rawStats(BASELINE);
  const arms: ArmStats[] = ARMS.map((spec) => {
    const s = rawStats(spec.id);
    const savedTokens = baseline.meanTokens - s.meanTokens;
    const savedPerSession = baseline.meanBilledUsd - s.meanBilledUsd;
    return {
      arm: spec.id,
      ...s,
      savedTokens,
      savedTokensPct: baseline.meanTokens > 0 ? savedTokens / baseline.meanTokens : 0,
      savedPerSession,
      savedPct: baseline.meanBilledUsd > 0 ? savedPerSession / baseline.meanBilledUsd : 0,
    };
  });

  // Per-task, per-arm mean tokens + delta vs OFF (the robust paired signal).
  const perTask = TASKS.map((t) => {
    const offTok = mean(ok.filter((r) => r.task === t.id && r.arm === BASELINE).map((r) => totalTokens(r.usage)));
    const byArm: Record<string, { tokens: number; tokDelta: number; cost: number }> = {};
    for (const spec of ARMS) {
      const rs = ok.filter((r) => r.task === t.id && r.arm === spec.id);
      const tokens = mean(rs.map((r) => totalTokens(r.usage)));
      byArm[spec.id] = { tokens, tokDelta: offTok - tokens, cost: mean(rs.map((r) => r.billedUsd)) };
    }
    return { task: t.id, offTok, byArm };
  });

  return { baseline: BASELINE, arms, perTask, okRuns: ok.length, totalRuns: rows.length };
}

function printReport(rows: RunResult[]) {
  const s = summarize(rows);
  const line = "─".repeat(82);
  console.log(`\n${line}`);
  console.log(`  CODAPH + MUBIT INJECTION BENCH (per-phase) — ${MODEL}`);
  console.log(`  ${s.okRuns}/${s.totalRuns} runs ok · ${REPS} rep(s)/arm · arms: ${ARMS.map((a) => a.id).join(", ")}`);
  console.log(line);

  const k = (n: number) => Math.round(n).toLocaleString();

  console.log(`\n  Per-task Δtokens vs OFF (positive = the phase SAVED tokens):`);
  const head = `  ${"task".padEnd(18)}${"OFF tok".padStart(10)}` + ARMS.filter((a) => a.id !== BASELINE).map((a) => a.label.padStart(11)).join("");
  console.log(head);
  for (const t of s.perTask) {
    const cells = ARMS.filter((a) => a.id !== BASELINE)
      .map((a) => {
        const d = t.byArm[a.id]?.tokDelta ?? 0;
        return `${(d >= 0 ? "+" : "") + k(d)}`.padStart(11);
      })
      .join("");
    console.log(`  ${t.task.padEnd(18)}${k(t.offTok).padStart(10)}${cells}`);
  }

  console.log(`\n  Aggregate (mean per session):`);
  for (const a of s.arms) {
    const tag =
      a.arm === BASELINE
        ? "baseline"
        : `${a.savedTokens >= 0 ? "saved" : "ADDED"} ${k(Math.abs(a.savedTokens))} tok (${pct(a.savedTokensPct)})`;
    console.log(
      `  ${a.arm.padEnd(20)} tokens ${k(a.meanTokens).padStart(9)} · turns ${a.meanTurns.toFixed(1)} · billed ${usd(a.meanBilledUsd).padStart(9)} · inj ${pct(a.injectedRate).padStart(6)} · ${tag}`,
    );
  }

  console.log(`\n  HEADLINE (vs OFF, tokens = robust signal):`);
  for (const a of s.arms.filter((x) => x.arm !== BASELINE)) {
    const flag = a.savedTokens < 0 ? "  ⚠ NET-NEGATIVE" : "";
    console.log(`  ${a.arm.padEnd(20)} ${k(a.savedTokens).padStart(9)} tok/session  (${pct(a.savedTokensPct)})${flag}`);
  }
  console.log(
    `\n  Caveats: nondeterministic agent runs, N=${REPS}/arm, single project, read-only tasks (Read/Grep/Glob).\n  Directional, not precise — confirm a win agrees across the aggregate AND resume-focus before shipping.`,
  );
  console.log(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(TRANSCRIPT_DIR)) mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const total = TASKS.length * REPS * ARMS.length;
  console.log(
    `Running ${total} claude sessions (${MODEL}) — ${TASKS.length} tasks × ${REPS} reps × ${ARMS.length} arms (${ARMS.map((a) => a.id).join(", ")})`,
  );

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
        // Rotate arm order per (task,rep) so no arm systematically inherits
        // another's warm Anthropic prompt-cache (cache-read is ~12.5x cheaper
        // than cache-write, which would otherwise fake a cost gain).
        const shift = (ti + rep) % ARMS.length;
        const order = [...ARMS.slice(shift), ...ARMS.slice(0, shift)];
        for (const spec of order) {
          n++;
          const r = await runOne(task, spec, rep);
          rows.push(r);
          const tag = r.ok
            ? `${usd(r.billedUsd)} · ${Math.round(totalTokens(r.usage)).toLocaleString()} tok · ${r.numTurns} turns${spec.id !== BASELINE ? (r.injected ? " · injected" : " · NO-INJECT?!") : ""}`
            : `ERROR: ${r.error}`;
          console.log(`[${n}/${total}] ${task.id.padEnd(18)} ${spec.label.padEnd(8)} rep${rep}  ${tag}`);
        }
      }
    }
  } finally {
    cleanup();
  }

  const summary = summarize(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `injection-bench-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ model: MODEL, reps: REPS, arms: ARMS.map((a) => a.id), rows, summary }, null, 2));
  printReport(rows);
  console.log(`Raw results → ${outPath}`);
}

main().catch((e) => {
  restoreSettings();
  console.error("bench failed:", e);
  process.exit(1);
});
