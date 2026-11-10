import { HEADINGS_CSV_COLUMNS, IMAGES_CSV_COLUMNS, SPEED_CSV_COLUMNS, type SeoExportKind } from '@app/specs/seo-exports.spec';
import type { ImageFilter } from '@app/specs/seo-sidebar.spec';
import { RESOURCE_TYPES, VITAL_LABELS } from '@app/specs/seo-speed.spec';
import { altState, filterImages, isOversized } from './images';
import { csvCell } from './links';
import { NAVIGATION_PHASES, type SpeedReport } from './performance';
import type { PageHeading, PageImage, SeoAudit } from './types';

// The Images, Headings and Speed tables as CSV (spec `seo-exports.spec.ts`; acceptance
// `seo-exports.feature.md`, Formatting). Pure: main formats them from its own ready audit
// (`seoExport.copyCsv`, the context menu's Copy SEO Data) and writes its own clipboard. Every cell
// goes through `csvCell` (formula guard, RFC 4180 quoting); lines end with CRLF.

/** A CSV and how many data rows it has (the header aside). */
export interface CsvExport {
  readonly csv: string;
  readonly rows: number;
}

function csv(columns: readonly string[], rows: readonly (readonly string[])[]): CsvExport {
  const lines = [columns, ...rows].map((cells) => cells.map(csvCell).join(','));
  return { csv: `${lines.join('\r\n')}\r\n`, rows: rows.length };
}

const yesNo = (on: boolean): string => (on ? 'yes' : 'no');
const ALT_MISSING = { missing: 'yes', decorative: 'decorative', present: 'no' } as const;

/** The images `filter` selects (`IMAGE_FILTERS`; `all` by default) as `IMAGES_CSV_COLUMNS` rows. */
export function imagesCsv(images: readonly PageImage[], filter: ImageFilter = 'all'): CsvExport {
  return csv(
    IMAGES_CSV_COLUMNS,
    filterImages(images, filter).map((image) => {
      const declared = image.width === null && image.height === null ? '' : `${image.width ?? ''}x${image.height ?? ''}`;
      return [
        image.src,
        image.alt?.text ?? '',
        ALT_MISSING[altState(image)],
        image.rendered ? String(image.rendered.width) : '',
        image.rendered ? String(image.rendered.height) : '',
        declared,
        image.loading ?? '',
        yesNo(image.inFirstViewport),
        yesNo(isOversized(image)),
      ];
    }),
  );
}

/** The headings, in document order, as `HEADINGS_CSV_COLUMNS` rows (`Order` is 1-based). */
export function headingsCsv(headings: readonly PageHeading[]): CsvExport {
  return csv(
    HEADINGS_CSV_COLUMNS,
    headings.map((heading, index) => [String(heading.level), heading.text, String(index + 1)]),
  );
}

const num = (value: number | null): string => (value === null || !Number.isFinite(value) ? '' : String(value));

/** A speed report as `SPEED_CSV_COLUMNS` rows, in `SPEED_CSV_SECTIONS` order; `null` without one. */
export function speedCsv(report: SpeedReport | null): CsvExport | null {
  if (report === null) return null;
  const rows: string[][] = [];
  for (const reading of report.vitals) {
    const label = VITAL_LABELS[reading.metric];
    rows.push(['Vitals', label.unit === 'ms' ? `${label.short} (ms)` : label.short, num(reading.value), reading.value === null ? '' : (reading.band ?? '')]);
  }
  const nav = report.navigation;
  if (nav !== null) {
    for (const phase of NAVIGATION_PHASES) rows.push(['Navigation', `${phase} (ms)`, num(nav.durations[phase]), '']);
    rows.push(['Navigation', 'TTFB (ms)', num(nav.ttfb), '']);
    rows.push(['Navigation', 'DOM interactive (ms)', num(nav.domInteractive), '']);
    rows.push(['Navigation', 'DOM content loaded (ms)', num(nav.domContentLoaded), '']);
    rows.push(['Navigation', 'Load (ms)', num(nav.load), '']);
  }
  const { requests } = report;
  rows.push(
    ['Requests', 'Total', num(requests.total), ''],
    ['Requests', 'Transfer (bytes)', num(requests.transfer), ''],
    ['Requests', 'Decoded (bytes)', num(requests.decoded), ''],
    ['Requests', 'Weight (bytes)', num(requests.weight), ''],
    ['Requests', 'Cached', num(requests.cached), ''],
    ['Requests', 'Size unavailable', num(requests.unavailable), ''],
  );
  for (const type of RESOURCE_TYPES) {
    const breakdown = report.byType.find((b) => b.type === type);
    rows.push(['Resource types', `${type} requests`, num(breakdown?.requests ?? 0), ''], ['Resource types', `${type} weight (bytes)`, num(breakdown?.weight ?? 0), '']);
  }
  rows.push(['DOM', 'Elements', num(report.dom.elements), ''], ['DOM', 'Depth', num(report.dom.depth), '']);
  return csv(SPEED_CSV_COLUMNS, rows);
}

/**
 * The CSV of `kind` from `audit` (spec `SEO_EXPORT_KINDS`): its images (`filter`, `all` by
 * default), its headings, or its own speed report (`null` when the audit has none). A filter on
 * another kind than `images` gives `null`.
 */
export function exportCsv(audit: SeoAudit, kind: SeoExportKind, filter?: ImageFilter): CsvExport | null {
  if (filter !== undefined && kind !== 'images') return null;
  switch (kind) {
    case 'images':
      return imagesCsv(audit.page.imageList, filter ?? 'all');
    case 'headings':
      return headingsCsv(audit.page.headings);
    case 'speed':
      return speedCsv(audit.performance);
  }
}
