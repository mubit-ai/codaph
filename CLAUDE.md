# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

Build the project:
```bash
bun run build
```

Run tests (all or single file):
```bash
bun test                          # Run all tests
bun test path/to/test.test.ts     # Run specific test file
```

Type checking / linting:
```bash
bun run typecheck                 # TypeScript type check (no emit)
bun run lint                      # Alias for typecheck
```

Run CLI locally from source:
```bash
bun run cli <command>             # e.g., bun run cli init, bun run cli sync
bun run cli <command> --cwd /path/to/project
```

Run TUI locally:
```bash
bun run tui                       # Opens TUI in current directory
```

## Architecture Overview

Codaph uses a **dual-store architecture**:

1. **Local JSONL mirror** (`src/lib/mirror-jsonl.ts`) - Append-only event store under `.codaph/` for deterministic timeline/diff rendering
2. **Mubit cloud memory** (`src/lib/memory-mubit.ts`) - Shared collaborative backend for cross-contributor context and semantic query

### Core Pipeline Flow

```
Agent Events → IngestPipeline → MirrorAppend + MubitMemoryWrite → QueryService/TUI
```

1. **Adapters** capture events from:
   - Codex SDK (`src/lib/adapter-codex-sdk.ts`) - Live streamed runs
   - Codex exec JSON (`src/lib/adapter-codex-exec.ts`) - `codex exec --json` output
   - History importers (`src/codex-history-sync.ts`, `src/claude-history-sync.ts`, `src/gemini-history-sync.ts`)

2. **IngestPipeline** (`src/lib/ingest-pipeline.ts`):
   - Redacts sensitive data via `redactUnknown()` (`src/lib/security.ts`)
   - Canonicalizes events with `createCapturedEvent()` (adds `eventId`, `actorId`, timestamps)
   - Deduplicates based on `eventId` before mirror append
   - Writes to local mirror (always) and Mubit (fail-open circuit after consecutive errors)
   - Supports batching and concurrency for Mubit writes

3. **Storage**:
   - `JsonlMirror` maintains manifest, sparse indexes, and `eventId` index
   - `MubitMemoryEngine` writes canonical events with actor/project metadata

4. **Query/Visualization**:
   - `QueryService` reads local mirror for sessions, timelines, diffs
   - TUI/CLI render from mirror; Mubit used for semantic Q&A only

### Key Types (`src/lib/core-types.ts`)

- `CapturedEventEnvelope` - Canonical event shape with `eventId`, `source`, `repoId`, `actorId`, `sessionId`, `threadId`, `ts`, `eventType`, `payload`, `reasoningAvailability`
- `AgentSource` - Event origin: `codex_sdk`, `codex_exec`, `codex_history`, `claude_code_history`, `gemini_cli_history`
- `IngestContext` - Pipeline context for event normalization

### Identity Resolution

Codaph resolves identity in priority order:
1. Explicit CLI flag
2. Environment variable
3. Saved Codaph settings (`src/settings-store.ts`)
4. Git/GitHub auto-detection fallback

Project identity: Uses `owner/repo` from `git remote origin` when available, otherwise local path hash.
Actor identity: Uses `gh api user` login when available, falls back to git config and shell user.

### Mubit Run Scopes

Two Mubit run scopes supported:
- **Project scope**: `codaph:<projectId>` - One shared run across contributors/sessions (collaborative default)
- **Session scope**: `codaph:<projectId>:<sessionId>` - Separate run per captured session

### Sync Automation (`src/sync-automation.ts`)

Git hooks (`post-commit`, `post-push`) and provider hooks (`agent-complete`) trigger automatic syncs. Sync locking prevents concurrent operations. State tracked in:
- `.codaph/sync-lock.json`
- `.codaph/sync-automation-log.jsonl`
- `.codaph/mubit-remote-sync-state.json`
- `.codaph/local-push-state.json`

## Agent Providers

Supported coding agents (`src/lib/agent-providers.ts`):
- **Codex** (OpenAI) - `codex`
- **Claude Code** (Anthropic) - `claude`
- **Gemini CLI** (Google) - `gemini`

Each provider has:
- A marker directory for detection (e.g., `.codex/`, `.claude/`)
- A history sync implementation for importing past sessions
- Optional provider-specific `agent-complete` hook for auto-sync after agent runs

Provider detection uses marker directories, user config, and provider-specific settings. Multi-select supported during `codaph init`.

## Entry Points

- `src/index.ts` - Main CLI entry point with command routing
- `src/project-registry.ts` - Project registry for tracking multiple codaph projects
- `src/settings-store.ts` - Global and project-scoped settings persistence
- `src/agent-status.ts` - Git status snapshots for agent context

## Testing Strategy

Tests live in `test/` mirroring `src/` structure. Key patterns:
- Unit tests for core types, ingest pipeline, mirror operations
- Integration tests for sync automation and settings management
- Mock implementations for Mubit/external dependencies
