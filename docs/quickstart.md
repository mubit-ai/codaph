---
layout: docs
---

# Quickstart

This guide gets Codaph running with shared Mubit memory in a few minutes.

## What You Need

- A repository you want to inspect
- Bun `1.3.9+`
- Codex CLI installed and authenticated
- A Mubit API key from [console.mubit.ai](https://console.mubit.ai)

Optional:

- `OPENAI_API_KEY` for Mubit query answer synthesis

## Install Codaph

Choose one path.

### Option A: Run from source (current repo)

```bash
cd /Users/anilp/Code/codaph
bun install
bun run typecheck
bun run build
```

Run commands with `bun run cli ...` while developing from source.

### Option B: Published binary (recommended for docs/site users)

```bash
codaph --help
```

If you install through `npx`, use the fallback form when your shell does not resolve the scoped bin automatically:

```bash
npx --yes --package @codaph/codaph codaph --help
```

## 1. Initialize Codaph in a Project

Open the target project and run:

```bash
cd /absolute/path/to/your/project
codaph init
```

What `codaph init` does:

- creates repo-local `.codaph/project.json`
- prompts for a Mubit API key if one is not configured yet
- enables repo-scoped auto-sync hooks (post-commit, and agent-complete when detectable)
- stores repo sync settings

If you do not have a Mubit key yet, the wizard points you to [console.mubit.ai](https://console.mubit.ai).

## 2. Run Fast Sync (Daily Sync Path)

```bash
codaph sync
```

What `codaph sync` does:

- runs the fast Mubit-first sync path
- pulls cloud activity into your local `.codaph` mirror
- uses repo-local sync state and automation settings
- does not replay global Codex history by default

Use this command for normal day-to-day usage.

## 3. Open the TUI

```bash
codaph tui
```

Inside the TUI:

- press `s` to run sync now (push + pull)
- press `r` to pull cloud activity now (manual fallback)
- press `enter` on a session to inspect prompts, thoughts, and diffs
- press `c` to filter by contributor

## 4. Backfill Historical Codex Sessions (Optional)

If you want older Codex sessions from `~/.codex/sessions` to appear in Codaph and Mubit, run:

```bash
codaph import
```

Use `codaph import` once (or occasionally). It is not part of the default daily `sync` path.

## 5. Check Status

```bash
codaph status
```

`codaph status` shows:

- auto-sync state
- last local push timestamp
- last remote pull timestamp
- Mubit snapshot diagnostics (including snapshot cap hints)

## Team Quickstart (Shared Mubit Memory)

For a team using the same repo:

1. Everyone runs `codaph init` in the repo.
2. Everyone uses the same Mubit backend key and project id.
3. Each person has a unique actor id (auto-detected in most cases).
4. One or more contributors run `codaph import` to backfill local Codex history.
5. Everyone runs `codaph sync` and opens `codaph tui`.

Read [Mubit Collaboration](./collaboration-mubit.md) for details and current limits.

## Non-Interactive Setup (CI / demos / scripted envs)

```bash
codaph setup --mubit-api-key <your-key>
cd /absolute/path/to/your/project
codaph init --yes
codaph sync
```

## If Something Looks Wrong

Start with:

```bash
codaph status
codaph doctor --mubit
```

Then check [Troubleshooting](./troubleshooting.md).
