// Spec: specs/command-palette.spec.ts (PALETTE_QUERY_MAX_CHARS, PALETTE_RECENT_BOOST, PALETTE_GROUPS, PALETTE_RECENT_LABEL)
// Acceptance: specs/command-palette.feature.md (Registry, matcher and recents)
import { describe, expect, test } from 'vitest';
import { PALETTE_GROUPS, PALETTE_QUERY_MAX_CHARS, PALETTE_RECENT_BOOST, PALETTE_RECENT_LABEL, type PaletteGroupId } from '@app/specs/command-palette.spec';
import { matchAction, paletteSections, rankActions } from '../match';

interface Item {
  readonly id: string;
  readonly label: string;
  readonly group: PaletteGroupId;
  readonly keywords?: readonly string[];
}

const item = (id: string, label: string, group: PaletteGroupId = 'page', keywords?: readonly string[]): Item => ({ id, label, group, keywords });
const score = (query: string, label: string, keywords?: readonly string[]) => matchAction(query, { label, keywords })?.score ?? null;
const order = (query: string, items: readonly Item[], recents: readonly string[] = []) => rankActions(query, items, recents).map((r) => r.action.id);

describe('fuzzy matcher', () => {
  test('matcher-prefers-prefix-and-word-starts', () => {
    const prefix = score('zoo', 'Zoom in')!;
    const wordStart = score('zoo', 'Reset zoom')!;
    const substring = score('oom', 'Zoom in')!;
    const subsequence = score('zmn', 'Zoom in')!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    // Shorter labels win a tie.
    expect(score('reload', 'Reload')!).toBeGreaterThan(score('reload', 'Reload, ignoring the cache')!);
    expect(order('reload', [item('long', 'Reload, ignoring the cache'), item('short', 'Reload')])).toEqual(['short', 'long']);
  });

  test('matcher-subsequence-and-indices', () => {
    // "cpt" → C-o-p-y t-he t-itle: the word starts are preferred.
    const match = matchAction('cptitle', { label: 'Copy the title' })!;
    expect(match).not.toBeNull();
    const label = [...'Copy the title'];
    expect(match.indices.map((i) => label[i]).join('').toLowerCase()).toBe('cptitle');
    expect(match.indices).toEqual([0, 2, 9, 10, 11, 12, 13]);
    // A prefix highlights the prefix.
    expect(matchAction('zoo', { label: 'Zoom in' })!.indices).toEqual([0, 1, 2]);
    // Characters out of order never match.
    expect(matchAction('mz', { label: 'Zoom' })).toBeNull();
    expect(matchAction('zoomx', { label: 'Zoom' })).toBeNull();
  });

  test('matcher-all-words-must-match', () => {
    expect(matchAction('copy title', { label: 'Copy the title' })).not.toBeNull();
    expect(matchAction('copy canonical', { label: 'Copy the title' })).toBeNull();
    // A word may match a keyword while another matches the label.
    expect(matchAction('copy seo', { label: 'Copy the title', keywords: ['seo'] })).not.toBeNull();
    // Whitespace alone is no query (everything matches, score 0).
    expect(matchAction('   ', { label: 'Anything' })).toEqual({ score: 0, indices: [] });
  });

  test('matcher-uses-keywords-below-labels', () => {
    const viaKeyword = matchAction('wcag', { label: 'Run the accessibility check', keywords: ['a11y', 'wcag'] })!;
    expect(viaKeyword).not.toBeNull();
    expect(viaKeyword.indices).toEqual([]);
    expect(score('wcag', 'WCAG report')!).toBeGreaterThan(viaKeyword.score);
    expect(order('history', [item('kw', 'Clear browsing data…', 'browser', ['history']), item('label', 'History panel')])).toEqual(['label', 'kw']);
  });

  test('matcher-label-always-beats-keyword', () => {
    // The weakest label match: a scattered subsequence late in a long label.
    const weakest = matchAction('zq', { label: `${'a '.repeat(60)}z${'b'.repeat(80)}q` })!;
    // The strongest keyword match: the keyword is exactly the query, on a short label.
    const strongest = matchAction('zq', { label: 'Other', keywords: ['zq'] })!;
    expect(weakest).not.toBeNull();
    expect(strongest).not.toBeNull();
    expect(weakest.score).toBeGreaterThan(strongest.score);
    // Per word, across a multi-word query: two label words beat a label word and a keyword word.
    const labels = matchAction('copy title', { label: 'Copy the long winded page title', keywords: [] })!;
    const mixed = matchAction('copy title', { label: 'Copy', keywords: ['title'] })!;
    expect(labels.score).toBeGreaterThan(mixed.score);
  });

  test('matcher-folds-case-and-accents', () => {
    const plain = score('zoom', 'Zoom in');
    expect(plain).not.toBeNull();
    expect(score('ZOOM', 'Zoom in')).toBe(plain);
    expect(score('zóom', 'Zoom in')).toBe(plain);
    expect(score('zoom', 'ZÓÓM in')).toBe(plain);
    expect(matchAction('resume', { label: 'Résumé' })!.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('matcher-is-bounded', () => {
    const long = 'a'.repeat(PALETTE_QUERY_MAX_CHARS * 10);
    const label = 'a'.repeat(PALETTE_QUERY_MAX_CHARS);
    const started = performance.now();
    const match = matchAction(long, { label });
    // The query is cut to its cap: it then matches the label exactly.
    expect(match).not.toBeNull();
    expect(match!.indices).toHaveLength(PALETTE_QUERY_MAX_CHARS);
    // A long scattered query against a long label stays fast.
    const scattered = Array.from({ length: PALETTE_QUERY_MAX_CHARS }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    matchAction(scattered, { label: `${'z'.repeat(400)} ${scattered.split('').join('-')}` });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('ranking', () => {
  const items = [
    item('tab.new', 'New tab', 'tabs'),
    item('panel.links', 'Links panel', 'panels'),
    item('copy.title', 'Copy the title', 'copy'),
    item('page.reload', 'Reload', 'page'),
    item('panel.overview', 'Overview panel', 'panels'),
    item('browser.clear', 'Clear browsing data…', 'browser'),
  ];

  test('ranking-recents-first-on-empty-query', () => {
    const sections = paletteSections('', rankActions('', items, ['page.reload', 'gone.away', 'copy.title']));
    expect(sections.map((s) => s.label)).toEqual([PALETTE_RECENT_LABEL, 'SEO panels', 'Tabs', 'Browser']);
    expect(sections[0]!.items.map((r) => r.action.id)).toEqual(['page.reload', 'copy.title']);
    // The other groups in PALETTE_GROUPS order, registration order inside each; recents aren't repeated.
    expect(sections.flatMap((s) => s.items.map((r) => r.action.id))).toEqual(['page.reload', 'copy.title', 'panel.links', 'panel.overview', 'tab.new', 'browser.clear']);
    const groupOrder = PALETTE_GROUPS.map((g) => g.label);
    const shown = sections.slice(1).map((s) => groupOrder.indexOf(s.label as (typeof groupOrder)[number]));
    expect([...shown].sort((a, b) => a - b)).toEqual(shown);
    // A query gives one flat list without headings.
    const flat = paletteSections('panel', rankActions('panel', items, []));
    expect(flat).toHaveLength(1);
    expect(flat[0]!.label).toBeNull();
  });

  test('ranking-recent-boost', () => {
    const two = [item('panel.links', 'Links panel', 'panels'), item('panel.overview', 'Overview panel', 'panels')];
    // Equal matches ("panel" is a word start in both): the recent one first.
    expect(order('panel', two)).toEqual(['panel.links', 'panel.overview']);
    expect(order('panel', two, ['panel.overview'])).toEqual(['panel.overview', 'panel.links']);
    const plain = rankActions('panel', two, []).find((r) => r.action.id === 'panel.overview')!;
    const boosted = rankActions('panel', two, ['panel.overview']).find((r) => r.action.id === 'panel.overview')!;
    expect(boosted.score).toBeCloseTo(plain.score + PALETTE_RECENT_BOOST, 5);
    expect([boosted.recent, plain.recent]).toEqual([true, false]);
    // A clearly better match still ranks first.
    expect(order('links', two, ['panel.overview'])).toEqual(['panel.links']);
    expect(order('li', [item('highlight', 'Toggle highlights', 'audit'), item('panel.links', 'Links panel', 'panels')], ['highlight'])).toEqual(['panel.links', 'highlight']);
  });
});
