---
name: codaph-observability
description: Use when working in a repo that uses Codaph and you need shared agent history, a fresh context block before starting Claude or Codex, a checkpoint before risky edits, diagnostics for agent loops, or explicit handoffs between agents.
---

# Codaph Observability

## Overview

Use this skill when Codaph should be the memory and handoff layer around agent work in a repo. It standardizes when to run `codaph push`, `pull`, `mubit context`, `mubit snapshot`, `mubit activity`, `checkpoint`, `diagnose`, `reflect`, and `handoff` so work becomes inspectable and transferable instead of living only in one terminal session.

## Response Contract

When the user asks about repo state, recent direction, what changed, what another agent did, or what the next agent should know, do not answer from code or git first.

Default to a Codaph-first evidence pass:

1. Run `codaph status --cwd <repo> --json`.
2. Run `codaph pull --cwd <repo> --json` to refresh local state from Codaph and Mubit.
3. Use `codaph pull --full --cwd <repo> --json` only if the user asks for full replay, remote history looks truncated, or a new machine needs reconstruction.
4. Ask Codaph for context with `codaph mubit context "<user question in plain language>" --cwd <repo> --json`.
5. If the question is about assembled state or current direction, also inspect `codaph mubit snapshot --cwd <repo> --json`.
6. If the question is about chronology, agent actions, or handoffs over time, inspect `codaph mubit activity --cwd <repo> --json`.
7. If the question is about one concrete run, add `--session <id>` to the context or follow-up commands.

If Codaph returns weak or empty results, say that explicitly and only then use git history, the working tree, or source inspection as secondary evidence.

## Answer Format

When this skill is used for analysis or status questions, clearly separate:

- `Codaph evidence`: what came from `status`, `pull`, `mubit context`, `mubit snapshot`, `mubit activity`, `doctor mubit`, `mubit diagnose`, handoffs, or other Codaph commands.
- `Secondary inference`: what you inferred from git history, the working tree, docs, or source code after Codaph evidence was insufficient.
- `Gaps`: what Codaph or Mubit did not return, such as an empty context block or missing strategies.

Do not present secondary inference as if it came from Codaph.

## When To Use

- The repo already has Codaph state such as `.codaph`, or should be tracked with Codaph.
- You are switching between Claude Code, Codex, and Gemini CLI.
- You want shared repo context before starting or resuming an agent run.
- You are about to make risky edits and want a named checkpoint first.
- An agent is looping on a bug and you want prior lessons or similar failures.
- You want a real handoff instead of a vague "done" message.
- You want reusable lessons after a meaningful outcome.

Do not use this skill if Codaph is not installed or configured for the repo and the task does not justify setting it up.

## Workflow

1. Resolve the target repo root and run `codaph status --cwd <repo> --json`.
2. If recent local agent work may not be in Codaph yet, run `codaph push --cwd <repo>`.
3. If you need team or cloud state locally, run `codaph pull --cwd <repo> --json`.
4. Use `codaph pull --full --cwd <repo> --json` only when history looks truncated or you are reconstructing a repo on a new machine.
5. Before answering repo-state or handoff questions, ask Codaph for a context block with `codaph mubit context`.
6. Use `codaph mubit snapshot` when you need assembled run state instead of a prompt-ready handoff block.
7. Use `codaph mubit activity` when you need chronological audit data instead of a semantic answer.
8. Before risky edits, create a checkpoint with `codaph checkpoint`.
9. If the agent is stuck, use `codaph doctor mubit` and `codaph mubit diagnose`.
10. If another agent should continue, create a structured handoff with `codaph handoff send`.
11. After meaningful progress, run `codaph mubit reflect`, then check `codaph mubit strategies` if you want reusable patterns.

## Decision Rules

- Prefer project scope when you need shared memory across contributors or providers.
- Add `--session <id>` when the task is tied to one concrete run.
- Use `mubit context` before handoffs or fresh starts, not after the new agent has already drifted.
- Use `mubit snapshot` for assembled state and `mubit activity` for chronology; do not treat them as interchangeable.
- Use checkpoints before refactors, migrations, or other state changes you may need to revisit.
- Use handoffs when switching providers; do not rely on free-form chat summaries alone.
- Reflection is most useful after successful work or instructive failures, not after trivial commands.

## Common Mistakes

- Writing a repo summary before running any Codaph commands.
- Running `mubit context` before `push` or `pull` and expecting fresh state.
- Forgetting `--action` on `codaph handoff send`.
- Diagnosing a run-wide problem with `--session`, or diagnosing a session-specific problem without `--session`.
- Assuming empty context or strategies means the command failed; sometimes Mubit simply found nothing strong enough to return.
- Blending Codaph output with git/code inference without labeling the difference.
- Expecting automatic agent registration or auto-checkpoints when repo automation settings still show those toggles as off.

## Reference

See [references/commands.md](references/commands.md) for copy-paste command patterns, including a smoke-test block for `/Users/shankha/code/codaph`.
