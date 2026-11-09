// Spec: specs/inspector.spec.ts (INSPECTOR_REFUSAL_MESSAGES, INSPECTOR_REGION_LABELS, the answer types),
// specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/seo-sidebar.spec.ts (SEO_PANELS)
// Acceptance: specs/inspector.feature.md (The panel, Command palette; Scenarios inspector-row-labels,
// inspector-tree-model, inspector-tree-keys, inspector-details-text, inspector-palette-actions; Phase 11 Task 5:
// source-lines-are-text, source-window-bounded, INSPECTOR_SOURCE_VIEW)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { INSPECTOR_REFUSAL_MESSAGES, INSPECTOR_SOURCE_MAX_CHARS, INSPECTOR_SOURCE_VIEW, type InspectorChild, type InspectorChildrenAnswer, type InspectorNode, type InspectorPickAnswer } from '@app/specs/inspector.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { inspectorPaletteSources } from '../inspector-palette';
import {
  ROOT_KEY,
  boxText,
  canInspect,
  extendWindow,
  findRows,
  firstWindow,
  mergeChildren,
  moreKey,
  pathKey,
  pathsToReveal,
  pickOutcomeText,
  rowLabel,
  seoRows,
  setExpanded,
  sourceRows,
  summaryRows,
  treeKeyAction,
  visibleRows,
  windowAround,
  type Tree,
} from '../inspector-view';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

// The panel's module talks to main through `ipc`; the line list under test never does.
vi.mock('../ipc', () => ({ ipc: {} }));

const TOKEN = 'a'.repeat(32);
const URL_A = 'https://www.example.com/a';
const row = (index: number, tag: string, childElementCount = 0, extra: Partial<InspectorChild> = {}): InspectorChild => ({ index, tag, id: '', classes: [], childElementCount, textPreview: '', shadow: false, ...extra });
type Ok = Extract<InspectorChildrenAnswer, { status: 'ok' }>;
const answer = (path: number[], node: InspectorChild, children: InspectorChild[], more = false, offset = 0): Ok => ({ status: 'ok', docToken: TOKEN, path, node, offset, children, more });

/** `<html>` with head and body; body with a header, a main (with an h1) and a footer. */
function sampleTree(): Tree {
  let tree: Tree = mergeChildren(new Map(), answer([], row(0, 'html', 2), [row(0, 'head', 1), row(1, 'body', 3)]));
  tree = mergeChildren(tree, answer([1], row(1, 'body', 3), [row(0, 'header'), row(1, 'main', 1), row(2, 'footer')]));
  return mergeChildren(tree, answer([1, 1], row(1, 'main', 1), [row(0, 'h1', 0, { textPreview: 'Title' })]));
}

describe('inspector view', () => {
  test('inspector-row-labels', () => {
    expect(rowLabel(row(0, 'div'))).toBe('div');
    expect(rowLabel(row(0, 'h1', 0, { id: 'title', classes: ['hero', 'big'] }))).toBe('h1#title.hero.big');
    expect(rowLabel(row(0, 'p', 0, { classes: ['x'] }))).toBe('p.x');
    expect(pathKey([])).toBe(ROOT_KEY);
    expect(pathKey([1, 0, 12])).toBe('1.0.12');
    expect(pathsToReveal([1, 1, 0])).toEqual([[], [1], [1, 1]]);
    expect(pathsToReveal([])).toEqual([]);
    const tab = (changes: Partial<TabState> = {}) => ({ id: 1, url: URL_A, crashed: false, ...changes }) as TabState;
    expect(canInspect(tab())).toBe(true);
    expect(canInspect(tab({ url: 'about:blank' }))).toBe(false);
    expect(canInspect(tab({ crashed: true }))).toBe(false);
    expect(canInspect(undefined)).toBe(false);
  });

  test('inspector-tree-model', () => {
    const tree = sampleTree();
    expect(visibleRows(tree).map((r) => (r.kind === 'node' ? [r.key, r.level, r.row.tag, r.expanded, r.expandable] : [r.key]))).toEqual([
      ['', 1, 'html', true, true],
      ['0', 2, 'head', false, true],
      ['1', 2, 'body', true, true],
      ['1.0', 3, 'header', false, false],
      ['1.1', 3, 'main', true, true],
      ['1.1.0', 4, 'h1', false, false],
      ['1.2', 3, 'footer', false, false],
    ]);
    // Closing keeps what was read; opening again shows it.
    const closed = setExpanded(tree, '1', false);
    expect(visibleRows(closed).map((r) => r.key)).toEqual(['', '0', '1']);
    expect(visibleRows(setExpanded(closed, '1', true))).toEqual(visibleRows(tree));
    // "Show more" appends the next page; a fresh read of the first page replaces the list.
    let list: Tree = mergeChildren(new Map(), answer([], row(0, 'html', 3), [row(0, 'li'), row(1, 'li')], true));
    // While more are left, the open node's last row is its "Show more".
    expect(visibleRows(list).map((r) => [r.kind, r.key, r.level])).toEqual([
      ['node', '', 1],
      ['node', '0', 2],
      ['node', '1', 2],
      ['more', moreKey(''), 2],
    ]);
    list = mergeChildren(list, answer([], row(0, 'html', 3), [row(2, 'li')], false, 2));
    expect(list.get(ROOT_KEY)!.kidSet).toEqual(new Set(['0', '1', '2']));
    expect(visibleRows(list).some((r) => r.kind === 'more')).toBe(false);
    expect(list.get(ROOT_KEY)).toMatchObject({ kids: ['0', '1', '2'], more: false, expanded: true });
    list = mergeChildren(list, answer([], row(0, 'html', 1), [row(0, 'li')]));
    expect(list.get(ROOT_KEY)!.kids).toEqual(['0']);
    // A child read again keeps its own loaded children while its row is the same element's.
    const again = mergeChildren(tree, answer([1], row(1, 'body', 3), [row(0, 'header'), row(1, 'main', 1, { textPreview: 'new text' }), row(2, 'footer')]));
    expect(again.get('1.1')).toMatchObject({ kids: ['1.1.0'], expanded: true, row: { textPreview: 'new text' } });
    // Another element at that path now: it starts afresh, and what was read under it goes.
    const changed = mergeChildren(tree, answer([1], row(1, 'body', 3), [row(0, 'header'), row(1, 'section', 1), row(2, 'footer')]));
    expect(changed.get('1.1')).toMatchObject({ kids: null, kidSet: null, expanded: false, row: { tag: 'section' } });
    expect(changed.has('1.1.0')).toBe(false);
    // A child no longer listed goes, with what is under it.
    const fewer = mergeChildren(tree, answer([1], row(1, 'body', 1), [row(0, 'header')]));
    expect([...fewer.keys()].sort()).toEqual(['', '0', '1', '1.0']);
  });

  test('inspector-tree-keys', () => {
    const rows = visibleRows(sampleTree());
    const act = (key: string, at: string) => treeKeyAction(key, rows, at);
    expect(act('ArrowDown', '')).toEqual({ type: 'focus', key: '0' });
    expect(act('ArrowUp', '0')).toEqual({ type: 'focus', key: '' });
    expect(act('ArrowUp', '')).toBeNull();
    expect(act('ArrowDown', '1.2')).toBeNull();
    expect(act('Home', '1.1.0')).toEqual({ type: 'focus', key: '' });
    expect(act('End', '')).toEqual({ type: 'focus', key: '1.2' });
    // → opens a closed row, then moves into it; ← closes an open row, else goes to the parent.
    expect(act('ArrowRight', '0')).toEqual({ type: 'expand', key: '0' });
    expect(act('ArrowRight', '1.1')).toEqual({ type: 'focus', key: '1.1.0' });
    expect(act('ArrowRight', '1.0')).toBeNull(); // no children
    expect(act('ArrowLeft', '1.1')).toEqual({ type: 'collapse', key: '1.1' });
    expect(act('ArrowLeft', '1.1.0')).toEqual({ type: 'focus', key: '1.1' });
    expect(act('ArrowLeft', '0')).toEqual({ type: 'focus', key: '' });
    expect(act('ArrowLeft', '')).toEqual({ type: 'collapse', key: '' });
    expect(treeKeyAction('ArrowLeft', visibleRows(setExpanded(sampleTree(), ROOT_KEY, false)), '')).toBeNull();
    expect(act('Enter', '1.1.0')).toEqual({ type: 'select', key: '1.1.0' });
    expect(act(' ', '1')).toEqual({ type: 'select', key: '1' });
    expect(act('a', '1')).toBeNull();
    // On "Show more": Enter and Space read the next children; ← goes to its node.
    const paged = visibleRows(mergeChildren(new Map(), answer([], row(0, 'html', 5), [row(0, 'li')], true)));
    expect(treeKeyAction('ArrowDown', paged, '0')).toEqual({ type: 'focus', key: moreKey('') });
    expect(treeKeyAction('Enter', paged, moreKey(''))).toEqual({ type: 'more', key: '' });
    expect(treeKeyAction(' ', paged, moreKey(''))).toEqual({ type: 'more', key: '' });
    expect(treeKeyAction('ArrowLeft', paged, moreKey(''))).toEqual({ type: 'focus', key: '' });
    expect(treeKeyAction('ArrowRight', paged, moreKey(''))).toBeNull();
    expect(act('ArrowDown', 'missing')).toBeNull();
  });

  test('inspector-details-text', () => {
    const node: InspectorNode = {
      tag: 'a',
      attributes: [],
      attributesMore: false,
      box: { x: 10.123, y: -4, width: 120, height: 18.5 },
      offset: { x: 10.123, y: 996 },
      styles: [],
      region: 'nav',
      seo: { headingLevel: null, link: { href: 'https://example.com/x', rel: '', target: '_blank' }, image: null, meta: null, linkRel: null, lang: null },
      childElementCount: 1,
    };
    expect(boxText(node.box)).toBe('120 × 18.5 at (10.12, -4)');
    expect(summaryRows(node)).toEqual([
      ['Tag', '<a>'],
      ['Box', '120 × 18.5 at (10.12, -4)'],
      ['In the document', '(10.12, 996)'],
      ['Region', 'Navigation'],
      ['Child elements', '1'],
    ]);
    expect(seoRows(node)).toEqual([
      ['Link', 'https://example.com/x'],
      ['rel', '(none)'],
      ['target', '_blank'],
      ['Language', '(not set)'],
    ]);
    const heading = { ...node, tag: 'h1', seo: { ...node.seo, link: null, headingLevel: 1, lang: 'en' } };
    expect(seoRows(heading)).toEqual([
      ['Heading level', 'H1'],
      ['Language', 'en'],
    ]);
    const image = { ...node, seo: { ...node.seo, link: null, image: { src: 'https://example.com/i.png', alt: null, naturalWidth: 4, naturalHeight: 3 }, meta: { name: 'robots', content: 'noindex' }, linkRel: { rel: 'canonical', href: 'https://example.com/c' } } };
    expect(seoRows(image)).toEqual([
      ['Image', 'https://example.com/i.png'],
      ['alt', '(missing)'],
      ['Natural size', '4 × 3'],
      ['meta robots', 'noindex'],
      ['link rel=canonical', 'https://example.com/c'],
      ['Language', '(not set)'],
    ]);
    expect(pickOutcomeText({ status: 'picked', docToken: TOKEN, path: [1] })).toBe('Element picked.');
    expect(pickOutcomeText({ status: 'refused', reason: 'cancelled' })).toBe(INSPECTOR_REFUSAL_MESSAGES.cancelled);
    expect(pickOutcomeText(null)).toBe(INSPECTOR_REFUSAL_MESSAGES.failed);
  });

  test('inspector-palette-actions', async () => {
    // The rail lists the Inspector after Changes, and the feature owns its palette jump.
    expect(SEO_PANELS.map((panel) => panel.id).slice(-2)).toEqual(['changes', 'inspector']);
    expect(FEATURE_PANEL_JUMPS).toContain('inspector');
    const picked: InspectorPickAnswer = { status: 'picked', docToken: TOKEN, path: [1, 1, 0] };
    const api = { pick: vi.fn(async (_tabId: number): Promise<InspectorPickAnswer> => picked) };
    const registry = createPaletteRegistry();
    registry.register(...builtinPaletteSources(new Proxy({}, { get: () => vi.fn(async () => true) }) as PaletteApi), ...inspectorPaletteSources(api));
    const ctxFor = (changes: Partial<TabState> | undefined): PaletteContext => {
      const active = changes === undefined ? undefined : ({ id: 3, url: URL_A, title: 'A', loading: false, crashed: false, documentSeq: 1, highlight: 'off', highlightPhrase: null, ...changes } as TabState);
      const state = { version: 1, tabs: active ? [active] : [], activeTabId: active?.id ?? null } as unknown as BrowserState;
      const audit: SeoAuditResponse = { status: 'ready', url: URL_A, audit: { url: URL_A, takenAt: 1 } as unknown as SeoAudit };
      return { state, tab: active, audit, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };
    };
    const ids = (ctx: PaletteContext) => registry.resolve(ctx).map((action) => action.id);
    const ctx = ctxFor({});
    // One jump only (the built-ins leave theirs out).
    expect(ids(ctx).filter((id) => id === 'panel.inspector')).toHaveLength(1);
    expect(ids(ctx)).toContain('inspector.pick');
    const action = (id: string) => registry.resolve(ctx).find((a) => a.id === id)!;
    await action('panel.inspector').run(ctx);
    expect(ctx.chrome.openPanel).toHaveBeenCalledWith('inspector', { focus: true });
    await expect(Promise.resolve(action('inspector.pick').run(ctx))).resolves.toBe('Element picked.');
    expect(api.pick).toHaveBeenCalledWith(3);
    expect(ctx.chrome.openPanel).toHaveBeenLastCalledWith('inspector');
    api.pick.mockResolvedValueOnce({ status: 'refused', reason: 'busy' });
    await expect(Promise.resolve(action('inspector.pick').run(ctx))).resolves.toBe(INSPECTOR_REFUSAL_MESSAGES.busy);
    // Only on a web page.
    for (const changes of [{ url: 'about:blank' }, { crashed: true }, undefined]) {
      const other = ctxFor(changes);
      expect(ids(other)).toContain('panel.inspector');
      expect(ids(other)).not.toContain('inspector.pick');
    }
  });

  test('source-lines-are-text', async () => {
    const hostile = '<!DOCTYPE html>\n<html><head><script>alert("x")</script></head>\r\n<body onload="steal()"><img src=x onerror=alert(1)>\r<p>مرحبا</p></body></html>';
    const { rows, cut, lines } = sourceRows(hostile);
    // Lines split on \n, \r\n and \r; each row is the page's text as a plain string, numbered from 1.
    expect(lines).toBe(4);
    expect(cut).toBe(false);
    expect(rows).toEqual([
      { line: 1, text: '<!DOCTYPE html>' },
      { line: 2, text: '<html><head><script>alert("x")</script></head>' },
      { line: 3, text: '<body onload="steal()"><img src=x onerror=alert(1)>' },
      { line: 4, text: '<p>مرحبا</p></body></html>' },
    ]);
    expect(rows.map((r) => r.text).join('\n')).toBe(hostile.replace(/\r\n?/g, '\n'));
    // A long line wraps into rows of `rowChars` (only the first carries its number), never splitting a surrogate pair.
    const view = { ...INSPECTOR_SOURCE_VIEW, rowChars: 4, maxRows: 6 };
    expect(sourceRows('abcdefghij\nk', view).rows).toEqual([
      { line: 1, text: 'abcd' },
      { line: null, text: 'efgh' },
      { line: null, text: 'ij' },
      { line: 2, text: 'k' },
    ]);
    expect(sourceRows('abc😀d', view).rows.map((r) => r.text)).toEqual(['abc', '😀d']);
    expect(sourceRows('', view)).toEqual({ rows: [{ line: 1, text: '' }], cut: false, lines: 1 });
    // At most `maxRows` rows: the rest is cut, and said so.
    const many = sourceRows('a\n'.repeat(20), view);
    expect(many.rows).toHaveLength(6);
    expect(many.cut).toBe(true);
    // The largest source stays a bounded list: one long line, or nothing but line breaks.
    expect(sourceRows('x'.repeat(INSPECTOR_SOURCE_MAX_CHARS)).rows).toHaveLength(Math.ceil(INSPECTOR_SOURCE_MAX_CHARS / INSPECTOR_SOURCE_VIEW.rowChars));
    const breaks = sourceRows('\n'.repeat(INSPECTOR_SOURCE_MAX_CHARS));
    expect([breaks.rows.length, breaks.cut]).toEqual([INSPECTOR_SOURCE_VIEW.maxRows, true]);
    // Find: case-insensitive, within a row, capped; a blank query finds nothing.
    const found = sourceRows('<H1>Title</H1>\n<p>title again</p>\n<p>none</p>');
    expect(findRows(found.rows, 'TITLE')).toEqual([0, 1]);
    expect(findRows(found.rows, '  ')).toEqual([]);
    expect(findRows(sourceRows('x\n'.repeat(10)).rows, 'x', 3)).toEqual([0, 1, 2]);

    // The panel's line list renders every row as text: the page's markup never becomes markup.
    const { SourceLines } = await import('../components/changes/Inspector');
    const html = renderToStaticMarkup(createElement(SourceLines, { rows, start: 0, end: rows.length, matches: [2], current: 2 }));
    // No tag of the page's, and no attribute of its: its quotes and angle brackets are escaped text.
    expect(html).not.toMatch(/<(script|img|body|p|html|head)\b/i);
    expect(html).not.toContain('onload="');
    expect(html).toContain('&lt;body onload=&quot;steal()&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('<bdi dir="auto">&lt;p&gt;مرحبا&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;</bdi>');
    expect(html).toMatch(/data-line="3"[^>]*data-match="true"[^>]*aria-current="true"/);
    // Only the window's rows are rendered, each with its index in the whole source.
    const windowed = renderToStaticMarkup(createElement(SourceLines, { rows, start: 1, end: 3, matches: [], current: null }));
    expect(windowed.match(/<li/g)).toHaveLength(2);
    expect([...windowed.matchAll(/data-row="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2']);
  });

  test('source-window-bounded', () => {
    const view = { pageRows: 500, maxRendered: 1_000 };
    const total = INSPECTOR_SOURCE_VIEW.maxRows;
    expect(firstWindow(total, view)).toEqual({ start: 0, end: 500 });
    expect(firstWindow(30, view)).toEqual({ start: 0, end: 30 });
    // A match inside the window keeps it; one far away renders the page of rows around it, never everything before it.
    const first = firstWindow(total, view);
    expect(windowAround(first, 499, total, view)).toBe(first);
    expect(windowAround(first, 99_000, total, view)).toEqual({ start: 98_750, end: 99_250 });
    expect(windowAround(first, total - 1, total, view)).toEqual({ start: total - 500, end: total });
    expect(windowAround({ start: 50_000, end: 50_500 }, 3, total, view)).toEqual({ start: 0, end: 500 });
    expect(windowAround(firstWindow(30, view), 29, 30, view)).toEqual({ start: 0, end: 30 });
    // Showing more lines after or before adds a page, never more than `maxRendered` rows at once.
    let win = first;
    for (let i = 0; i < 400; i++) {
      win = extendWindow(win, 'after', total, view);
      expect(win.end - win.start).toBeLessThanOrEqual(view.maxRendered);
    }
    expect(win).toEqual({ start: total - 1_000, end: total });
    for (let i = 0; i < 400; i++) {
      win = extendWindow(win, 'before', total, view);
      expect(win.end - win.start).toBeLessThanOrEqual(view.maxRendered);
    }
    expect(win).toEqual({ start: 0, end: 1_000 });
    expect(extendWindow({ start: 0, end: 500 }, 'after', 700, view)).toEqual({ start: 0, end: 700 });
    // The spec's own bound on what is rendered at once.
    expect(INSPECTOR_SOURCE_VIEW.maxRendered * INSPECTOR_SOURCE_VIEW.rowChars).toBeLessThanOrEqual(1_000_000);
  });
});
