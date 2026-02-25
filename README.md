# Codaph

Codaph is a terminal-first CLI/TUI for inspecting coding-agent activity with shared Mubit-backed memory.

Once a legend said, if Pentagon can vibe code secret ops with AI, we can surely engineer a CLI with it. That legend is Shankha

## Installation

Use one of the following methods.

### npm / npx

```bash
npx @codaph/codaph --help
```

If your environment does not resolve the scoped bin automatically:

```bash
npx --yes --package @codaph/codaph codaph --help
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

# one-time repo setup (wizard)
codaph init

# daily sync (fast, Mubit-first)
codaph sync

# open terminal UI
codaph tui

# optional historical backfill from ~/.codex/sessions
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
