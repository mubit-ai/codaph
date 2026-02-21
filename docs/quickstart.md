# Quickstart

## 1) Install

```bash
bun install
bun run hooks:install
bun run agent:status -- --source manual
```

## 2) Verify Codex Login

```bash
codex login status
```

## 3) Build and Launch Desktop

```bash
bun run desktop
```

In the app:
1. Add one or more project folders.
2. Use Codex CLI/Desktop normally for those projects.
3. Click `Sync Now` (or keep `Auto Sync` enabled).
4. Inspect prompts, reasoning/thoughts, and diffs per session.

## 4) Optional CLI

```bash
bun run cli run "Explain this codebase" --cwd /absolute/project/path
```
