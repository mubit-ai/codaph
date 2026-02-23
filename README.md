# Codaph

Codaph is a Codex-first capture layer for coding agent activity, with a CLI/TUI-first workflow and MuBit-backed collaborative memory.

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

## Run TUI (Primary)

```bash
# required for collaborative MuBit writes/queries
export MUBIT_API_KEY=...
export OPENAI_API_KEY=...

bun run tui
bun run cli doctor
```

TUI flow:
1. Add or select a project folder.
2. Sync Codex history from `~/.codex/sessions` into Codaph mirror + MuBit.
3. Inspect prompts, thoughts, assistant output, and file changes by session.
4. Query MuBit semantic memory for the active session.

TUI keyboard map:
- `q`: quit
- `?`: help overlay
- `p`: switch project
- `a`: add/switch project path
- Browse view: `up/down` navigate sessions, `enter` inspect, `s` sync
- Inspect view: `up/down` prompt navigation, `tab` cycle pane focus, `d` full diff overlay, `m` MuBit chat, `left` or `esc` back
- Chat panel: type message, `enter` send, `esc` close chat

## CLI Commands (Primary)

```bash
bun run cli --help
bun run cli doctor

# import normal Codex app/CLI usage into .codaph and MuBit
bun run cli sync --cwd /absolute/project/path
# optional local-only mode (no remote writes)
bun run cli sync --cwd /absolute/project/path --local-only

# direct capture through Codaph
bun run cli run "Summarize this repo" --cwd /absolute/project/path
bun run cli exec "Refactor src/config.ts" --cwd /absolute/project/path

# inspect
bun run cli sessions list --cwd /absolute/project/path
bun run cli inspect --session <session-id> --cwd /absolute/project/path
bun run cli timeline --session <session-id> --cwd /absolute/project/path
bun run cli diff --session <session-id> --cwd /absolute/project/path

# MuBit semantic query
bun run cli mubit query "what changed in auth?" --session <session-id> --cwd /absolute/project/path
bun run cli mubit query "what changed in auth?" --session <session-id> --cwd /absolute/project/path --raw
# disable OpenAI synthesis and show MuBit-only summary
bun run cli mubit query "what changed in auth?" --session <session-id> --cwd /absolute/project/path --no-agent
```

MuBit flags:
- `--mubit` / `--no-mubit`
- `--mubit-api-key <key>` (or `MUBIT_API_KEY`)
- `--raw` (for `mubit query`, print full response JSON)
- `--agent` / `--no-agent` (for `mubit query`, OpenAI synthesis on top of MuBit)
- `--openai-api-key <key>` (or `OPENAI_API_KEY`)
- `--openai-model <model>`
- `--mubit-transport <auto|http|grpc>`
- `--mubit-endpoint`, `--mubit-http-endpoint`, `--mubit-grpc-endpoint`
- `--mubit-write-timeout-ms <ms>` (default `15000`, set `0` to disable timeout)

## Desktop App (Kept, Secondary)

```bash
bun run desktop
```

Desktop flow (unchanged):
1. Click **Add Folder** and pick a project root.
2. Keep using Codex CLI/Desktop as you normally do.
3. In Codaph click **Sync Now** (or leave **Auto Sync** on).
4. View **Prompts**, **Thoughts**, **Assistant Output**, and **Diff Summary**.
5. Add more folders to switch between projects.

Optional:
- Use direct capture in the expandable panel if you want Codaph to initiate a run itself.

All captured events are written under `<project>/.codaph`.
