import type { SeoAuditRef, SeoExportService } from '@app/ipc-contract';
import { copyValueOf, exportCsv, type SeoAuditResponse } from '@app/seo-core';
import type { CopyValueKey } from '@app/specs/command-palette.spec';
import type { SeoExportKind } from '@app/specs/seo-exports.spec';
import type { ImageFilter } from '@app/specs/seo-sidebar.spec';
import { shownAudit } from './audit-ref';

// The SEO table exports in main (Phase 11 Task 1, Decision 1; acceptance `seo-exports.feature.md`,
// Main): a service over the tabs' audits (`browser.seo.getAudit`, i.e. `audits.response`). Every CSV
// and value is formatted here from main's own ready audit, only if it is the audit the caller names
// (the chrome's ref, or the context menu's remembered one), and written with Electron's `clipboard`
// in main. Nothing from the chrome is ever written.

export interface SeoExportsOptions {
  /** The tab's audit state (`browser.seo.getAudit`). */
  readonly audit: (tabId: number) => SeoAuditResponse;
  /** Electron's `clipboard` in main; without it nothing is written. */
  readonly clipboard?: { writeText(text: string): void };
}

export interface SeoExports extends SeoExportService {
  /**
   * Writes value `key` (`copyValueOf`) of the tab's ready audit if it is `shown` and has that value;
   * `false`, nothing written, otherwise (the context menu's Copy SEO Data values).
   */
  copyValue(tabId: number, shown: SeoAuditRef, key: CopyValueKey): boolean;
}

export function createSeoExports(options: SeoExportsOptions): SeoExports {
  return {
    copyCsv(tabId: number, shown: SeoAuditRef, kind: SeoExportKind, filter?: ImageFilter) {
      const audit = shownAudit(options.audit(tabId), shown);
      if (!options.clipboard || audit === null) return null;
      const out = exportCsv(audit, kind, filter);
      if (out === null) return null;
      options.clipboard.writeText(out.csv);
      return out.rows;
    },
    copyValue(tabId, shown, key) {
      const audit = shownAudit(options.audit(tabId), shown);
      if (!options.clipboard || audit === null) return false;
      const value = copyValueOf(audit, key);
      if (value === null) return false;
      options.clipboard.writeText(value);
      return true;
    },
  };
}
