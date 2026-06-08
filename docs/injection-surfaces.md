# Cross-agent injection surfaces

Reference for how each supported coding agent lets Codaph (a) inject context at
session start / per prompt and (b) gate or short-circuit a tool call before it
runs. This is the seam map for the token-reduction work — the levers Codaph uses
to cut tokens are delivered through these hooks.

**Headline:** as of mid-2026 **all three agents expose the full lever set** —
session-start context injection, per-prompt context injection, and a pre-tool
deny/gate. Earlier Codaph work wired only Claude Code; Codex and Gemini have
since shipped comparable hook systems. The contracts differ in detail (below)
but the pure decision logic (`context-injection.ts`) is reusable across all
three behind thin per-agent output adapters.

## Claude Code (reference implementation — already wired)

- **Events:** `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `SessionEnd` (+ others).
- **Context injection (SessionStart / UserPromptSubmit):** stdout JSON
  `{"hookSpecificOutput": {"hookEventName": "...", "additionalContext": "..."}}`.
- **Pre-tool deny (PreToolUse):** `{"hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`; augment with `additionalContext`.
- **Install:** `.claude/settings.json` `hooks` object. Codaph: `installClaudeCodeHooksBestEffort` (`src/index.ts`), output builders `buildHookOutput` / `buildPreToolHookOutput` (`src/lib/context-injection.ts`).

## Codex CLI (OpenAI) — contract is nearly identical to Claude

Docs: https://developers.openai.com/codex/hooks

- **Events:** `SessionStart` (startup|resume|clear|compact), `UserPromptSubmit`, `PreToolUse` (before Bash/apply_patch/MCP tool), `PermissionRequest`, `PostToolUse`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `Stop`.
- **Context injection (SessionStart / UserPromptSubmit):** plain stdout text is "added as extra developer context"; or JSON **identical to Claude's shape**:
  `{"hookSpecificOutput": {"hookEventName":"SessionStart","additionalContext":"..."}}`.
- **Pre-tool deny (PreToolUse):** **same shape as Claude** —
  `{"hookSpecificOutput": {"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. Also supports `"permissionDecision":"allow"` with `"updatedInput"` (rewrite the tool input) and `"additionalContext"` (augment without blocking). Exit code `2` + stderr also denies.
- **PermissionRequest:** `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message":"..."}}}`.
- **Install/discovery:** `hooks.json` or inline `[hooks]` tables in `config.toml`, at `~/.codex/{hooks.json,config.toml}` and `<repo>/.codex/{hooks.json,config.toml}`. (Codaph today only drops an `agent-complete` script into `~/.codex/hooks/` via `installAgentCompleteHookBestEffort` in `src/sync-automation.ts` — the lifecycle-hook config is a new, separate seam.)
- **Implication:** Codaph's existing Claude output builders work for Codex **verbatim** — same `additionalContext` and `permissionDecision` JSON. The deny lever **is** available on Codex.

## Gemini CLI (Google) — same capabilities, different field names

Docs: https://geminicli.com/docs/hooks/reference/

- **Events:** `SessionStart` (startup|resume|clear), `BeforeAgent` (after prompt submit, before planning), `BeforeModel`, `BeforeToolSelection` (before the LLM picks tools), `BeforeTool` / `AfterTool`, `AfterModel`, `AfterAgent`, `SessionEnd`, `PreCompress`, `Notification`.
- **Context injection (SessionStart / BeforeAgent):** stdout JSON
  `{"hookSpecificOutput": {"additionalContext": "..."}}` — note **no `hookEventName`** field; the text is "appended to the prompt for this turn only".
- **Pre-tool deny (BeforeTool):** top-level **`{"decision":"deny"|"block","reason":"..."}`** (NOT the nested `permissionDecision` shape). Exit code `2` + stderr also blocks.
- **Tool gating (BeforeToolSelection):** `{"hookSpecificOutput":{"toolConfig":{"mode":"AUTO"|"ANY"|"NONE","allowedFunctionNames":[...] }}}` — restrict the toolset rather than deny a specific call.
- **Install:** `settings.json` `hooks` object (project or extension `hooks/hooks.json`). All hooks receive on stdin a base schema: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `timestamp`.
- **Implication:** needs a small Gemini output adapter — `additionalContext` without `hookEventName`, and `{decision, reason}` for deny — but the same Codaph decision logic feeds it.

## Consequences for the plan

1. **Deny is NOT Claude-only.** All three support a pre-tool deny/gate, so the cache-tax short-circuit lever (Phase 2.2) ports to Codex (same JSON) and Gemini (adapter).
2. **One pure core, three thin adapters.** Keep `decidePreToolAction` / digest builders agent-agnostic (Phase 1.6); add per-agent hook-output adapters: Claude (exists), Codex (≈identical), Gemini (`{decision,reason}` + bare `additionalContext`).
3. **Generalize `hooksInstall`** (today `claude-code` only, `src/index.ts`) to also write Codex `hooks.json`/`config.toml` lifecycle entries and Gemini `settings.json` hooks.
4. **Measurement parity:** `parseCodexTranscriptUsage` / `parseGeminiTranscriptUsage` (`src/lib/token-accounting.ts`, Phase 0.2) give per-agent token totals; per-tool-result attribution (`token-attribution.ts`) remains Claude-transcript-shaped and would need per-agent transcript adapters to drive the offload work-list for Codex/Gemini.

## Implementation status

Done and unit-tested:
- **Output adapters** — `buildHookOutput` / `buildPreToolHookOutput` take an `AgentHookFormat` (`claude` | `codex` | `gemini`); `src/index.ts` selects it per provider via `hookFormatForProvider`.
- **Installers** — `installCodexHooksBestEffort` (`.codex/hooks.json`) and `installGeminiHooksBestEffort` (`.gemini/settings.json`) reuse the generic `installJsonHookFileBestEffort` merge; `codaph hooks install <claude-code|codex|gemini-cli> [--injection]` is generalized.
- **Token measurement** — per-provider transcript usage parsers (Phase 0.2).

Remaining (needs the real CLIs to verify the exact stdin schemas):
- **Per-provider stdin payload parsing.** The hook handlers read Claude-shaped fields (`payload.prompt`, `payload.tool_name`/`tool_input`, `payload.session_id`, `hookSourceFromPayload`). Codex's payload is close to Claude's; Gemini's base schema (`session_id`, `transcript_path`, `cwd`, `hook_event_name`) and `BeforeAgent` prompt key differ. Until adapters normalise these, **hooks are fail-open** — an unrecognised payload yields `{}` (no injection), never a broken session — so installing Codex/Gemini hooks is safe but Gemini injection may no-op until the payload adapter lands.
- **Cross-contributor offload** — mirror local summaries to Mubit `archive`/`dereference` (wrappers exist) from the post-session `agent-complete` automation, keyed by the `aggregateAttributions` work-list.

## Live benchmark findings (real Claude Code) and the resulting do-no-harm posture

Two A/B benchmarks against the real `claude` CLI (cloud Mubit, sonnet-4-6) were decisive:

1. **SessionStart digest → net-negative (~−17% tokens).** It injected (75%) but the "where work left off" recovery is irrelevant to a fresh prompt the hook can't see, and occasionally seeded extra exploration (one run: 5 turns/230k vs 3/140k).
2. **PreToolUse deny-on-Read → much worse (~−55% tokens),** even with a perfect deterministic outline. The agent genuinely needs the file, **re-reads it** (the retry is allowed by design; a post-compaction re-read is a legitimate need), and pays the summary + full read + ~2× the turns.

**Conclusion: hook-based injection/denial does not reduce tokens for coding agents — it increases them.** The agent's exploration is purposeful; interrupting or pre-loading it adds friction. The genuine, measured token-reduction lever is **measurement-guided subagent offload in long sessions** (attribution showed ~$24 / ~8% offloadable cache-tax on a real 440-turn session): a subagent reads the file and returns a short summary, so the bulk never enters the *main* context — which the agent does deliberately, not something a hook can force.

**Resulting posture (shipped, evidence-based, do-no-harm by default):**
- `SessionStart`: injects **nothing on a fresh startup** by default; recovery block only on `compact` (a proven context-loss need). Full startup digest is opt-in (`includeOverview`).
- `PreToolUse` **Read**: **never denied**, and not augmented in `shortcircuit` mode (left alone); a deterministic-summary hint is attached only in explicit `augment` mode.
- `PreToolUse` Grep/Glob: augment-only in practice (deny needs a freshness key that isn't wired).
- `UserPromptSubmit`: prompt-keyed retrieval, weak-answer-gated — the most defensible injection lever, retained.
- All injection remains **off by default** and gated by `scripts/bench-gate.ts`, which correctly blocked every net-negative config above.
- **Reliable token-reduction value = the measurement layer** (`codaph tokens attribution` / `--aggregate`) + the subagent-offload workflow it identifies.

## The lever that WORKS: subagent offload (validated live)

The opposite of intercepting the main agent's reads (which backfired) is to have the main agent **voluntarily delegate** exploration to a subagent that runs in its OWN context — so the file/search bulk never enters the main conversation, and (with a cheap model) is processed at a fraction of the price.

**Shipped:** `codaph hooks install claude-code` now also installs a **`codaph-explorer`** subagent (`.claude/agents/codaph-explorer.md`, `src/lib/claude-agents.ts`): `model: haiku`, read-only tools + codaph's Mubit MCP memory tools, with a system prompt that explores widely and returns ONLY a compact summary. Its `description` ("Use PROACTIVELY for where/what/how…") drives auto-delegation.

**Live A/B (real Claude Code, sonnet-4-6 main, haiku subagent, cloud Mubit), same task, N=2:**
- **Main-context tokens: 236k → 83k (−65%)** — *structural, consistent across both reps* (the file bulk lives in the subagent's context, not the main session's, so it never compounds in the main cache-read tax).
- **Total billed (incl. the haiku subagent): ~−37%** — cheaper in both reps; structurally because the bulk is processed by haiku, not the sonnet main agent. (Exact % is noisy at N=2 / cache-order-sensitive; the main-context reduction is the robust metric.)
- **Answer quality maintained** — the subagent read the real files and the final answer cited exact line numbers (`ingest-pipeline.ts:252–287`, `:274`).

Measurement note: in headless `claude -p`, a subagent's turns are NOT tagged `isSidechain` in the transcript — its cost folds into `total_cost_usd`. So delegation is detected via the `Agent` tool_use (renamed from `Task` in CC v2.1.63), and main-context size is the clean isolation metric. Harness: `scripts/bench-offload.ts`.

**Bottom line:** offloading search/exploration to the haiku `codaph-explorer` subagent is the token-reduction lever that actually works — it shrinks the (expensive) main context by ~⅔ and cuts cost, with answer quality intact. This is what `codaph tokens attribution` points at, now shipped as an installable subagent.
