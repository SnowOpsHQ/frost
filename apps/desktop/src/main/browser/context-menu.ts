import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { ADDRESS_INPUT_MAX_LENGTH } from '@app/specs/browser.spec';
import { CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL, CONTEXT_MENU_SELECTION_MAX } from '@app/specs/page-commands.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { searchUrl } from './address';

// The page's context menu (spec `page-commands.feature.md`, Context menu): a pure function of a
// tab's `context-menu` params and history flags; main builds and pops up the native menu from it
// (`showTabContextMenu`, `menu.ts`). Only Electron *types* are imported. Labels are frost's own
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

/** `text` with invisible characters removed and whitespace runs collapsed to one space, trimmed. */
function cleanSelection(text: string): string {
  return text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** The search item's label: the cleaned selection, cut to `CONTEXT_MENU_SELECTION_MAX`, `&` doubled. */
function searchLabel(selection: string): string {
  const chars = [...selection];
  const shown = chars.length <= CONTEXT_MENU_SELECTION_MAX ? selection : `${chars.slice(0, CONTEXT_MENU_SELECTION_MAX - 1).join('')}…`;
  return CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', shown.replaceAll('&', '&&'));
}

function isMailto(url: string): boolean {
  try {
    return new URL(url).protocol === 'mailto:';
  } catch {
    return false;
  }
}

const separator: MenuItemConstructorOptions = { type: 'separator' };

/** The context menu for a click with `params` in a tab with these history flags. */
export function contextMenuTemplate(
  params: ContextMenuParamsInput,
  history: { readonly canGoBack: boolean; readonly canGoForward: boolean },
  commands: ContextMenuCommands,
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
    groups.push([{ id: 'context-search', label: searchLabel(selection), enabled: true, click: () => commands.openInNewTab(searchUrl(query)) }]);
  }

  // A plain page: history and reload.
  if (groups.length === 0) {
    groups.push([
      entry('back', () => commands.back(), history.canGoBack),
      entry('forward', () => commands.forward(), history.canGoForward),
      entry('reload', () => commands.reload()),
    ]);
  }
  return groups.flatMap((group, i) => (i === 0 ? group : [separator, ...group]));
}
