import { describe, expect, it } from "vitest";
import {
  INJECTION_TRUST_HEADER,
  buildHookOutput,
  buildPreToolHookOutput,
  buildPromptContext,
  buildSessionStartContext,
  buildToolMemoryQuery,
  clampToTokenBudget,
  decidePreToolAction,
  distillFactsBlock,
  estimateTokens,
  extractContextBlockText,
  isActivityNarration,
  isBarePathBullet,
  isCoveredByClaudeMd,
  extractPromptAnswer,
  extractSnapshotText,
  extractStrategyLines,
  fetchToolMemoryAnswer,
  formatInjection,
  isWeakAnswer,
  shouldInjectForPrompt,
  toolSignature,
  type InjectionMemory,
} from "../src/lib/context-injection";
import { DEFAULT_INJECTION_CONFIG, type ResolvedInjectionConfig } from "../src/lib/injection-config";

const ENABLED: ResolvedInjectionConfig = { ...DEFAULT_INJECTION_CONFIG, enabled: true };

// Build a stub Mubit engine; each method defaults to an empty response and can
// be overridden (including with a rejecting promise to exercise fail-open).
function makeMemory(overrides: Partial<Record<keyof InjectionMemory, () => Promise<Record<string, unknown>>>> = {}): InjectionMemory {
  const empty = async (): Promise<Record<string, unknown>> => ({});
  return {
    getContextBlock: overrides.getContextBlock ?? empty,
    inspectContextSnapshot: overrides.inspectContextSnapshot ?? empty,
    surfaceStrategies: overrides.surfaceStrategies ?? empty,
    queryWithContextFallback: overrides.queryWithContextFallback ?? empty,
  } as unknown as InjectionMemory;
}

describe("pure helpers", () => {
  it("estimates tokens and clamps to a budget", () => {
    expect(estimateTokens("abcd")).toBe(1);
    const long = "x".repeat(1000);
    const clamped = clampToTokenBudget(long, 10); // 10 tokens ≈ 40 chars
    expect(clamped.length).toBeLessThanOrEqual(40);
    expect(clamped).toContain("truncated");
    expect(clampToTokenBudget("short", 100)).toBe("short");
  });

  it("extracts context block text, falling back to section summaries", () => {
    expect(extractContextBlockText({ context_block: "hello" })).toBe("hello");
    expect(extractContextBlockText({ context: "via context" })).toBe("via context");
    expect(
      extractContextBlockText({ section_summaries: [{ section_name: "A", summary: "sa" }, { summary: "sb" }] }),
    ).toBe("- A: sa\n- sb");
    expect(extractContextBlockText({})).toBeNull();
  });

  it("flags activity narration but keeps durable facts", () => {
    expect(isActivityNarration("The user explored the repository structure.")).toBe(true);
    expect(isActivityNarration("The agent is initiating a systematic exploration.")).toBe(true);
    expect(isActivityNarration("The developer performed a codebase analysis.")).toBe(true);
    expect(isActivityNarration("Listed the file structure of the project.")).toBe(true);
    expect(isActivityNarration("The codebase implements git hooks in src/sync-automation.ts.")).toBe(false);
    expect(isActivityNarration("Auth lives in src/auth; CLI in src/index.ts.")).toBe(false);
  });

  it("distils a fact block: drops narration + citation noise, keeps durable facts", () => {
    const block = [
      "### Known Facts",
      "",
      "- The user is performing a comprehensive architectural audit of the codebase.",
      "  (source: codaph-cli, score: 0.99)",
      "- The codebase implements git hooks (post-commit, post-push) in src/sync-automation.ts.",
      "  (source: codaph-cli, score: 0.98)",
      "- The agent explored the test directory structure.",
      "  (source: codaph-cli, score: 0.97)",
    ].join("\n");
    const out = distillFactsBlock(block);
    expect(out).toContain("### Known Facts");
    expect(out).toContain("git hooks (post-commit, post-push) in src/sync-automation.ts");
    expect(out).not.toContain("architectural audit");
    expect(out).not.toContain("explored the test directory");
    expect(out).not.toContain("source:");
    expect(out).not.toContain("score:");
  });

  it("distils to empty + drops the emptied header when every fact is narration", () => {
    const block = [
      "### Known Facts",
      "- The user listed the project files.",
      "  (source: codaph-cli, score: 0.99)",
      "- The agent inspected the test suite.",
    ].join("\n");
    expect(distillFactsBlock(block)).toBe("");
  });

  it("extractContextBlockText strips narration and returns null when nothing durable remains", () => {
    expect(
      extractContextBlockText({
        context_block: "### Known Facts\n- The user explored src/.\n- The agent listed files.",
      }),
    ).toBeNull();
    expect(
      extractContextBlockText({
        context_block: "- The user explored the repo.\n- Redaction lives in src/lib/security.ts (redactUnknown).",
      }),
    ).toBe("- Redaction lives in src/lib/security.ts (redactUnknown).");
  });

  it("composes snapshot text from summary + next actions + progress", () => {
    const text = extractSnapshotText({
      snapshot_summary: "Mid-refactor of auth.",
      snapshot_next_actions: ["wire logout", "add tests"],
      snapshot_progress: ["extracted session store"],
    });
    expect(text).toContain("Mid-refactor of auth.");
    expect(text).toContain("Next actions:");
    expect(text).toContain("- wire logout");
    expect(text).toContain("Recent progress:");
    expect(extractSnapshotText({})).toBeNull();
  });

  it("extracts strategy lines up to a cap", () => {
    const lines = extractStrategyLines(
      { strategies: [{ description: "d1" }, { summary: "d2" }, { title: "d3" }, { description: "d4" }] },
      2,
    );
    expect(lines).toEqual(["- d1", "- d2"]);
    expect(extractStrategyLines({})).toEqual([]);
  });

  it("confidence-gates strategy lines by supporting_lesson_count when minSupport > 0", () => {
    const strategies = {
      strategies: [
        { description: "reinforced", supporting_lesson_count: 3 },
        { description: "one-off", supporting_lesson_count: 1 },
        { description: "no-support" },
        { description: "camel", supportingLessonCount: 2 },
      ],
    };
    expect(extractStrategyLines(strategies, 5, 2)).toEqual(["- reinforced", "- camel"]);
    // minSupport 0 (default) keeps all.
    expect(extractStrategyLines(strategies, 5)).toHaveLength(4);
  });

  it("isBarePathBullet flags lead-only paths but keeps paths with a claim", () => {
    expect(isBarePathBullet("src/foo.ts")).toBe(true);
    expect(isBarePathBullet("src/lib/bar.ts:")).toBe(true);
    expect(isBarePathBullet("package.json")).toBe(true);
    expect(isBarePathBullet("src/foo.ts owns the fail-open circuit")).toBe(false);
    expect(isBarePathBullet("Redaction lives in src/lib/security.ts")).toBe(false);
    expect(isBarePathBullet("It uses sha256 hashing.")).toBe(false);
  });

  it("isCoveredByClaudeMd suppresses bullets the agent already has", () => {
    const claudeMd = "The ingest pipeline writes to a local JSONL mirror and Mubit cloud memory.";
    expect(isCoveredByClaudeMd("The ingest pipeline writes to the JSONL mirror and Mubit memory.", claudeMd)).toBe(true);
    expect(isCoveredByClaudeMd("Authentication uses bcrypt password hashing rounds.", claudeMd)).toBe(false);
    expect(isCoveredByClaudeMd("anything", null)).toBe(false);
    // Too few significant terms → never considered covered (avoids over-suppression).
    expect(isCoveredByClaudeMd("the mirror", claudeMd)).toBe(false);
  });

  it("identifies weak answers and extracts prompt answers", () => {
    expect(isWeakAnswer("I do not know.")).toBe(true);
    expect(isWeakAnswer("")).toBe(true);
    // Hedged non-answers that lead with a disclaimer are weak too.
    expect(isWeakAnswer("I do not know. While the evidence identifies X, it does not document Y.")).toBe(true);
    expect(isWeakAnswer("The provided evidence does not specify the dedupe logic.")).toBe(true);
    expect(isWeakAnswer("auth lives in src/auth")).toBe(false);
    expect(extractPromptAnswer({ final_answer: "real answer" })).toBe("real answer");
    expect(extractPromptAnswer({ final_answer: "I don't know", supplemental_context_block: "block" })).toBe("block");
    expect(extractPromptAnswer({ final_answer: "unknown" })).toBeNull();
  });

  it("gates trivial prompts", () => {
    expect(shouldInjectForPrompt("hi", 24)).toBe(false);
    expect(shouldInjectForPrompt("thanks", 24)).toBe(false);
    expect(shouldInjectForPrompt("short", 24)).toBe(false);
    expect(shouldInjectForPrompt("How does the ingest pipeline dedupe events?", 24)).toBe(true);
  });

  it("formats an injection with the trust header and clamps; empty parts => null", () => {
    const out = formatInjection([{ heading: "Overview", body: "stuff" }], 1000);
    expect(out).toContain(INJECTION_TRUST_HEADER);
    expect(out).toContain("## Overview");
    expect(out).toContain("stuff");
    expect(formatInjection([{ heading: "x", body: "   " }], 1000)).toBeNull();
  });

  it("builds hook output JSON, no-op for empty context", () => {
    expect(buildHookOutput("SessionStart", null)).toBe("{}");
    expect(buildHookOutput("SessionStart", "  ")).toBe("{}");
    const parsed = JSON.parse(buildHookOutput("SessionStart", "ctx"));
    expect(parsed).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" } });
  });

  it("emits per-agent context-injection shapes (claude/codex identical, gemini omits hookEventName)", () => {
    const claude = JSON.parse(buildHookOutput("SessionStart", "ctx", "claude"));
    const codex = JSON.parse(buildHookOutput("SessionStart", "ctx", "codex"));
    expect(codex).toEqual(claude); // Codex shares Claude's contract
    expect(claude.hookSpecificOutput.hookEventName).toBe("SessionStart");

    const gemini = JSON.parse(buildHookOutput("SessionStart", "ctx", "gemini"));
    expect(gemini).toEqual({ hookSpecificOutput: { additionalContext: "ctx" } });
    expect(gemini.hookSpecificOutput.hookEventName).toBeUndefined();
  });

  it("emits per-agent pre-tool shapes (gemini uses top-level decision/reason)", () => {
    const deny = { kind: "deny" as const, text: "auth in src/auth" };
    const claudeDeny = JSON.parse(buildPreToolHookOutput(deny, "claude"));
    expect(claudeDeny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(buildPreToolHookOutput(deny, "codex"))).toEqual(claudeDeny);

    const geminiDeny = JSON.parse(buildPreToolHookOutput(deny, "gemini"));
    expect(geminiDeny.decision).toBe("deny");
    expect(geminiDeny.reason).toContain("auth in src/auth");
    expect(geminiDeny.hookSpecificOutput).toBeUndefined();

    const geminiAug = JSON.parse(buildPreToolHookOutput({ kind: "augment", text: "hint" }, "gemini"));
    expect(geminiAug.hookSpecificOutput.additionalContext).toContain("hint");
    expect(geminiAug.hookSpecificOutput.hookEventName).toBeUndefined();
  });
});

describe("buildSessionStartContext", () => {
  it("returns null on resume (context already present)", async () => {
    const out = await buildSessionStartContext(makeMemory(), "run:proj", "resume", ENABLED);
    expect(out).toBeNull();
  });

  it("returns null when sessionStart is disabled", async () => {
    const config: ResolvedInjectionConfig = {
      ...ENABLED,
      sessionStart: { enabled: false, maxTokens: 1500, includeOverview: false },
    };
    const out = await buildSessionStartContext(makeMemory(), "run:proj", "startup", config);
    expect(out).toBeNull();
  });

  it("on compact injects only a recovery block from the snapshot", async () => {
    const memory = makeMemory({
      inspectContextSnapshot: async () => ({ snapshot_summary: "Was wiring the SessionEnd hook." }),
    });
    const out = await buildSessionStartContext(memory, "run:proj", "compact", ENABLED);
    expect(out).toContain("Resuming after compaction");
    expect(out).toContain("Was wiring the SessionEnd hook.");
  });

  it("by DEFAULT injects NOTHING on a fresh startup (do-no-harm; live A/B showed a blind digest is net-negative)", async () => {
    const memory = makeMemory({
      // Nothing should even be queried on a default fresh start.
      getContextBlock: async () => {
        throw new Error("must not query on default startup");
      },
      inspectContextSnapshot: async () => {
        throw new Error("must not query on default startup");
      },
      surfaceStrategies: async () => {
        throw new Error("must not query on default startup");
      },
    });
    expect(await buildSessionStartContext(memory, "run:proj", "startup", ENABLED)).toBeNull();
  });

  it("with includeOverview on, composes overview (pruning bare paths + CLAUDE.md-covered) + snapshot + lessons", async () => {
    const config: ResolvedInjectionConfig = {
      ...ENABLED,
      sessionStart: { ...ENABLED.sessionStart, includeOverview: true },
    };
    const memory = makeMemory({
      getContextBlock: async () => ({
        context_block: [
          "- Auth lives in src/auth and is verified at startup.",
          "- src/index.ts", // bare path lead → dropped
          "- The ingest pipeline writes to the JSONL mirror and Mubit memory.", // covered by CLAUDE.md → dropped
        ].join("\n"),
      }),
      inspectContextSnapshot: async () => ({ snapshot_summary: "Refactoring sync." }),
      surfaceStrategies: async () => ({ strategies: [{ description: "Mubit writes are fail-open.", supporting_lesson_count: 4 }] }),
    });
    const claudeMd = "The ingest pipeline writes to a local JSONL mirror and Mubit cloud memory.";
    const out = await buildSessionStartContext(memory, "run:proj", "startup", config, claudeMd);
    expect(out).toContain("Project overview");
    expect(out).toContain("Auth lives in src/auth");
    expect(out).not.toContain("- src/index.ts"); // bare-path lead pruned
    expect(out).not.toContain("ingest pipeline writes"); // CLAUDE.md-covered pruned
    expect(out).toContain("Where recent work left off");
    expect(out).toContain("Mubit writes are fail-open");
  });

  it("is fail-open: a rejecting overview query does not throw and other parts still render", async () => {
    const config: ResolvedInjectionConfig = {
      ...ENABLED,
      sessionStart: { ...ENABLED.sessionStart, includeOverview: true },
    };
    const memory = makeMemory({
      getContextBlock: async () => {
        throw new Error("network down");
      },
      inspectContextSnapshot: async () => ({ snapshot_summary: "Still have a snapshot." }),
    });
    const out = await buildSessionStartContext(memory, "run:proj", "startup", config);
    expect(out).toContain("Still have a snapshot.");
    expect(out).not.toContain("Project overview");
  });
});

describe("buildPromptContext", () => {
  it("returns null for trivial prompts", async () => {
    const out = await buildPromptContext(makeMemory(), "run:proj", "hi", ENABLED);
    expect(out).toBeNull();
  });

  it("injects a relevant block for a substantive prompt", async () => {
    const memory = makeMemory({
      queryWithContextFallback: async () => ({ final_answer: "The dedupe key is eventId; see ingest-pipeline.ts." }),
    });
    const out = await buildPromptContext(memory, "run:proj", "How does event dedupe work in the pipeline?", ENABLED);
    expect(out).toContain("Relevant prior context");
    expect(out).toContain("eventId");
  });

  it("returns null when the retrieved answer is weak", async () => {
    const memory = makeMemory({
      queryWithContextFallback: async () => ({ final_answer: "I do not know." }),
    });
    const out = await buildPromptContext(memory, "run:proj", "What is the meaning of this obscure thing?", ENABLED);
    expect(out).toBeNull();
  });
});

describe("PreToolUse helpers", () => {
  it("builds memory queries only for Read/Grep/Glob with usable input", () => {
    expect(buildToolMemoryQuery("Grep", { pattern: "redactUnknown" })).toContain("redactUnknown");
    expect(buildToolMemoryQuery("Glob", { pattern: "**/*.test.ts" })).toContain("**/*.test.ts");
    expect(buildToolMemoryQuery("Read", { file_path: "src/index.ts" })).toContain("src/index.ts");
    expect(buildToolMemoryQuery("Bash", { command: "ls" })).toBeNull();
    expect(buildToolMemoryQuery("Grep", {})).toBeNull();
  });

  it("produces stable signatures keyed on tool + input", () => {
    const a = toolSignature("Grep", { pattern: "x" });
    const b = toolSignature("grep", { pattern: "x" });
    const c = toolSignature("Grep", { pattern: "y" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("decides allow when there is no/weak answer or mode is off", () => {
    const base = { toolName: "Grep", alreadyDenied: false, denialCount: 0, maxDenials: 8 };
    expect(decidePreToolAction({ ...base, mode: "shortcircuit", answer: null }).kind).toBe("allow");
    expect(decidePreToolAction({ ...base, mode: "shortcircuit", answer: "I do not know." }).kind).toBe("allow");
    expect(decidePreToolAction({ ...base, mode: "off", answer: "auth in src/auth" }).kind).toBe("allow");
  });

  it("augments (never denies) in augment mode", () => {
    const d = decidePreToolAction({
      mode: "augment",
      toolName: "Grep",
      answer: "auth in src/auth",
      alreadyDenied: false,
      denialCount: 0,
      maxDenials: 8,
    });
    expect(d.kind).toBe("augment");
    expect(d.text).toBe("auth in src/auth");
  });

  it("short-circuits search tools once, then falls back to augment (loop guard + cap)", () => {
    // High confidence + fresh target + shortcircuit are required to deny.
    const base = {
      mode: "shortcircuit" as const,
      answer: "auth in src/auth",
      confidence: 0.9,
      fileFresh: true,
      minConfidenceToAugment: 0.6,
      minConfidenceToDeny: 0.8,
      maxDenials: 2,
    };
    // fresh, confident grep → deny
    expect(decidePreToolAction({ ...base, toolName: "Grep", alreadyDenied: false, denialCount: 0 }).kind).toBe("deny");
    // same signature already denied → augment (don't loop)
    expect(decidePreToolAction({ ...base, toolName: "Grep", alreadyDenied: true, denialCount: 1 }).kind).toBe("augment");
    // denial cap reached → augment
    expect(decidePreToolAction({ ...base, toolName: "Glob", alreadyDenied: false, denialCount: 2 }).kind).toBe("augment");
    // Read is left ALONE in shortcircuit (live A/B proved deny AND augment on
    // reads both backfire) — neither denied nor augmented, even when fresh+confident.
    expect(decidePreToolAction({ ...base, toolName: "Read", alreadyDenied: false, denialCount: 0 }).kind).toBe("allow");
  });

  it("deny is fenced by confidence, freshness, and regret-backoff", () => {
    const base = {
      mode: "shortcircuit" as const,
      toolName: "Grep",
      answer: "auth in src/auth",
      minConfidenceToAugment: 0.6,
      minConfidenceToDeny: 0.8,
      alreadyDenied: false,
      denialCount: 0,
      maxDenials: 8,
    };
    // not fresh → augment, not deny
    expect(decidePreToolAction({ ...base, confidence: 0.9, fileFresh: false }).kind).toBe("augment");
    // freshness unknown (null, the Phase 2.2 default) → augment, not deny
    expect(decidePreToolAction({ ...base, confidence: 0.9, fileFresh: null }).kind).toBe("augment");
    // confidence below deny threshold → augment
    expect(decidePreToolAction({ ...base, confidence: 0.7, fileFresh: true }).kind).toBe("augment");
    // confidence unknown → can't deny
    expect(decidePreToolAction({ ...base, confidence: null, fileFresh: true }).kind).toBe("augment");
    // all gates pass → deny
    expect(decidePreToolAction({ ...base, confidence: 0.85, fileFresh: true }).kind).toBe("deny");
    // a prior regret backs off deny even when all else passes
    expect(decidePreToolAction({ ...base, confidence: 0.85, fileFresh: true, denyBackoff: true }).kind).toBe("augment");
  });

  it("confidence gate drops a known-low-confidence answer entirely (augment mode)", () => {
    const base = { mode: "augment" as const, toolName: "Grep", answer: "maybe src/auth", minConfidenceToAugment: 0.6, alreadyDenied: false, denialCount: 0, maxDenials: 8 };
    expect(decidePreToolAction({ ...base, confidence: 0.4 }).kind).toBe("allow"); // dropped
    expect(decidePreToolAction({ ...base, confidence: 0.8 }).kind).toBe("augment");
    expect(decidePreToolAction({ ...base, confidence: null }).kind).toBe("augment"); // unknown → fall back to augment
  });

  it("renders hook output per decision kind", () => {
    expect(buildPreToolHookOutput({ kind: "allow", text: null })).toBe("{}");

    const augment = JSON.parse(buildPreToolHookOutput({ kind: "augment", text: "hint here" }));
    expect(augment.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(augment.hookSpecificOutput.additionalContext).toContain("hint here");

    const deny = JSON.parse(buildPreToolHookOutput({ kind: "deny", text: "auth in src/auth" }));
    expect(deny.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain("auth in src/auth");
    expect(deny.hookSpecificOutput.permissionDecisionReason).toContain("re-issue");
  });

  it("fetchToolMemoryAnswer returns {answer, confidence}, null on weak/error", async () => {
    const ok = makeMemory({
      queryWithContextFallback: async () => ({ final_answer: "lives in src/auth/index.ts", confidence: 0.82 }),
    });
    const got = await fetchToolMemoryAnswer(ok, "run:proj", "where is auth?", 400);
    expect(got?.answer).toContain("src/auth");
    expect(got?.confidence).toBeCloseTo(0.82, 6);

    // No top-level confidence → mean of evidence scores.
    const viaEvidence = makeMemory({
      queryWithContextFallback: async () => ({ final_answer: "in src/x", evidence: [{ score: 0.4 }, { score: 0.6 }] }),
    });
    expect((await fetchToolMemoryAnswer(viaEvidence, "run:proj", "where?", 400))?.confidence).toBeCloseTo(0.5, 6);

    const weak = makeMemory({ queryWithContextFallback: async () => ({ final_answer: "unknown" }) });
    expect(await fetchToolMemoryAnswer(weak, "run:proj", "where?", 400)).toBeNull();

    const boom = makeMemory({
      queryWithContextFallback: async () => {
        throw new Error("down");
      },
    });
    expect(await fetchToolMemoryAnswer(boom, "run:proj", "where?", 400)).toBeNull();
  });
});
