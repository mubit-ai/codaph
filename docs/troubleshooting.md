# Troubleshooting

This page covers common Codaph issues and fast recovery steps.

## MuBit Shows Disabled

Symptoms:

- TUI header shows `MuBit:off`
- MuBit commands return disabled message

Checks:

```bash
bun run cli doctor --cwd /absolute/project/path --mubit
```

Fixes:

- Ensure `MUBIT_API_KEY` is set in shell or root `.env`.
- Run commands from repo root so Bun loads root `.env`.
- Verify `--mubit` is present when forcing MuBit mode.
- Set key in TUI settings (`o`) if you prefer saved settings.

## `sync` Appears Stuck

Symptoms:

- progress line continues for long duration
- previous runs timed out after large imports

Fixes:

- Re-run with local-only to isolate network impact:
  `bun run cli sync --cwd /absolute/project/path --no-mubit`
- Then enable MuBit and retry:
  `bun run cli sync --cwd /absolute/project/path --mubit`
- Use `sync remote` to pull shared state separately:
  `bun run cli sync remote --cwd /absolute/project/path --mubit`

Notes:

- Codaph uses dedupe-first ingest and a MuBit write circuit-breaker to prevent repeated blocking failures.

## No Collaborator Prompts or Diffs

Symptoms:

- you see only your own sessions
- contributor overlay is empty

Fixes:

1. Confirm team uses same `projectId`:
   `CODAPH_PROJECT_ID=owner/repo`
2. Confirm each teammate has unique actor id.
3. Run local sync (`s`) and then remote sync (`r`) in TUI.
4. Confirm run scope is `project` in settings overlay.

## MuBit Query Returns No Useful Answer

Symptoms:

- empty or weak query answer
- no evidence shown

Fixes:

- Use a tighter question:
  `what changed in <file> between prompts 3 and 5?`
- Ensure target session exists in project scope.
- Increase limit:
  `--limit 12`
- Disable synthesis for debugging:
  `--raw` or `--no-agent`

## Codex CLI Not Found for Direct Capture

Symptoms:

- direct `run`/`exec` capture reports missing codex binary

Fixes:

- Install Codex CLI and verify:
  `codex --version`
- Use history sync path meanwhile:
  `bun run cli sync --cwd /absolute/project/path`

## TUI Layout Issues in Terminal

Symptoms:

- borders overflow
- content shifts or clips

Fixes:

- Increase terminal width and height.
- Use a monospaced font with normal character width.
- Disable aggressive terminal zoom.
- Start from a fresh terminal session after upgrades.

## NPM Publish Fails With `E403`

Symptoms:

- GitHub Actions publish step fails with `403 Forbidden`.
- Error says: `You may not perform that action with these credentials.`

Fixes:

1. Ensure repo secret `NPM_TOKEN` is valid and not expired/revoked.
2. Use an npm token type that can publish (Automation/Publish capable, not read-only).
3. Confirm token account can publish package name:
   - if package exists: account must be listed in `npm owner ls <package>`
   - if package is new: account must be allowed to claim that name
4. For this repo, publish under the org scope and use:
   `npx @codaph/codaph ...`

Notes:

- Workflow now runs an npm auth preflight (`npm whoami` and owner check) before publish to surface this earlier.

## Reset Local Codaph State (Safe)

If local mirror is inconsistent and you want a fresh rebuild:

```bash
rm -rf /absolute/project/path/.codaph
bun run cli sync --cwd /absolute/project/path --mubit
bun run cli sync remote --cwd /absolute/project/path --mubit
```

This does not delete MuBit remote memory.
