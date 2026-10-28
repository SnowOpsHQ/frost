# Feature: the Search Console performance panel

Spec: `specs/gsc-panel.spec.ts` (Zod-free: `GSC_PANEL_METRICS`, `GSC_METRIC_LABELS`, `GSC_LOWER_IS_BETTER`,
`GSC_SCOPE_LABELS`, `GSC_PANEL_DEFAULTS`, `GSC_CHART`, `GSC_PANEL_STATES`, `GSC_PANEL_ACTIONS`,
`GSC_PANEL_COPY`, `GSC_PANEL_TEXT`, `GSC_READING_STATES`, `GSC_REASON_STATES`), reading the API of `specs/gsc.spec.ts`
/ `specs/gsc.schema.ts` (`gsc.watch`, `gsc.performance`, `gsc.topQueries`, `gscDateRange`) and the account of
`specs/account-state.schema.ts` (`account.watch`). The rail entry is `SEO_PANELS`' `search-console`
(`specs/seo-sidebar.spec.ts`); its palette jump is in `FEATURE_PANEL_JUMPS` (`specs/command-palette.spec.ts`).
Phase 4 Task 10. Each line maps to one named test.

## Decisions
- **A rail panel without rules.** `search-console` has no audit categories, so its rail item has no
  status dot (neutral), and it does not wait for the page's audit: it shows its own states for every
  tab, pending or not.
- **Gated in the chrome as well as in main.** Search Console is a `pro` feature. The panel reads
  `gsc.watch` (configured, entitled, connected) and `account.watch` (signed in or not) first and sends no
  read until the build is configured, the plan includes `search-console`, a Google account is connected
  and the tab shows an `http(s)` page; main refuses the rest anyway (`not-entitled` before anything is
  sent). Signed out: "Search Console is part of frost Pro" and Sign in (Settings, Account); a free plan:
  the same title and Account settings; not connected: Connect in Settings (Search Console section). The
  panel never starts a connection or a sign-in itself: those need the click in Settings.
- **What it reads.** For the active tab's URL (its fragment dropped) and the chosen scope — **This page**
  (`page`) or **Whole property** (`property`, naming the matched property's `siteUrl`) — and range (7, 28 or
  90 days): `gsc.performance` (per-day rows and totals) and `gsc.topQueries`, both at once. Totals are
  main's (CTR clicks / impressions, position impression-weighted). Scope, range and metric hold while the
  chrome runs (`GSC_PANEL_DEFAULTS` at start) and are shared by every tab.
- **When it reads.** Only while the panel is open (the sidebar shows it); again when the URL (without
  fragment), the scope, the range or the connection changes, and on Retry. Never on a timer: main's
  15-minute cache makes going back cheap. An answer for an earlier request (the URL changed meanwhile) is
  dropped, never shown.
- **The chart is frost's own SVG**, drawn with attributes (no `style=`): one line for the chosen metric
  over every day of the range, a few "nice" y ticks (1, 2 or 5 × 10ⁿ apart; compact labels such as 1.5M),
  the first, middle and last dates on the x axis. Clicks and impressions count a day Google did not answer
  as 0; CTR and position have no value there, so their line breaks. A lone value is a dot. Position is
  "lower is better": its axis is inverted (the best position at the top). Accessible: `role="img"` with an
  `aria-label` summary (metric, range, total or average, best day) and a visually hidden table of the
  answered days.
- **Freshness.** Every data state says "Search Console data lags about two days; range <start> – <end>"
  from `gscDateRange(days, now)` (the answer's own range once it is there).
- **Renderer constraints.** Strict CSP and Trusted Types: no `style=`, no Zod (types only from
  `*.schema.ts`; values from the Zod-free specs). Its own stylesheet (`gsc-panel.css`). Queries and the
  property's `siteUrl` are inert, bidi-isolated text.

## Chart (`apps/desktop/src/renderer/__tests__/gsc-chart.test.ts`)
- `chart-nice-ticks` — y ticks are 1, 2 or 5 × 10ⁿ apart, cover every value, start at 0 for counts, and are at most `GSC_CHART.maxYTicks`.
- `chart-empty-range` — no rows: no line, no dots, a zero tick, and the summary says there is no data.
- `chart-single-point` — one answered day of CTR: a dot at its date, no line.
- `chart-days-filled-and-gaps` — clicks fill unanswered days with 0 (one line over the whole range); CTR breaks its line at an unanswered day.
- `chart-position-inverted` — position's best (lowest) value is drawn at the top and its ticks are positions of at least 1.
- `chart-large-numbers` — values in the millions get compact tick labels and stay inside the plot.
- `chart-ctr-percent-ticks` — CTR ticks are percentages.
- `chart-x-ticks` — the first, middle and last dates of the range, as short UTC dates.
- `chart-summary` — the label names the metric, the range, the total (counts) or average (CTR, position) and the best day.

## View model (`apps/desktop/src/renderer/__tests__/gsc-view.test.ts`)
- `format-metrics` — counts with separators (compact from a million), CTR as a percentage with one decimal, position with one decimal, no position as "—".
- `format-freshness` — the freshness note from `gscDateRange` (dates as "Sep 29, 2026").
- `gate-before-reading` — each `gsc.watch` / `account.watch` combination gives its state, words and button, and a read only when configured, entitled, connected and on a web page.
- `answer-states` — each unavailable reason gives its state, words and button (`not-entitled` told apart by the account; `no-property` names the host); `ok` without impressions is `no-data`; with data, the four tiles.
- `controls-only-when-reading` — the scope and range controls show in the reading states only (loading, data, no data, quota, network, invalid).
- `property-scope-names-site` — the whole-property choice names the answered property's `siteUrl`.
- `request-key` — the request ignores the fragment; the URL, scope, range or connection give a new one.
- `stale-answer-ignored` — an answer for an earlier request is dropped; a retry asks again for the same one.
- `prefs-store` — scope, range and metric start at `GSC_PANEL_DEFAULTS` and notify subscribers when they change.
- `rail-has-no-dot-without-rules` — the Search Console rail item has no status dot, even with failing findings.

## Reading (`apps/desktop/src/renderer/__tests__/use-gsc-data.test.ts`, jsdom)
- `use-gsc-data-reads-on-change` — one performance and one top-queries read per request; again on URL, scope or range change; never on a timer; nothing without a request.
- `use-gsc-data-drops-stale-answers` — an answer that lands after the URL changed is not shown; the current one is.
- `use-gsc-data-retry` — Retry reads the same request again.

## Palette (`apps/desktop/src/renderer/__tests__/gsc-palette.test.ts`)
- `gsc-palette-actions` — "Open Search Console panel" (the panel's jump, in `FEATURE_PANEL_JUMPS`: the built-ins leave it out) opens the panel and focuses its rail item; "Search Console: whole property" and "Search Console: this page" set the scope and open the panel, each offered on a web page while the other scope is chosen.

## End to end (`apps/desktop/e2e/gsc-panel.e2e.ts`; fakes `fake-backend.ts` (plan switchable), `fake-google.ts`)
- `gsc-panel-signed-out` — signed out, on a loopback page: "Search Console is part of frost Pro"; its button opens Settings on Account; the rail item has no dot; nothing reached the fake Google.
- `gsc-panel-free-plan` — signed in on a free plan: the same title, Account settings; still nothing reached the fake Google.
- `gsc-panel-not-connected` — on Pro without a Google account: the connect prompt; its button opens Settings on Search Console.
- `gsc-panel-page-totals-and-chart` — connected (through Settings' Connect), the page on the loopback site matched to its URL-prefix property: the totals and the chart's table are the fake rows, the freshness note names the range, and the read was the page filter.
- `gsc-panel-property-scope` — Whole property names the property's `siteUrl`, shows the property's totals and reads without a page filter.
- `gsc-panel-range-change` — 7 days sends a new read over the 7-day range.
- `gsc-panel-top-queries` — the top queries table lists the fake queries, most clicks first.
- `gsc-panel-position-inverted` — the position metric draws the inverted axis.
- `gsc-panel-no-property-and-not-web` — a host no property covers says so with the host; a non-web tab says only web pages have data.
- `gsc-panel-palette-whole-property` — the palette's "Search Console: whole property" opens the panel on the property scope.
