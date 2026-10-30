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
- **Phase 2 — SEO engine and sidebar:** done. Visiting a page gives a live audit with a 0–100 health
  score in a docked, collapsible sidebar: Overview, On-Page, Links, Images, Social, Schema,
  Indexability, Page Speed and Compliance panels, from 101 rules of frost's own. Extraction runs in
  isolated worlds, and the analysis runs in a worker thread with a hard timeout. The plan and how it
  was built: [`docs/plans/phase-2-seo-engine.md`](docs/plans/phase-2-seo-engine.md).
- **Phase 2.5 — SEO tooling depth:** built (Tasks 1–7); its macOS release check is run separately.
  The day-to-day toolkit around the audit: per-tab render profiles (device, crawler user agents,
  network, JavaScript and cache off), a served-HTML vs rendered-DOM comparison, a Content panel with
  a snippet editor, a command palette, an SEO devtools drawer, find in page, reopen closed tab,
  history and a choice of search engine, and on-request link, sitemap and hreflang checks; the
  sidebar gains Content and JavaScript panels (eleven, with 111 rules). What the app does now:
  [`apps/desktop/README.md`](apps/desktop/README.md); the plan and how it was built:
  [`docs/plans/phase-2.5-seo-tooling.md`](docs/plans/phase-2.5-seo-tooling.md).
- **Phase 3 — SERP, intent and indexability:** built (Tasks 1–7); its macOS release check runs on
  the macOS CI runner. Two new sidebar panels (thirteen in all):
  - **SERP**, on a Google, Bing or DuckDuckGo result page you load. It shows the page's composition,
    page-1 ownership by domain, outlines of the features on the page, the tab's search parameters,
    and an honest "couldn't read this layout" state. It reads the page with selectors that are
    signed data, updatable without an app release.
  - **Visibility**, which on request fetches the page as Googlebot, Bingbot and AI crawlers fetch it,
    beside a normal browser, and marks the differences.

  An optional on-device intent classifier labels queries with its confidence; its model is
  downloaded only after you agree. The plan and how it was built:
  [`docs/plans/phase-3-serp-intent.md`](docs/plans/phase-3-serp-intent.md).
- **Phase 4 — Accounts, entitlements, telemetry and Search Console:** built. Sign in to a frost
  account through the system browser, confirmed in the app; a signed snapshot arrives that main
  verifies, with offline grace. frost is free and open source (2026-10-29): only sync needs an account;
  the AI agent and Search Console work signed out. Telemetry (usage
  traces and error reports) is off by default, scrubbed, and does what its two switches say. A
  read-only Search Console connection feeds a page and site performance panel, and a Settings view
  holds all of it. The account API is a lean backend (`apps/backend`) that runs locally and in tests
  only. The plan and how it was built:
  [`docs/plans/phase-4-accounts-telemetry.md`](docs/plans/phase-4-accounts-telemetry.md); the
  backend: [`apps/backend/README.md`](apps/backend/README.md).
- **Phase 5 — AI agent:** built. A sidebar agent that audits and operates the browser, in a
  utility process of its own that holds no keys: main makes every model request (your own
  Anthropic or OpenAI key, or the Vercel AI Gateway; keys stay in the OS keychain). Read-only tools
  run on a standing grant; navigate, click and visibility probes ask unless granted for the site;
  `execute_javascript`, AI search and MCP tools ask every time, and tool output reaches the model
  as untrusted data. SERP, intent, probes and Search Console come from Phases 3 and 4, and the
  agent is gated on the account's `ai-agent` flag. Skills, a grants page, chat retention and export,
  a context meter and MCP connections (labelled untrusted, sandboxed where the OS allows) round it
  out. The plan and how it was built: [`docs/plans/phase-5-ai-agent.md`](docs/plans/phase-5-ai-agent.md).
- **Phase 6 — Change intelligence:** built (Tasks 1–8). Per-page change history and visual evidence,
  kept locally, with explicit retention controls:
  - **Changes** (a sidebar panel) captures what a page says to search engines. Each distinct state
    becomes an immutable version, recorded with its render profile and search parameters, and a
    readable diff shows what changed, by region: head, HTTP, structured data, main content,
    navigation, header, sidebar, footer.
  - **Screenshots** of the viewport, a selected area or the whole page (stitched as it scrolls),
    stored by content hash in the profile directory.
  - **Projects** group pages and searches. Capture now visits each one in a tab of its own.
  - **Retention:** keep the last N versions or N days per project, Purge now with a preview,
    measured disk usage, and a purge log.
  - **Inspector** (a sidebar panel): a read-only DOM tree and element picker.

  The database refuses changes to captured rows; they are removed only by a recorded purge. The
  plan, its schema and how it was built:
  [`docs/plans/phase-6-change-intelligence.md`](docs/plans/phase-6-change-intelligence.md).
- **Phase 7 — Cross-platform packaging, signed auto-update and sync groundwork:** built. Linux
  (AppImage, deb, zip) and Windows (Squirrel installer, zip) packages beside the macOS one, each
  verified in CI; an Ed25519-signed, staged update manifest, with nothing downloaded or installed
  without a click (builds are unsigned, so updates install by hand); and a libSQL driver seam with
  the groundwork for opt-in sync of change intelligence. The plan and how it was built:
  [`docs/plans/phase-7-sync-update-platforms.md`](docs/plans/phase-7-sync-update-platforms.md).
- **Next:** finishing sync (the switch to turn it on, a worker thread, a real server), and code
  signing for macOS and Windows (`docs/design/IMPLEMENTATION-PLAN.md` §4).

## Clean-room note
frost is a **clean-room** build. It is designed from a written behavioral/design
spec authored by us, not from any third party's source. **This repository contains
no third-party code, bundles, or UI assets.** Third-party open-source libraries are used
only as dependencies under their own licenses (see `apps/desktop/THIRD_PARTY_NOTICES`).

## Layout
- `apps/desktop/` — the Electron app (main, preload, the React chrome, the on-device intent utility
  process), packaged with Electron Forge.
- `apps/backend/` — the account API (`@app/backend`): web and desktop sign-in, signed entitlement
  snapshots and an admin CLI. Hono, better-auth and Drizzle on Postgres (PGlite in dev and tests).
  Never deployed from this repo.
- `packages/seo-core/` — the SEO audit engine (`@app/seo-core`): the rule catalog's checks, the
  health score, the schema, robots.txt, hreflang, page speed and security readers, the content
  report, the served-vs-rendered comparison and the link, sitemap and hreflang check readers. Pure
  TypeScript, with no Electron, DOM or Zod dependency.
- `packages/change-intel/` — the change-intelligence diff engine (`@app/change-intel`): canonical
  JSON, snapshot identity, the region-tagged diff between two captures and word-level inline diffs.
  Pure TypeScript, like `seo-core`.
- `packages/db/` — the local database (Drizzle over `node:sqlite`): the browser session, history,
  pinned render profiles, content notes and app settings, and change intelligence's append-only
  captures, versions, diffs, screenshots, projects and purge log.
- `packages/ipc-contract/` — the typed tRPC IPC contract and its sender guard.
- `packages/telemetry/` — consent-gated telemetry (`@app/telemetry`): OpenTelemetry traces and Sentry
  error events behind a consent gate, with allowlists and scrubbing. Pure Node, no Electron import.
- `specs/` — machine-checkable spec artifacts (constants, Zod schemas, `*.feature.md` acceptance
  lists); every scenario maps to a named test.
- `docs/design/IMPLEMENTATION-PLAN.md` — the design doc (intent, stack, security model, 8-phase roadmap).
- `docs/plans/` — the executable, spec-driven phase plans (Phases 0–7).
- `semgrep/`, `security/`, `scripts/` — the CI security gates' rules, baseline and runner, and
  `scripts/sign-selectors.mjs` (`pnpm sign:selectors`, for maintainers signing a selector pack).

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

## License
Copyright (C) 2026 SnowOpsHQ.

frost is free software: you can redistribute it and/or modify it under the terms of the
**GNU Affero General Public License, version 3** (`AGPL-3.0-only`), as published by the Free
Software Foundation. See [`LICENSE`](LICENSE). It is distributed WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Bundled third-party libraries keep their own licenses; the packaged app ships their notices in
`THIRD_PARTY_NOTICES`. For a commercial license, contact SnowOpsHQ.
