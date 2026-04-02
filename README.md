# Codaph

Replay how your codebase was built. Codaph captures agent prompts, reasoning, and file diffs from Claude Code, Codex, and Gemini CLI into a shared [Mubit](https://mubit.ai) memory that your whole team can search semantically.

Unlike git-local session logs, Codaph gives your team shared semantic memory across agents and contributors. 

> [!WARNING]
> Codaph is in beta. Be mindful.

## Get Started

```bash
npm i -g @codaph/codaph
codaph enable
```

That's it. `codaph enable` auto-detects your agents, installs hooks, and optionally connects to Mubit cloud memory. Works without a Mubit key too (local-only mode).

Then explore your agent activity:

```bash
codaph tui
```

## Why Codaph + Mubit

When multiple engineers work with coding agents in parallel, the reasoning behind changes gets lost. Onboarding a new engineer or agent means a cold start every time.

Codaph captures the full story (prompts, thoughts, diffs) locally, and Mubit shares it as searchable semantic memory across your team. Ask "what changed in auth?" and get answers ranked by relevance from everyone's agent sessions.

## Agent Support

- [x] Claude Code
- [x] Codex (OpenAI)
- [x] Gemini CLI (Google)
- [ ] Cursor (planned)
- [ ] OpenCode (planned)
- [ ] GitHub Copilot CLI (planned)

## Roadmap

- [ ] Rust rewrite for performance
- [ ] Mubit state subscription for auto exec / scripting
- [ ] Dependencies map and upgrade sync
- [ ] Plugin system for coding agents

## Installation

### npm (recommended)

```bash
npm i -g @codaph/codaph
```

### From source

```bash
git clone https://github.com/mubit-ai/codaph.git
cd codaph
bun install
bun run build
```

## Usage

```bash
# one-command setup (recommended)
codaph enable

# open terminal UI
codaph tui

# daily sync
codaph pull

# backfill agent history to Mubit
codaph push

# check sync status
codaph status
```

## Advanced Setup

For granular control, use the individual setup commands:

```bash
# global key setup
codaph setup --mubit-api-key <your-mubit-key>

# optional: OpenAI-assisted query/chat
codaph setup --openai-api-key <your-openai-key>

# per-repo init with provider selection
codaph init
```

You can also set `MUBIT_API_KEY`, `OPENAI_API_KEY`, and `OPENAI_MODEL` as environment variables.

`codaph init` also writes a reusable Claude Code MCP template at `.codaph/mcp/claude-code.json`.
Use `codaph mcp setup claude` to print (or run with `--run`) the recommended `claude mcp add ...` command.

Optional query example (OpenAI-assisted if `OPENAI_API_KEY` is set, otherwise Mubit response):

```bash
codaph mubit query "what changed in auth?"
codaph mubit query "what is the current direction of this repo?" --rank-by freshness
codaph mubit query "what changed in auth?" --session <session-id>
codaph mubit activity --limit 20 --exclude-derived --projection compact
```

If you are running from source, use `bun run cli` instead of `codaph`.

```bash
bun run cli init --cwd /absolute/project/path
bun run cli sync --cwd /absolute/project/path
bun run cli tui --cwd /absolute/project/path
```

## MCP (Claude Code)

Codaph ships a local MCP server over stdio:

```bash
codaph mcp
```

Recommended setup (personal use):

```bash
codaph mcp setup claude --scope user --run
```

This uses Claude Code user scope (`~/.claude.json`) so one Codaph MCP config works across repos.

Project scope (`.mcp.json`) is also supported when you want a shared/team config. `codaph init` writes a copy/merge template at `.codaph/mcp/claude-code.json`.

See [MCP Setup (Claude Code)](docs/mcp-setup.md) for `claude mcp add` commands, JSON examples, and troubleshooting.

## Documentation

Start with [Quickstart](docs/quickstart.md) for Mubit API key setup, optional OpenAI-assisted query/chat setup, and the recommended first-run flow.

- [Docs Index](docs/index.md)
- [Quickstart](docs/quickstart.md)
- [CLI Reference](docs/cli-reference.md)
- [Skills](docs/skills.md)
- [MCP Setup (Claude Code)](docs/mcp-setup.md)
- [TUI Guide](docs/tui-guide.md)
- [Mubit Collaboration](docs/collaboration-mubit.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Repo Skills](skills/README.md)
- [Codaph Observability Skill](skills/codaph-observability/SKILL.md)

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests and documentation as appropriate.

## License

Dual-licensed under either of the following, at your option:

- MIT
- Apache License 2.0

See [LICENSE](LICENSE) for the full text of both licenses.
