import { panelStatus, type SchemaEntity, type SeoAuditResponse } from '@app/seo-core';
import { HIGHLIGHT_PANELS, LINK_FILTER_QUERY_MAX_CHARS, SEO_PANELS, SIDEBAR_DEFAULT_OPEN, type HighlightMode, type PanelStatus, type SeoPanelId } from '@app/specs/seo-sidebar.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { RAW_VIEW_MARKED, SCHEMA_PANEL_LIMITS } from '@app/specs/schema-types.spec';

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

/**
 * Each available panel's rail dot for a ready audit (`panelStatus`); none otherwise, never for
 * unavailable panels, and never for a panel without rules (no `categories`: Search Console).
 */
export function railStatuses(response: SeoAuditResponse | null): Partial<Record<SeoPanelId, PanelStatus>> {
  if (response?.status !== 'ready') return {};
  const statuses: Partial<Record<SeoPanelId, PanelStatus>> = {};
  for (const panel of SEO_PANELS) if (panel.available && panel.categories.length > 0) statuses[panel.id] = panelStatus(response.audit.findings, panel.categories);
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

/**
 * Whether the tab's highlight overlay must be turned off (`HIGHLIGHT_PANELS`): it is on, and the
 * sidebar is collapsed or shows another panel than the one whose toggle owns it.
 */
export function highlightToClear(mode: HighlightMode, panel: SeoPanelId, open: boolean): boolean {
  return mode !== 'off' && (!open || HIGHLIGHT_PANELS[mode] !== panel);
}

/** `n` with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * A page value as tooltip text, wrapped in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE
 * (U+2068 … U+2069), so a bidi override in it cannot reorder the rest of the tooltip.
 */
export function isolatedTooltip(value: string): string {
  return `⁨${value}⁩`;
}

/**
 * Whether a page-derived URL may be offered as "Open in new tab": `http(s)` only (main checks it
 * again). Every other URL is shown as text, never as a link.
 */
export function openableUrl(url: string): boolean {
  return isWebUrl(url);
}

/** `w × h` (CSS px), or `null` for no size. */
export function formatSize(size: { readonly width: number; readonly height: number } | null): string | null {
  return size ? `${formatCount(size.width)} × ${formatCount(size.height)}` : null;
}

/** The declared `width` / `height` attributes as `w × h` (`?` for a missing one), or `null` when neither is set. */
export function declaredSize(width: string | null, height: string | null): string | null {
  const w = width?.trim() || null;
  const h = height?.trim() || null;
  return w === null && h === null ? null : `${w ?? '?'} × ${h ?? '?'}`;
}

/** How many times larger than shown an image's file is (the larger of the two ratios, one decimal), or `null`. */
export function oversizeRatio(rendered: { width: number; height: number } | null, natural: { width: number; height: number } | null): string | null {
  if (!rendered || !natural || rendered.width === 0 || rendered.height === 0) return null;
  const ratio = Math.max(natural.width / rendered.width, natural.height / rendered.height);
  return `${(Math.round(ratio * 10) / 10).toLocaleString('en-US')}×`;
}

/** The search box's value as sent to main: cut to `LINK_FILTER_QUERY_MAX_CHARS` UTF-16 code units, never splitting a surrogate pair. */
export function linkQuery(value: string): string {
  if (value.length <= LINK_FILTER_QUERY_MAX_CHARS) return value;
  const end = LINK_FILTER_QUERY_MAX_CHARS;
  const code = value.charCodeAt(end - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

// ---- Schema panel (Task 3; acceptance `seo-schema.feature.md`, Renderer helpers) ---------------

/** What a top-level entity without a type is called in the summary. */
export const UNTYPED_LABEL = 'Untyped';

/**
 * Top-level entities counted by type (an entity with two types counts for both), most first, ties in
 * first-seen order. A node that only extends another (`extends`) is part of that one, not counted.
 */
export function schemaTypeSummary(entities: readonly Pick<SchemaEntity, 'types' | 'extends'>[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    if (entity.extends !== null) continue;
    for (const type of entity.types.length > 0 ? entity.types : [UNTYPED_LABEL]) counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
}

/**
 * `text` split around the error at `offset` (clamped to the text): what comes before, the character
 * at it (a whole code point; `''` at the end), and what comes after.
 */
export function errorExcerpt(text: string, offset: number): { before: string; at: string; after: string } {
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, text.length));
  const code = text.codePointAt(at);
  const width = code === undefined ? 0 : code > 0xffff ? 2 : 1;
  return { before: text.slice(0, at), at: text.slice(at, at + width), after: text.slice(at + width) };
}

/** Every entity of the tree (nested ones too) by key, so a reference can be opened where it is. */
export function entityIndex(entities: readonly SchemaEntity[]): Map<number, SchemaEntity> {
  const index = new Map<number, SchemaEntity>();
  const stack = [...entities];
  while (stack.length > 0) {
    const entity = stack.pop()!;
    if (index.has(entity.key)) continue;
    index.set(entity.key, entity);
    for (const property of entity.properties) for (const value of property.values) if (value.kind === 'entity') stack.push(value.entity);
  }
  return index;
}

/** Whether the top-level node at `index` of a card starts open (`SCHEMA_PANEL_LIMITS.openTopLevel`). */
export function openByDefault(index: number): boolean {
  return index < SCHEMA_PANEL_LIMITS.openTopLevel;
}

/** How many of `total` rows a list shows at first (`step` of them at most). */
export function firstShown(total: number, step: number): number {
  return Math.min(total, step);
}

/** How many rows a list shows after "Show more": `step` more, at most `total`. */
export function moreShown(shown: number, total: number, step: number): number {
  return Math.min(total, shown + step);
}

/** A run of raw-view text, or one marked character (`U+202E`) shown as a marker instead of itself. */
export type RawSegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'mark'; readonly code: string };

const MARKED = new RegExp(RAW_VIEW_MARKED.source, 'g');

/** `text` split into runs of plain text and `RAW_VIEW_MARKED` characters (bidi controls, C0 controls but tab and line feed, DEL). Linear. */
export function rawSegments(text: string): RawSegment[] {
  const out: RawSegment[] = [];
  let from = 0;
  for (const match of text.matchAll(MARKED)) {
    if (match.index > from) out.push({ kind: 'text', text: text.slice(from, match.index) });
    out.push({ kind: 'mark', code: `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` });
    from = match.index + 1;
  }
  if (from < text.length) out.push({ kind: 'text', text: text.slice(from) });
  return out;
}
