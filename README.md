# frost

A desktop **SEO browser with an AI agent** — a Chromium-based browser with a docked
SEO analysis sidebar, a local change-history store, and an agent that can drive the
browser and run SEO skills.

## Status
Pre-implementation. This repo contains the design and the Phase 0 plan. No product
code exists yet; Phase 0, Task 1 scaffolds the monorepo.

## Clean-room note
frost is a **clean-room** build. It is designed from a written behavioral/design
spec authored by us, not from any third party's source. **This repository contains
no third-party code, bundles, or UI assets.** The reverse-engineering analysis that
informed the design (decompiled bundles, screenshots) is kept in a separate private
workspace and is intentionally not committed here.

## Layout
- `docs/design/IMPLEMENTATION-PLAN.md` — the design doc (intent, stack, security model, 8-phase roadmap).
- `docs/plans/phase-0-foundations.md` — the executable, spec-driven Phase 0 plan (task-level, TDD).
- `specs/` — machine-checkable spec artifacts (authored per task during implementation).

## Getting started (on the target host)
1. Clone this repo.
2. Open it as a project in your T3 Code environment.
3. Implement `docs/plans/phase-0-foundations.md` task-by-task (subagent-driven recommended).

## Build principles (from the design)
TypeScript + React + Electron Forge · pnpm/Turbo monorepo · typed tRPC IPC with a central
sender guard · SQLite + Drizzle (local-first) · Vercel AI-SDK agent · security & consented
telemetry designed in from commit #1.

## License
Copyright (C) 2026 SnowOpsHQ.

frost is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** (`AGPL-3.0-only`), as published by the Free
Software Foundation. See [`LICENSE`](LICENSE). It is distributed WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Bundled third-party libraries keep their own licenses; the packaged app ships their notices in
`THIRD_PARTY_NOTICES`. For a commercial license, contact SnowOpsHQ.
