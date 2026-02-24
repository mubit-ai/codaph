# Codaph Documentation

Codaph captures Codex activity, stores structured memory in Mubit, and renders inspectable timelines and diffs in a CLI/TUI-first workflow.

This folder gives you the operational and technical docs to run Codaph in solo and team modes.

## Start Here

1. Read [Quickstart](./quickstart.md).
2. Run `bun run cli doctor`.
3. Start `bun run tui`.
4. Sync local Codex history with `s`, then sync shared Mubit activity with `r`.

## Documentation Map

- [One-Page CLI/TUI Guide](./one-page-cli-tui.md)
  Single publish-facing page for npx/brew users.
- [Quickstart](./quickstart.md)
  End-to-end setup for first run.
- [CLI Reference](./cli-reference.md)
  Commands, flags, and examples.
- [TUI Guide](./tui-guide.md)
  Views, keyboard controls, and workflows.
- [Mubit Collaboration](./collaboration-mubit.md)
  Shared project memory model and contributor attribution.
- [Architecture](./architecture.md)
  Package-level design and data flow.
- [Data Model](./data-model.md)
  Canonical event schema and local index layout.
- [Troubleshooting](./troubleshooting.md)
  Fixes for common runtime and sync problems.
- [Roadmap](./roadmap.md)
  What is done and what remains.

## Current Product Status

Codaph Phase 1A is operational for Codex-first ingestion and collaborative Mubit-backed memory.

- Codex history ingestion is available through local session sync.
- Mubit writes and semantic queries are available.
- Remote Mubit timeline import is available.
- TUI supports actor filtering and contributor overlay.
