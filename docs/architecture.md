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

### Adapters

- `@codaph/adapter-codex-sdk`
  Captures events from Codex SDK streamed runs.
- `@codaph/adapter-codex-exec`
  Captures JSON output from `codex exec --json`.
- `codex-history-sync` (`tools/codaph-cli`)
  Imports historical sessions from `~/.codex/sessions`.

### Ingestion

- `@codaph/ingest-pipeline`
  Normalizes and redacts payloads, appends mirror, and writes MuBit.
  The pipeline deduplicates before remote write and opens a fail-open circuit after repeated MuBit write failures.

### Storage

- `@codaph/mirror-jsonl`
  Append-only event store under `.codaph/`.
  Maintains manifest, sparse indexes, and `eventId` index.
- `@codaph/memory-mubit`
  Writes canonical events to MuBit control APIs.
  Supports project-scoped and session-scoped run ids.
  Appends `codaph_event` activity for remote replay.

### Query and Visualization

- `@codaph/query-service`
  Reads local mirror and returns sessions, timelines, diffs, and contributors.
- `tools/codaph-cli`
  Exposes CLI commands and interactive TUI.
  Includes local sync and remote MuBit sync.
- `apps/desktop`
  Secondary Electron + Vue UI surface over the same mirror.

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
