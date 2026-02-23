# Codaph CLI/TUI One-Page Guide

This is the single-page guide you can publish for Codaph users.

## What Codaph Does

Codaph captures Codex sessions, stores collaborative memory in MuBit, and lets you inspect prompts, thoughts, and diffs in a terminal UI.

## Install

Pick one method.

### A) Local (today)

```bash
git clone <your-repo-url>
cd codaph
bun install
bun run build
```

Run:

```bash
bun run tui --cwd /absolute/project/path --mubit
```

### B) npx (after npm publish)

```bash
npx codaph tui --cwd /absolute/project/path --mubit
```

### C) Homebrew (after formula publish)

```bash
brew install codaph
codaph tui --cwd /absolute/project/path --mubit
```

## Required Environment

```bash
export MUBIT_API_KEY=your_mubit_key
```

Optional for MuBit answer synthesis:

```bash
export OPENAI_API_KEY=your_openai_key
```

Optional explicit collaboration identity:

```bash
export CODAPH_PROJECT_ID=owner/repo
export CODAPH_ACTOR_ID=your-github-login
export CODAPH_MUBIT_RUN_SCOPE=project
```

## First 60 Seconds

1. Start TUI:
   `codaph tui --cwd /absolute/project/path --mubit`
2. Press `s` to sync local Codex history (`~/.codex/sessions`).
3. Press `r` to sync shared MuBit remote timeline.
4. Press `enter` on a session to inspect.
5. Press `m` to ask a MuBit question in session context.

## TUI Keys

- `q` quit
- `?` help
- `o` settings
- `a` add project
- `p` switch project
- Browse: `up/down`, `enter`, `s`, `r`
- Inspect: `up/down`, `tab`, `d`, `m`, `f`, `c`, `left`

## CLI Essentials

```bash
# health check
codaph doctor --cwd /absolute/project/path --mubit

# local codex history -> local mirror (+ MuBit if enabled)
codaph sync --cwd /absolute/project/path --mubit

# shared MuBit timeline -> local mirror
codaph sync remote --cwd /absolute/project/path --mubit

# inspect
codaph sessions list --cwd /absolute/project/path
codaph inspect --session <session-id> --cwd /absolute/project/path
codaph diff --session <session-id> --cwd /absolute/project/path

# query memory
codaph mubit query "what changed in auth?" --session <session-id> --cwd /absolute/project/path --mubit
```

## Team / Collaboration Model

- Everyone uses the same project id (`owner/repo`).
- Everyone uses the same MuBit backend key for that workspace.
- Each contributor has a unique actor id.
- Use run scope `project` for shared memory.

Run ids:

- project scope: `codaph:<owner/repo>`
- session scope: `codaph:<owner/repo>:<sessionId>`

## Settings (inside TUI)

Press `o` and set:

- project name
- MuBit project id
- actor id
- MuBit API key
- OpenAI API key
- run scope (`project` or `session`)

## Common Issues

- `MuBit:off`
  Run `codaph doctor --mubit` and verify `MUBIT_API_KEY`.
- No teammate activity
  Ensure same `CODAPH_PROJECT_ID`, then run `sync remote`.
- Query has no useful answer
  Ask a narrower question and increase `--limit`.

## Publish Notes

For npm release docs, advertise:

```bash
npx codaph ...
```

For Homebrew release docs, advertise:

```bash
brew install codaph
codaph ...
```

If your final package or formula names differ, replace `codaph` in this page before publishing.
