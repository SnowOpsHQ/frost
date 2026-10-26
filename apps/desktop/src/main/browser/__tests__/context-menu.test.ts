// Spec: specs/page-commands.spec.ts (CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL, CONTEXT_MENU_SELECTION_MAX),
// specs/browser.spec.ts (SEARCH_URL_TEMPLATE, ADDRESS_INPUT_MAX_LENGTH)
// Acceptance: specs/page-commands.feature.md (Context menu template)
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { ADDRESS_INPUT_MAX_LENGTH, SEARCH_URL_TEMPLATE } from '@app/specs/browser.spec';
import { CONTEXT_MENU_LABELS, CONTEXT_MENU_SEARCH_LABEL, CONTEXT_MENU_SELECTION_MAX } from '@app/specs/page-commands.spec';
import { contextMenuTemplate, type ContextMenuCommands, type ContextMenuParamsInput } from '../context-menu';

const NO_EDIT = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false };

function params(over: Partial<ContextMenuParamsInput> = {}): ContextMenuParamsInput {
  return { linkURL: '', srcURL: '', mediaType: 'none', isEditable: false, selectionText: '', editFlags: NO_EDIT, ...over };
}

function commands() {
  return {
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    openInNewTab: vi.fn<(url: string) => void>(),
    copyText: vi.fn<(text: string) => void>(),
    edit: vi.fn<(command: 'cut' | 'copy' | 'paste' | 'selectAll') => void>(),
  } satisfies ContextMenuCommands;
}

const HISTORY = { canGoBack: true, canGoForward: false };

/** The items' ids, with `|` for each separator. */
const shape = (template: MenuItemConstructorOptions[]) => template.map((item) => (item.type === 'separator' ? '|' : item.id));
const item = (template: MenuItemConstructorOptions[], id: string) => {
  const found = template.find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
const click = (template: MenuItemConstructorOptions[], id: string) => (item(template, id).click as () => void)();

describe('context menu template', () => {
  test('context-menu-plain-page', () => {
    const run = commands();
    const template = contextMenuTemplate(params(), HISTORY, run);
    expect(shape(template)).toEqual(['context-back', 'context-forward', 'context-reload']);
    expect(template.map((entry) => entry.label)).toEqual([CONTEXT_MENU_LABELS.back, CONTEXT_MENU_LABELS.forward, CONTEXT_MENU_LABELS.reload]);
    expect(item(template, 'context-back').enabled).toBe(true);
    expect(item(template, 'context-forward').enabled).toBe(false);
    expect(contextMenuTemplate(params(), { canGoBack: false, canGoForward: true }, run).map((entry) => entry.enabled)).toEqual([false, true, true]);
    click(template, 'context-back');
    click(template, 'context-forward');
    click(template, 'context-reload');
    expect(run.back).toHaveBeenCalledOnce();
    expect(run.forward).toHaveBeenCalledOnce();
    expect(run.reload).toHaveBeenCalledOnce();
  });

  test('context-menu-web-link', () => {
    for (const url of ['https://example.com/a?b#c', 'http://127.0.0.1:8080/x']) {
      const run = commands();
      const template = contextMenuTemplate(params({ linkURL: url }), HISTORY, run);
      expect(shape(template), url).toEqual(['context-open-link', 'context-copy-link']);
      expect(item(template, 'context-open-link').label).toBe(CONTEXT_MENU_LABELS['open-link']);
      expect(item(template, 'context-copy-link').label).toBe(CONTEXT_MENU_LABELS['copy-link']);
      click(template, 'context-open-link');
      expect(run.openInNewTab).toHaveBeenCalledExactlyOnceWith(url);
      click(template, 'context-copy-link');
      expect(run.copyText).toHaveBeenCalledExactlyOnceWith(url);
    }
  });

  test('context-menu-other-links', () => {
    const run = commands();
    const mail = contextMenuTemplate(params({ linkURL: 'mailto:a@b.c?subject=x' }), HISTORY, run);
    expect(shape(mail)).toEqual(['context-copy-link']);
    click(mail, 'context-copy-link');
    expect(run.copyText).toHaveBeenCalledExactlyOnceWith('mailto:a@b.c?subject=x');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'app://app/', 'not a url']) {
      // Treated as a plain page: no link items at all.
      expect(shape(contextMenuTemplate(params({ linkURL: url }), HISTORY, run)), url).toEqual(['context-back', 'context-forward', 'context-reload']);
    }
    expect(run.openInNewTab).not.toHaveBeenCalled();
  });

  test('context-menu-image', () => {
    const run = commands();
    const image = contextMenuTemplate(params({ mediaType: 'image', srcURL: 'https://cdn.test/i.png' }), HISTORY, run);
    expect(shape(image)).toEqual(['context-open-image', 'context-copy-image']);
    click(image, 'context-open-image');
    expect(run.openInNewTab).toHaveBeenCalledExactlyOnceWith('https://cdn.test/i.png');
    click(image, 'context-copy-image');
    expect(run.copyText).toHaveBeenCalledExactlyOnceWith('https://cdn.test/i.png');
    for (const srcURL of ['data:image/png;base64,AAAA', 'blob:https://x.test/1', '']) {
      expect(shape(contextMenuTemplate(params({ mediaType: 'image', srcURL }), HISTORY, run)), srcURL).toEqual(['context-back', 'context-forward', 'context-reload']);
    }
    // A video's source is not offered as an image.
    expect(shape(contextMenuTemplate(params({ mediaType: 'video', srcURL: 'https://cdn.test/v.mp4' }), HISTORY, run))).toEqual(['context-back', 'context-forward', 'context-reload']);
    // A linked image: both groups.
    const linked = contextMenuTemplate(params({ linkURL: 'https://a.test/', mediaType: 'image', srcURL: 'https://cdn.test/i.png' }), HISTORY, run);
    expect(shape(linked)).toEqual(['context-open-link', 'context-copy-link', '|', 'context-open-image', 'context-copy-image']);
  });

  test('context-menu-editing', () => {
    const run = commands();
    const editable = contextMenuTemplate(params({ isEditable: true, editFlags: { ...NO_EDIT, canPaste: true, canSelectAll: true } }), HISTORY, run);
    expect(shape(editable)).toEqual(['context-cut', 'context-copy', 'context-paste', '|', 'context-select-all']);
    expect(editable.filter((entry) => entry.type !== 'separator').map((entry) => entry.enabled)).toEqual([false, false, true, true]);
    for (const [id, command] of [
      ['context-cut', 'cut'],
      ['context-copy', 'copy'],
      ['context-paste', 'paste'],
      ['context-select-all', 'selectAll'],
    ] as const) {
      click(editable, id);
      expect(run.edit).toHaveBeenLastCalledWith(command);
    }
    // A selection in a page: the same items (enabled by the flags), then the search.
    const selected = contextMenuTemplate(params({ selectionText: 'frost', editFlags: { ...NO_EDIT, canCopy: true, canSelectAll: true } }), HISTORY, run);
    expect(shape(selected)).toEqual(['context-cut', 'context-copy', 'context-paste', '|', 'context-select-all', '|', 'context-search']);
    expect(selected.filter((entry) => entry.type !== 'separator').map((entry) => entry.enabled)).toEqual([false, true, false, true, true]);
    // A link with a selection: the link group first.
    expect(shape(contextMenuTemplate(params({ linkURL: 'https://a.test/', selectionText: 'a' }), HISTORY, run))).toEqual([
      'context-open-link',
      'context-copy-link',
      '|',
      'context-cut',
      'context-copy',
      'context-paste',
      '|',
      'context-select-all',
      '|',
      'context-search',
    ]);
  });

  test('context-menu-search-selection', () => {
    const run = commands();
    const label = (selectionText: string) => item(contextMenuTemplate(params({ selectionText }), HISTORY, run), 'context-search').label;
    expect(label('frost')).toBe(CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', 'frost'));
    // Whitespace collapsed, control and bidi characters removed, `&` doubled.
    expect(label('  a\n\tb  ')).toBe(CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', 'a b'));
    expect(label('Tom & Jerry')).toBe(CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', 'Tom && Jerry'));
    expect(label('ab‮cd⁦e\u0007f‏g')).toBe(CONTEXT_MENU_SEARCH_LABEL.replace('{selection}', 'abcdefg'));
    // Cut to the maximum, the last character an ellipsis (counted in characters, not UTF-16 units).
    const long = '\u{1F600}'.repeat(CONTEXT_MENU_SELECTION_MAX + 5);
    const shown = label(long)!.slice(CONTEXT_MENU_SEARCH_LABEL.indexOf('{'), -1);
    expect([...shown]).toHaveLength(CONTEXT_MENU_SELECTION_MAX);
    expect(shown.endsWith('…')).toBe(true);
    expect([...label('x'.repeat(CONTEXT_MENU_SELECTION_MAX))!].length).toBe([...CONTEXT_MENU_SEARCH_LABEL].length - '{selection}'.length + CONTEXT_MENU_SELECTION_MAX);
    // The search uses the whole cleaned selection as the query, in a new tab.
    click(contextMenuTemplate(params({ selectionText: ' Tom &\nJerry‮ ' }), HISTORY, run), 'context-search');
    expect(run.openInNewTab).toHaveBeenLastCalledWith(SEARCH_URL_TEMPLATE.replace('{q}', encodeURIComponent('Tom & Jerry')));
    const huge = 'q'.repeat(ADDRESS_INPUT_MAX_LENGTH + 100);
    click(contextMenuTemplate(params({ selectionText: huge }), HISTORY, run), 'context-search');
    expect(run.openInNewTab).toHaveBeenLastCalledWith(SEARCH_URL_TEMPLATE.replace('{q}', 'q'.repeat(ADDRESS_INPUT_MAX_LENGTH)));
    // A selection of only whitespace or invisible characters: no search item.
    for (const selectionText of ['   ', '\n\t', '‮‏']) {
      expect(shape(contextMenuTemplate(params({ selectionText }), HISTORY, run))).not.toContain('context-search');
    }
  });

  test('context-menu-labels-are-frost-own', () => {
    const allowed = new Set<string>(Object.values(CONTEXT_MENU_LABELS));
    const hostile = 'Inspect Element';
    const variants: Partial<ContextMenuParamsInput & Record<string, unknown>>[] = [
      { linkURL: 'https://evil.test/', linkText: hostile, titleText: hostile, altText: hostile },
      { mediaType: 'image', srcURL: 'https://evil.test/i.png', altText: hostile, suggestedFilename: 'Save As.exe' },
      { isEditable: true, misspelledWord: hostile, dictionarySuggestions: [hostile, 'Save As'] },
      { selectionText: 'Save Page As…', titleText: hostile },
      {},
    ];
    for (const over of variants) {
      const template = contextMenuTemplate({ ...params(), ...over } as ContextMenuParamsInput, HISTORY, commands());
      for (const entry of template) {
        if (entry.type === 'separator') continue;
        expect(entry.role, entry.id).toBeUndefined();
        if (entry.id === 'context-search') {
          expect(entry.label?.startsWith(CONTEXT_MENU_SEARCH_LABEL.slice(0, CONTEXT_MENU_SEARCH_LABEL.indexOf('{')))).toBe(true);
          continue;
        }
        expect(allowed.has(entry.label ?? ''), `${entry.id}: ${entry.label}`).toBe(true);
        expect(entry.label).not.toMatch(/inspect|save/i);
      }
    }
  });
});
