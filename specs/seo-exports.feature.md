# Feature: SEO exports and Copy SEO Data

Spec: `specs/seo-exports.spec.ts` (`SEO_EXPORT_KINDS`, `IMAGES_CSV_COLUMNS`, `HEADINGS_CSV_COLUMNS`,
`SPEED_CSV_COLUMNS`, `SPEED_CSV_SECTIONS`, `SEO_EXPORT_LABELS`), `specs/seo-exports.schema.ts`
(`SeoExportInputSchema`), `specs/page-commands.spec.ts` (`CONTEXT_MENU_LABELS['copy-seo']`,
`CONTEXT_MENU_COPY_SEO_VALUES`), `specs/command-palette.spec.ts` (`COPY_VALUE_KEYS`,
`COPY_VALUE_MAX_CHARS`) and `specs/seo-sidebar.spec.ts` (`CSV_FORMULA_PREFIXES`, `IMAGE_FILTERS`).
Phase 11 Task 1 (SL-013, SL-130; plan Decisions 1–2). Each line maps to one named test.

## Decisions
- **Main writes every copy and CSV from data it holds.** The chrome names the tab, the audit it shows
  (`SeoAuditRefSchema`: URL and `takenAt`), the kind and, for images, a filter. Main formats the CSV
  from the tab's **ready** audit, only if it is that audit, and writes Electron's `clipboard` in main.
  A stale ref, another tab, a pending or missing audit: nothing is written (`null`). The chrome never
  sends CSV text and never touches the clipboard. *Rejected:* the chrome building CSV and writing the
  clipboard (it has no clipboard permission, and main would trust a chrome string).
- **Cells are guarded.** Every cell goes through `csvCell`: a cell starting with a
  `CSV_FORMULA_PREFIXES` character gets a leading `'`; quoting per RFC 4180; `\r\n` line ends.
- **Speed is the audit's own report.** The speed CSV exports `audit.performance` (measured with the
  audit, bound by the same audit ref); `null` writes nothing. Exporting the live measurement is cut.
- **A router of its own.** `seoExport.copyCsv` lives in `packages/ipc-contract/src/seo-export-router.ts`
  (`enforceSender` first, `SeoExportInputSchema`), registered with one line beside the hub's `seo`.
- **The context menu holds no chrome ref.** Main builds Copy SEO Data from the clicked tab's ready
  audit at the click and remembers its URL and `takenAt`; an item runs only if the tab's ready audit is
  still that one (else nothing is written).
- **Bounded.** Very large values (outlines, header lists, link lists) are cut at `COPY_VALUE_MAX_CHARS`;
  CSV rows are bounded by the snapshot's own caps.

## Formatting (`packages/seo-core/src/__tests__/exports.test.ts`)
- **Scenario: images-csv-columns-and-filter** — the header is `IMAGES_CSV_COLUMNS`; one row per image
  the `IMAGE_FILTERS` value selects, in document order, with the documented cells.
- **Scenario: missing-alt-csv** — `missing-alt` writes only the images with no `alt` attribute
  (`alt=""` is decorative, not missing).
- **Scenario: headings-csv-order** — the header is `HEADINGS_CSV_COLUMNS`; one row per heading, its
  level, text and 1-based order.
- **Scenario: speed-csv-from-audit-performance** — the rows come from the audit's speed report, in
  `SPEED_CSV_SECTIONS` order; an audit with no report gives `null`.
- **Scenario: csv-formula-guard** — a cell starting `=`, `+`, `-`, `@`, tab or CR gets a leading `'`;
  a cell with `"`, `,` or a line break is quoted, its `"` doubled.

## Main (`apps/desktop/src/main/seo/__tests__/exports.test.ts`)
- **Scenario: export-from-shown-audit-only** — a stale ref (URL or `takenAt`), another tab, a pending
  audit or none: nothing written, `null`.
- **Scenario: speed-csv-null-performance-writes-nothing** — an audit with `performance: null`: `null`,
  nothing written.
- **Scenario: writes-through-main-clipboard** — a matching ref writes the CSV through the injected
  clipboard and answers the row count.

## Router (`packages/ipc-contract/src/__tests__/seo-export-router.test.ts`)
- **Scenario: enforces-sender** — a foreign sender is refused before input is read or the service is
  called; without the service, a masked internal error.
- **Scenario: input-bounded** — a bad tab id, a missing or malformed audit ref, an unknown kind, a
  filter outside `IMAGE_FILTERS`, a filter on another kind, or an extra field is refused.

## Context menu (`apps/desktop/src/main/browser/__tests__/context-menu.test.ts`)
- **Scenario: context-menu-copy-seo-submenu-on-web-pages-only** — see `page-commands.feature.md`.
- **Scenario: context-menu-copy-skips-when-audit-changed-since-the-menu-opened** — see
  `page-commands.feature.md`.

## Panels and palette
- The Images panel has "Copy as CSV" (its current filter, so the No alt chip gives the missing-alt
  CSV); On-Page's Headings section and the Speed panel (the audit's report, disabled without one) have
  their own. The palette's Copy group offers the four exports (`export-palette.ts`). Status lines are
  frost's own words; nothing from the page is shown in them.
- **Scenario: context-menu-copy-seo-data** (e2e, `seo-panels.e2e.ts`) — deferred to Task 13.
