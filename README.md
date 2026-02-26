# Codaph

Codaph is a terminal-first CLI interface for inspecting coding-agent activity with shared Mubit-backed memory.

Codaph is the result of a confusion - who prompted _(this)_? during our dev cycle. The prompt or code wasn't the problem but the lack of story around it. With agentic coding tools, we are shipping faster than ever but also missing out on so much story. Codaph aims to be the bridge and to also convince you to sign up to Mubit.

> [!WARNING]
> Codaph is in beta and can break. Plus, its agentically engineered. Be mindful.

> Once a legend said, if Pentagon can vibe code secret ops with AI, we can surely engineer a CLI with it.

## Plans

- [ ] Rust rewrite for the love of game and performance optimisation
- [ ] Use Mubit state subscription for auto exec / scripting
- [ ] Dependencies map and upgrade sync in Mubit
- [ ] Plugin for coding agents
- [ ] Add support for
  - [x] Claude Code
  - [ ] OpenCode
  - [x] Gemini
  - [ ] Cursor
  - [x] Codex

## What's the Point of using a memory platform like Mubit

If you have more than 2 engineers working in parallel with various coding agents, it gets difficult to trace semantic reasoning and understand the story.

Onboarding a new engineer or a new agent becomes a problem with the coldstart. Using Mubit helps avoid it and build on top the semantic layer (of your own code).

The goal with Codaph is to enable a VCS that humans can use to understand the code story while we offload the tasks to agents.

## Installation

Use one of the following methods.

### npm / npx

```bash
npm i -g @codaph/codaph
```

### From source (development)

```bash
git clone <your-repo-url>
cd codaph
bun install
bun run build
```

## First-Time Setup (Keys)

Codaph uses Mubit for shared cloud memory and sync. Configure a Mubit API key before your first `sync`.

OpenAI is optional. If you add `OPENAI_API_KEY`, Codaph can produce OpenAI-assisted answers for `codaph mubit query` and TUI chat (`m`) using Mubit evidence. The default OpenAI model is `gpt-4.1-mini`, and you can override it with `OPENAI_MODEL`.

```bash
codaph setup --mubit-api-key <your-mubit-key>

# optional: OpenAI-assisted query/chat
codaph setup --openai-api-key <your-openai-key>
```

You can also set `MUBIT_API_KEY`, `OPENAI_API_KEY`, and `OPENAI_MODEL` as environment variables. If a Mubit key is missing, `codaph init` prompts for it.

## Usage

Run Codaph from the project root you want to inspect.

```bash
# one-time key setup (recommended; can also use env vars)
codaph setup --mubit-api-key <your-mubit-key>

# one-time repo setup (wizard; detects .codex/.claude/.gemini and lets you multi-select)
codaph init

# daily sync (fast, Mubit-first)
codaph sync

# open terminal UI
codaph tui

# optional historical backfill from local agent history (Codex / Claude Code / Gemini CLI)
codaph import

# inspect sync and automation state
codaph status
```

Optional query example (OpenAI-assisted if `OPENAI_API_KEY` is set, otherwise Mubit response):

```bash
codaph mubit query "what changed in auth?" --session <session-id>
```

If you are running from source, use `bun run cli` instead of `codaph`.

```bash
bun run cli init --cwd /absolute/project/path
bun run cli sync --cwd /absolute/project/path
bun run cli tui --cwd /absolute/project/path
```

## Documentation

Start with [Quickstart](docs/quickstart.md) for Mubit API key setup, optional OpenAI-assisted query/chat setup, and the recommended first-run flow.

- [Docs Index](docs/index.md)
- [Quickstart](docs/quickstart.md)
- [CLI Reference](docs/cli-reference.md)
- [TUI Guide](docs/tui-guide.md)
- [Mubit Collaboration](docs/collaboration-mubit.md)
- [Troubleshooting](docs/troubleshooting.md)

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests and documentation as appropriate.

## License

Dual-licensed under either of the following, at your option:

- MIT
- Apache License 2.0

See [LICENSE](LICENSE) for the full text of both licenses.
