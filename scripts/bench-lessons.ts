#!/usr/bin/env bun
//
// Lessons bench: how many tokens does a captured Mubit "lesson" save a future
// session by short-circuiting the rediscovery of a NON-OBVIOUS fix?
//
// The value of memory is cross-session learning: session 1 hits a wall, finds
// the fix; that lesson is captured; session 2 gets it injected and skips the
// struggle. A lesson only pays off when, without it, the agent burns tokens
// rediscovering something it can't just read off the code. So each scenario
// plants a trap whose cause is buried (tribal knowledge), lets the agent
// actually struggle (full tools, in an isolated clone), and compares
// tokens-to-COMPLETION with the lesson vs without.
//
// Arms:
//   off    — no lesson. Agent must rediscover the fix.
//   oracle — the perfect hand-written lesson injected via --append-system-prompt.
//            This is the CEILING: max saving when the right lesson is present.
//   (realized arm — full Codaph capture->reflect->inject loop — added next stage.)
//
// Isolation: each run executes in a fresh `git clone --local` of the repo (its
// own .git, so bypassPermissions can't harm the real repo), node_modules
// symlinked in. Removed after the run.
//
// Run:  bun scripts/bench-lessons.ts
// Tune: BENCH_MODEL, BENCH_REPS, BENCH_SCENARIOS (comma ids), BENCH_ARMS.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const REPO = process.cwd();
const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";
const REPS = Number(process.env.BENCH_REPS ?? "3");
const PER_RUN_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? "360000"); // 6 min
const MAX_TURNS = process.env.BENCH_MAX_TURNS ?? "40";
const FULL_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write"];
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const RESULTS_DIR = join(REPO, "bench-results");
const WT_ROOT = join(tmpdir(), "codaph-bench-clones");

// off    — no lesson.
// oracle — lesson in the SYSTEM prompt (--append-system-prompt).
// hint   — lesson PREPENDED to the user prompt (max salience; closest to how
//          Codaph injects additionalContext). Comparing oracle vs hint isolates
//          whether injection CHANNEL determines the saving.
type Arm = "off" | "oracle" | "hint";
const ARMS: Arm[] = (process.env.BENCH_ARMS?.split(",").map((s) => s.trim()).filter(Boolean) as Arm[]) ?? ["off", "oracle", "hint"];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  id: string;
  kind: "planted" | "git-replay";
  baseRef?: string; // git-replay: commit to check out (e.g. a fix commit's parent)
  setup: (clone: string) => void; // plant trap fixtures into the clone
  prompt: string;
  lesson: string; // the oracle lesson a prior session would have captured
  verify: (clone: string) => boolean; // did the agent actually complete the task?
}

function w(clone: string, rel: string, content: string): void {
  const p = join(clone, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

const ALL_SCENARIOS: Scenario[] = [
  {
    // Non-discoverable trap: `report.ts` fails with a generic error; the cause is
    // a compound requirement (a marker file with exact content) buried 3 files
    // deep. The fix isn't guessable — you have to trace it, or know the lesson.
    id: "policy-gotcha",
    kind: "planted",
    setup: (clone) => {
      w(
        clone,
        "bench-fixture/report.ts",
        `import { validate } from "./lib/validate";\nvalidate();\nconsole.log("REPORT READY");\n`,
      );
      w(
        clone,
        "bench-fixture/lib/validate.ts",
        `import { policyOK } from "./policy";\nexport function validate(): void {\n  if (!policyOK()) {\n    throw new Error("validation failed: policy not satisfied");\n  }\n}\n`,
      );
      w(
        clone,
        "bench-fixture/lib/policy.ts",
        `import { existsSync, readFileSync } from "node:fs";\n// Report requires a marker file in the cwd containing exactly "CODAPH-OK".\nexport function policyOK(): boolean {\n  try {\n    return existsSync(".codaph-fixture-token") && readFileSync(".codaph-fixture-token", "utf8").trim() === "CODAPH-OK";\n  } catch {\n    return false;\n  }\n}\n`,
      );
    },
    prompt:
      "Running `bun bench-fixture/report.ts` currently fails. Make it print `REPORT READY`. Do not modify any file under bench-fixture/. When done, briefly state what the fix was.",
    lesson:
      "Known gotcha for this project: `bun bench-fixture/report.ts` runs a policy check that requires a marker file named `.codaph-fixture-token` in the current working directory whose contents are exactly `CODAPH-OK`. To fix: create that file with that content, then run the command.",
    verify: (clone) => {
      const r = spawnSync("bun", ["bench-fixture/report.ts"], { cwd: clone, encoding: "utf8", timeout: 30000 });
      return (r.stdout ?? "").includes("REPORT READY");
    },
  },
];

const SCEN_FILTER = (process.env.BENCH_SCENARIOS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const SCENARIOS = SCEN_FILTER.length ? ALL_SCENARIOS.filter((s) => SCEN_FILTER.includes(s.id)) : ALL_SCENARIOS;

// ---------------------------------------------------------------------------
// Clone isolation
// ---------------------------------------------------------------------------

function sh(cmd: string, args: string[], cwd?: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function makeClone(name: string, baseRef?: string): string {
  const dir = join(WT_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(WT_ROOT, { recursive: true });
  const cloned = sh("git", ["clone", "--local", "--quiet", REPO, dir]);
  if (!cloned.ok) throw new Error(`git clone failed: ${cloned.out}`);
  if (baseRef) {
    const co = sh("git", ["checkout", "--quiet", "--detach", baseRef], dir);
    if (!co.ok) throw new Error(`git checkout ${baseRef} failed: ${co.out}`);
  }
  // Symlink node_modules so the agent can run bun without installing (network-free).
  try {
    if (existsSync(join(REPO, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  } catch {
    /* best effort */
  }
  return dir;
}

function removeClone(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Run + analyze
// ---------------------------------------------------------------------------

function runClaude(
  prompt: string,
  cwd: string,
  opts: { systemLesson?: string | null; promptLesson?: string | null },
): Promise<{ json: any | null; error: string | null }> {
  return new Promise((resolve) => {
    const finalPrompt = opts.promptLesson
      ? `Context from a previous session on this project (a known gotcha):\n${opts.promptLesson}\n\n---\n\nTask: ${prompt}`
      : prompt;
    const args = [
      "-p",
      finalPrompt,
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--max-turns",
      MAX_TURNS,
      "--permission-mode",
      "bypassPermissions",
      ...(opts.systemLesson ? ["--append-system-prompt", opts.systemLesson] : []),
      "--allowedTools",
      ...FULL_TOOLS,
    ];
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env, CODAPH_INJECT: "0" }, // ceiling arms control the lesson via append-system-prompt, not Codaph
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

// Locate the transcript for a session by scanning ~/.claude/projects (robust to
// path-dashing quirks for /tmp vs /private/tmp).
function findTranscript(sessionId: string): string | null {
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const p = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function countToolCalls(content: string): number {
  return (content.match(/"type"\s*:\s*"tool_use"/g) ?? []).length;
}

interface RunResult {
  scenario: string;
  arm: Arm;
  rep: number;
  ok: boolean; // claude ran AND task verified complete
  completed: boolean; // task verified complete
  error: string | null;
  billedUsd: number;
  codaphUsd: number;
  usage: TokenUsage;
  numTurns: number;
  toolCalls: number;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(scn: Scenario, arm: Arm, rep: number): Promise<RunResult> {
  const name = `${scn.id}-${arm}-${rep}`;
  const base: RunResult = {
    scenario: scn.id,
    arm,
    rep,
    ok: false,
    completed: false,
    error: null,
    billedUsd: 0,
    codaphUsd: 0,
    usage: emptyUsage(),
    numTurns: 0,
    toolCalls: 0,
    durationMs: 0,
  };
  let clone: string | null = null;
  try {
    clone = makeClone(name, scn.baseRef);
    scn.setup(clone);
    const { json, error } = await runClaude(scn.prompt, clone, {
      systemLesson: arm === "oracle" ? scn.lesson : null,
      promptLesson: arm === "hint" ? scn.lesson : null,
    });
    if (!json || json.is_error || !json.session_id) {
      base.error = error ?? json?.subtype ?? "claude error";
      return base;
    }
    await sleep(400);
    const tpath = findTranscript(json.session_id);
    if (tpath) {
      const content = readFileSync(tpath, "utf8");
      const parsed = parseTranscriptUsage(content);
      base.usage = parsed.totals;
      base.codaphUsd = estimateTranscriptCost(parsed, DEFAULT_PRICE_TABLE).totalUsd;
      base.toolCalls = countToolCalls(content);
    }
    base.billedUsd = typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0;
    base.numTurns = typeof json.num_turns === "number" ? json.num_turns : 0;
    base.durationMs = typeof json.duration_ms === "number" ? json.duration_ms : 0;
    base.completed = scn.verify(clone);
    base.ok = base.completed;
    return base;
  } catch (e) {
    base.error = String(e);
    return base;
  } finally {
    if (clone) removeClone(clone);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const usd = (n: number) => `$${n.toFixed(4)}`;
const k = (n: number) => Math.round(n).toLocaleString();
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function printReport(rows: RunResult[]) {
  const line = "─".repeat(80);
  console.log(`\n${line}`);
  console.log(`  MUBIT LESSONS BENCH (ceiling) — ${MODEL} · ${REPS} rep(s)/arm`);
  console.log(line);

  for (const scn of SCENARIOS) {
    const arm = (a: Arm) => rows.filter((r) => r.scenario === scn.id && r.arm === a);
    const done = (a: Arm) => arm(a).filter((r) => r.completed);
    console.log(`\n  ${scn.id}  [${scn.kind}]`);
    console.log(
      `  ${"arm".padEnd(8)}${"done".padStart(6)}${"med tok".padStart(11)}${"mean tok".padStart(11)}${"med turns".padStart(11)}${"med tools".padStart(11)}${"mean $".padStart(10)}`,
    );
    for (const a of ARMS) {
      const d = done(a);
      const all = arm(a);
      const toks = d.map((r) => totalTokens(r.usage));
      console.log(
        `  ${a.padEnd(8)}${`${d.length}/${all.length}`.padStart(6)}${k(median(toks)).padStart(11)}${k(mean(toks)).padStart(11)}${median(d.map((r) => r.numTurns)).toFixed(0).padStart(11)}${median(d.map((r) => r.toolCalls)).toFixed(0).padStart(11)}${usd(mean(d.map((r) => r.billedUsd))).padStart(10)}`,
      );
    }
    // Saving vs off, on COMPLETED runs (tokens-to-success), per lesson arm.
    const offTok = median(done("off").map((r) => totalTokens(r.usage)));
    const offUsd = mean(done("off").map((r) => r.billedUsd));
    for (const a of ARMS.filter((x) => x !== "off")) {
      const aTok = median(done(a).map((r) => totalTokens(r.usage)));
      const aUsd = mean(done(a).map((r) => r.billedUsd));
      if (offTok > 0 && aTok > 0) {
        console.log(
          `  → ${a} saves (median tok): ${k(offTok - aTok)} (${pct((offTok - aTok) / offTok)}) · billed: ${usd(offUsd - aUsd)} (${pct(offUsd > 0 ? (offUsd - aUsd) / offUsd : 0)})`,
        );
      }
    }
  }
  console.log(`\n${line}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const total = SCENARIOS.length * ARMS.length * REPS;
  console.log(`Lessons bench: ${total} runs (${MODEL}) — ${SCENARIOS.length} scenario(s) × ${ARMS.join("/")} × ${REPS} reps`);

  const rows: RunResult[] = [];
  let n = 0;
  for (const scn of SCENARIOS) {
    for (let rep = 1; rep <= REPS; rep++) {
      for (const arm of ARMS) {
        n++;
        const r = await runOne(scn, arm, rep);
        const tag = r.error
          ? `ERROR: ${r.error}`
          : `${r.completed ? "DONE" : "FAILED"} · ${k(totalTokens(r.usage))} tok · ${r.numTurns} turns · ${r.toolCalls} tools · ${usd(r.billedUsd)}`;
        console.log(`[${n}/${total}] ${scn.id.padEnd(16)} ${arm.padEnd(7)} rep${rep}  ${tag}`);
        rows.push(r);
      }
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `lessons-bench-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify({ model: MODEL, reps: REPS, arms: ARMS, rows }, null, 2));
  printReport(rows);
  console.log(`Raw results → ${outPath}`);
}

main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
