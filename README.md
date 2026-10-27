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
  local browser-session database that restores tabs. The plan and how it was built:
  [`docs/plans/phase-1-browser-core.md`](docs/plans/phase-1-browser-core.md).
- **Phase 2 — SEO engine and sidebar:** built (Tasks 1–6); the release check (Task 7) is in
  progress. Visiting a page gives a live audit with a 0–100 health score in a docked, collapsible
  sidebar: Overview, On-Page, Links, Images, Social, Schema, Indexability, Page Speed and Compliance
  panels, from 101 rules of frost's own. Extraction runs in isolated worlds, and the analysis runs in
  a worker thread with a hard timeout. What the app does now:
  [`apps/desktop/README.md`](apps/desktop/README.md); the plan and how it was built:
  [`docs/plans/phase-2-seo-engine.md`](docs/plans/phase-2-seo-engine.md).
- **Next:** Phase 3, SERP + intent + indexability (`docs/design/IMPLEMENTATION-PLAN.md` §4).

## Clean-room note
frost is a **clean-room** build. It is designed from a written behavioral/design
spec authored by us, not from any third party's source. **This repository contains
no third-party code, bundles, or UI assets.** Third-party open-source libraries are used
only as dependencies under their own licenses (see `apps/desktop/THIRD_PARTY_NOTICES`).

## Layout
- `apps/desktop/` — the Electron app (main, preload, the React chrome), packaged with Electron Forge.
- `packages/seo-core/` — the SEO audit engine (`@app/seo-core`): the rule catalog's checks, the
  health score, and the schema, robots.txt, hreflang, page speed and security readers. Pure
  TypeScript, with no Electron, DOM or Zod dependency.
- `packages/db/` — the local browser-session database (Drizzle over `node:sqlite`).
- `packages/ipc-contract/` — the typed tRPC IPC contract and its sender guard.
- `specs/` — machine-checkable spec artifacts (constants, Zod schemas, `*.feature.md` acceptance
  lists); every scenario maps to a named test.
- `docs/design/IMPLEMENTATION-PLAN.md` — the design doc (intent, stack, security model, 8-phase roadmap).
- `docs/plans/` — the executable, spec-driven phase plans (Phases 0–2).
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
