# Mubit Collaboration

This guide explains how Codaph shares activity through Mubit across contributors working in the same repository.

## The Model (What Is Shared vs Local)

Codaph uses two storage layers:

- Mubit stores shared cloud memory for the repo.
- `.codaph/` stores the local read model (sessions, prompts, diffs, indexes).

Each contributor can see shared cloud activity after running `codaph sync`, but local-only history from `~/.codex/sessions` appears only after that user runs `codaph import` on their own machine.

This is the most important distinction to understand.

## Team Setup Checklist

For a team to see each other in Codaph:

1. Everyone uses the same repository.
2. Everyone uses the same Mubit backend key.
3. Everyone resolves to the same project id (`owner/repo` recommended).
4. Everyone uses `project` run scope (recommended).
5. Everyone has a unique actor id.
6. Everyone runs `codaph init` and `codaph sync`.

## Recommended Team Workflow

### Once per contributor

```bash
cd /path/to/repo
codaph init
```

### Daily workflow

```bash
codaph sync
codaph tui
```

### Optional historical backfill (per machine)

```bash
codaph import
```

Run `codaph import` when you want old local Codex sessions from that machine to be added to Codaph and Mubit.

## Identity Resolution

Codaph tries to auto-detect the project id and actor id. You can still override both.

### Project id resolution (highest priority first)

1. `--mubit-project-id`
2. `CODAPH_PROJECT_ID`
3. `MUBIT_PROJECT_ID`
4. saved project settings
5. git `origin` (`owner/repo`)
6. local path hash fallback

### Actor id resolution (highest priority first)

1. `--mubit-actor-id`
2. `CODAPH_ACTOR_ID`
3. saved global settings
4. GitHub CLI (`gh api user`)
5. git config
6. shell user

## Run Scope (Use `project` for Collaboration)

### Project scope (recommended)

Run id format:

```text
codaph:<projectId>
```

Use this mode to aggregate contributor activity in one shared memory space.

### Session scope (advanced)

Run id format:

```text
codaph:<projectId>:<sessionId>
```

Use this when you need strict isolation per session.

## Why Two People Can See Different Prompt Counts

This usually happens even when both contributors use the same Mubit key and project id.

Common reasons:

- one person ran `codaph import` and the other did not
- cloud pull is based on a snapshot and may return a partial event slice
- event-level snapshots can be dominated by thoughts/tool events instead of prompts

Codaph now writes a prompt-focused cloud stream to improve prompt parity, but local backfill can still show more complete history on the originating machine.

## Verify Team Configuration

Run this on both machines:

```bash
codaph status
cat .codaph/project.json
```

Compare:

- `repoId`
- `mubitProjectId`
- `mubitRunScope`
- remote pull counters and snapshot fingerprint

If the snapshot fingerprint matches, both users are pulling the same cloud snapshot.

## Commands You Will Actually Use

```bash
# normal daily sync
codaph sync

# optional history backfill for this machine
codaph import

# inspect sync + cloud state
codaph status

# view prompts/thoughts/diffs
codaph tui
```

## Current Limits (Important)

- Cloud pull uses a Mubit snapshot timeline and may be bounded.
- Prompt parity is better than full thought/diff parity when the cloud snapshot is capped.
- `codaph import` is machine-local because it reads that machine's `~/.codex/sessions`.

These are product limits, not usually user mistakes.
