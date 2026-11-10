import type { SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { MISSING_ALT_EXPORT_LABEL, SEO_EXPORT_LABELS, type SeoExportKind } from '@app/specs/seo-exports.spec';
import type { ImageFilter } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { readyAudit, type PaletteAction, type PaletteSource } from './palette/registry';

// The SEO table exports in the command palette (Phase 11 Task 1, Decision 1; acceptance
// `seo-exports.feature.md`, Panels and palette): "Copy images as CSV", "… missing alt …", "Copy
// headings as CSV" and "Copy speed (audit) as CSV", each through main's `seoExport.copyCsv` from the
// shown audit (main formats and writes its own clipboard). Registered from `CommandPalette.tsx`; pure
// (the procedure is injected) so availability is unit tested. `exportStatus` is the status line the
// panels' buttons show too.

/** The procedure the exports call (`actions.copySeoCsv` in `ipc.ts`). */
export interface ExportPaletteApi {
  /** How many rows main copied; `null`: nothing (the audit changed); `'failed'`: the IPC call failed. */
  copySeoCsv(tabId: number, audit: { url: string; takenAt: number }, kind: SeoExportKind, filter?: ImageFilter): Promise<number | null | 'failed'>;
}

const NOUNS: Readonly<Record<SeoExportKind, readonly [string, string]>> = { images: ['image', 'images'], headings: ['heading', 'headings'], speed: ['speed row', 'speed rows'] };

/**
 * What the status line says after an export: how many rows main copied; that nothing was because the
 * shown audit is no longer the tab's ready one (`null`; every action and button is offered only when
 * its table exists); or that the call failed.
 */
export function exportStatus(kind: SeoExportKind, rows: number | null | 'failed'): string {
  if (rows === 'failed') return 'Couldn’t copy';
  if (rows === null) return 'Nothing copied: the audit changed';
  const [one, many] = NOUNS[kind];
  return `Copied ${rows.toLocaleString('en-US')} ${rows === 1 ? one : many} as CSV`;
}

/** The tab shows an `http(s)` page without an error or crash panel. */
const onWebPage = (tab: TabState | undefined): tab is TabState => tab !== undefined && isWebUrl(tab.url) && tab.error === null && !tab.crashed;
const ref = (audit: SeoAudit) => ({ url: audit.url, takenAt: audit.takenAt });

function exportAction(api: ExportPaletteApi, id: string, label: string, kind: SeoExportKind, keywords: readonly string[], has: (audit: SeoAudit) => boolean, filter?: ImageFilter): PaletteAction {
  return {
    id,
    label,
    group: 'copy',
    keywords: ['clipboard', 'csv', 'export', 'spreadsheet', ...keywords],
    icon: 'copy',
    available: (ctx) => {
      const audit = readyAudit(ctx);
      return onWebPage(ctx.tab) && audit !== null && has(audit);
    },
    run: async (ctx) => {
      const audit = readyAudit(ctx)!;
      return exportStatus(kind, await api.copySeoCsv(ctx.tab!.id, ref(audit), kind, filter));
    },
  };
}

/** The palette's export actions, calling `api`. */
export function exportPaletteSources(api: ExportPaletteApi): PaletteSource[] {
  const label = (text: string) => `Copy ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  return [
    exportAction(api, 'export.images', label(SEO_EXPORT_LABELS.images), 'images', ['images', 'alt', 'pictures'], (audit) => audit.page.imageList.length > 0),
    exportAction(api, 'export.images-missing-alt', label(MISSING_ALT_EXPORT_LABEL), 'images', ['images', 'alt', 'missing', 'accessibility'], (audit) => audit.page.imageList.some((image) => image.alt === null), 'missing-alt'),
    exportAction(api, 'export.headings', label(SEO_EXPORT_LABELS.headings), 'headings', ['headings', 'outline', 'h1', 'h2'], (audit) => audit.page.headings.length > 0),
    exportAction(api, 'export.speed', label(SEO_EXPORT_LABELS.speed), 'speed', ['speed', 'performance', 'vitals', 'lcp'], (audit) => audit.performance !== null),
  ];
}
