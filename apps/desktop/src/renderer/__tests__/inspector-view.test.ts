// Spec: specs/inspector.spec.ts (INSPECTOR_REFUSAL_MESSAGES, INSPECTOR_REGION_LABELS, the answer types),
// specs/command-palette.spec.ts (FEATURE_PANEL_JUMPS, Registration API), specs/seo-sidebar.spec.ts (SEO_PANELS)
// Acceptance: specs/inspector.feature.md (The panel, Command palette; Scenarios inspector-row-labels,
// inspector-tree-model, inspector-tree-keys, inspector-details-text, inspector-palette-actions)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { FEATURE_PANEL_JUMPS } from '@app/specs/command-palette.spec';
import { INSPECTOR_REFUSAL_MESSAGES, type InspectorChild, type InspectorChildrenAnswer, type InspectorNode, type InspectorPickAnswer } from '@app/specs/inspector.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { inspectorPaletteSources } from '../inspector-palette';
import { ROOT_KEY, boxText, canInspect, mergeChildren, pathKey, pathsToReveal, pickOutcomeText, rowLabel, seoRows, setExpanded, summaryRows, treeKeyAction, visibleRows, type Tree } from '../inspector-view';
import { builtinPaletteSources, type PaletteApi } from '../palette/builtins';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';

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
    expect(visibleRows(tree).map((r) => [r.key, r.level, r.row.tag, r.expanded, r.expandable])).toEqual([
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
    list = mergeChildren(list, answer([], row(0, 'html', 3), [row(2, 'li')], false, 2));
    expect(list.get(ROOT_KEY)).toMatchObject({ kids: ['0', '1', '2'], more: false, expanded: true });
    list = mergeChildren(list, answer([], row(0, 'html', 1), [row(0, 'li')]));
    expect(list.get(ROOT_KEY)!.kids).toEqual(['0']);
    // A child read again keeps its own loaded children.
    const again = mergeChildren(tree, answer([1], row(1, 'body', 3), [row(0, 'header'), row(1, 'main', 1, { id: 'm' }), row(2, 'footer')]));
    expect(again.get('1.1')).toMatchObject({ kids: ['1.1.0'], expanded: true, row: { id: 'm' } });
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
      const active = changes === undefined ? undefined : ({ id: 3, url: URL_A, title: 'A', loading: false, crashed: false, documentSeq: 1, highlight: 'off', ...changes } as TabState);
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
});
