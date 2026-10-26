import { panelStatus, type SeoAuditResponse } from '@app/seo-core';
import { SEO_PANELS, SIDEBAR_DEFAULT_OPEN, type PanelStatus, type SeoPanelId } from '@app/specs/seo-sidebar.spec';

// Pure helpers behind the SEO sidebar (spec `seo-sidebar.spec.ts`; acceptance
// `seo-sidebar.feature.md`, Renderer helpers).

/** The persisted open / closed value (`SIDEBAR_STORAGE_KEY`): `'1'` open, `'0'` closed, else the default. */
export function sidebarOpenFromStorage(value: string | null): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  return SIDEBAR_DEFAULT_OPEN;
}

export type LengthIndicator = 'missing' | 'short' | 'ok' | 'long';

/** How a measured length compares with its recommended range (`null` or `0`: missing). */
export function lengthIndicator(length: number | null | undefined, min: number, max: number): LengthIndicator {
  if (length === null || length === undefined || length === 0) return 'missing';
  if (length < min) return 'short';
  if (length > max) return 'long';
  return 'ok';
}

/** Each available panel's rail dot for a ready audit (`panelStatus`); none otherwise, and never for unavailable panels. */
export function railStatuses(response: SeoAuditResponse | null): Partial<Record<SeoPanelId, PanelStatus>> {
  if (response?.status !== 'ready') return {};
  const statuses: Partial<Record<SeoPanelId, PanelStatus>> = {};
  for (const panel of SEO_PANELS) if (panel.available) statuses[panel.id] = panelStatus(response.audit.findings, panel.categories);
  return statuses;
}

/** A fetched `seo.getAudit` answer and the tab it was asked for. */
export interface FetchedAudit {
  readonly tabId: number;
  readonly response: SeoAuditResponse;
}

/**
 * What the sidebar shows for `tab`: the fetched answer only if it is this tab's and for the URL the
 * tab shows now; anything else (another tab's, an SPA that moved on, nothing yet) is `pending`.
 */
export function shownResponse(tab: { readonly id: number; readonly url: string }, fetched: FetchedAudit | null): SeoAuditResponse {
  if (fetched && fetched.tabId === tab.id && fetched.response.url === tab.url) return fetched.response;
  return { status: 'pending', url: tab.url };
}

/** `n` with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
