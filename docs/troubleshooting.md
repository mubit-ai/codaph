---
layout: docs
---

# Troubleshooting

This page covers common Codaph issues and the fastest recovery path.

## Start Here (Quick Diagnostics)

Run these first:

```bash
codaph status
codaph doctor --mubit
```

`codaph status` explains repo automation and recent sync state.
`codaph doctor` explains resolved runtime configuration.

## `codaph import` Looks Stuck or Runs for a Long Time

Symptoms:

- spinner keeps moving, but progress feels slow
- `Mubit write timed out` messages appear
- import takes much longer than expected

What is usually happening:

- `codaph import` is scanning local Codex history and writing to Mubit
- Mubit writes are slow or timing out
- some events may still succeed, so the run is partial rather than fully broken

What to do:

1. Retry with a longer timeout:

```bash
codaph import --mubit-write-timeout-ms 30000
```

2. If you only need the local mirror first, run local-only and retry cloud later:

```bash
codaph import --local-only
codaph sync
```

3. Check cloud results after import:

```bash
codaph status
```

Notes:

- Codaph batches Mubit ingest during `import`, but cloud latency can still dominate runtime.
- Repeated timeout messages do not always mean zero progress. Some writes may already have succeeded.

## Teammate Sees Fewer Prompts Than You Do

Symptoms:

- same repo, same Mubit key, same project id
- teammate sees some of your prompts, but not all

What this usually means:

- sharing works
- cloud pull is partial (snapshot-limited)
- your local machine also has extra history from `codaph import`

What to check:

```bash
codaph status
cat .codaph/project.json
```

Compare on both machines:

- `mubitProjectId`
- `mubitRunScope`
- snapshot fingerprint (`fp=...`)
- `received`, `imported`, `dedup`

If both users have the same snapshot fingerprint, they are pulling the same cloud snapshot.

What to do:

- run `codaph sync` again on the teammate machine
- run `codaph import` on the originating machine to backfill history into Mubit
- use a smaller/fresher session for demos when snapshot limits matter

Read [Mubit Collaboration](./collaboration-mubit.md) for the full explanation.

## `codaph sync` Does Not Show Historical Codex Sessions

Symptoms:

- `codaph sync` runs quickly but old Codex sessions do not appear

This is expected.

`codaph sync` is the fast daily sync path. Historical Codex replay moved to:

```bash
codaph import
```

Use `codaph import` once (or occasionally) when you need backfill from `~/.codex/sessions`.

## Mubit Shows Disabled (`Mubit:off`)

Symptoms:

- TUI header shows `Mubit:off`
- cloud pull fails
- Mubit query commands show disabled state

Checks:

```bash
codaph doctor --mubit
```

Fixes:

- set `MUBIT_API_KEY`
- run `codaph init` again if you skipped Mubit during setup
- verify your shell environment is available in the terminal where you run Codaph
- confirm you did not force `--no-mubit`

## Auto-Sync Is Off

Symptoms:

- `codaph status` shows `Automation: disabled`
- commits do not trigger Codaph sync behavior

Fix:

```bash
codaph sync setup --yes
```

If agent-complete hook setup is partial, Codaph prints a manual command to attach:

```bash
codaph hooks run agent-complete --quiet
```

Git post-commit hook can still be enabled even when agent-complete auto-detection is unavailable.

## Another Sync Is Already Running

Symptoms:

- `Another Codaph sync is already running for this repo`

Cause:

- another sync process is active
- or a previous run exited unexpectedly and left a stale lock

What to do:

- wait a few seconds and retry
- rerun `codaph sync` (Codaph now attempts to reclaim stale locks automatically)

## No Codex History for This Repo

Symptoms:

- push/import output says `No Codex history for this repo`

What it means:

- Codaph scanned `~/.codex/sessions`
- no session files matched the current repository path

What to do:

- confirm you are in the correct repo root
- confirm the Codex sessions you expect were created in this repo path
- run `codaph import --cwd /absolute/path/to/repo` if you are invoking from another directory

## Mubit Query Returns Weak Results

Symptoms:

- answer is empty or generic
- evidence list is small

What to do:

- ask a narrower question
- point to a specific file, prompt, or session
- increase `--limit`
- use `--raw` or `--no-agent` to debug the underlying Mubit response

Example:

```bash
codaph mubit query "what changed in auth.ts during the last session?" --session <session-id> --limit 12
```

## TUI Layout Looks Broken

Symptoms:

- borders wrap or clip
- panes overlap

Fixes:

- use a wider terminal window
- reduce terminal zoom
- use a monospaced font
- restart the terminal after upgrading Codaph

## Reset Local Codaph State (Safe)

Use this when local mirror files are inconsistent and you want to rebuild from scratch.

```bash
rm -rf .codaph
codaph import
codaph sync
```

This resets local state only. It does not delete Mubit cloud data.
