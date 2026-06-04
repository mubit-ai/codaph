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
});

describe("buildSessionStartContext", () => {
  it("returns null on resume (context already present)", async () => {
    const out = await buildSessionStartContext(makeMemory(), "run:proj", "resume", ENABLED);
    expect(out).toBeNull();
  });

  it("returns null when sessionStart is disabled", async () => {
    const config: ResolvedInjectionConfig = { ...ENABLED, sessionStart: { enabled: false, maxTokens: 1500 } };
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

  it("on startup composes overview + snapshot + lessons", async () => {
    const memory = makeMemory({
      getContextBlock: async () => ({ context_block: "Auth lives in src/auth; CLI in src/index.ts." }),
      inspectContextSnapshot: async () => ({ snapshot_summary: "Refactoring sync." }),
      surfaceStrategies: async () => ({ strategies: [{ description: "Mubit writes are fail-open." }] }),
    });
    const out = await buildSessionStartContext(memory, "run:proj", "startup", ENABLED);
    expect(out).toContain("Project overview");
    expect(out).toContain("Auth lives in src/auth");
    expect(out).toContain("Where recent work left off");
    expect(out).toContain("Lessons & gotchas");
    expect(out).toContain("Mubit writes are fail-open");
  });

  it("is fail-open: a rejecting Mubit call does not throw and other parts still render", async () => {
    const memory = makeMemory({
      getContextBlock: async () => {
        throw new Error("network down");
      },
      inspectContextSnapshot: async () => ({ snapshot_summary: "Still have a snapshot." }),
    });
    const out = await buildSessionStartContext(memory, "run:proj", "startup", ENABLED);
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
    const base = { mode: "shortcircuit" as const, answer: "auth in src/auth", maxDenials: 2 };
    // fresh grep → deny
    expect(decidePreToolAction({ ...base, toolName: "Grep", alreadyDenied: false, denialCount: 0 }).kind).toBe("deny");
    // same signature already denied → augment (don't loop)
    expect(decidePreToolAction({ ...base, toolName: "Grep", alreadyDenied: true, denialCount: 1 }).kind).toBe("augment");
    // denial cap reached → augment
    expect(decidePreToolAction({ ...base, toolName: "Glob", alreadyDenied: false, denialCount: 2 }).kind).toBe("augment");
    // Read is never denied even in shortcircuit mode
    expect(decidePreToolAction({ ...base, toolName: "Read", alreadyDenied: false, denialCount: 0 }).kind).toBe("augment");
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

  it("fetchToolMemoryAnswer returns a clamped answer, null on weak/error", async () => {
    const ok = makeMemory({ queryWithContextFallback: async () => ({ final_answer: "lives in src/auth/index.ts" }) });
    expect(await fetchToolMemoryAnswer(ok, "run:proj", "where is auth?", 400)).toContain("src/auth");

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
