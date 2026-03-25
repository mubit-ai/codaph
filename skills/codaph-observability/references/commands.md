# Codaph Commands

Use `<repo>` for the target repository root.

## Daily Flow

```bash
codaph status --cwd <repo> --json
codaph push --cwd <repo>
codaph pull --cwd <repo>
```

Use `codaph pull --full --json` when normal pull looks windowed or you need full remote replay.

## Question Answering Sequence

Use this sequence before answering questions like "what changed?", "what is the current direction?", or "what should the next agent know?".

```bash
codaph status --cwd <repo> --json
codaph pull --cwd <repo> --json
codaph mubit context "what should the next agent know about this work?" --cwd <repo> --json
```

Only add full replay when needed:

```bash
codaph pull --cwd <repo> --full --json
```

If Codaph returns weak context, say so explicitly before falling back to git history or source inspection.

## Context Before Starting An Agent

Project scope:

```bash
codaph mubit context "what should the next agent know?" --cwd <repo> --json
```

Session scope:

```bash
codaph mubit context "what should the next agent know?" --cwd <repo> --session <session-id> --json
```

## Before Risky Edits

```bash
codaph checkpoint "before-auth-refactor" --cwd <repo> --json
```

Use `--session <session-id>` when the checkpoint belongs to one concrete run.

## When The Agent Is Stuck

```bash
codaph doctor mubit --cwd <repo>
codaph mubit diagnose "auth failure in CI" --cwd <repo> --json
```

If the failure belongs to one run:

```bash
codaph mubit diagnose "auth failure in CI" --cwd <repo> --session <session-id> --json
```

## Handoffs

Create:

```bash
codaph handoff send \
  --cwd <repo> \
  --task auth-cleanup \
  --from claude-code \
  --to codex \
  --action continue \
  "continue validating the auth cleanup" \
  --json
```

List:

```bash
codaph handoff list --cwd <repo> --json
```

Feedback:

```bash
codaph handoff feedback \
  --cwd <repo> \
  --handoff <handoff-id> \
  --verdict approve \
  --comments "looks good" \
  --json
```

## Reflection

```bash
codaph mubit reflect --cwd <repo> --json
codaph mubit strategies --cwd <repo> --json
```

Use `--session <session-id>` when reflection should stay tied to one run.

## Codaph Repo Smoke Test

```bash
codaph status --cwd /Users/shankha/code/codaph --json
codaph pull --cwd /Users/shankha/code/codaph --full --json
codaph mubit context "what should the next agent know about the current codaph work?" --cwd /Users/shankha/code/codaph --json
codaph checkpoint "smoke-test" --cwd /Users/shankha/code/codaph --json
```
