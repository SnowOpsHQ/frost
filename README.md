# frost

A desktop **SEO browser with an AI agent** — a Chromium-based browser with a docked
SEO analysis sidebar, a local change-history store, and an agent that can drive the
browser and run SEO skills.

## Status
- **Phase 0 — Foundations:** done. A pnpm/Turbo monorepo, the hardened Electron shell, the typed
  sender-guarded IPC contract, the security policy module, CI security gates, and macOS arm64
  packaging.
- **Phase 1 — Browser core:** done. A usable, hardened browser: tabs, an address bar, navigation
  guards for browsed content, per-origin permission prompts, page commands and a context menu, and a
  local browser-session database that restores tabs. What the app does now:
  [`apps/desktop/README.md`](apps/desktop/README.md); the plan and how it was built:
  [`docs/plans/phase-1-browser-core.md`](docs/plans/phase-1-browser-core.md).
- **Next:** Phase 2, the SEO engine and sidebar (`docs/design/IMPLEMENTATION-PLAN.md` §4).

## Clean-room note
frost is a **clean-room** build. It is designed from a written behavioral/design
spec authored by us, not from any third party's source. **This repository contains
no third-party code, bundles, or UI assets.** The reverse-engineering analysis that
informed the design (decompiled bundles, screenshots) is kept in a separate private
workspace and is intentionally not committed here.

## Layout
- `apps/desktop/` — the Electron app (main, preload, the React chrome), packaged with Electron Forge.
- `packages/ipc-contract/` — the typed tRPC IPC contract and its sender guard.
- `packages/db/` — the local browser-session database (Drizzle over `node:sqlite`).
- `specs/` — machine-checkable spec artifacts (constants, Zod schemas, `*.feature.md` acceptance
  lists); every scenario maps to a named test.
- `docs/design/IMPLEMENTATION-PLAN.md` — the design doc (intent, stack, security model, 8-phase roadmap).
- `docs/plans/` — the executable, spec-driven phase plans (Phase 0, Phase 1).
- `semgrep/`, `security/`, `scripts/` — the CI security gates' rules, baseline and runner.

## Getting started
1. Node ≥ 22.18 and pnpm 12.15.0 (`package.json#packageManager`); `pnpm install`.
2. `pnpm lint`, `pnpm test`; `pnpm --filter @app/desktop build && pnpm --filter @app/desktop test:e2e`
   (needs a display); `pnpm --filter @app/desktop start` for a dev run. More, including macOS
   packaging, in [`apps/desktop/README.md`](apps/desktop/README.md).
3. New work follows `CONTRIBUTING.md`: spec first, a failing named test, then the code.

## Build principles (from the design)
TypeScript + React + Electron Forge · pnpm/Turbo monorepo · typed tRPC IPC with a central
sender guard · SQLite + Drizzle (local-first) · Vercel AI-SDK agent · security & consented
telemetry designed in from commit #1.
