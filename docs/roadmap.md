# Roadmap

This page answers two questions:

- What is already done.
- What remains to complete Phase 1 and move into the next iteration.

## Shipped

- Codex-first ingestion through SDK and `exec --json`.
- Local append-only mirror with deterministic timeline/diff reads.
- Mubit write path with project/session run scope.
- Mubit remote replay into local mirror (`sync remote`).
- Contributor attribution through `actorId` and TUI actor filter.
- TUI settings for project id, actor id, Mubit key, OpenAI key, and run scope.
- OpenAI-assisted synthesis layer over Mubit query responses.

## Remaining (High Priority)

- Merge semantic Mubit context directly into query-service timeline APIs.
- Improve remote replay coverage for non-`codaph_event` activity shapes.
- Add encryption-at-rest for local `.codaph` mirror files.
- Add richer full-diff per-thought mapping with stronger hunk context.

## Remaining (Product / UX)

- Tighten TUI visual polish and responsive behavior on narrow terminals.
- Expand project-level contributor analytics and trend summaries.
- Improve first-run onboarding prompts inside TUI.

## Remaining (Platform / Reliability)

- Add CI workflows for smoke tests around sync and TUI behavior.
- Add load tests for very large Codex history imports.
- Add migration/version marker for `.codaph` index formats.

## Phase 2 Direction

- Deeper collaborative memory tooling in Mubit.
- Dependency-aware optimization recommendations from repo history.
- Stronger team-level audit trails across prompts, thoughts, and code changes.
