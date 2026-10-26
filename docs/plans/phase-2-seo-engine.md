# Phase 2 — SEO Engine + Sidebar Implementation Plan

> **For agentic workers:** implement task-by-task, subagent-driven (a fresh implementer per task, a
> fresh reviewer before the next). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** frost's core value. Visiting a page produces a live SEO audit with a health score, shown in
a docked SEO sidebar next to the page: Overview, On-Page, Schema, Indexability, Page Speed and
Compliance panels.

**Architecture:**
- `packages/seo-core` (`@app/seo-core`) is pure TypeScript with no Electron or DOM dependency. It holds
  the `PageSnapshot` model, the rule catalog, and the health-score model.
- Main collects the snapshot for the active tab from three sources:
  - an extractor script we write, run in an **isolated world** (`executeJavaScriptInIsolatedWorld`) so
    the page's own scripts and CSP are never touched;
  - response metadata from the browse session (status, headers);
  - fetches main makes itself (robots.txt).
- Main validates the snapshot with Zod (it is untrusted page data, size-capped) and runs the rules.
  The chrome reads the audit through `enforceSender`-guarded procedures, like `browser.*`.
- The sidebar is part of the chrome (`app://app`). The page view shrinks to make room, so the
  page-area bounds mechanism from Phase 1 is unchanged.

**UI direction** (`docs/ui-reference/README.md`, our own design):
- The sidebar is collapsible; toggle with Cmd/Ctrl+Shift+S.
- A persistent panel rail shows each panel's status at a glance (pass / warn / error).
- Every panel follows one pattern: score → ranked issues (each with a short "why it matters" and
  "how to fix") → details.

**Tech Stack:** As Phase 1, plus `web-vitals` (Task 5) and `axe-core` (Task 6) as dependencies. Both
are open-source libraries the design names (§4 Phase 2). They are injected into the isolated world
only, never into the chrome.

## Spec-Driven Development protocol

As Phases 0–1:
- Every task first authors or updates `specs/` artifacts. Rules are specified as data: id, category,
  severity, the condition in prose, and why/fix text.
- Every rule has a named unit test with a passing and a failing fixture snapshot.

## Global Constraints

Everything in Phase 0–1's Global Constraints and `CONTRIBUTING.md` still holds, plus:
- **Clean-room.** Rule ids, wording, thresholds and scoring are frost's own, written from SEO first
  principles. Nothing is copied from any other product's rules, prompts or UI. Third-party
  libraries are used only as npm dependencies under their licenses: `web-vitals` (Apache-2.0) and
  `axe-core` (MPL-2.0, used unmodified).
- **Isolated extraction.** Extraction and measurement scripts run only via
  `executeJavaScriptInIsolatedWorld` with a dedicated world id. They never run in the main world, and
  never modify the page's DOM, CSP or globals. Pages cannot observe or tamper with them beyond
  ordinary DOM changes. One exception, on the user's request only: highlight mode (Task 2) appends a
  single host element of its own to `<html>`, holding its overlay in a closed shadow root styled
  through the CSSOM; it changes no page element, adds no stylesheet, and is removed when turned off,
  on navigation, when the tab changes, the sidebar collapses or its panel is left. The page can see
  (and remove) that host, never its contents.
- **Snapshot handling.**
  - Results are untrusted. Zod-validate them in main, with hard caps on counts and string lengths.
  - A page that returns garbage gets an "audit unavailable" state, not a crash.
- **The chrome renders page-derived strings as text only.** No HTML, no `innerHTML`, no URLs turned
  into clickable `href`s without `http(s)` validation. Links in panels open via `browser.*`
  procedures (navigate / new background tab), never `window.open` from the chrome.
- **Auditing must not break browsing.** It is debounced and skipped for background tabs. Each run is
  time-limited, and the page's performance must not degrade noticeably.

## Review Focus
- **A page that fights the extractor** must yield a bounded, validated snapshot or "unavailable" —
  never a hang, crash or main-thread stall. Covers a huge DOM, deep nesting, 100k links, a 10 MB
  title, prototype-polluted globals, and an overridden `document.querySelectorAll` in the main world
  (no effect on the isolated world). Task 1 (`hostile-page-snapshot-is-bounded`).
- **Page-derived text in panels is inert**: `<script>`, `javascript:` hrefs and bidi overrides in
  titles/alt text render as text, and their links are not clickable unless `http(s)`. Task 1
  (`page-text-is-inert-in-sidebar`).
- **SPA navigations** (`pushState`) re-audit the new URL, and stale results never show against the
  wrong URL. Task 1 (`audit-matches-current-url`).
- **robots.txt fetching** uses the browse session (cookies off), follows at most N redirects, caps its
  size, and never fetches non-`http(s)` URLs. Task 4 (`robots-fetch-is-bounded`).
- **Injected libraries** (web-vitals, axe) never run in the main world and are not page-visible.
  Tasks 5–6 (`measurement-runs-isolated`).

---

### Task 1: seo-core, extraction, sidebar shell, Overview + On-Page

**Files:**
- `packages/seo-core` with the `PageSnapshot` type plus Zod schema, a rule interface, ~25 on-page rules,
  and `scoreAudit()`.
- `specs/seo-snapshot.spec.ts`, `specs/seo-rules.feature.md`, `specs/seo-sidebar.feature.md`.
- Main: `apps/desktop/src/main/seo/{extract,auditor}.ts`; the extractor source is bundled as a string.
- Router: `seo.getAudit`. The audit version goes in tab state, so `browser.watch` wakes the chrome.
- Renderer:
  - sidebar shell with a rail;
  - Overview (score ring, counts, top issues);
  - On-Page panel (title/meta/headings outline/word count/canonical/robots meta/lang/viewport,
    link and image summaries).

**Rules (first set, frost's own wording and thresholds):**
- Title: missing, empty, multiple, too short or long (in characters; pixel width later), duplicated
  in H1 is OK.
- Meta description: missing, too short or long, multiple.
- H1: missing, multiple, empty.
- Heading hierarchy skips a level.
- Canonical: missing, multiple, relative, points off-host (info), conflicts with `og:url` (info).
- Meta robots: `noindex` / `nofollow` present (warn).
- `lang` missing.
- Viewport meta missing.
- Thin content (word count below threshold).
- Images: missing alt (count), alt too long.
- Links: empty anchor text, `javascript:` hrefs, `nofollow` count (info).
- URL hygiene: length, uppercase, underscores, query parameters on canonical.

**Health score:** weighted by severity (error/warn/info), normalised 0–100, documented in the spec.

- [x] Spec → red → green → commit `feat(seo): seo-core, isolated extraction and the SEO sidebar`

### Task 2: On-Page detail — Links, Images, Social

- Links table: internal/external/nofollow/sponsored/ugc, anchor text, and target. Filters; copy as
  CSV via the main-process clipboard.
- Images table: src, alt, dimensions, lazy-loading, oversized-for-display.
- Social: Open Graph and Twitter card fields, required-field rules, and a preview card rendered by
  frost from text fields. Remote images are shown only if `http(s)`, loaded through the browse
  session, and are not tracking-capable from the chrome. Decide: show the image URL only, or proxy it.
- Highlight mode: an isolated-world overlay outlining links by type and the heading outline on the page,
  toggled from the panel. It is removed cleanly.
- Decisions (`specs/seo-panels.feature.md`): CSV and "Copy URL" are written by main
  (`seo.copyLinksCsv`, `seo.copyUrl`: only what the audit lists); remote images are never loaded
  into the chrome (URL, declared size and a placeholder; a proxied thumbnail could come later); the
  overlay lives in a closed shadow root styled through the CSSOM, so a page's CSP does not affect it;
  links open through `browser.openBackgroundTab` (`http(s)` only).
- [x] commit `feat(seo): links, images, social and highlight mode`

### Task 3: Schema panel

- Extract JSON-LD (parse defensively; size caps), microdata and RDFa-lite into a normalised tree.
- Validation: JSON syntax errors; `@context`/`@type` present; frost's own required/recommended property
  sets for common types (Organization, WebSite, BreadcrumbList, Article, Product, FAQPage, LocalBusiness,
  Event, Recipe, VideoObject).
- Tree UI with per-node issues.
- [ ] commit `feat(seo): schema extraction and validation`

### Task 4: Indexability panel

- Main-frame response status and headers from the browse session (`webRequest.onCompleted` /
  `onHeadersReceived`, recorded per tab and main-frame request), including `X-Robots-Tag`.
- robots.txt: fetch and parse with our own parser (groups, Allow/Disallow, wildcards, `$`, longest-match
  precedence, Sitemap lines). Verdict for the current URL for Googlebot and `*`.
- Combined indexability verdict: status code, meta robots, X-Robots-Tag, canonical-to-self, and
  robots.txt.
- hreflang: extraction plus basic validation (self-reference, x-default, valid codes; reciprocity is
  out of scope).
- Quick actions: open robots.txt or the sitemap in a new tab.
- [ ] commit `feat(seo): indexability panel`

### Task 5: Page Speed panel

- Inject `web-vitals` into the isolated world.
  - Report LCP, CLS, INP (on interaction), FCP and TTFB.
  - Use a buffered `PerformanceObserver` so late attachment works; document any metric limits.
- Resource summary from the Performance API: requests and transfer bytes by type, and the largest
  resources.
- Thresholds (good / needs improvement / poor) as spec constants, with rules feeding the health score.
- [ ] commit `feat(seo): page speed panel`

### Task 6: Compliance panel

- Security: HTTPS, mixed content (from the snapshot), and security headers (CSP, HSTS,
  X-Content-Type-Options, frame protection, Referrer-Policy, Permissions-Policy) from Task 4's
  response headers.
- Accessibility: run `axe-core` in the isolated world on demand (button) with a time cap. Group the
  violations by impact; each node is shown as a text selector.
- [ ] commit `feat(seo): compliance panel`

### Task 7: Release check

- Mac package `verify:mac`, full e2e on macOS and Linux, Mac screenshots of each panel on real pages,
  README and plan updates.
- [ ] commit `docs: phase 2 seo engine`

## Self-review notes
- **Deliverable (design §4 Phase 2):** a `seo-core` rule engine (Tasks 1–6); isolated-world extraction
  (1); CWV (5) and a11y (6) adapters; On-Page / Schema / Speed / Compliance panels (1–6); a health
  score (1).
- **Out of scope:** SERP overlay, intent, AI readiness (Phase 3); raw-vs-rendered JavaScript diff;
  GSC; change history (Phase 6).
