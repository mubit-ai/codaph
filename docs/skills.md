---
layout: docs
---

# Skills

Codaph can be used directly from the CLI, through Claude Code via MCP, or with agent skills that standardize the workflow around context, checkpoints, diagnostics, and handoffs.

This page covers the repo-shared skill included with Codaph.

## Why Use A Skill

The CLI commands are already enough, but a skill helps an agent remember when to use them.

Use a skill when you want the agent to consistently:

- pull fresh Codaph state before starting work
- ask Mubit for a context block before a new run or provider switch
- create a checkpoint before risky edits
- diagnose repeated failures
- create an explicit handoff instead of ending with a loose summary
- reflect after meaningful work so later sessions can reuse the lessons

## Included Repo Skill

Codaph ships a repo-tracked skill at:

```text
skills/codaph-observability/SKILL.md
```

Use it when the repo already has Codaph state or when you want Codaph to be the memory and handoff layer around work done by Claude Code, Codex, or Gemini CLI.

## How To Invoke The Skill

Agents typically need a markdown link to the local `SKILL.md` file.

Use the absolute path to your local checkout, for example:

```md
[$codaph-observability](/absolute/path/to/codaph/skills/codaph-observability/SKILL.md)
```

Then tell the agent what you want, for example:

```text
[$codaph-observability](/absolute/path/to/codaph/skills/codaph-observability/SKILL.md)

Use Codaph to pull the latest repo memory, load context for the current auth work, and create a checkpoint before edits.
```

If you copied the skill into a personal skills directory such as `~/.codex/skills`, use that absolute path instead.

## What The Skill Does

The included `codaph-observability` skill standardizes this workflow:

1. Run `codaph status --cwd <repo> --json`.
2. Run `codaph push --cwd <repo>` if local work may be ahead.
3. Run `codaph pull --cwd <repo>` or `codaph pull --full --cwd <repo>` when remote replay is needed.
4. Use `codaph mubit context` before starting or resuming an agent.
5. Use `codaph mubit snapshot` when you need assembled run state, and `codaph mubit activity` when you need chronological evidence.
6. Use `codaph checkpoint` before risky edits.
7. Use `codaph doctor mubit` and `codaph mubit diagnose` when an agent is stuck.
8. Use `codaph handoff send` when another agent should continue.
9. Use `codaph mubit reflect` and `codaph mubit strategies` after meaningful work.

## Recommended Usage By Tool

### Claude Code

Use the skill alongside Codaph MCP.

- The skill helps Claude remember the workflow.
- MCP lets Claude inspect Codaph status, sessions, timelines, context, diagnostics, strategies, and handoffs without leaving the session.

See [MCP Setup (Claude Code)](./mcp-setup.md).

### Codex

Use the skill to keep Codaph commands in the normal terminal workflow.

- Codex can run `codaph ...` commands in the same terminal session.
- Codaph hooks and import paths can still capture or sync Codex work separately.

### Gemini CLI

Use the same skill workflow as Codex.

- Gemini can run the Codaph commands directly.
- Codaph remains a separate CLI and TUI, but the skill keeps the workflow consistent.

## When Not To Use A Skill

Do not add the skill just for ceremony.

Skip it when:

- the repo is not using Codaph
- the task is too small to justify memory, checkpoints, or handoffs
- you only need one direct command and no repeated workflow guidance

## Related Docs

- [Quickstart](./quickstart.md)
- [CLI Reference](./cli-reference.md)
- [MCP Setup (Claude Code)](./mcp-setup.md)
- [Mubit Collaboration](./collaboration-mubit.md)
