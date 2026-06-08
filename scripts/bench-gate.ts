#!/usr/bin/env bun
//
// Regression gate for the per-phase injection bench. Reads a bench-results JSON
// (newest by default) and FAILS (non-zero exit) when an injection arm regresses
// token usage beyond a noise tolerance — so "an injection change ships only if
// the bench shows it's net-positive on tokens" becomes an enforceable check
// rather than a hope.
//
// Two hard checks (the plan's "aggregate AND resume-focus must agree"):
//   1. Every gated arm's aggregate savedTokensPct >= -tolerance (default -2%).
//   2. The session-only arm keeps the proven resume-focus win (Δtokens > 0),
//      when both that arm and that task are present.
//
// Bench runs are nondeterministic at small N, so this is a manual PRE-MERGE
// step, not CI-blocking. Run after `bun scripts/bench-injection.ts`.
//
// Run:   bun scripts/bench-gate.ts
// Flags: --file <path>  --tolerance <fraction e.g. 0.02>  --arms <a,b>

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const RESULTS_DIR = join(REPO, "bench-results");
const BASELINE = "off";

function flag(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1]! : null;
}

function newestResultsFile(): string | null {
  if (!existsSync(RESULTS_DIR)) return null;
  // Filenames embed an ISO timestamp, so a lexicographic sort is chronological.
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith("injection-bench-") && f.endsWith(".json"))
    .sort();
  return files.length ? join(RESULTS_DIR, files[files.length - 1]!) : null;
}

interface ArmStats {
  arm: string;
  runs: number;
  meanTokens: number;
  savedTokens: number;
  savedTokensPct: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function main(): void {
  const tolerance = Math.abs(Number(flag("tolerance") ?? process.env.GATE_TOLERANCE ?? "0.02"));
  const armFilter = (flag("arms") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const file = flag("file") ?? newestResultsFile();
  if (!file || !existsSync(file)) {
    console.error("bench-gate: no bench-results file found. Run `bun scripts/bench-injection.ts` first.");
    process.exit(2);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`bench-gate: could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const summary = parsed?.summary;
  if (!summary || !Array.isArray(summary.arms)) {
    console.error(
      `bench-gate: ${file} has no per-arm summary (old bench format?). Re-run the current bench-injection.ts.`,
    );
    process.exit(2);
  }

  const arms: ArmStats[] = summary.arms;
  const gated = arms
    .filter((a) => a.arm !== BASELINE)
    .filter((a) => armFilter.length === 0 || armFilter.includes(a.arm));

  console.log(`bench-gate — ${file}`);
  console.log(`tolerance ${(tolerance * 100).toFixed(1)}% · baseline ${BASELINE} · ${gated.length} arm(s) gated\n`);

  const failures: string[] = [];

  // Check 1: aggregate token savings within tolerance per arm.
  for (const a of gated) {
    const pctSaved = num(a.savedTokensPct);
    const pass = pctSaved >= -tolerance;
    const verb = a.savedTokens >= 0 ? "saved" : "ADDED";
    console.log(
      `  ${pass ? "PASS" : "FAIL"}  ${a.arm.padEnd(20)} ${verb} ${Math.round(Math.abs(num(a.savedTokens))).toLocaleString()} tok/session (${(pctSaved * 100).toFixed(1)}%)`,
    );
    if (!pass) {
      failures.push(`${a.arm}: aggregate tokens regressed ${(pctSaved * 100).toFixed(1)}% (>${(tolerance * 100).toFixed(1)}% over baseline)`);
    }
  }

  // Check 2: the session-only arm must keep the proven resume-focus win.
  const perTask: any[] = Array.isArray(summary.perTask) ? summary.perTask : [];
  const resume = perTask.find((t) => t?.task === "resume-focus");
  const sessionGated = gated.some((a) => a.arm === "session-only");
  if (sessionGated && resume) {
    const delta = num(resume?.byArm?.["session-only"]?.tokDelta);
    const pass = delta > 0;
    console.log(`\n  ${pass ? "PASS" : "FAIL"}  resume-focus / session-only Δtokens = ${delta >= 0 ? "+" : ""}${Math.round(delta).toLocaleString()} (must be > 0)`);
    if (!pass) {
      failures.push("session-only lost the resume-focus win (Δtokens <= 0) — its proven sweet spot regressed");
    }
  } else if (sessionGated) {
    console.log("\n  (resume-focus task not in this run — skipping the sweet-spot check)");
  }

  if (failures.length > 0) {
    console.error(`\n❌ bench-gate FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\n✅ bench-gate passed — no arm regressed tokens beyond tolerance.");
}

main();
