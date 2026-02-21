# Codaph

Codaph is a Codex-first local capture layer for coding agent activity.

## Requirements

- Bun `1.3.9+`
- Codex CLI installed (`codex --version`)
- Codex login available (`codex login status`)

## Setup

```bash
bun install
bun run hooks:install
bun run typecheck
bun run build
```

## Run Desktop App (Folder-First UX)

```bash
bun run desktop
```

Desktop flow:
1. Click **Add Folder** and pick a project root.
2. Keep using Codex CLI/Desktop as you normally do.
3. In Codaph click **Sync Now** (or leave **Auto Sync** on).
4. View **Prompts**, **Thoughts**, **Assistant Output**, and **Diff Summary**.
5. Add more folders to switch between projects.

Optional:
- Use direct capture in the expandable panel if you want Codaph to initiate a run itself.

## CLI Commands

```bash
bun run cli --help
bun run cli run "Summarize this repo" --cwd /absolute/project/path
bun run cli exec "Refactor src/config.ts" --cwd /absolute/project/path
bun run cli sessions list --cwd /absolute/project/path
bun run cli timeline --session <session-id> --cwd /absolute/project/path
bun run cli diff --session <session-id> --cwd /absolute/project/path
```

All captured events are written under `<project>/.codaph`.
