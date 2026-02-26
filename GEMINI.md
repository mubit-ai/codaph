# GEMINI.md

This project, **Codaph**, is a terminal-first CLI and TUI for inspecting coding-agent activity, utilizing **gemini**, Claude, and Codex history synchronized via **Mubit** shared memory.

## Project Overview
Codaph acts as a bridge for agentic coding story-telling, providing a version control-like experience for agent prompts, thoughts, and diffs. It helps teams avoid "coldstart" problems when onboarding new engineers or agents by maintaining a semantic layer of the codebase's history.

- **Main Technologies**: TypeScript, Bun, Node.js.
- **Key Integrations**: Mubit SDK, OpenAI Codex SDK, Anthropic (Claude Code), and Google (Gemini CLI).
- **Architecture**: Dual-store system using a local append-only JSONL mirror (`.codaph/`) and Mubit cloud memory.

## Building and Running
The project uses **Bun** as the primary runtime and package manager.

- **Install Dependencies**: `bun install`
- **Build Project**: `bun run build` (Outputs to `dist/index.js`)
- **Run Tests**: `bun test` or `bun test <path>`
- **Type Checking**: `bun run typecheck`
- **Run CLI from Source**: `bun run cli <command>` (e.g., `bun run cli sync`)
- **Open TUI**: `bun run tui`

## Development Conventions
- **Language**: TypeScript (ESM).
- **Testing**: Vitest-compatible tests located in `test/`, mirroring the `src/` directory structure.
- **Workflow**: 
    - Changes should be verified with `bun run typecheck` and `bun test`.
    - Local agent events are redacted for security before being stored or synced.
    - Identity is resolved via Git, GitHub API, or environment variables.

## Key Files
- `src/index.ts`: CLI entry point and command routing.
- `src/lib/ingest-pipeline.ts`: Core event processing, redaction, and storage logic.
- `src/lib/mirror-jsonl.ts`: Local event store management.
- `src/lib/memory-mubit.ts`: Mubit cloud memory integration.
- `src/mcp-server.ts`: Local Model Context Protocol (MCP) server implementation.
- `src/gemini-history-sync.ts`: Logic for importing **gemini** CLI history.
- `AGENT.md`: Append-only status log of repository changes (maintained by agents).
- `CLAUDE.md`: Guidance specific to Claude Code interactions.

## Deployment
The project is published to NPM as `@codaph/codaph`. Ensure `prepublishOnly` (typecheck, test, build) passes before publishing.
