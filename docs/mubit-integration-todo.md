---
layout: docs
---

# Mubit Integration Status

Codaph is now integrated with Mubit for write, query, and remote replay flows.

Implemented:

- post-normalization write hook in ingest pipeline
- semantic query command (`mubit query`) with optional OpenAI synthesis
- remote replay job (`sync remote`) from Mubit context snapshot timeline
- project-scoped and session-scoped run ids
- actor-aware metadata for collaborative attribution

Remaining integration work is tracked in [Roadmap](./roadmap.md).
