# Quickstart

This guide gets Codaph running with collaborative MuBit memory in less than 10 minutes.

## 1) Prerequisites

- Bun `1.3.9+`
- Codex CLI installed and authenticated
- MuBit API key
- Optional OpenAI API key for MuBit answer synthesis

## 2) Install and Build

Run commands from the repository root.

```bash
cd /Users/anilp/Code/codaph
bun install
bun run typecheck
bun run build
```

## 3) Configure Secrets

Use root `.env` or shell exports.

```bash
export MUBIT_API_KEY=your_mubit_key
export OPENAI_API_KEY=your_openai_key
```

Optional collaborative overrides:

```bash
export CODAPH_PROJECT_ID=owner/repo
export CODAPH_ACTOR_ID=your-github-login
export CODAPH_MUBIT_RUN_SCOPE=project
```

## 4) Validate Runtime Wiring

```bash
bun run cli doctor --cwd /Users/anilp/Code/codaph --mubit
```

Expected signals:

- `MuBit runtime: enabled`
- `MuBit project id:` is set (auto-detected from git remote or explicit override)
- `MuBit actor id:` is set

## 5) Run TUI (Primary UX)

```bash
bun run tui --cwd /Users/anilp/Code/codaph --mubit
```

Inside TUI:

1. Press `a` to add/select project folder.
2. Press `s` to sync local Codex sessions from `~/.codex/sessions`.
3. Press `r` to sync shared MuBit remote activity into local mirror.
4. Press `enter` on a session to inspect prompts, thoughts, and diffs.
5. Press `m` to ask MuBit questions in context.

## 6) CLI-Only Workflow (Optional)

```bash
# local codex history -> mirror (+ MuBit if enabled)
bun run cli sync --cwd /absolute/project/path --mubit

# remote MuBit timeline -> mirror
bun run cli sync remote --cwd /absolute/project/path --mubit

# inspect and query
bun run cli sessions list --cwd /absolute/project/path
bun run cli inspect --session <session-id> --cwd /absolute/project/path
bun run cli mubit query "what changed in auth?" --session <session-id> --cwd /absolute/project/path --mubit
```

## 7) Scope Note

Codaph is CLI/TUI-first and currently ships without the Electron desktop app.
