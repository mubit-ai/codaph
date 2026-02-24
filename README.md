# Codaph

Codaph is a Codex-first capture layer for coding agent activity, with a CLI/TUI-first workflow and Mubit-backed collaborative memory.

## Repository Layout

Codaph now uses a single-app layout for readability.

```text
src/
  index.ts            # CLI + TUI entrypoint
  lib/                # core modules (adapters, ingest, mirror, query, mubit)
  *.ts                # sync, settings, project registry, hooks
test/                 # all tests
docs/                   # user and architecture docs
```

## Documentation

Start here:

- [docs/README.md](docs/README.md) (docs index)
- [docs/quickstart.md](docs/quickstart.md) (wizard-first setup)
- [docs/one-page-cli-tui.md](docs/one-page-cli-tui.md) (publish-facing overview)
- [docs/troubleshooting.md](docs/troubleshooting.md) (common issues and fixes)

Reference docs:

- [docs/cli-reference.md](docs/cli-reference.md)
- [docs/tui-guide.md](docs/tui-guide.md)
- [docs/collaboration-mubit.md](docs/collaboration-mubit.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/data-model.md](docs/data-model.md)
- [docs/roadmap.md](docs/roadmap.md)

## Requirements

- Bun `1.3.9+`
- Codex CLI installed (`codex --version`)
- Codex login available (`codex login status`)

## Setup

```bash
bun install
bun run hooks:install
bun run typecheck
bun run build
```

## Use Via NPX

After npm publish, users can run Codaph directly without cloning:

```bash
npx @codaph/codaph --help
npx @codaph/codaph tui --cwd /absolute/project/path --mubit
# fallback if your npx does not auto-resolve the bin:
npx --yes --package @codaph/codaph codaph --help
```

## Release Tag Publish (GitHub Actions)

Codaph now publishes to npm on release tags via:
`/Users/anilp/Code/codaph/.github/workflows/publish-npm.yml`

Release flow:

```bash
# 1) bump version in package.json (must match tag)
# 2) commit and push
git tag v0.1.0
git push origin v0.1.0
```

Workflow requirements:
- GitHub repo secret `NPM_TOKEN` must be set.
- Tag format must be `v<package.json version>` (example `v0.1.0`).
- `NPM_TOKEN` must be from an npm account that can publish the package name.
- If publish fails with `E403`, use an npm Automation/Publish token with write access (not read-only), and ensure token scope includes `@codaph`.

## Quick Start (User Flow)

Codaph is Mubit-first and wizard-first.

From a target project repo:

```bash
codaph init
codaph sync
codaph tui
```

Optional historical backfill from local Codex sessions:

```bash
codaph import
```

Use `codaph status` to inspect automation, last push/pull timestamps, and Mubit snapshot diagnostics.

See [docs/quickstart.md](docs/quickstart.md) for the full walkthrough.

## Developer Commands (Source Checkout)

When running from this source repo, use `bun run cli` instead of the published `codaph` binary:

```bash
bun run cli --help
bun run cli init --cwd /absolute/project/path
bun run cli sync --cwd /absolute/project/path
bun run cli tui --cwd /absolute/project/path
bun run cli import --cwd /absolute/project/path
bun run cli status --cwd /absolute/project/path
```

Codaph is CLI/TUI-only. Captured local state is stored under `<project>/.codaph`.
