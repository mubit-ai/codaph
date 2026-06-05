#!/usr/bin/env bun
// Realized before/after: does fixing the digest assembly (distillFactsBlock now
// strips raw activity traces / working-memory dumps) actually recover the lesson
// saving end to end? Injects the REAL Codaph digest (captured -> reflected ->
// inject preview) for the same project, BEFORE vs AFTER the fix, via the
// validated salient channel (== how additionalContext arrives, trust-header
// included), vs OFF. Same buried-gotcha task, isolated clones, verified.
//
// Run: bun scripts/bench-lessons-realized.ts
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscriptUsage, estimateTranscriptCost, emptyUsage, totalTokens, DEFAULT_PRICE_TABLE, type TokenUsage } from "../src/lib/token-accounting";

const REPO = process.cwd();
const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";
const REPS = Number(process.env.BENCH_REPS ?? "3");
const PER_RUN_TIMEOUT_MS = 360000;
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const WT_ROOT = join(tmpdir(), "codaph-bench-clones");
const RESULTS_DIR = join(REPO, "bench-results");

// Strip preview chrome → just the injected digest body.
function digestBody(path: string): string {
  const raw = readFileSync(path, "utf8");
  const start = raw.indexOf("# Codaph project memory");
  const body = start >= 0 ? raw.slice(start) : raw;
  return body.split("\n").filter((l) => !/^(\[~|Tip:|\$ bun|Injection preview|Budgets:|=== )/.test(l.trim())).join("\n").trim();
}
const DIGEST = { before: digestBody("/tmp/digest-before.txt"), after: digestBody("/tmp/digest-after.txt") };

const TASK = "Running `bun bench-fixture/report.ts` currently fails. Make it print `REPORT READY`. Do not modify any file under bench-fixture/. When done, briefly state what the fix was.";
type Arm = "off" | "before" | "after";
const ARMS: Arm[] = ["off", "before", "after"];

function plant(clone: string) {
  const w = (rel: string, c: string) => { mkdirSync(join(clone, rel, ".."), { recursive: true }); writeFileSync(join(clone, rel), c); };
  w("bench-fixture/report.ts", `import { validate } from "./lib/validate";\nvalidate();\nconsole.log("REPORT READY");\n`);
  w("bench-fixture/lib/validate.ts", `import { policyOK } from "./policy";\nexport function validate(): void {\n  if (!policyOK()) throw new Error("validation failed: policy not satisfied");\n}\n`);
  w("bench-fixture/lib/policy.ts", `import { existsSync, readFileSync } from "node:fs";\nexport function policyOK(): boolean {\n  try { return existsSync(".codaph-fixture-token") && readFileSync(".codaph-fixture-token","utf8").trim() === "CODAPH-OK"; } catch { return false; }\n}\n`);
}
function makeClone(name: string): string {
  const dir = join(WT_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(WT_ROOT, { recursive: true });
  if (spawnSync("git", ["clone", "--local", "--quiet", REPO, dir], { encoding: "utf8" }).status !== 0) throw new Error("clone failed");
  try { if (existsSync(join(REPO, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules")); } catch {}
  return dir;
}
function runClaude(prompt: string, cwd: string): Promise<any> {
  return new Promise((resolve) => {
    const c = spawn("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json", "--max-turns", "40", "--permission-mode", "bypassPermissions", "--allowedTools", "Read", "Grep", "Glob", "Bash", "Edit", "Write"], { cwd, env: { ...process.env, CODAPH_INJECT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let killed = false;
    const t = setTimeout(() => { killed = true; c.kill("SIGKILL"); }, PER_RUN_TIMEOUT_MS);
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => { clearTimeout(t); if (killed) return resolve(null); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    c.on("error", () => { clearTimeout(t); resolve(null); });
  });
}
function findTranscript(sid: string): string | null {
  try { for (const p of readdirSync(PROJECTS_DIR)) { const f = join(PROJECTS_DIR, p, `${sid}.jsonl`); if (existsSync(f)) return f; } } catch {}
  return null;
}
function verify(clone: string): boolean {
  const r = spawnSync("bun", ["bench-fixture/report.ts"], { cwd: clone, encoding: "utf8", timeout: 30000 });
  return (r.stdout ?? "").includes("REPORT READY");
}

interface Row { arm: Arm; rep: number; completed: boolean; usage: TokenUsage; billedUsd: number; turns: number; tools: number; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(arm: Arm, rep: number): Promise<Row> {
  const row: Row = { arm, rep, completed: false, usage: emptyUsage(), billedUsd: 0, turns: 0, tools: 0 };
  const clone = makeClone(`realized-${arm}-${rep}`);
  try {
    plant(clone);
    const prompt = arm === "off" ? TASK : `${DIGEST[arm]}\n\n---\n\nTask: ${TASK}`;
    const json = await runClaude(prompt, clone);
    if (json?.session_id) {
      await sleep(400);
      const tp = findTranscript(json.session_id);
      if (tp) { const c = readFileSync(tp, "utf8"); const p = parseTranscriptUsage(c); row.usage = p.totals; row.billedUsd = estimateTranscriptCost(p, DEFAULT_PRICE_TABLE).totalUsd; row.tools = (c.match(/"type"\s*:\s*"tool_use"/g) ?? []).length; }
      row.billedUsd = typeof json.total_cost_usd === "number" ? json.total_cost_usd : row.billedUsd;
      row.turns = json.num_turns ?? 0;
    }
    row.completed = verify(clone);
  } finally { rmSync(clone, { recursive: true, force: true }); }
  return row;
}

const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const k = (n: number) => Math.round(n).toLocaleString();

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`Realized before/after: ${ARMS.length * REPS} runs (${MODEL}). Digest sizes: before≈${Math.round(DIGEST.before.length / 4)} tok, after≈${Math.round(DIGEST.after.length / 4)} tok`);
  const rows: Row[] = [];
  let n = 0;
  for (let rep = 1; rep <= REPS; rep++) {
    for (const arm of ARMS) {
      n++;
      const r = await runOne(arm, rep);
      console.log(`[${n}/${ARMS.length * REPS}] ${arm.padEnd(7)} rep${rep}  ${r.completed ? "DONE" : "FAIL"} · ${k(totalTokens(r.usage))} tok · ${r.turns} turns · ${r.tools} tools · $${r.billedUsd.toFixed(4)}`);
      rows.push(r);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(RESULTS_DIR, `lessons-realized-${stamp}.json`), JSON.stringify({ model: MODEL, reps: REPS, rows }, null, 2));

  const done = (a: Arm) => rows.filter((r) => r.arm === a && r.completed);
  const tok = (a: Arm) => med(done(a).map((r) => totalTokens(r.usage)));
  const line = "─".repeat(76);
  console.log(`\n${line}\n  REALIZED LESSON INJECTION — before vs after the digest fix (${MODEL})\n${line}`);
  console.log(`  ${"arm".padEnd(8)}${"done".padStart(6)}${"med tok".padStart(11)}${"med turns".padStart(11)}${"med tools".padStart(11)}${"med $".padStart(10)}`);
  for (const a of ARMS) {
    const d = done(a);
    console.log(`  ${a.padEnd(8)}${`${d.length}/${REPS}`.padStart(6)}${k(tok(a)).padStart(11)}${med(d.map((r) => r.turns)).toFixed(0).padStart(11)}${med(d.map((r) => r.tools)).toFixed(0).padStart(11)}${("$" + med(d.map((r) => r.billedUsd)).toFixed(4)).padStart(10)}`);
  }
  const off = tok("off");
  if (off > 0) for (const a of ["before", "after"] as Arm[]) if (tok(a) > 0) console.log(`  → ${a} saves vs off: ${k(off - tok(a))} tok (${(((off - tok(a)) / off) * 100).toFixed(1)}%)`);
  console.log(`  (oracle/clean-lesson ceiling measured earlier ≈ 52%)\n${line}`);
}
main();
