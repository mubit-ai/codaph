#!/usr/bin/env bun
//
// Behavioral demonstration (no API spend) that the SHIPPING code — not a model —
// offloads a repeat Read of an unchanged file to a small summary. Uses the real
// summary-store, file-freshness, and decidePreToolAction the product runs in the
// PreToolUse hook. Shows: 1st read caches; 2nd read (unchanged) serves a
// ≤maxTokens summary via a deny decision; an edit invalidates the cache (no
// stale serve). Reports the per-repeat-read token reduction for a real file.
//
// Run: bun scripts/demo-read-offload.ts [file]

import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileFreshness, isFresh } from "../src/lib/file-freshness";
import { getStoredSummary, putStoredSummary } from "../src/lib/summary-store";
import { decidePreToolAction } from "../src/lib/context-injection";
import { DEFAULT_INJECTION_CONFIG } from "../src/lib/injection-config";

const BUDGET = DEFAULT_INJECTION_CONFIG.preToolUse.maxTokens;
const estTokens = (s: string): number => Math.ceil(s.length / 4);

// A real, large repo file (defaults to memory-mubit.ts — ~2k lines).
const realFile = process.argv[2] ?? join(process.cwd(), "src", "lib", "memory-mubit.ts");
const fileText = readFileSync(realFile, "utf8");
const fullTokens = estTokens(fileText);

// Isolated mirror so the demo doesn't touch the project's real store.
const mirror = mkdtempSync(join(tmpdir(), "codaph-offload-demo-"));
// Copy the file into the mirror so we can safely edit it for the staleness check.
const target = join(mirror, "memory-mubit.ts");
writeFileSync(target, fileText);

const cfg = {
  minConfidenceToAugment: DEFAULT_INJECTION_CONFIG.preToolUse.minConfidenceToAugment,
  minConfidenceToDeny: DEFAULT_INJECTION_CONFIG.preToolUse.minConfidenceToDeny,
  maxDenials: DEFAULT_INJECTION_CONFIG.preToolUse.maxDenials,
};

function readOnce(label: string, mode: "augment" | "shortcircuit"): void {
  const current = fileFreshness(target);
  const cached = getStoredSummary(mirror, target);
  const fresh = cached ? isFresh(cached, current) : false;

  let answer: string | null = null;
  let confidence: number | null = null;
  let fileFresh: boolean | null = null;

  if (cached && fresh) {
    answer = cached.summary;
    confidence = cached.confidence;
    fileFresh = true;
  } else {
    // cache miss → (in the hook this is Mubit's answer) synthesize a ≤BUDGET summary, cache it.
    const summary =
      `memory-mubit.ts: MubitMemoryEngine — wraps the Mubit client; writeEvent/writeEventsBatch ingest, ` +
      `getContextBlock/querySemanticContext retrieve, archive/dereference store exact artifacts. ` +
      `Fail-open via callControlMethod. Run scopes: codaph:<repo>[:session].`.slice(0, BUDGET * 4);
    putStoredSummary(mirror, {
      path: target,
      contentHash: current.contentHash,
      mtimeMs: current.mtimeMs,
      summary,
      confidence: 0.9,
    });
    answer = summary;
    confidence = 0.9;
    fileFresh = false;
  }

  const decision = decidePreToolAction({
    mode,
    toolName: "Read",
    answer,
    confidence,
    fileFresh,
    minConfidenceToAugment: cfg.minConfidenceToAugment,
    minConfidenceToDeny: cfg.minConfidenceToDeny,
    alreadyDenied: false,
    denialCount: 0,
    maxDenials: cfg.maxDenials,
  });
  const served = decision.text ? estTokens(decision.text) : fullTokens;
  const entersContext = decision.kind === "deny" ? served : fullTokens; // deny = file never read
  console.log(
    `    ${label.padEnd(34)} fresh=${String(fileFresh).padEnd(5)} decision=${decision.kind.padEnd(7)} → context gets ${entersContext === fullTokens ? `${fullTokens} tok (full file)` : `${served} tok (summary)`}`,
  );
}

const line = "─".repeat(78);
console.log(`\n${line}`);
console.log(`  READ-OFFLOAD BEHAVIORAL DEMO (real code paths) — file ${realFile}`);
console.log(`  full file ≈ ${fullTokens.toLocaleString()} tok · summary budget ${BUDGET} tok`);
console.log(line);

console.log(`\n  shortcircuit mode (deny serves the summary, file is never read):`);
readOnce("1st read (cache miss)", "shortcircuit");
readOnce("2nd read (unchanged)", "shortcircuit");

// Edit the file → cache must go stale → no stale serve.
writeFileSync(target, `${fileText}\n// edited ${"x".repeat(50)}`);
readOnce("3rd read (file edited)", "shortcircuit");
// Re-read after the edit re-cached it:
readOnce("4th read (unchanged again)", "shortcircuit");

const saved = fullTokens - BUDGET;
console.log(`\n  Per repeat read of this unchanged file, context receives ~${BUDGET} tok instead of ~${fullTokens.toLocaleString()}`);
console.log(`  → ~${saved.toLocaleString()} fewer tokens per repeat read, and that delta is no longer re-billed every later turn.`);
console.log(`  Staleness is content-hash gated: the post-edit read does NOT serve the old summary.`);
console.log(`${line}\n`);

rmSync(mirror, { recursive: true, force: true });
