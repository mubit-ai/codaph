# Codaph: Mubit-Powered Memory for Codex Workflows

Codaph helps you inspect coding-agent activity in a terminal UI and share project memory through Mubit.

Use it to answer:

- what prompt caused this diff?
- what did the agent think before changing this file?
- what changed across contributors on this repo?

## Why Codaph Feels Different

Codaph is built around a simple split:

- `codaph sync` is fast and Mubit-first for daily use.
- `codaph import` is explicit historical backfill from local Codex history.

This keeps the common path fast while still supporting full history when you want it.

## Install

Choose one path.

### Source (today)

```bash
git clone <your-repo-url>
cd codaph
bun install
bun run build
```

Run from source with:

```bash
bun run cli <command>
```

### npm / npx (publish path)

```bash
npx @codaph/codaph --help
```

Fallback when your environment does not resolve the scoped bin automatically:

```bash
npx --yes --package @codaph/codaph codaph --help
```

### Homebrew (publish path)

```bash
brew install codaph
codaph --help
```

## Quickstart (Recommended)

From your project root:

```bash
codaph init
codaph sync
codaph tui
```

What happens:

- `init` sets up `.codaph/`, prompts for a Mubit key if needed, and enables auto-sync hooks
- `sync` performs the fast daily sync path
- `tui` opens the viewer for prompts, thoughts, and diffs

### Optional history backfill

```bash
codaph import
```

Use `import` when you want old local Codex sessions from `~/.codex/sessions` to be added to Codaph and Mubit.

## Daily Workflow

```bash
codaph sync
codaph status
codaph tui
```

Inside the TUI:

- `s` sync now (push + pull)
- `r` pull cloud now (manual fallback)
- `c` contributors overlay
- `f` actor filter
- `m` ask Mubit in context

## Team / Collaboration Setup

To share memory across contributors:

- use the same Mubit backend key
- use the same project id (`owner/repo` recommended)
- use `project` run scope (default in shared setups)
- give each contributor a unique actor id

Then each contributor runs:

```bash
codaph init
codaph sync
codaph tui
```

## Core Commands (User-Facing)

```bash
# one-time global setup (optional if init wizard handles it)
codaph setup --mubit-api-key <key>

# one-time repo setup
codaph init

# fast daily sync (Mubit-first)
codaph sync

# status + diagnostics summary
codaph status

# optional historical Codex backfill
codaph import

# terminal UI
codaph tui
```

## Troubleshooting in 30 Seconds

Run these first:

```bash
codaph status
codaph doctor --mubit
```

Common cases:

- `Mubit:off`: missing API key or Mubit disabled
- teammate sees fewer prompts: cloud snapshot is partial, local import differs
- `import` is slow: Mubit writes are timing out; retry with higher timeout

## Publish-Ready Notes

This page is written for user-facing docs. For technical internals, link to:

- `docs/architecture.md`
- `docs/data-model.md`
- `docs/troubleshooting.md`

For release docs, prefer showing `codaph ...` commands instead of `bun run cli ...`.
