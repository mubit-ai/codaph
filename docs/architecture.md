# Architecture

Codaph uses a dual-store architecture:

- MuBit is the shared collaborative memory backend.
- Local JSONL mirror is the deterministic read model for timeline and diff rendering.

## Design Goals

- Capture Codex activity without changing normal Codex usage.
- Keep timeline rendering deterministic and fast in local terminals.
- Share cross-contributor memory and context through MuBit.
- Preserve actor attribution from ingestion to query.

## Runtime Components

All runtime code now lives under `src/` for readability.

### Adapters

- `src/lib/adapter-codex-sdk.ts`
  Captures events from Codex SDK streamed runs.
- `src/lib/adapter-codex-exec.ts`
  Captures JSON output from `codex exec --json`.
- `codex-history-sync` (`src/codex-history-sync.ts`)
  Imports historical sessions from `~/.codex/sessions`.

### Ingestion

- `src/lib/ingest-pipeline.ts`
  Normalizes and redacts payloads, appends mirror, and writes MuBit.
  The pipeline deduplicates before remote write and opens a fail-open circuit after repeated MuBit write failures.

### Storage

- `src/lib/mirror-jsonl.ts`
  Append-only event store under `.codaph/`.
  Maintains manifest, sparse indexes, and `eventId` index.
- `src/lib/memory-mubit.ts`
  Writes canonical events to MuBit control APIs.
  Supports project-scoped and session-scoped run ids.
  Appends `codaph_event` activity for remote replay.

### Query and Visualization

- `src/lib/query-service.ts`
  Reads local mirror and returns sessions, timelines, diffs, and contributors.
- `src/index.ts`
  Exposes CLI commands and interactive TUI.
  Includes local sync and remote MuBit sync.

## Data Flow

1. Codaph captures Codex events from live run or session history.
2. Ingest pipeline redacts and canonicalizes event payloads.
3. Event is appended to local mirror with `eventId` idempotency checks.
4. New events are written to MuBit with actor/project metadata.
5. Remote MuBit timeline can be synced back into the mirror.
6. TUI and CLI render timeline/diff from mirror and call MuBit for semantic Q&A.

## Shared Identity Model

Codaph resolves identity in this order:

1. Explicit CLI flag
2. Environment variable
3. Saved Codaph settings
4. Git/GitHub auto-detection fallback

Project identity:

- Uses `owner/repo` from `git remote origin` when available.
- Falls back to local path hash only when project id cannot be resolved.

Actor identity:

- Uses `gh api user` login when available.
- Falls back to git config and then shell user.

## Run Scope Model

Codaph supports two MuBit run scopes:

- `project`
  `codaph:<projectId>`
  One shared run across contributors and sessions.
- `session`
  `codaph:<projectId>:<sessionId>`
  Separate run per captured session.

Project scope is the collaborative default when a project id is available.
