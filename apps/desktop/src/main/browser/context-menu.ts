import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { copyValueOf, type SeoAudit, type SeoAuditResponse } from '@app/seo-core';
import { ADDRESS_INPUT_MAX_LENGTH } from '@app/specs/browser.spec';
import { CONTEXT_MENU_COPY_SEO_LABELS, CONTEXT_MENU_COPY_SEO_VALUES, CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL, CONTEXT_MENU_SELECTION_MAX } from '@app/specs/page-commands.spec';
import { SEO_EXPORT_KINDS } from '@app/specs/seo-exports.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { contextMenuSearchLabel, DEFAULT_SEARCH_ENGINE, wellFormed, type SearchEngineId } from '@app/specs/browser-polish.spec';
import { searchUrl } from './address';
import type { SeoExports } from '../seo/exports';

// The page's context menu (spec `page-commands.feature.md`, Context menu): a pure function of a
// tab's `context-menu` params and history flags; main builds and pops up the native menu from it
// (`popupContextMenu`, `menu.ts`). Only Electron *types* are imported. Labels are frost's own
// (`CONTEXT_MENU_LABELS`), except the cleaned, cut selection in the search item.

/** The `context-menu` params the menu reads. */
export type ContextMenuParamsInput = Pick<ContextMenuParams, 'linkURL' | 'srcURL' | 'mediaType' | 'isEditable' | 'selectionText' | 'editFlags'>;

/** What the menu's items do (bound to the tab whose page was clicked). */
export interface ContextMenuCommands {
  back(): void;
  forward(): void;
  reload(): void;
  /** Opens an `http(s)` URL in a new background tab next to the tab. */
  openInNewTab(url: string): void;
  copyText(text: string): void;
  edit(command: 'cut' | 'copy' | 'paste' | 'selectAll'): void;
}

/** Control characters and bidi controls (overrides, embeddings, isolates, marks). */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * `text` with invisible characters removed, whitespace runs collapsed to one space, trimmed, and any
 * lone surrogate replaced by U+FFFD (`wellFormed`: the label and the search URL stay valid text).
 */
function cleanSelection(text: string): string {
  return wellFormed(text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim());
}

/** The search item's label: the cleaned selection, cut to `CONTEXT_MENU_SELECTION_MAX`, `&` doubled. */
function searchLabel(selection: string, engine: SearchEngineId): string {
  const chars = [...selection];
  const shown = chars.length <= CONTEXT_MENU_SELECTION_MAX ? selection : `${chars.slice(0, CONTEXT_MENU_SELECTION_MAX - 1).join('')}…`;
  // The chosen engine's label (`browser-polish.spec.ts`); the default's is `CONTEXT_MENU_SEARCH_LABEL`.
  const template = engine === DEFAULT_SEARCH_ENGINE ? CONTEXT_MENU_SEARCH_LABEL : contextMenuSearchLabel(engine);
  return template.replace('{selection}', shown.replaceAll('&', '&&'));
}

function isMailto(url: string): boolean {
  try {
    return new URL(url).protocol === 'mailto:';
  } catch {
    return false;
  }
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

/**
 * Copy SEO Data for one click (`CONTEXT_MENU_COPY_SEO_VALUES`, Phase 11 Task 1, Decision 1): the
 * tab's ready audit when the menu was built, and how an item writes. The items carry that audit's
 * ref; main writes only if the tab's ready audit is still that one when the item is clicked.
 */
export interface CopySeoMenu {
  readonly audit: SeoAudit;
  copyValue(ref: { readonly url: string; readonly takenAt: number }, key: (typeof CONTEXT_MENU_COPY_SEO_VALUES)[number]): void;
  copyCsv(ref: { readonly url: string; readonly takenAt: number }, kind: (typeof SEO_EXPORT_KINDS)[number]): void;
}

/**
 * Copy SEO Data for tab `tabId` from its audit state at the click: only a ready audit of an
 * `http(s)` page (else `null`, no submenu). Items write through `exports` (main's clipboard, the
 * same shown-audit check as the panels' copies).
 */
export function copySeoMenuFor(tabId: number, response: SeoAuditResponse, exports: Pick<SeoExports, 'copyValue' | 'copyCsv'>): CopySeoMenu | null {
  if (response.status !== 'ready' || !isWebUrl(response.audit.url)) return null;
  return {
    audit: response.audit,
    copyValue: (ref, key) => void exports.copyValue(tabId, ref, key),
    copyCsv: (ref, kind) => void exports.copyCsv(tabId, ref, kind),
  };
}

/**
 * Copy SEO Data for the tab whose page `contents` is (main's `showContextMenu`): that tab's audit
 * state at the click, through `copySeoMenuFor`; `null` for contents that is no tab's.
 */
export function copySeoMenuForContents(
  tabs: { tabIdOf(contents: unknown): number | null; readonly seo: { getAudit(tabId: number): SeoAuditResponse } },
  contents: unknown,
  exports: Pick<SeoExports, 'copyValue' | 'copyCsv'>,
): CopySeoMenu | null {
  const tabId = tabs.tabIdOf(contents);
  return tabId === null ? null : copySeoMenuFor(tabId, tabs.seo.getAudit(tabId), exports);
}

/** The Copy SEO Data submenu item: the values, a separator, the CSVs; a missing value, no images or no speed report disabled. */
function copySeoItem(menu: CopySeoMenu): MenuItemConstructorOptions {
  // The audit's ref, taken now: an item clicked after the tab's audit changed writes nothing.
  const ref = { url: menu.audit.url, takenAt: menu.audit.takenAt };
  const values = CONTEXT_MENU_COPY_SEO_VALUES.map(
    (key): MenuItemConstructorOptions => ({ id: `context-copy-seo-${key}`, label: CONTEXT_MENU_COPY_SEO_LABELS[key], enabled: copyValueOf(menu.audit, key) !== null, click: () => menu.copyValue(ref, key) }),
  );
  const csvs = SEO_EXPORT_KINDS.map(
    (kind): MenuItemConstructorOptions => ({ id: `context-copy-seo-csv-${kind}`, label: CONTEXT_MENU_COPY_SEO_LABELS[kind], enabled: kind === 'speed' ? menu.audit.performance !== null : kind === 'images' ? menu.audit.page.imageList.length > 0 : true, click: () => menu.copyCsv(ref, kind) }),
  );
  return { id: 'context-copy-seo', label: CONTEXT_MENU_LABELS['copy-seo'], submenu: [...values, separator, ...csvs] };
}

/**
 * The context menu for a click with `params` in a tab with these history flags; searches use
 * `engine`. With `copySeo` (the tab's ready audit of a web page) it ends with Copy SEO Data.
 */
export function contextMenuTemplate(
  params: ContextMenuParamsInput,
  history: { readonly canGoBack: boolean; readonly canGoForward: boolean },
  commands: ContextMenuCommands,
  engine: SearchEngineId = DEFAULT_SEARCH_ENGINE,
  copySeo: CopySeoMenu | null = null,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  const entry = (id: keyof typeof CONTEXT_MENU_LABELS, click: () => void, enabled = true): MenuItemConstructorOptions => ({
    id: `context-${id}`,
    label: CONTEXT_MENU_LABELS[id],
    enabled,
    click,
  });

  const link = params.linkURL;
  if (isWebUrl(link)) {
    groups.push([entry('open-link', () => commands.openInNewTab(link)), entry('copy-link', () => commands.copyText(link))]);
  } else if (isMailto(link)) {
    groups.push([entry('copy-link', () => commands.copyText(link))]);
  }

  const image = params.srcURL;
  if (params.mediaType === 'image' && isWebUrl(image)) {
    groups.push([entry('open-image', () => commands.openInNewTab(image)), entry('copy-image', () => commands.copyText(image))]);
  }

  const selection = cleanSelection(params.selectionText);
  if (params.isEditable || selection !== '') {
    const flags = params.editFlags;
    groups.push([
      entry('cut', () => commands.edit('cut'), flags.canCut),
      entry('copy', () => commands.edit('copy'), flags.canCopy),
      entry('paste', () => commands.edit('paste'), flags.canPaste),
    ]);
    groups.push([entry('select-all', () => commands.edit('selectAll'), flags.canSelectAll)]);
  }
  if (selection !== '') {
    const query = [...selection].slice(0, ADDRESS_INPUT_MAX_LENGTH).join('');
    groups.push([{ id: 'context-search', label: searchLabel(selection, engine), enabled: true, click: () => commands.openInNewTab(searchUrl(query, engine)) }]);
  }

  // A plain page: history and reload.
  if (groups.length === 0) {
    groups.push([
      entry('back', () => commands.back(), history.canGoBack),
      entry('forward', () => commands.forward(), history.canGoForward),
      entry('reload', () => commands.reload()),
    ]);
  }
  if (copySeo !== null) groups.push([copySeoItem(copySeo)]);
  return groups.flatMap((group, i) => (i === 0 ? group : [separator, ...group]));
}
