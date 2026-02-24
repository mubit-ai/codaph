# TUI Guide

Codaph TUI is the fastest way to inspect prompts, thoughts, and diffs after sync.

The TUI is primarily a viewer. Codaph sync and hooks keep the local mirror warm, and the TUI lets you inspect what happened.

## Start the TUI

From the project root:

```bash
codaph tui
```

From a different directory:

```bash
codaph tui --cwd /absolute/path/to/project
```

If Mubit is enabled, the header shows `Mubit:on`.

## What You See

### Browse view

Browse view lists sessions for the current repo.

Use browse view to:

- inspect recent sessions
- run sync now (`s`)
- pull cloud activity now (`r`)
- switch project (`p`)
- open settings (`o`)

### Inspect view

Inspect view shows the selected session in panes.

Typical panes include:

- prompts
- thoughts
- diffs / changed files
- optional Mubit chat panel

Use this view to answer questions like:

- what prompt caused this change?
- what did the agent think before editing?
- what files changed across a session?
- which contributor authored this prompt?

### Status line / header

The header shows operational state, including:

- `Mubit:on/off`
- `AutoSync:on/off`
- cloud status (`ok`, `no-change`, `capped?`, `error`)
- last push / pull timestamps
- actor filter

This helps you tell whether you are looking at fresh data.

## Recommended Workflow

1. Open `codaph tui` in the repo.
2. Press `s` to run sync now (push + pull).
3. Open a session with `enter`.
4. Use `c` to inspect contributors.
5. Filter by actor when needed.
6. Use `d` for a larger diff view.
7. Use `m` to ask a Mubit question in context.

If the cloud is unchanged, Codaph shows a `no-change` state instead of looking like a failed sync.

## Keyboard Shortcuts

### Global

- `q` quit
- `?` help
- `o` settings

### Browse view

- `up/down` move selection
- `enter` open selected session
- `s` sync now (push + pull)
- `r` pull cloud now (manual fallback)
- `p` switch project
- `a` add project

### Inspect view

- `up/down` move selection or scroll active pane
- `tab` cycle focused pane
- `d` open full diff overlay
- `m` open/close Mubit chat
- `f` cycle actor filter
- `c` open contributors overlay
- `left` or `esc` go back to browse view

### Contributors overlay

- `up/down` select contributor
- `enter` apply actor filter
- `esc` or `c` close overlay

### Chat panel

- type question and press `enter`
- `esc` closes the chat panel

## Sync Behavior Inside the TUI

The TUI does not replace setup or import.

- `s` runs the normal sync workflow (fast daily sync)
- `r` runs a cloud pull fallback
- `codaph import` remains the command for historical Codex backfill

If collaborators still see fewer prompts than you do, read [Troubleshooting](./troubleshooting.md) and [Mubit Collaboration](./collaboration-mubit.md).

## Settings You Might Change

Open settings with `o`.

Common settings:

- Mubit project id override
- actor id override
- run scope (`project` or `session`)
- Mubit API key (global)
- OpenAI API key (global)

Use `project` run scope for shared team memory in most cases.
