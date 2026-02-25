---
layout: docs
---

# Codaph Documentation

Codaph helps you inspect coding-agent activity with a local terminal UI and shared Mubit-backed memory.

Use these docs in this order:

1. [Quickstart](./quickstart.md) for first-time setup.
2. [One-Page CLI/TUI Guide](./one-page-cli-tui.md) for a publishable overview.
3. [TUI Guide](./tui-guide.md) for the day-to-day workflow.
4. [Troubleshooting](./troubleshooting.md) when sync or Mubit behavior looks wrong.

## Start Here

### New user (recommended)

Use [Quickstart](./quickstart.md) first for Mubit API key setup, optional OpenAI-assisted query/chat setup, and the recommended first-run flow.

1. Open the target repository.
2. Run `codaph init`.
3. Run `codaph sync`.
4. Open `codaph tui`.
5. Run `codaph import` once if you want historical Codex sessions in Mubit.

### Team setup (shared Mubit memory)

1. Everyone uses the same Mubit backend key and project id.
2. Everyone runs `codaph init` inside the same repo.
3. One person runs `codaph import` to backfill local Codex history (optional but useful).
4. Everyone runs `codaph sync` and then `codaph tui`.

Read [Mubit Collaboration](./collaboration-mubit.md) for the shared-memory model and limits.

## Product Mental Model

Codaph has two sync paths on purpose:

- `codaph sync` is the fast daily path.
  It focuses on Mubit-first synchronization and repo-local state.
- `codaph import` is the historical backfill path.
  It scans `~/.codex/sessions` and imports matching sessions for the current repo.

This split keeps daily sync fast and makes history replay explicit.

## Documentation Map

### User docs

- [Quickstart](./quickstart.md)
  First-time setup, keys, and first run.
- [One-Page CLI/TUI Guide](./one-page-cli-tui.md)
  Publish-ready overview page.
- [CLI Reference](./cli-reference.md)
  User-facing commands with minimal flags first.
- [TUI Guide](./tui-guide.md)
  Views, keys, and recommended workflow.
- [Mubit Collaboration](./collaboration-mubit.md)
  Team setup, project scope, and cloud sync behavior.
- [Troubleshooting](./troubleshooting.md)
  Common errors and recovery steps.

### Technical docs

- [Architecture](./architecture.md)
- [Data Model](./data-model.md)
- [Roadmap](./roadmap.md)

## Current Product Status

Codaph is production-usable for CLI/TUI workflows and Mubit-backed collaboration.

- `codaph init` provides a repo setup flow and Mubit onboarding.
- `codaph sync` is a fast, Mubit-first daily sync path.
- `codaph import` backfills local Codex history on demand.
- TUI supports prompt/thought/diff inspection with contributor filters.
- Cloud pull includes a prompt-focused stream to improve collaborator prompt parity.

## Conventions Used in This Docs Set

- `codaph ...` examples assume a published install (`npm`, `brew`, or local bin on `PATH`).
- If you are developing from source, replace `codaph` with `bun run cli`.
- Commands assume you run them from the project root unless `--cwd` is shown.
