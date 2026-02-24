# CLI Reference

Codaph CLI is the primary non-UI interface for capture, sync, query, and automation workflows.

## Command Overview

```bash
bun run cli --help
```

Core command groups:

- Capture: `run`, `exec`
- Sync: `sync`, `sync remote`
- Read: `sessions list`, `timeline`, `diff`, `inspect`
- Mubit: `mubit query`, `mubit backfill`
- Project registry: `projects list|add|remove`
- Diagnostics: `doctor`
- TUI launcher: `tui`

## Capture Commands

`run`

```bash
bun run cli run "Summarize this repo" --cwd /absolute/project/path
```

Uses Codex SDK adapter and stores normalized events.

`exec`

```bash
bun run cli exec "Refactor auth flow" --cwd /absolute/project/path
```

Uses `codex exec --json` adapter and stores normalized events.

## Sync Commands

`sync`

```bash
bun run cli sync --cwd /absolute/project/path --mubit
```

Imports local Codex history from `~/.codex/sessions`.
Writes to local mirror and Mubit when enabled.

`sync remote`

```bash
bun run cli sync remote --cwd /absolute/project/path --mubit --limit 1200
```

Imports remote Mubit timeline activity into local mirror for collaborator visibility.

## Read Commands

`sessions list`

```bash
bun run cli sessions list --cwd /absolute/project/path
```

`timeline`

```bash
bun run cli timeline --session <session-id> --cwd /absolute/project/path --json
```

`diff`

```bash
bun run cli diff --session <session-id> --cwd /absolute/project/path
```

`inspect`

```bash
bun run cli inspect --session <session-id> --cwd /absolute/project/path
```

## Mubit Query Command

```bash
bun run cli mubit query "why did this file change?" --session <session-id> --cwd /absolute/project/path --mubit
```

Options:

- `--limit <n>` controls Mubit evidence size.
- `--raw` prints raw Mubit response JSON.
- `--no-agent` disables OpenAI synthesis and prints Mubit-native output.

## Diagnostic Command

```bash
bun run cli doctor --cwd /absolute/project/path --mubit
```

Use this first when runtime behavior is unclear.
It prints resolved project id, actor id, run scope, key detection, and enable state.

## Mubit Flags

- `--mubit` / `--no-mubit`
- `--mubit-api-key <key>`
- `--mubit-project-id <owner/repo>`
- `--mubit-run-scope <project|session>`
- `--mubit-actor-id <actor>`
- `--mubit-write-timeout-ms <ms>`
- `--mubit-transport <auto|http|grpc>`
- `--mubit-endpoint <url>`
- `--mubit-http-endpoint <url>`
- `--mubit-grpc-endpoint <host:port>`
- `--mubit-agent-id <id>`

## OpenAI Agent Flags

- `--agent` / `--no-agent`
- `--openai-api-key <key>`
- `--openai-model <model>`

## Environment Variables

- `MUBIT_API_KEY`
- `MUBIT_APIKEY` (fallback)
- `OPENAI_API_KEY`
- `OPENAI_APIKEY` (fallback)
- `CODAPH_PROJECT_ID`
- `CODAPH_ACTOR_ID`
- `CODAPH_MUBIT_RUN_SCOPE`
- `MUBIT_PROJECT_ID`

## Exit Behavior

- `0` on successful command completion.
- Non-zero on failures such as missing required flags, missing Mubit auth, or query/sync runtime errors.
