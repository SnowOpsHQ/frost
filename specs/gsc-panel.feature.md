# Feature: the Search Console performance panel

Spec: `specs/gsc-panel.spec.ts` (Zod-free: `GSC_PANEL_METRICS`, `GSC_METRIC_LABELS`, `GSC_LOWER_IS_BETTER`,
`GSC_SCOPE_LABELS`, `GSC_RANGE_MONTHS`, `GSC_RANGE_PRESETS`, `GSC_RANGE_PRESET_LABELS`, `gscPresetRange`,
`GSC_PANEL_DEFAULTS`, `GSC_RANGE_TEXT`, `GSC_FILTER_TEXT`, `GSC_DEVICE_LABELS`, `GSC_DEVICE_ORDER`,
`GSC_CALENDAR`, `GSC_CHART`, `GSC_PANEL_STATES`, `GSC_PANEL_ACTIONS`, `GSC_PANEL_COPY`, `GSC_PANEL_TEXT`,
`GSC_READING_STATES`, `GSC_REASON_STATES`), reading the API of `specs/gsc.spec.ts` / `specs/gsc.schema.ts`
(`gsc.watch`, `gsc.performance`, `gsc.topQueries`, `gsc.countries`, `gscDateRange`, `gscRetentionStart`,
`gscCustomRange`, `GSC_COUNTRY_ALPHA3`, `GSC_DEVICES`). The rail entry is `SEO_PANELS`' `search-console`
(`specs/seo-sidebar.spec.ts`); its palette jump is in `FEATURE_PANEL_JUMPS` (`specs/command-palette.spec.ts`).
Phase 4 Task 10; ranges, filters and the calendar Phase 9 Task 3 (SL-040). Each line maps to one named test.

## Decisions
- **A rail panel without rules.** `search-console` has no audit categories, so its rail item has no
  status dot (neutral), the sidebar's "Run the audit again" button and "Audited …" footer are hidden on
  it (they describe the audit, not this panel), and it does not wait for the page's audit: it shows its
  own states for every tab, pending or not.
- **No account, no plan (2026-10-29).** Search Console is free and needs no frost account
  (`UNGATED_FEATURES`), so the panel does not read `account.watch` and has no sign-in or plan states.
  It reads `gsc.watch` (configured, connected) first and sends no read until the build has a Search
  Console client, a Google account is connected and the tab shows an `http(s)` page. Until the watch
  answered it is `loading`. No client in this build: the unconfigured words; not connected: Connect in
  Settings (Search Console section), or, when main ended the connection because Google refused it
  (`error: 'auth-expired'`), Reconnect in Settings. `entitled` (always true from main) is not read, and
  a `not-entitled` answer (which main never sends) shows the unconfigured words. The panel never starts
  a connection itself: that needs the click in Settings.
- **What it reads.** For the active tab's URL (its fragment dropped) and the chosen scope — **This page**
  (`page`) or **Whole property** (`property`, naming the matched property's `siteUrl`) — and range (7, 28 or
  90 days, or a longer range below): `gsc.performance` (per-day rows and totals) and `gsc.topQueries`, both
  at once, with the country and device filters. Totals are main's (CTR clicks / impressions, position
  impression-weighted). Scope, range, custom dates, metric and filters hold while the chrome runs
  (`GSC_PANEL_DEFAULTS` at start: no filters) and are shared by every tab.
- **Ranges (Phase 9).** The day presets (7, 28, 90) stay buttons and read as `days`, as before. "More
  ranges…" (a select) offers "Last 3 months", "Last 6 months", "Last 12 months" and "Last 16 months"
  only, and a "Custom range…" button (`aria-haspopup="dialog"`, `aria-expanded`; it shows the dates once
  a custom range is set) opens the calendar. No select option opens a dialog: moving through a closed
  select with the arrow keys fires `change` in Chromium on Windows and Linux (WCAG 3.2.2). A month preset reads as a `range` from `gscPresetRange`: it ends on the lag day and starts
  that many calendar months before it; "Last 16 months" starts at `gscRetentionStart`, so it always
  fits `GSC_MAX_RANGE_DAYS`. The custom range applies only once both days
  are picked (Cancel or Escape keep the last range). A custom range is clamped to the calendar's days
  (`gscRetentionStart` to the lag day) when it is read, so a chrome left open for days never sends one
  main refuses.
- **Filters (Phase 9).** A country select (only the countries `gsc.countries` answered for the page or
  property, range and device; "All countries" first, then by name) and a device select ("All
  devices", Desktop, Mobile, Tablet). A country is named with `Intl.DisplayNames` through
  `GSC_COUNTRY_ALPHA3`; a code Google answers without a name there (`zzz`, `xkk`) is shown as is, in
  capitals. The chosen country stays listed even when a new list lacks it. "Clear filters" shows only
  while a filter is set and resets both, keeping the scope and range; so does the palette's "Search
  Console: clear filters". The `gsc.countries` read uses the same page, scope, range and device but no
  country (main ignores it there), so choosing a country does not read the list again. With a filter
  set, the `no-data` notice says "with these filters".
- **The calendar (Phase 9)** is `GSC_CALENDAR`: a modal dialog popover with the WAI-ARIA date picker
  dialog's keyboard model (roving tabindex in a `grid`, arrows, Home/End, PageUp/PageDown and their
  Shift years, Enter/Space picks, Escape closes and returns focus to what opened it; Tab stays inside
  the dialog). The week starts on the locale's first day. Days before `gscRetentionStart` and after the
  lag day are `aria-disabled` and cannot be picked or focused; picked days are `aria-selected`. Drawn
  with classes only (no `style=`).
- **When it reads.** Only while the panel is open (the sidebar shows it); again when the URL (without
  fragment), the scope, the range, a filter or the connection changes — `GSC_READ_DEBOUNCE_MS` after the last
  change, so a page that rewrites its URL while it loads reads once — and at once on Retry. Never on a
  timer: main's 15-minute cache makes going back cheap. An answer for an earlier request (the URL
  changed meanwhile) is dropped, never shown. While a new scope or range of the same page reads, the
  last data stays shown, dimmed (`aria-busy`); another page or connection shows the loading state.
- **The chart is frost's own SVG**, drawn with attributes (no `style=`): one line for the chosen metric
  over every day of the range, a few "nice" y ticks (1, 2 or 5 × 10ⁿ apart; compact labels such as 1.5M),
  the first, middle and last dates on the x axis (by month, `Jul 2025`, when the range is over
  `GSC_CHART.monthTicksAfterDays` days; up to 490 days, every point inside the plot). Ticks are evenly spaced (position's from 1 up) and
  labelled with the decimals their step needs, so no two read alike (CTR below 1% has two decimals).
  Google omits a day without impressions, so clicks and impressions count a missing day up to the last
  answered day as 0; days after the last answered day have no data yet (final data can lag more than two
  days): the line ends there. CTR and position have no value on a missing day, so their line breaks. A
  lone value is a dot. Position is "lower is better": its axis is inverted (the best position at the top).
  Accessible: `role="img"` with an `aria-label` summary (metric, range, total or average, data through
  the last day when it ends early, and a best day — for CTR and position only among days with at least
  `GSC_RATE_HIGHLIGHT_MIN_IMPRESSIONS` impressions) and a visually hidden table of the answered days with
  a short caption (no duplicate SVG `<title>`).
- **Freshness.** Every data state says "Search Console data lags about two days; range <start> – <end>"
  from `gscDateRange(days, now)` (the answer's own range once it is there), adding ", data through
  <last>" when the answered days end before the range does; the totals then say "Through <last>". CTR
  below 1% shows two decimals.
- **Motion.** The panel's entrance and the dimming honour `prefers-reduced-motion`.
- **Renderer constraints.** Strict CSP and Trusted Types: no `style=`, no Zod (types only from
  `*.schema.ts`; values from the Zod-free specs). Its own stylesheet (`gsc-panel.css`). Queries and the
  property's `siteUrl` are inert, bidi-isolated text.

## Chart (`apps/desktop/src/renderer/__tests__/gsc-chart.test.ts`)
- `chart-nice-ticks` — y ticks are 1, 2 or 5 × 10ⁿ apart, cover every value, start at 0 for counts, and are at most `GSC_CHART.maxYTicks`; no two labels alike (tiny CTR and position steps included).
- `chart-empty-range` — no rows: no line, no dots, a zero tick, and the summary says there is no data.
- `chart-single-point` — one answered day of CTR: a dot at its date, no line.
- `chart-days-filled-and-gaps` — clicks fill unanswered days inside the answered span with 0; days after the last answered day have no value (the line ends there); CTR breaks its line at an unanswered day.
- `chart-position-inverted` — position's best (lowest) value is drawn at the top; its ticks are evenly spaced positions of at least 1.
- `chart-large-numbers` — values in the millions get compact tick labels and stay inside the plot.
- `chart-ctr-percent-ticks` — CTR ticks are percentages, with two decimals below 1%.
- `chart-x-ticks` — the first, middle and last dates of the range, as short UTC dates.
- `chart-long-range-ticks` — a 490-day range keeps every point and tick inside the plot, its x ticks are still the first, middle and last days, and over 90 days they are labelled by month (`Jul 2025`); at 90 days, by day.
- `chart-summary` — the label names the metric, the range, the total (counts) or average (CTR, position), the last answered day when it ends early, and the best day (CTR and position: only a day with enough impressions; else none).

## View model (`apps/desktop/src/renderer/__tests__/gsc-view.test.ts`)
- `format-metrics` — counts with separators (compact from a million), CTR as a percentage with one decimal (two below 1%), position with one decimal, no position as "—".
- `format-freshness` — the freshness note from `gscDateRange` (dates as "Sep 29, 2026"), with "data through <last>" when the rows end early.
- `gate-before-reading` — each `gsc.watch` value (not answered, unconfigured, not connected, connecting, a connection ended with `auth-expired` …) gives its state, words and button, and a read only when configured, connected and on a web page, whatever `entitled` says; no state, word or button is about an account or a plan.
- `answer-states` — each unavailable reason gives its state, words and button (`not-entitled` the unconfigured words; `no-property` names the host); `ok` without impressions is `no-data`; with data, the four tiles.
- `controls-only-when-reading` — the scope and range controls show in the reading states only (loading, data, no data, quota, network, invalid).
- `property-scope-names-site` — the whole-property choice names the answered property's `siteUrl`.
- `request-key` — the request ignores the fragment; the URL, scope, range or connection give a new one (filters: `filters-in-request-key`).
- `stale-answer-ignored` — an answer for an earlier request is dropped; a retry asks again for the same one; the last `ok` data of the same page and connection is kept (as pending) while another scope or range reads.
- `pending-keeps-data` — while a scope or range read runs, the last data shows (state `data`, pending) with the new choices; tiles say "Through <last>" when the rows end early.
- `prefs-store` — scope, range, custom dates, metric and filters start at `GSC_PANEL_DEFAULTS` (no filters) and notify subscribers when they change; custom dates are kept only with the `custom` range, which needs them.
- `presets-to-ranges` — 7, 28 and 90 read as `days`; each month preset reads as a range that ends on the lag day and starts that many calendar months earlier (`16m` at `gscRetentionStart`); every one is accepted by `gscCustomRange` and fits `GSC_MAX_RANGE_DAYS` on every day across two years (a leap February included).
- `custom-range-bounds` — the calendar's days run from `gscRetentionStart` to the lag day; a picked range out of order swaps; a stored range that the clock moved past is clamped into the bounds when read (accepted by `gscCustomRange`); the `no-data` words name the range.
- `filters-in-request-key` — a country or device gives a new request key and goes into the query (none: no key sent); the countries read carries the device but never the country; the store keeps them.
- `clear-filters` — clearing resets the country and device only (scope, range and metric stay), notifies once, and the view says whether a filter is set (the button's condition).
- `country-names-from-alpha3` — `usa` is "United States" (through `GSC_COUNTRY_ALPHA3` and `Intl.DisplayNames`); a code without a name (`zzz`, `xkk`) or without `Intl.DisplayNames` is the code in capitals; options are sorted by name, each once, and the chosen country stays listed.
- `rail-has-no-dot-without-rules` — the Search Console rail item has no status dot, even with failing findings.

## Reading (`apps/desktop/src/renderer/__tests__/use-gsc-data.test.ts`, jsdom)
- `use-gsc-data-reads-on-change` — one performance and one top-queries read per request, `GSC_READ_DEBOUNCE_MS` after the last change (quick changes read once); again on URL, scope or range change; never on a timer; nothing without a request.
- `use-gsc-data-drops-stale-answers` — an answer that lands after the URL changed is not shown; the current one is.
- `use-gsc-data-retry` — Retry reads the same request again, at once.
- `filters-trigger-one-read` — a country or device change sends one performance and one top-queries read with the filter (after the debounce); a device change reads the countries again (with the device), a country change does not; the countries answer is kept for the page while a new one reads.
- `use-gsc-data-keeps-data-for-scope-change` — a scope or range change keeps the last data as pending; another URL does not.

## Panel (`apps/desktop/src/renderer/__tests__/gsc-panel.test.ts`, jsdom, IPC faked)
- `gsc-panel-reads-only-when-connected` — not connected, the panel shows its notice and never calls `gsc.performance`, `gsc.topQueries` or `gsc.countries` (nor `account.watch`); connected, signed out of frost, it reads once (and its countries once).
- `custom-range-only-from-its-button` — the range select lists the month presets only, and a `change` to any of them applies it without opening the calendar; the "Custom range…" button (a dialog popup, `aria-expanded`) opens it with focus inside, and Escape closes it with focus back on the button.

## Palette (`apps/desktop/src/renderer/__tests__/gsc-palette.test.ts`)
- `gsc-palette-actions` — "Open Search Console panel" (the panel's jump, in `FEATURE_PANEL_JUMPS`: the built-ins leave it out) opens the panel and focuses its rail item; "Search Console: whole property" and "Search Console: this page" set the scope and open the panel, each offered on a web page while the other scope is chosen.
- `gsc-palette-clear-filters` — "Search Console: clear filters" is offered on a web page only while a filter is set; it clears both and opens the panel.

## Calendar (`apps/desktop/src/renderer/__tests__/gsc-calendar.test.ts`, jsdom)
- `calendar-keyboard` — a modal dialog with a grid; one day is tabbable (roving tabindex) and focused on open; arrows move a day and a week, Home/End to the week's ends (the locale's week start), PageUp/PageDown a month, Shift a year; Enter picks the start (`aria-selected`), Space the end, which applies the range (swapped when picked backwards) and closes; Escape closes without a change and returns focus to the opener; the month buttons keep focus unless they disable (then the day takes it); Tab wraps inside the dialog.
- `calendar-disables-unavailable-days` — days before `gscRetentionStart` and after the lag day are `aria-disabled`, never tabbable, not picked by a click, and keys stop at the bounds; the month buttons are disabled at either end.

## End to end (`apps/desktop/e2e/gsc-panel.e2e.ts`; fake `fake-google.ts`; never signed in to frost)
One documented serial sequence (not connected, then connected); each test after connecting sets the
scope, range, metric and fake rows it needs itself.
- `gsc-panel-not-connected` — signed out of frost, on a loopback page: the connect prompt; its button opens Settings on Search Console; the rail item has no dot, and neither the rerun button nor the audit footer shows (Overview has both); nothing reached the fake Google.
- `gsc-panel-page-totals-and-chart` — connected (through Settings' Connect), the page on the loopback site matched to its URL-prefix property: the totals and the chart's table are the fake rows, the line ends at the last answered day, the totals and the freshness note say "through" it, and the read was the page filter.
- `gsc-panel-property-scope` — Whole property names the property's `siteUrl`, shows the property's totals and reads without a page filter.
- `gsc-panel-range-change` — 7 days sends one new read over the 7-day range, keeping the last data shown (dimmed: `data-pending`) until it answers (the fake holds the read until the test releases it, `holdQueries`, so the check never races a fast answer).
- `gsc-panel-top-queries` — the top queries table lists the fake queries, most clicks first.
- `gsc-panel-position-inverted` — the position metric draws the inverted axis.
- `gsc-panel-no-property-and-not-web` — a host no property covers says so with the host; a non-web tab says only web pages have data.
- `gsc-panel-palette-whole-property` — the palette's "Search Console: whole property" opens the panel on the property scope.
- `gsc-panel-custom-range` (Phase 9) — "Custom range…" opens the calendar (`aria-expanded`, focus inside) and reads nothing; picking two days of the month before the lag day's applies them, closes it with focus back on the button (now "Change dates", `data-active`), unpresses the day presets and sends one read over exactly those days.
- `gsc-panel-16m-preset` (Phase 9) — "Last 16 months" in the range select applies at once (no calendar) and sends one read from `gscRetentionStart` to the lag day (`gscPresetRange('16m')`).
- `gsc-panel-country-device-filters` (Phase 9) — the country select names the countries the fake answered (in name order); a country sends one performance and one top-queries read with it (the countries are not read again), a device one of each more and the countries again with the device; the fake's echo (`fakeFilterEcho`: a country halves, a device fifths the clicks and names itself in the queries) shows in the totals and queries, and the chosen country stays chosen.
- `gsc-panel-clear-filters` (Phase 9) — "Clear filters" resets both (not the scope or range), goes away with focus on the country select, and the unfiltered answer is back, any read for it made without a country or device.
