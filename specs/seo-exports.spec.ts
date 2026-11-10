/**
 * SEO table exports (Phase 11 Task 1, Decision 1; acceptance `seo-exports.feature.md`): the Images,
 * Headings and Speed tables copied as CSV. Plain values, so the chrome renderer can import them (Zod
 * stays in `seo-exports.schema.ts`, main-only).
 *
 * Main writes every CSV, with Electron's `clipboard`, from the tab's **ready** audit, and only if it
 * is the audit the chrome shows (`SeoAuditRefSchema`; another one, a pending one, another tab or no
 * audit: nothing written), as `seo.copyLinksCsv` does. The chrome sends only the tab, the audit ref,
 * the kind and (images) a filter; it never sends CSV text and never touches the clipboard. Cells go
 * through `csvCell` (`seo-sidebar.spec.ts`, `CSV_FORMULA_PREFIXES`: a cell starting `=`, `+`, `-`,
 * `@`, tab or CR gets a leading `'`; a cell holding `"`, `,`, CR or LF is quoted, its `"` doubled),
 * with the header row first and `\r\n` line ends (RFC 4180).
 */
import type { ImageFilter } from './seo-sidebar.spec';

/** What can be exported (`seoExport.copyCsv`'s `kind`). */
export const SEO_EXPORT_KINDS = ['images', 'headings', 'speed'] as const;
export type SeoExportKind = (typeof SEO_EXPORT_KINDS)[number];

/**
 * The images CSV: the audit's images (the snapshot's list, at most `SNAPSHOT_LIMITS.maxImages`) the
 * `IMAGE_FILTERS` value selects (`filterImages`; `all` when none is sent), in document order, so
 * `missing-alt` is the missing-alt CSV. Columns, in order:
 * - `URL`: the source as kept;
 * - `Alt`: the alt text (empty when missing or `alt=""`);
 * - `Alt missing`: `yes` with no `alt` attribute, `decorative` for `alt=""`, else `no`;
 * - `Width`, `Height`: the rendered size in CSS px (empty when not rendered);
 * - `Declared size`: the `width` × `height` attributes as written (`640x360`; a missing one empty, `640x`; empty when neither);
 * - `Loading`: the `loading` attribute as written (empty when absent);
 * - `In first viewport`, `Oversized`: `yes` or `no`.
 */
export const IMAGES_CSV_COLUMNS = ['URL', 'Alt', 'Alt missing', 'Width', 'Height', 'Declared size', 'Loading', 'In first viewport', 'Oversized'] as const;

/** The headings CSV: the audit's headings in document order. `Level`: `1`…`6`; `Text` as kept; `Order`: its 1-based position. */
export const HEADINGS_CSV_COLUMNS = ['Level', 'Text', 'Order'] as const;

/**
 * The speed CSV: the audit's own speed report (`audit.performance`, measured with the audit), never
 * the Speed panel's live measurement; an audit with no report (`null`) writes nothing. One row per
 * fact, sections in `SPEED_CSV_SECTIONS` order:
 * - `Vitals`: each metric (`VITAL_METRICS` order) by its short name (`LCP (ms)`, `CLS`), its value (ms, or the CLS score)
 *   and its band (`good`, `needs-improvement`, `poor`); both empty when not measured;
 * - `Navigation`: each phase's duration (`<phase> (ms)`), then TTFB, DOM interactive, DOM content
 *   loaded and load (ms; empty when not reached); no rows without navigation timing;
 * - `Requests`: total, transfer, decoded and weight (bytes), cached, size unavailable;
 * - `Resource types`: each `RESOURCE_TYPES` type's request count (`<type> requests`) and weight (`<type> weight (bytes)`);
 * - `DOM`: elements, depth.
 * Numbers are written as digits (no grouping); `Band` is empty but for vitals.
 */
export const SPEED_CSV_COLUMNS = ['Section', 'Metric', 'Value', 'Band'] as const;
export const SPEED_CSV_SECTIONS = ['Vitals', 'Navigation', 'Requests', 'Resource types', 'DOM'] as const;

/** What the chrome calls each export (buttons, palette rows, the context menu). Frost's own words. */
export const SEO_EXPORT_LABELS: Readonly<Record<SeoExportKind, string>> = {
  images: 'Images as CSV',
  headings: 'Headings as CSV',
  speed: 'Speed (audit) as CSV',
};
/** The missing-alt images CSV's label (`images` with the `missing-alt` filter). */
export const MISSING_ALT_EXPORT_LABEL = 'Images missing alt as CSV' as const;

/** The filter an images export takes (`IMAGE_FILTERS`); other kinds take none. */
export type SeoExportFilter = ImageFilter;
