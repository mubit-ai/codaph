# CLI Reference

Codaph is Mubit-first by default. The primary CLI path is:

1. `codaph init`
2. `codaph sync`
3. `codaph status`
4. `codaph tui`
5. `codaph import` (optional backfill)

This page documents the user-facing commands first and keeps advanced commands at the end.

## Command Overview

```bash
codaph --help
```

Primary commands:

- `setup` (global config)
- `init` (repo setup + onboarding)
- `sync` (fast daily sync)
- `status` (repo sync + automation status)
- `import` (historical Codex backfill)
- `tui` (terminal UI)

Advanced commands are available but not required for normal usage.

## `codaph setup`

Use this command to set global secrets and defaults.

```bash
codaph setup --mubit-api-key <key>
```

Common uses:

- set Mubit API key globally
- set OpenAI API key for query synthesis
- set global actor id

Examples:

```bash
codaph setup --mubit-api-key <key>
codaph setup --openai-api-key <key>
codaph setup --mubit-actor-id <your-login>
```

## `codaph init`

Use this command once per repository.

```bash
cd /absolute/path/to/project
codaph init
```

What it does:

- detects or stores repo identity (`owner/repo` when available)
- creates `.codaph/project.json`
- prompts for Mubit API key if missing
- installs repo-scoped auto-sync hooks (best effort)

Useful flags:

- `--yes` non-interactive mode
- `--force` reinstall/reapply setup behavior
- `--no-auto-sync` skip hook install
- `--cwd <path>` run init for another repo

## `codaph sync`

Use this command for day-to-day syncing.

```bash
codaph sync
```

Behavior:

- fast Mubit-first sync path
- cloud pull into local mirror
- repo-local automation/status integration
- no global Codex history replay by default

Useful flags (most users do not need these):

- `--cwd <path>` run from another directory
- `--json` machine-readable output
- `--no-auto-enable` skip first-run automation prompt during sync
- `--mubit-write-timeout-ms <ms>` tune write timeout for slow networks

### `codaph sync` subcommands (advanced / compatibility)

These are available when you need manual control.

```bash
codaph sync all
codaph sync pull
codaph sync status
codaph sync setup
```

Compatibility aliases are still supported:

- `codaph sync remote` (alias for `codaph sync pull`)
- `codaph sync push` (compat alias for `codaph import`)

## `codaph import`

Use this command for historical backfill from local Codex session files.

```bash
codaph import
```

Behavior:

- scans `~/.codex/sessions`
- imports only sessions that match the current repo path
- writes to local `.codaph` mirror
- writes to Mubit when enabled

Use this command:

- once after onboarding
- after long periods of running Codex outside Codaph hooks
- when rebuilding a local mirror from your machine's Codex history

Useful flags:

- `--cwd <path>`
- `--json`
- `--local-only` (compat alias to disable Mubit writes)
- `--mubit-write-timeout-ms <ms>`

## `codaph status`

Use this command to understand sync and automation state.

```bash
codaph status
```

It shows:

- repo id
- auto-sync settings
- local push timestamps/counters
- remote pull timestamps/counters
- snapshot fingerprint and cap diagnostics

Useful flags:

- `--cwd <path>`
- `--json`

## `codaph tui`

Launch the terminal UI.

```bash
codaph tui
```

Useful flags:

- `--cwd <path>`
- `--mubit` / `--no-mubit`

The TUI is primarily a viewer. Use `codaph sync` or `s`/`r` in the TUI to refresh data.

## Common Environment Variables

Most users only need:

- `MUBIT_API_KEY`
- `OPENAI_API_KEY` (optional)

Codaph can also use:

- `CODAPH_PROJECT_ID`
- `CODAPH_ACTOR_ID`
- `CODAPH_MUBIT_RUN_SCOPE`
- `MUBIT_APIKEY` (fallback)
- `OPENAI_APIKEY` (fallback)

## Advanced Commands

These commands are useful for debugging, inspection, and power users.

### Diagnostics

```bash
codaph doctor --mubit
```

### Session inspection

```bash
codaph sessions list
codaph inspect --session <session-id>
codaph timeline --session <session-id>
codaph diff --session <session-id>
```

### Mubit queries

```bash
codaph mubit query "what changed in auth?" --session <session-id>
```

Useful query flags:

- `--limit <n>`
- `--raw`
- `--agent` / `--no-agent`

### Direct capture (advanced)

```bash
codaph run "Summarize this repo"
codaph exec "Refactor auth flow"
```

## Exit Codes

- `0` on success
- non-zero on command or runtime error
