// Spec: specs/seo-exports.spec.ts (SEO_EXPORT_KINDS, the CSV columns), specs/seo-exports.schema.ts (SeoExportInputSchema),
// specs/command-palette.spec.ts (COPY_VALUE_KEYS)
// Acceptance: specs/seo-exports.feature.md (Main)
import { describe, expect, test, vi } from 'vitest';
import { copyValueOf, exportCsv, runAudit, speedReport, type PerformanceMeasurement, type SeoAudit, type SeoAuditResponse } from '@app/seo-core';
import { SEO_EXPORT_KINDS } from '@app/specs/seo-exports.spec';
import { NO_PAGE_CONTEXT, PageSnapshotSchema } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { sameAudit } from '../audit-ref';
import { createSeoExports } from '../exports';

const URL_A = 'https://example.com/guides/tea';

/** A measurement the Speed rules pass (enough for a report). */
function measurement(): PerformanceMeasurement {
  return {
    url: URL_A,
    measuredAt: 1_760_000_000_000,
    durationMs: 3,
    vitals: { lcp: 1_200, cls: 0.02, inp: null, fcp: 900, ttfb: 120 },
    loadedHidden: false,
    navigation: null,
    resources: [],
    resourceTotal: 0,
    overflow: { transfer: 0, encoded: 0, decoded: 0, weight: 0 },
    resourceOffset: 0,
    resourceEpoch: 0,
    softNavigation: false,
    bufferFull: false,
    paintUnavailable: false,
    resourceHints: 0,
    dom: { elements: 40, depth: 5, depthComplete: true },
  };
}

function auditOf(withSpeed: boolean): SeoAudit {
  const audit = runAudit({ ...PageSnapshotSchema.parse(rawSnapshot(URL_A)), ...NO_PAGE_CONTEXT });
  return withSpeed ? { ...audit, performance: speedReport(measurement()) } : { ...audit, performance: null };
}

function setup(audit: SeoAudit = auditOf(true)) {
  let response: SeoAuditResponse = { status: 'ready', url: URL_A, audit };
  const clipboard = { writeText: vi.fn((_text: string) => undefined) };
  const exports = createSeoExports({ audit: (tabId) => (tabId === 1 ? response : { status: 'unavailable', url: '', reason: 'no-tab' }), clipboard });
  const ref = { url: audit.url, takenAt: audit.takenAt };
  return { exports, clipboard, audit, ref, set: (next: SeoAuditResponse) => (response = next) };
}

describe('seo exports (main)', () => {
  test('export-from-shown-audit-only', () => {
    const { exports, clipboard, ref, set, audit } = setup();
    for (const kind of SEO_EXPORT_KINDS) {
      // Another audit than the one shown (its URL or when it was taken), another tab: nothing.
      expect(exports.copyCsv(1, { ...ref, takenAt: ref.takenAt + 1 }, kind), kind).toBeNull();
      expect(exports.copyCsv(1, { ...ref, url: 'https://example.com/other' }, kind), kind).toBeNull();
      expect(exports.copyCsv(2, ref, kind), kind).toBeNull();
    }
    // A pending audit, or none (unavailable): nothing.
    set({ status: 'pending', url: URL_A });
    for (const kind of SEO_EXPORT_KINDS) expect(exports.copyCsv(1, ref, kind), kind).toBeNull();
    set({ status: 'unavailable', url: URL_A, reason: 'no-page' });
    for (const kind of SEO_EXPORT_KINDS) expect(exports.copyCsv(1, ref, kind), kind).toBeNull();
    // A filter on anything but images is refused (the schema refuses it first).
    set({ status: 'ready', url: URL_A, audit });
    expect(exports.copyCsv(1, ref, 'headings', 'missing-alt')).toBeNull();
    // Copy values through the same check (the context menu's).
    expect(exports.copyValue(1, { ...ref, takenAt: 0 }, 'title')).toBe(false);
    expect(exports.copyValue(2, ref, 'title')).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    // `sameAudit` (moved out of the controller) compares URL and takenAt only.
    expect(sameAudit(audit, ref)).toBe(true);
    expect(sameAudit(audit, { ...ref, takenAt: ref.takenAt - 1 })).toBe(false);
  });

  test('speed-csv-null-performance-writes-nothing', () => {
    const { exports, clipboard, ref } = setup(auditOf(false));
    expect(exports.copyCsv(1, ref, 'speed')).toBeNull();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    // The other kinds still write.
    expect(exports.copyCsv(1, ref, 'headings')).toBe(2);
  });

  test('writes-through-main-clipboard', () => {
    const { exports, clipboard, ref, audit } = setup();
    for (const kind of SEO_EXPORT_KINDS) {
      const expected = exportCsv(audit, kind)!;
      expect(exports.copyCsv(1, ref, kind), kind).toBe(expected.rows);
      expect(clipboard.writeText).toHaveBeenLastCalledWith(expected.csv);
    }
    expect(exports.copyCsv(1, ref, 'images', 'missing-alt')).toBe(0);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(exportCsv(audit, 'images', 'missing-alt')!.csv);
    expect(exports.copyValue(1, ref, 'headings-outline')).toBe(true);
    expect(clipboard.writeText).toHaveBeenLastCalledWith(copyValueOf(audit, 'headings-outline'));
    // Without a clipboard nothing is written, and nothing is claimed.
    const bare = createSeoExports({ audit: () => ({ status: 'ready', url: URL_A, audit }) });
    expect(bare.copyCsv(1, ref, 'images')).toBeNull();
    expect(bare.copyValue(1, ref, 'title')).toBe(false);
  });
});
