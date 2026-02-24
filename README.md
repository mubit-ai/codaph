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

## Usage

Run Codaph from the project root you want to inspect.

```bash
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

If you are running from source, use `bun run cli` instead of `codaph`.

```bash
bun run cli init --cwd /absolute/project/path
bun run cli sync --cwd /absolute/project/path
bun run cli tui --cwd /absolute/project/path
```

## Documentation

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
