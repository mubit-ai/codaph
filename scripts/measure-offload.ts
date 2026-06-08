#!/usr/bin/env bun
//
// Empirical, cost-free demonstration that the offload lever reduces tokens.
// Runs the REAL attributeContextCost over an actual Claude transcript to measure
// the compounding cache-read tax that already happened, then models the token/$
// reduction the implemented ≤maxTokens summary-offload would have produced.
//
// No API spend, no agent spawn — it reads a transcript on disk and uses the same
// pricing + attribution code the product ships. Pass a transcript path, or it
// picks the largest transcript for THIS repo.
//
// Run: bun scripts/measure-offload.ts [transcript.jsonl]

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { attributeContextCost } from "../src/lib/token-attribution";
import { DEFAULT_PRICE_TABLE } from "../src/lib/token-accounting";
import { DEFAULT_INJECTION_CONFIG } from "../src/lib/injection-config";

const SUMMARY_BUDGET = DEFAULT_INJECTION_CONFIG.preToolUse.maxTokens; // 400 tok served instead of bulk

function pickTranscript(): string | null {
  if (process.argv[2]) {
    return process.argv[2];
  }
  const dir = join(homedir(), ".claude", "projects", process.cwd().replaceAll("/", "-"));
  if (!existsSync(dir)) {
    return null;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  return files[0]?.f ?? null;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function k(n: number): string {
  return Math.round(n).toLocaleString();
}

const path = pickTranscript();
if (!path || !existsSync(path)) {
  console.error("No transcript found. Pass one: bun scripts/measure-offload.ts <file.jsonl>");
  process.exit(2);
}

const a = attributeContextCost(readFileSync(path, "utf8"), DEFAULT_PRICE_TABLE);
if (!a) {
  console.error("No assistant turns in that transcript.");
  process.exit(2);
}

const line = "─".repeat(78);
console.log(`\n${line}`);
console.log(`  OFFLOAD MEASUREMENT (real transcript, real pricing) — model ${a.model}`);
console.log(`  ${a.assistantTurns} assistant turns · ${a.toolResults} tool results · ${k(a.totalResultTokens)} result tok`);
console.log(line);

console.log(`\n  MEASURED cache tax in this real session:`);
console.log(`    actual cache cost (read ${usd(a.cacheReadUsdActual)} + write ${usd(a.cacheWriteUsdActual)}) = ${usd(a.cacheReadUsdActual + a.cacheWriteUsdActual)}`);
console.log(`    attributable to tool results: ${usd(a.attributableUsd)}  ·  offloadable: ${usd(a.offloadableUsd)}`);

// Model the offload: each offloadable result of R tokens would instead be served
// as a summary of S = min(R, SUMMARY_BUDGET) tokens, so its compounding tax scales
// by S/R. Two scopes:
//   conservative (within-session): only the RE-READ tax is removed (first read of
//     the file this session still pays, because that's when we cache the summary).
//   cross-session (cache pre-warmed): a repeat read of an UNCHANGED file in a later
//     session serves the cached summary from turn one, removing write + reads.
let consSaved = 0; // re-read tax removed only
let crossSaved = 0; // full bulk tax removed (write + reads)
let savedResultTokens = 0;
const offloadable = a.drivers.filter((d) => d.offloadable && d.resultTokens > SUMMARY_BUDGET);
for (const d of offloadable) {
  const S = Math.min(d.resultTokens, SUMMARY_BUDGET);
  const shrink = 1 - S / d.resultTokens;
  consSaved += d.cacheReadUsd * shrink; // remove only the compounding re-read portion
  crossSaved += d.totalUsd * shrink; // remove write + read portion
  savedResultTokens += (d.resultTokens - S) * Math.max(1, d.rereadTurns);
}

console.log(`\n  MODELED reduction from the ≤${SUMMARY_BUDGET}-tok summary-offload (${offloadable.length} large offloadable results):`);
console.log(`    within-session (re-read tax removed):   ${usd(consSaved)}  saved`);
console.log(`    cross-session (cache pre-warmed):       ${usd(crossSaved)}  saved`);
const cacheTotal = a.cacheReadUsdActual + a.cacheWriteUsdActual;
if (cacheTotal > 0) {
  console.log(`    cross-session as a share of cache cost: ${((crossSaved / cacheTotal) * 100).toFixed(1)}%`);
}
console.log(`    context token-turns kept out of the window: ~${k(savedResultTokens)}`);

console.log(`\n  Top offloadable results (R = result tok, served as ≤${SUMMARY_BUDGET}-tok summary on repeat):`);
for (const d of offloadable.slice(0, 8)) {
  const S = Math.min(d.resultTokens, SUMMARY_BUDGET);
  console.log(
    `    ${usd(d.totalUsd * (1 - S / d.resultTokens)).padStart(9)}  ${d.toolName.padEnd(5)} R=${k(d.resultTokens).padStart(7)} tok · re-read ${d.rereadTurns}× · ${d.target ?? ""}`.slice(0, 110),
  );
}
console.log(`\n  Assumptions: summary fidelity ≥ the need (else the agent re-reads — bounded by the regret guard);`);
console.log(`  offload applies to repeat reads of UNCHANGED files (content-hash gated). Pricing = ${a.unpriced ? "UNPRICED" : "DEFAULT_PRICE_TABLE"}.`);
console.log(`${line}\n`);
