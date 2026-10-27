# SEO Browser — Clean-Room Rebuild · Implementation Plan

> A functionally-similar "SEO browser with an AI agent," rebuilt from the architecture and
> lessons from a private analysis of an existing product — **not** from its code, bundle, or branding. The security
> and privacy gaps we found are designed out from the start, not inherited.

Status: **draft for approval** · nothing is built until this is signed off.

---

## 1. Intent

Build a desktop Chromium-based browser with a docked SEO analysis sidebar, a local
change-history store, and an AI agent that can drive the browser and run SEO skills. Match the
*capabilities* of the analyzed product while improving on its security, privacy, and data posture.

**Goals**
- A browser where visiting a page produces live on-page SEO, schema, performance, accessibility,
  indexability and AI-visibility analysis.
- An AI agent that can audit pages, run SEO skills, and operate the browser under explicit approval.
- Local-first data with an upgrade path to sync; honest, consent-gated telemetry.

**Non-goals (v1)**
- Windows/Linux builds (macOS-first; architecture stays cross-platform).
- The built-in VPN (deferred; it's a distinct product with its own infra/legal surface).
- Server-side rank-tracking/crawling infrastructure beyond what the desktop app needs.

**Anti-goals (a failure even if it ships)**
- Any website being able to launch OS apps/files, reach privileged IPC, or forge entitlements.
- Telemetry UI that doesn't match telemetry behavior; "anonymous" that isn't.
- Copying proprietary code, prompts, or trademarks from the analyzed app.

---

## 2. How it's built (decisions — my calls; override any)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron (latest stable)** + Electron Forge | Proven for this exact app shape; WebContentsView tabs. |
| Language/UI | **TypeScript + React** | Matches the domain; large ecosystem. |
| Monorepo | **pnpm workspaces + Turborepo** | Desktop app, shared packages, backend in one repo. |
| IPC | **tRPC v11 + Zod** over a small in-repo link in `@app/ipc-contract` (one `ipcMain.handle` channel `app:trpc`; preload `exposeIpcBridge()` → `window.frostIpc.invoke`), every procedure typed, one central `enforceSender` middleware | Root-cause fix for the IPC/sender findings. In-repo because electron-trpc supports tRPC v10 only, and trpc-electron crashes main on a null `senderFrame`. |
| Data | **SQLite + Drizzle**: Node's built-in **`node:sqlite`** now (Phase 1), **libSQL** when sync lands (Phase 7) | Local-first now; sync later with no rewrite. `node:sqlite` (`DatabaseSync`, in Electron's main-process Node) ships no native binary, so packaging, ASAR integrity and the fuses are untouched; libSQL's native `.node` module would need unpacking from the ASAR. Drizzle (schema + queries, over its `sqlite-proxy` driver) and an async repository API make the move to libSQL a driver swap. |
| AI | **Vercel AI SDK** + **AI Gateway** (`provider/model` strings); agent loop in a locked-down utility process | Provider-agnostic, observable, no shipped keys. |
| On-device ML | **ONNX Runtime native** with Core ML EP (Apple Silicon) | SERP intent classifier; faster/lower-power than WASM. |
| Backend | **Separate service**: API + **better-auth** + Postgres; billing via Stripe (server-side) | Keep entitlement enforcement off the client. |
| Telemetry | **OpenTelemetry** → one consent-gated exporter; errors via Sentry with `beforeSend` gate | Honest, centralized, opt-in. |
| Secrets/entitlements | OS keychain (safeStorage) for tokens; **signed** entitlement snapshots (KMS/JWT) | Fixes the unsigned-cache finding. |

---

## 3. Architecture

```
apps/
  desktop/            Electron app (main, preload, renderer)
    main/             window + tab lifecycle, typed-IPC routers, security policy
    preload/          minimal typed bridge (NO raw ipc passthrough)
    renderer/         React UI: browser chrome + SEO sidebar
    workers/          seo-dom mirror, embedding, audit injection
  agent-runtime/      AI agent utility process (tools, skills, approvals)
  backend/            API + better-auth + billing (separate deploy)
packages/
  seo-core/           audit rules engine, schema/CWV/axe adapters (pure, testable)
  ipc-contract/       Zod schemas + tRPC routers shared by main/preload/renderer
  db/                 Drizzle schema + migrations (change-intelligence model)
  ai-skills/          declarative SEO skills + tool definitions
  telemetry/          consent-gated OTel/Sentry wrapper
  ui/                 design system
```

**Security model (baked in, not bolted on)**
- `setWindowOpenHandler`: always deny (no Electron window is ever created). Only `http/https/mailto`
  are allowlisted, and only on a real, unconsumed user gesture: in the app's own windows such a
  popup opens externally (`mailto:` without attachment keys); in a browser tab an `http(s)` popup
  becomes a background tab and a popup never opens an external handler (a tab reaches `mailto:`
  only by a main-frame navigation on a gesture). Everything else is dropped outright, with no
  confirmation dialog to click through (stricter than an allow-on-confirm flow). (Directly closes
  the confirmed High finding.)
- Every `WebContentsView`: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`,
  `webSecurity:true` set **explicitly**; cookie-encryption fuse on.
- `will-navigate` guard pins the app frame to its own `app://` origin.
- Permissions **deny-by-default**; prompt per-permission, per-origin.
- Audit scripts run in an **isolated world** so we never weaken a visited page's CSP; our own
  `app://` pages get a strict CSP + Trusted Types.
- Deep-link login requires an in-app confirmation bound to a nonce/pending request.
- Agent `execute_javascript` and MCP command servers run under per-call approval and an OS sandbox
  profile; no shell/file/fetch tools by default.

---

## 4. Phased roadmap

Each phase is independently demoable and ends with tests + a security check (Electronegativity +
Semgrep ipc rules + a Playwright `openExternal` regression test) in CI.

**Phase 0 — Foundations (skeleton)**
- Monorepo, Electron Forge, typed-IPC contract package, security policy module, CI with the security
  scanners wired from commit #1. Deliverable: a hardened empty browser window + one typed IPC call.

**Phase 1 — Browser core**
- Tabbed browsing (WebContentsView), address bar, session partition, navigation guards, permission
  prompts, local browser-session DB. Deliverable: a usable, hardened browser.

**Phase 2 — SEO engine + sidebar (the core value)**
- `seo-core` rule engine; isolated-world extraction of meta/headings/links/schema; Core Web Vitals
  (web-vitals) and accessibility (axe) adapters; On-Page / Schema / Speed / Compliance panels.
  Deliverable: visit a page → live audit with a health score.

**Phase 2.5 — SEO tooling depth**
- Per-tab render profiles (device, user agent, network, JavaScript/cache switches) recorded with every
  audit; served-HTML vs rendered-DOM comparison; content analysis (n-grams, readability, pixel widths,
  target query) and a search-snippet editor; a keyboard command palette; an SEO devtools drawer
  (network, redirects, console, storage, issues); browser polish (find in page, reopen closed tab,
  history, choice of search engine); bounded link-status and sitemap checks. Deliverable: the
  day-to-day SEO toolkit around the audit.

**Phase 3 — SERP + intent + indexability**
- SERP overlay with remotely-configured (signed) selectors: result composition, page-1 ownership by
  domain, feature outlines on the page, visible per-tab search parameters, and honest "couldn't read
  this layout" states; on-device embedding + intent classifier (ORT) with its confidence shown;
  indexability/AI-readiness probes (bot user-agents). Deliverable: SERP and visibility panels.

**Phase 4 — Accounts, entitlements, telemetry**
- Backend API + better-auth; signed entitlement snapshots with offline grace; consent-gated
  OTel/Sentry with working Settings toggles. Search Console connection (read-only OAuth scope, tokens in the OS
  keychain and main only) with a page/site performance panel. Deliverable: sign-in, plan gating, honest telemetry.

**Phase 5 — AI agent**
- Agent runtime utility process; Vercel AI SDK via Gateway; tool set (page audit/data/text, SERP,
  navigate/click, run-ai-search, GSC) with the approval + sandbox model; declarative SEO skills;
  user-governed customisation (skills editor, MCP connections labelled untrusted, a page to review and
  revoke standing grants, chat export/retention, a context meter).
  Deliverable: an agent that audits and operates the browser safely.

**Phase 6 — Change intelligence**
- Append-only capture/version/diff schema (immutability via triggers); region/context tagging;
  Changes panel; local-first screenshots (viewport, area, full page) and projects that group pages and
  queries, each capture recording its render profile and search parameters; a DOM inspector.
  Deliverable: per-page change history and visual evidence with explicit retention controls.

**Phase 7 — Sync & polish (optional)**
- libSQL/local-first sync of change-intelligence; auto-update (signed, staged); cross-platform.

---

## 5. Testing & quality gates
- Unit: `seo-core` rules and diff logic (pure, high-coverage).
- Integration: typed-IPC round-trips with sender-validation assertions.
- E2E (Playwright/CDP): the `openExternal` deny test, permission prompts, agent approval flow.
- Security CI: Electronegativity + Semgrep (every `ipcMain.handle` must carry a sender guard).

---

## 6. Open decisions (genuinely yours — don't need them to start Phase 0)
1. **Product intent**: shippable product vs. internal tool — changes how much Phase 4/backend we build.
2. **AI model routing**: our own proxied credits (like the original) vs. user bring-your-own-key.
3. **Backend build-vs-buy**: Payload CMS (fast) vs. a lean custom API (lighter, more control).
4. **VPN**: in or out of scope long-term.
5. **Monetization**: whether Phase 4 billing is needed for v1.

None block the early phases; Phases 0–3 are the same regardless.
