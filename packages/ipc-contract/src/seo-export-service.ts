import type { SeoExportKind } from '@app/specs/seo-exports.spec';
import type { ImageFilter } from '@app/specs/seo-sidebar.spec';
import type { SeoAuditRef } from './services';

// The SEO table exports as the `seoExport.*` procedures see them (Phase 11 Task 1, Decision 1;
// acceptance `seo-exports.feature.md`). Main implements it over its tabs' audits and its clipboard
// (`main/seo/exports.ts`); this package only knows the interface.

export interface SeoExportService {
  /**
   * Writes the `kind` table (`SEO_EXPORT_KINDS`) of the tab's ready audit to the system clipboard as
   * CSV, if that audit is the one the chrome shows (`audit`): images filtered by `filter`
   * (`IMAGE_FILTERS`, `all` when left out), headings, or the audit's own speed report. Answers how
   * many data rows it wrote, or `null` (nothing written) for a stale ref, another tab, no ready
   * audit, no speed report, or a filter on another kind.
   */
  copyCsv(tabId: number, audit: SeoAuditRef, kind: SeoExportKind, filter?: ImageFilter): number | null;
}
