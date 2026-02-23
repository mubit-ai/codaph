# MuBit Collaboration

This document explains how Codaph uses MuBit as a shared memory backend across contributors on the same project.

## Collaboration Model

Codaph combines two stores:

- MuBit stores shared cross-contributor memory.
- Local `.codaph` mirror stores deterministic timeline and diff read models.

Each contributor writes events with actor metadata to the same MuBit project scope.
Each contributor then syncs remote activity into their local mirror to inspect shared history.

## Identity Resolution

Codaph resolves project and actor automatically, but allows explicit override.

Project id resolution order:

1. `--mubit-project-id`
2. `CODAPH_PROJECT_ID`
3. `MUBIT_PROJECT_ID`
4. saved project setting
5. auto-detect `owner/repo` from `git remote origin`
6. fallback local path hash

Actor id resolution order:

1. `--mubit-actor-id`
2. `CODAPH_ACTOR_ID`
3. saved global setting
4. `gh api user` login
5. `git config github.user`
6. `git config user.name`
7. shell user

## Run Scope

### Project Scope (Collaborative Default)

Run id:

```text
codaph:<projectId>
```

Use this mode to aggregate all contributor activity into one shared memory timeline.

### Session Scope

Run id:

```text
codaph:<projectId>:<sessionId>
```

Use this mode when you want strict per-session isolation.

## Team Setup Checklist

Every contributor should:

1. Use the same `MUBIT_API_KEY`.
2. Use the same `projectId` (`owner/repo` recommended).
3. Use unique actor id.
4. Use `project` run scope for collaboration.
5. Run both local and remote sync regularly.

Recommended shell setup:

```bash
export MUBIT_API_KEY=...
export CODAPH_PROJECT_ID=owner/repo
export CODAPH_ACTOR_ID=<your-login>
export CODAPH_MUBIT_RUN_SCOPE=project
```

## Operational Flow

1. Contributor uses Codex normally.
2. Codaph `sync` imports local sessions and writes canonical events to MuBit.
3. Codaph writes `codaph_event` activity entries for remote replay.
4. Other contributors run `sync remote` to import remote MuBit activity into local mirror.
5. TUI shows contributor-attributed prompts, thoughts, and file changes.

## Commands

Local ingest + MuBit write:

```bash
bun run cli sync --cwd /absolute/project/path --mubit
```

Remote replay into mirror:

```bash
bun run cli sync remote --cwd /absolute/project/path --mubit --limit 1200
```

Contributor-level inspection:

```bash
bun run tui --cwd /absolute/project/path --mubit
```

Then in inspect view:

- press `c` for contributors overlay
- press `enter` on contributor to filter prompts

## What Gets Attributed

For each event, Codaph stores:

- `actorId`
- `project_id` / `repo_id`
- `session_id`
- `thread_id`
- event timestamp
- normalized event payload

This metadata powers per-contributor views and actor filters.

## Current Limits

- Remote replay currently imports events from MuBit activity entries with type `codaph_event`.
- Query service does not yet merge semantic MuBit context directly into timeline rows.
- Local mirror encryption-at-rest is not yet implemented.
