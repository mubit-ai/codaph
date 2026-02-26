---
layout: docs
---

# MCP Setup (Claude Code)

Codaph includes a local MCP server over stdio so Claude Code (and other MCP clients) can inspect Codaph status, sessions, timelines, and diff summaries.

## Recommended Default: User Scope (`~/.claude.json`)

For most users, configure Codaph MCP in Claude Code user scope:

- one setup works across repos
- no repo config file to commit
- Codaph tools can still target specific repos with `cwd` / `project_path`

Use project scope (`.mcp.json`) when you want to share MCP setup with a team.

## `codaph init` Generates a Claude MCP Template

When you run `codaph init`, Codaph writes a reusable template at:

```bash
.codaph/mcp/claude-code.json
```

This file is a safe copy/merge source. Codaph writes it inside `.codaph` so it does not overwrite:

- `~/.claude.json`
- repo `.mcp.json`
- other MCP servers you already configured

Template shape:

```json
{
  "mcpServers": {
    "codaph": {
      "type": "stdio",
      "command": "codaph",
      "args": ["mcp"]
    }
  }
}
```

## Fastest Setup: `codaph mcp setup claude`

Codaph can print (or run) the Claude Code command for you.

Print the recommended command:

```bash
codaph mcp setup claude
```

Run it automatically:

```bash
codaph mcp setup claude --run
```

Useful flags:

- `--scope user|project|local` (default: `user`)
- `--mode codaph|npx` (default: `codaph`)
- `--cwd <path>`
- `--json`

Examples:

```bash
# user-scope (recommended)
codaph mcp setup claude --scope user --run

# project-scope shared config entry
codaph mcp setup claude --scope project --run

# fallback when codaph is not globally installed
codaph mcp setup claude --mode npx
```

## Manual Claude Code Command (`claude mcp add`)

Codaph does not require another package for this. Use the existing `codaph mcp` entrypoint.

Installed binary:

```bash
claude mcp add --scope user codaph -- codaph mcp
```

`npx` fallback (no global install):

```bash
claude mcp add --scope user codaph -- npx --yes --package @codaph/codaph codaph mcp
```

## Manual JSON Config (Project Scope)

If you prefer `.mcp.json`, copy the generated `.codaph/mcp/claude-code.json` template and place it in the repo root as `.mcp.json`.

```json
{
  "mcpServers": {
    "codaph": {
      "type": "stdio",
      "command": "codaph",
      "args": ["mcp"]
    }
  }
}
```

## Verify the Connection

In Claude Code:

- open `/mcp`
- confirm `codaph` shows `connected`

Optional CLI checks:

```bash
claude mcp list
claude mcp get codaph
```

## What Codaph MCP Exposes

Current tools include:

- `codaph_status`
- `codaph_sessions_list`
- `codaph_contributors_list`
- `codaph_timeline_get`
- `codaph_diff_summary`
- `codaph_projects_list`

## If Claude Code Shows `failed`

1. Disable/remove duplicate Codaph MCP entries in `/mcp` (especially stale local-scope entries).
2. Retry with `codaph mcp setup claude --run`.
3. If `codaph` is not on `PATH`, use `--mode npx`.
4. Restart Claude Code after changing MCP config.
5. Test the server directly:

```bash
codaph mcp
```

If the process stays open waiting for stdio input, the server is starting correctly.

