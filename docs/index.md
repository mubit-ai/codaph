---
layout: docs
---

# Codaph Docs

Codaph is a terminal-first viewer for coding-agent activity with shared Mubit memory.

Start here if you are new:

1. [Quickstart](./quickstart.md)
2. [One-Page CLI/TUI Guide](./one-page-cli-tui.md)
3. [TUI Guide](./tui-guide.md)
4. [MCP Setup (Claude Code)](./mcp-setup.md)
5. [Troubleshooting](./troubleshooting.md)

## 60-Second Start

From your project root:

```bash
codaph init
codaph sync
codaph tui
```

Use [Quickstart](./quickstart.md) for first-time setup details, including Mubit API key setup and optional OpenAI-assisted query/chat configuration.

If you want Claude Code to inspect Codaph data directly, use [MCP Setup (Claude Code)](./mcp-setup.md).

Optional historical backfill from local agent history:

```bash
codaph import
```

## What To Read Next

### User guides

- [Quickstart](./quickstart.md)
- [CLI Reference](./cli-reference.md)
- [MCP Setup (Claude Code)](./mcp-setup.md)
- [TUI Guide](./tui-guide.md)
- [Mubit Collaboration](./collaboration-mubit.md)
- [Troubleshooting](./troubleshooting.md)
- [One-Page CLI/TUI Guide](./one-page-cli-tui.md)

### Technical docs

- [Architecture](./architecture.md)
- [Data Model](./data-model.md)
- [Roadmap](./roadmap.md)

## Key Concept

- `codaph sync` is the fast daily sync path.
- `codaph import` is the optional historical agent backfill path.

This keeps normal usage fast and makes heavy history replay explicit.
