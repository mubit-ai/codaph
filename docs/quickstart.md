---
layout: docs
---

# Quickstart

Codaph lets you inspect coding-agent activity in a terminal UI and share project memory through Mubit.
This quickstart gets a new project working in a few minutes, including Mubit setup and optional OpenAI-assisted query/chat.

## What You Need

Required:

- A repository you want to inspect
- A coding agent CLI you use (Codex, Claude Code, or Gemini CLI)
- A Mubit API key (you can create one in [console.mubit.ai](https://console.mubit.ai))

Only needed for source/development install:

- Bun `1.3.9+`

Optional (recommended for query/chat quality):

- `OPENAI_API_KEY` for OpenAI-assisted synthesis in `codaph mubit query` and TUI chat
- `OPENAI_MODEL` only if you want to override the default OpenAI model (`gpt-4.1-mini`)

## Before You Start: Keys and What They Do

Codaph uses Mubit for shared cloud memory and sync. You must configure a Mubit API key to use Mubit-backed sync and collaboration features.

Codaph can also use OpenAI for small query/chat responses on top of Mubit evidence. This is optional and affects `codaph mubit query ...` and the TUI chat panel (`m`) when agent mode is enabled.

By default, Codaph uses `gpt-4.1-mini` for OpenAI-assisted synthesis/chat. You can override it with `OPENAI_MODEL` or `--openai-model <model>`.

If you do not configure OpenAI, Codaph falls back to Mubit responses.

## Get a Mubit API Key

Create your Mubit key before running the first sync.

1. Open [mubit.ai](https://mubit.ai), then go to [console.mubit.ai](https://console.mubit.ai).
2. Create an account or sign in.
<!-- MEDIA PLACEHOLDER: Mubit signup / console account creation screenshot or short video (future asset path: docs/assets/img/quickstart/mubit-signup.png) -->
3. Open the developer/API access area in the console.
4. Create an API key and copy it.
<!-- MEDIA PLACEHOLDER: Mubit console API key creation / copy flow screenshot or short video (future asset path: docs/assets/img/quickstart/mubit-api-key.png) -->
5. Store it securely. Do not commit it to your repository.

## Add Your Keys (Recommended Setup Path)

Set global keys first so `codaph init` can run without prompting for missing credentials.

```bash
codaph setup --mubit-api-key <your-mubit-key>
```

If you want OpenAI-assisted query/chat answers, add your OpenAI key too:

```bash
codaph setup --openai-api-key <your-openai-key>
```

You can also use environment variables instead of `codaph setup`:

```bash
export MUBIT_API_KEY=<your-mubit-key>
# Optional:
export OPENAI_API_KEY=<your-openai-key>
# Optional model override (default is gpt-4.1-mini):
export OPENAI_MODEL=<your-model>
```

`codaph init` still prompts for a Mubit API key if one is not configured yet, so the wizard-first path remains valid.

## Install Codaph

Choose one install path.

### Option A: Published binary (recommended for most users)

Start by verifying the installed binary:

```bash
codaph --help
```

If you run through `npx`, use this fallback form when your shell does not resolve the scoped binary automatically:

```bash
npx --yes --package @codaph/codaph codaph --help
```

### Option B: Run from source (contributors / local development)

Use this path when you are developing Codaph itself.

```bash
cd /Users/anilp/Code/codaph
bun install
bun run typecheck
bun run build
```

Run commands with `bun run cli ...` while developing from source.

## Initialize Codaph in a Project

Open the repository you want to inspect and run:

```bash
cd /absolute/path/to/your/project
codaph init
```

What `codaph init` does:

- creates repo-local `.codaph/project.json`
- prompts for a Mubit API key if one is not configured yet
- detects `.codex`, `.claude`, `.gemini` folders and lets you multi-select agent integrations (recognized providers are preselected)
- enables repo-scoped auto-sync hooks (post-commit, and agent-complete when detectable)
- stores repo sync settings

If you do not have a Mubit key yet, the wizard points you to [console.mubit.ai](https://console.mubit.ai).

## Run Your First Sync

Run the fast daily sync path after initialization:

```bash
codaph sync
```

What `codaph sync` does:

- runs the fast Mubit-first sync path
- pulls cloud activity into your local `.codaph` mirror
- uses repo-local sync state and automation settings
- does not replay global agent history by default (Codex / Claude Code / Gemini CLI)

Use this command for normal day-to-day usage.

## Open the TUI

Launch the terminal UI to browse sessions, prompts, thoughts, and diffs:

```bash
codaph tui
```

Inside the TUI:

- press `s` to run sync now (push + pull)
- press `r` to pull cloud activity now (manual fallback)
- press `enter` on a session to inspect prompts, thoughts, and diffs
- press `c` to filter by contributor

## Ask Mubit a Question (Optional OpenAI-assisted)

After you identify a session id, you can query Mubit directly from the CLI:

```bash
codaph mubit query "what changed in auth?" --session <session-id>
```

Codaph returns a Mubit response by default. If `OPENAI_API_KEY` is configured, Codaph can synthesize a shorter answer using OpenAI (`gpt-4.1-mini` by default) on top of Mubit evidence.

Use `--agent` or `--no-agent` to control OpenAI-assisted behavior for a specific query. Use `--openai-model <model>` to override the model for that command.

In the TUI, press `m` to open the Mubit chat panel. OpenAI-assisted chat is optional and uses the same key/model settings when enabled.

## Backfill Historical Agent Sessions (Optional)

If you want older local agent sessions (Codex / Claude Code / Gemini CLI) to appear in Codaph and Mubit, run:

```bash
codaph import
```

Use `codaph import` once (or occasionally). It is not part of the default daily `sync` path.
Use `--providers <csv|all|auto>` if you want to limit the backfill to specific agents.

## Check Status

Check local sync state and Mubit diagnostics when you finish setup:

```bash
codaph status
```

`codaph status` shows:

- auto-sync state
- last local push timestamp
- last remote pull timestamp
- Mubit snapshot diagnostics (including snapshot cap hints)

## Team Quickstart (Shared Mubit Memory)

For a team using the same repo:

1. Everyone runs `codaph init` in the repo.
2. Everyone uses the same Mubit backend key and project id.
3. Each person has a unique actor id (auto-detected in most cases).
4. One or more contributors run `codaph import` to backfill local agent history.
5. Everyone runs `codaph sync` and opens `codaph tui`.

Read [Mubit Collaboration](./collaboration-mubit.md) for details and current limits.

## Non-Interactive Setup (CI / demos / scripted envs)

Use explicit flags in scripted environments:

```bash
codaph setup --mubit-api-key <your-key>
# Optional OpenAI-assisted query/chat:
codaph setup --openai-api-key <your-openai-key>
cd /absolute/path/to/your/project
codaph init --yes
codaph sync
```

## If Something Looks Wrong

Start with diagnostics before resetting anything:

```bash
codaph status
codaph doctor --mubit
```

Then check [Troubleshooting](./troubleshooting.md).
