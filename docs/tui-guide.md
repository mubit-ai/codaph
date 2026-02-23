# TUI Guide

Codaph TUI is the fastest workflow for browsing sessions, investigating prompt-to-diff history, and querying MuBit in context.

## Start TUI

```bash
bun run tui --cwd /absolute/project/path --mubit
```

If `--cwd` is omitted, Codaph uses the current working directory.

## Views

### Browse View

Browse view lists sessions with counts and status.

Use it to:

- sync local Codex history (`s`)
- sync remote MuBit timeline (`r`)
- add/switch projects (`a` / `p`)
- open settings (`o`)
- inspect a session (`enter`)

### Inspect View

Inspect view renders structured panes:

- prompts
- thoughts
- files changed
- diff
- optional MuBit chat panel

Inspect supports actor filtering and contributor overlay for collaborative analysis.

### Full Diff Overlay

Press `d` in inspect view to open full diff.
Use `up/down` to scroll and `d` or `esc` to close.

### Settings Overlay

Press `o` to open settings.

You can set:

- project name override
- MuBit project id override
- global actor id
- global MuBit key
- global OpenAI key
- auto-fill from git/GitHub
- run scope toggle (`project`/`session`)

## Keyboard Map

Global:

- `q` quit
- `?` help
- `o` settings

Browse:

- `up/down` select session
- `enter` inspect selected session
- `s` sync local Codex history
- `r` sync remote MuBit timeline
- `p` switch project
- `a` add project

Inspect:

- `up/down` move list selection or scroll active pane
- `tab` cycle focused pane
- `enter` move prompt focus into thoughts navigation
- `d` open full diff
- `m` open/close MuBit chat
- `f` cycle actor filter
- `c` open contributor overlay
- `left` or `esc` go back to browse

Contributor overlay:

- `up/down` select contributor
- `enter` apply actor filter
- `esc` or `c` close overlay

Chat:

- type question and press `enter`
- `esc` closes chat panel

## Recommended Workflow

1. Open TUI in project root.
2. Run `s` to import latest local Codex sessions.
3. Run `r` to pull shared MuBit activity from collaborators.
4. Open active session with `enter`.
5. Use `c` to inspect contributor list and choose one.
6. Use `f` to cycle actor filter quickly.
7. Ask contextual question in chat with `m`.

## Notes on Thoughts

Codaph only renders reasoning text that Codex exposes in captured events.
When interfaces do not expose full reasoning, Codaph marks reasoning availability and shows limited thought slices.
