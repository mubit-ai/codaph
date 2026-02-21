# Architecture

Phase 1A is Codex-first:

- Capture through Codex SDK and `codex exec --json`
- Normalize to canonical events
- Redact sensitive content
- Persist local JSONL mirror
- Query sessions/timeline/diff from local index
- MuBit integration deferred
