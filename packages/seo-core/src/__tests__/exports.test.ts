// Spec: specs/seo-exports.spec.ts (SEO_EXPORT_KINDS, IMAGES_CSV_COLUMNS, HEADINGS_CSV_COLUMNS, SPEED_CSV_COLUMNS,
// SPEED_CSV_SECTIONS), specs/seo-sidebar.spec.ts (CSV_FORMULA_PREFIXES, IMAGE_FILTERS)
// Acceptance: specs/seo-exports.feature.md (Formatting)
import { describe, expect, test } from 'vitest';
import { HEADINGS_CSV_COLUMNS, IMAGES_CSV_COLUMNS, SEO_EXPORT_KINDS, SPEED_CSV_COLUMNS, SPEED_CSV_SECTIONS } from '@app/specs/seo-exports.spec';
import { RESOURCE_TYPES, VITAL_METRICS } from '@app/specs/seo-speed.spec';
import { CSV_FORMULA_PREFIXES, IMAGE_FILTERS } from '@app/specs/seo-sidebar.spec';
import { exportCsv, filterImages, headingsCsv, imagesCsv, runAudit, speedCsv, speedReport, type PageImage } from '../index';
import { page, text } from './fixtures';
import { measurement, withVitals } from './performance-fixtures';

/** The CSV's lines (CRLF line ends, a final CRLF), each split naively on commas (the fixtures quote nothing unless a test says so). */
function lines(csv: string): string[] {
  expect(csv.endsWith('\r\n')).toBe(true);
  expect(csv.slice(0, -2)).not.toMatch(/(?<!\r)\n/);
  return csv.slice(0, -2).split('\r\n');
}

function image(changes: Partial<PageImage> = {}): PageImage {
  return { src: 'https://example.com/a.png', alt: text('A'), width: '100', height: '50', loading: null, rendered: { width: 100, height: 50 }, natural: { width: 100, height: 50 }, inFirstViewport: false, cssSized: false, ...changes };
}

const IMAGES: PageImage[] = [
  image({ src: 'https://example.com/hero.jpg', alt: text('Hero shot'), width: '1200', height: '600', loading: 'eager', rendered: { width: 1200, height: 600 }, natural: { width: 1200, height: 600 }, inFirstViewport: true }),
  image({ src: 'https://example.com/no-alt.png', alt: null, width: null, height: null, loading: 'lazy', rendered: { width: 300, height: 200 }, natural: { width: 1500, height: 1000 } }),
  image({ src: 'https://example.com/spacer.gif', alt: text(''), width: '1', height: null, rendered: null, natural: null }),
];

describe('seo exports', () => {
  test('images-csv-columns-and-filter', () => {
    expect(SEO_EXPORT_KINDS).toEqual(['images', 'headings', 'speed']);
    const all = imagesCsv(IMAGES, 'all');
    expect(all.rows).toBe(3);
    expect(lines(all.csv)).toEqual([
      IMAGES_CSV_COLUMNS.join(','),
      'https://example.com/hero.jpg,Hero shot,no,1200,600,1200x600,eager,yes,no',
      'https://example.com/no-alt.png,,yes,300,200,,lazy,no,yes',
      'https://example.com/spacer.gif,,decorative,,,1x,,no,no',
    ]);
    // Left out, the filter is `all`; every filter selects exactly what the panel's chip shows.
    expect(imagesCsv(IMAGES)).toEqual(all);
    for (const filter of IMAGE_FILTERS) {
      const out = imagesCsv(IMAGES, filter);
      expect(out.rows, filter).toBe(filterImages(IMAGES, filter).length);
      expect(lines(out.csv).length, filter).toBe(out.rows + 1);
    }
    expect(lines(imagesCsv(IMAGES, 'oversized').csv).slice(1)).toEqual(['https://example.com/no-alt.png,,yes,300,200,,lazy,no,yes']);
    // From the audit: the snapshot's images.
    const audit = runAudit(page({ images: IMAGES, imageTotal: 3 }));
    expect(exportCsv(audit, 'images')).toEqual(all);
    expect(exportCsv(audit, 'images', 'lazy-first-viewport')).toEqual(imagesCsv(IMAGES, 'lazy-first-viewport'));
    // No images: the header only.
    expect(imagesCsv([], 'all')).toEqual({ csv: `${IMAGES_CSV_COLUMNS.join(',')}\r\n`, rows: 0 });
  });

  test('missing-alt-csv', () => {
    const out = imagesCsv(IMAGES, 'missing-alt');
    expect(out.rows).toBe(1);
    // Only the image with no alt attribute; `alt=""` is decorative, not missing.
    expect(lines(out.csv)).toEqual([IMAGES_CSV_COLUMNS.join(','), 'https://example.com/no-alt.png,,yes,300,200,,lazy,no,yes']);
    expect(exportCsv(runAudit(page({ images: IMAGES, imageTotal: 3 })), 'images', 'missing-alt')).toEqual(out);
  });

  test('headings-csv-order', () => {
    const audit = runAudit(page());
    const out = headingsCsv(audit.page.headings);
    expect(out.rows).toBe(5);
    expect(lines(out.csv)).toEqual([
      HEADINGS_CSV_COLUMNS.join(','),
      '1,SEO basics,1',
      '2,How crawlers read a page,2',
      '3,Titles and descriptions,3',
      '3,Headings,4',
      '2,Next steps,5',
    ]);
    expect(exportCsv(audit, 'headings')).toEqual(out);
    expect(headingsCsv([])).toEqual({ csv: `${HEADINGS_CSV_COLUMNS.join(',')}\r\n`, rows: 0 });
  });

  test('speed-csv-from-audit-performance', () => {
    const audit = runAudit(page({ performance: withVitals({ lcp: 1_800, cls: 0.31, inp: null }) }));
    const report = audit.performance!;
    expect(report).not.toBeNull();
    const out = speedCsv(report)!;
    const rows = lines(out.csv);
    expect(rows[0]).toBe(SPEED_CSV_COLUMNS.join(','));
    expect(out.rows).toBe(rows.length - 1);
    const body = rows.slice(1).map((row) => row.split(','));
    // Sections in order, each present.
    const sections = body.map((cells) => cells[0]);
    expect([...new Set(sections)]).toEqual([...SPEED_CSV_SECTIONS]);
    // Vitals: one row per metric, value and band as the report has them (empty when not measured).
    const vitals = body.filter((cells) => cells[0] === 'Vitals');
    expect(vitals).toHaveLength(VITAL_METRICS.length);
    for (const reading of report.vitals) {
      const row = vitals.find((cells) => cells[1]!.toLowerCase().startsWith(reading.metric));
      expect(row, reading.metric).toBeDefined();
      expect(row![2], reading.metric).toBe(reading.value === null ? '' : String(reading.value));
      expect(row![3], reading.metric).toBe(reading.band ?? '');
    }
    expect(vitals.find((cells) => cells[1]!.toLowerCase().startsWith('cls'))![3]).toBe('poor');
    expect(vitals.find((cells) => cells[1]!.toLowerCase().startsWith('inp'))!.slice(2)).toEqual(['', '']);
    // Requests and resource types from the report; band only for vitals.
    expect(body.find((cells) => cells[0] === 'Requests' && cells[1] === 'Total')![2]).toBe(String(report.requests.total));
    expect(body.filter((cells) => cells[0] === 'Resource types')).toHaveLength(RESOURCE_TYPES.length * 2);
    expect(body.find((cells) => cells[0] === 'DOM' && cells[1] === 'Elements')![2]).toBe(String(report.dom.elements));
    expect(body.filter((cells) => cells[0] !== 'Vitals').every((cells) => cells[3] === '')).toBe(true);
    // The audit's own report, exactly; none: nothing.
    expect(exportCsv(audit, 'speed')).toEqual(out);
    expect(speedCsv(null)).toBeNull();
    expect(exportCsv(runAudit(page({ performance: null })), 'speed')).toBeNull();
    // Without navigation timing there are no navigation rows.
    const noNav = speedCsv({ ...speedReport(measurement()), navigation: null })!;
    expect(lines(noNav.csv).some((row) => row.startsWith('Navigation,'))).toBe(false);
  });

  test('csv-formula-guard', () => {
    for (const prefix of CSV_FORMULA_PREFIXES) {
      const out = imagesCsv([image({ src: `${prefix}HYPERLINK("https://evil.example/")`, alt: text(`${prefix}1+1`) })], 'all');
      const body = out.csv.split('\r\n')[1]!;
      // Every cell starting with a formula prefix gets a leading `'` (then quoting, as needed).
      expect(body.startsWith(`"'${prefix}`) || body.startsWith(`'${prefix}`), JSON.stringify(prefix)).toBe(true);
    }
    const headings = headingsCsv([{ level: 2, text: '=SUM(A1:A9)' }, { level: 3, text: 'Tea, "green", and\nmore' }]);
    expect(headings.csv.split('\r\n').slice(1, 3)).toEqual(["2,'=SUM(A1:A9),1", '3,"Tea, ""green"", and\nmore",2']);
  });
});
