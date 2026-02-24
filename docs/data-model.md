# Data Model

Codaph stores canonical events in both Mubit and local JSONL mirror.

## Canonical Event Envelope

`CapturedEventEnvelope` is the core unit across adapters, ingestion, storage, and query.

```ts
interface CapturedEventEnvelope {
  eventId: string;
  source: "codex_sdk" | "codex_exec";
  repoId: string;
  actorId: string | null;
  sessionId: string;
  threadId: string | null;
  ts: string; // ISO-8601
  eventType: string;
  payload: Record<string, unknown>;
  reasoningAvailability: "full" | "partial" | "unavailable";
}
```

## Identity Fields

- `repoId`
  Shared project id when configured (`owner/repo`), otherwise path-derived hash.
- `actorId`
  Contributor identity used for team attribution and filtering.
- `sessionId`
  Group of events from one Codex interaction session.
- `threadId`
  Thread-level grouping when available.

## Idempotency

- `eventId` is the dedupe key.
- Ingestion can pass explicit `eventId` from remote replay paths.
- Mirror maintains `.codaph/index/<repoId>/event-ids.json` to avoid duplicate writes.

## Local Mirror Layout

```text
.codaph/
  events/<repoId>/YYYY/MM/DD/segment-YYYYMMDD.jsonl
  runs/<sessionId>/raw-codex.ndjson
  index/<repoId>/manifest.json
  index/<repoId>/sparse-index.json
  index/<repoId>/event-ids.json
```

## Local Indexes

`manifest.json`

- Segment metadata with event counts and time boundaries.

`sparse-index.json`

- `sessions`: from/to, event count, thread ids, actor ids, and segment refs.
- `threads`: thread-level summary and segment refs.
- `actors`: contributor-level summary with session and segment refs.

`event-ids.json`

- Exact mapping from `eventId` to segment/time/session/actor.

## Mubit Mapping

Each event is written to Mubit with:

- `run_id` based on configured run scope
- `idempotency_key = eventId`
- metadata including:
  - `project_id`
  - `repo_id`
  - `actor_id`
  - `session_id`
  - `thread_id`
  - `ts`

Codaph also appends activity entries of type `codaph_event` for remote timeline replay.

## Query Filters

Timeline queries support:

- `repoId`
- optional `sessionId`
- optional `threadId`
- optional `actorId`
- optional time window (`from`, `to`)
- optional `itemType`
