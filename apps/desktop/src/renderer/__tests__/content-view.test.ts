// Spec: specs/seo-content.spec.ts (MAX_SNIPPET_VARIANTS, input caps, SNIPPET_BUDGETS_PX; READABILITY_FORMULAS,
// SENTENCE_LIMITS, DIFFICULT_SENTENCE_REASONS, Phase 8), specs/seo-limits.spec.ts (HIGHLIGHT_PHRASE_MAX_CHARS, Phase 11),
// specs/browser.spec.ts (TabState.highlightPhrase); seo-content.spec.ts (SERP_PREVIEW_VARIANTS, SERP_PREVIEW_TOGGLES,
// SERP_PREVIEW_VARIANT_MISSING, SERP_PREVIEW_LIMITS, Phase 11 Task 3)
// Acceptance: specs/seo-content.feature.md (Panel; Keyphrase highlight, Phase 11 Task 2; Result preview facts, Phase 11 Task 3)
import { describe, expect, test } from 'vitest';
import { truncateToWidth, type Readability, type SentenceReport, type SerpPreviewFacts } from '@app/seo-core';
import { MAX_SNIPPET_VARIANTS, READABILITY_FORMULAS, SENTENCE_LIMITS, SERP_PREVIEW_LIMITS, SERP_PREVIEW_VARIANT_MISSING, SERP_PREVIEW_VARIANTS, SNIPPET_BUDGETS_PX, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { HIGHLIGHT_PHRASE_MAX_CHARS } from '@app/specs/seo-limits.spec';
import {
  capInput,
  capQuery,
  cleanSiteName,
  countLabel,
  difficultSentenceItems,
  firstFreeSlot,
  keyphraseToggle,
  ngramBar,
  ratingView,
  ratio,
  readabilityView,
  sentenceStatsView,
  SERP_TOGGLES_ON,
  siteNameOverride,
  snippetIndicator,
  standardPreview,
  variantCard,
  variantChoices,
  widthMeter,
} from '../content-view';

/** Result preview facts as `serpPreview` answers them (Phase 11 Task 3), with `changes`. */
function serpFacts(changes: Partial<SerpPreviewFacts> = {}): SerpPreviewFacts {
  const cut = (text: string, budget: number) => truncateToWidth(text, budget, 'description');
  return {
    siteName: { name: 'Tea House', text: 'Tea House', shown: cut('Tea House', 300), source: 'website-schema', monogram: 'T' },
    breadcrumb: { host: 'example.com', crumbs: [{ name: 'Guides', shown: 'Guides', url: 'https://example.com/guides' }], steps: [{ name: 'Guides', shown: 'Guides', url: 'https://example.com/guides' }], more: false, source: 'breadcrumb-schema', line: cut('example.com › Guides', 450) },
    date: { iso: '2025-01-05', shown: 'Jan 5, 2025', source: 'article-date-published' },
    rating: { value: 4.4, best: 5, worst: 1, count: 120, countOf: 'reviews', stars: 4, shown: '4.4' },
    article: { headline: 'Sencha, brewed' },
    video: { name: 'Brewing sencha', duration: '1:35', uploadDate: { iso: '2024-03-02', shown: 'Mar 2, 2024' }, thumbnail: true },
    recipe: { name: null, totalTime: '1 hr 15 min', yield: '4 glasses', rating: { value: 7.25, best: 10, worst: 0, count: 1, countOf: 'ratings', stars: 4, shown: '7.3' } },
    variants: { standard: true, 'top-stories': true, video: true, recipe: true },
    blocks: [0],
    ...changes,
  };
}

describe('content view', () => {
  // Phase 11 Task 3: the result preview's variant cards and toggles, from the facts alone.
  test('preview-variant-cards', () => {
    const facts = serpFacts();
    expect(variantChoices(facts).map((c) => [c.variant, c.available, c.reason])).toEqual(SERP_PREVIEW_VARIANTS.map((v) => [v, true, null]));
    expect(variantCard('top-stories', facts, 'Page title')).toEqual({
      variant: 'top-stories',
      heading: 'Top stories',
      monogram: 'T',
      lines: [
        { kind: 'site', text: 'Tea House' },
        { kind: 'title', text: 'Sencha, brewed' },
        { kind: 'meta', text: 'Jan 5, 2025' },
      ],
    });
    expect(variantCard('video', facts, 'Page title')!.lines).toEqual([
      { kind: 'badge', text: '1:35' },
      { kind: 'title', text: 'Brewing sencha' },
      { kind: 'meta', text: 'Tea House · Mar 2, 2024' },
    ]);
    // A recipe without a name of its own takes the page title; its own rating, out of ten.
    expect(variantCard('recipe', facts, 'Page title')!.lines).toEqual([
      { kind: 'title', text: 'Page title' },
      { kind: 'site', text: 'Tea House' },
      { kind: 'rating', text: '★★★★☆ Rating: 7.3 of 10 · 1 rating' },
      { kind: 'meta', text: '1 hr 15 min · Makes 4 glasses' },
    ]);
    expect(ratingView(facts.rating!)).toEqual({ stars: '★★★★☆', label: 'Rating: 4.4 · 120 reviews' });
    // Without the nodes: no card, and the choice says why.
    const bare = serpFacts({ article: null, video: null, recipe: null, date: null, rating: null, variants: { standard: true, 'top-stories': false, video: false, recipe: false } });
    expect(variantChoices(bare).filter((c) => !c.available).map((c) => c.reason)).toEqual([SERP_PREVIEW_VARIANT_MISSING['top-stories'], SERP_PREVIEW_VARIANT_MISSING.video, SERP_PREVIEW_VARIANT_MISSING.recipe]);
    for (const variant of ['top-stories', 'video', 'recipe'] as const) expect(variantCard(variant, bare, 'T')).toBeNull();
    // The standard previews and their toggles.
    expect(standardPreview(facts, SERP_TOGGLES_ON)).toEqual({ siteName: 'Tea House', monogram: 'T', trail: 'example.com › Guides', trailTruncated: false, date: 'Jan 5, 2025', rating: { stars: '★★★★☆', label: 'Rating: 4.4 · 120 reviews' } });
    expect(standardPreview(facts, { 'site-name': false, breadcrumb: false, date: false, rating: false })).toEqual({ siteName: 'example.com', monogram: 'E', trail: 'example.com', trailTruncated: false, date: null, rating: null });
    // The site name off on a www. host: the host as the host fallback names it.
    const www = serpFacts({ breadcrumb: { ...facts.breadcrumb, host: 'www.example.com' } });
    expect(standardPreview(www, { ...SERP_TOGGLES_ON, 'site-name': false })).toMatchObject({ siteName: 'example.com', monogram: 'E' });
    // The override as typed: one line, no controls, capped; blank is none.
    expect(cleanSiteName('Tea\nHouse\u0007')).toBe('TeaHouse');
    expect([...cleanSiteName('😀'.repeat(80))].length).toBe(SERP_PREVIEW_LIMITS.maxSiteNameChars);
    expect(siteNameOverride('   ')).toBeUndefined();
    expect(siteNameOverride(' Mine ')).toBe(' Mine ');
  });

  test('ngram-row-highlight-toggle', () => {
    // Off, or another mode: not pressed; pressing asks for keyphrase with the row's own text.
    expect(keyphraseToggle({ highlight: 'off', highlightPhrase: null }, 'running shoes')).toEqual({ pressed: false, available: true, next: { mode: 'keyphrase', phrase: 'running shoes' } });
    expect(keyphraseToggle({ highlight: 'links', highlightPhrase: null }, 'running shoes').pressed).toBe(false);
    // Another phrase on: this row is not pressed, pressing switches to it.
    expect(keyphraseToggle({ highlight: 'keyphrase', highlightPhrase: 'trail' }, 'running shoes')).toMatchObject({ pressed: false, next: { mode: 'keyphrase', phrase: 'running shoes' } });
    // This phrase on: pressed, pressing turns the overlay off.
    expect(keyphraseToggle({ highlight: 'keyphrase', highlightPhrase: 'running shoes' }, 'running shoes')).toEqual({ pressed: true, available: true, next: { mode: 'off' } });
    // A phrase the procedure cannot take (empty, too long, several lines) is not offered.
    expect(keyphraseToggle({ highlight: 'off', highlightPhrase: null }, '').available).toBe(false);
    expect(keyphraseToggle({ highlight: 'off', highlightPhrase: null }, 'x'.repeat(HIGHLIGHT_PHRASE_MAX_CHARS)).available).toBe(true);
    expect(keyphraseToggle({ highlight: 'off', highlightPhrase: null }, 'x'.repeat(HIGHLIGHT_PHRASE_MAX_CHARS + 1)).available).toBe(false);
    for (const breaking of ['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029']) expect(keyphraseToggle({ highlight: 'off', highlightPhrase: null }, `two${breaking}lines`).available).toBe(false);
  });

  test('ngram-bar-classes', () => {
    expect(ngramBar(10, 10)).toBe(100);
    expect(ngramBar(5, 10)).toBe(50);
    expect(ngramBar(1, 3)).toBe(33.3);
    // Never invisible, never past the track.
    expect(ngramBar(1, 1_000)).toBe(2);
    expect(ngramBar(20, 10)).toBe(100);
    expect(ngramBar(0, 10)).toBe(0);
    expect(ngramBar(3, 0)).toBe(0);
  });

  test('width-meter', () => {
    expect(widthMeter(null)).toMatchObject({ state: 'empty', fill: 0 });
    const fits = widthMeter(truncateToWidth('A short title', SNIPPET_BUDGETS_PX.titleDesktop, 'title'));
    expect(fits.state).toBe('fits');
    expect(fits.mark).toBe(80);
    expect(fits.fill).toBeLessThan(fits.mark);
    expect(fits.label).toMatch(/^\d+ px of about 580 px: fits$/);
    const over = widthMeter(truncateToWidth('W'.repeat(40), SNIPPET_BUDGETS_PX.titleDesktop, 'title'));
    expect(over.state).toBe('over');
    expect(over.fill).toBeGreaterThan(over.mark);
    expect(over.label).toBe('755 px of about 580 px: cut');
    // A huge width stops at the track's end.
    expect(widthMeter(truncateToWidth('W'.repeat(400), SNIPPET_BUDGETS_PX.titleDesktop, 'title')).fill).toBe(100);
  });

  test('on-page-length-verdict-uses-width', () => {
    // Since the review the minimum is a width too: narrower than `min` px is short, whatever the count.
    const cut = (width: number, truncated = false) => ({ width, truncated });
    expect(snippetIndicator(null, null, 294)).toBe('missing');
    expect(snippetIndicator(0, null, 294)).toBe('missing');
    expect(snippetIndicator(12, cut(120), 294)).toBe('short');
    expect(snippetIndicator(40, cut(178), 294)).toBe('short');
    // 15 full-width characters (300 px) are long enough.
    expect(snippetIndicator(15, cut(300), 294)).toBe('ok');
    // Over 60 characters but narrow: fine; wide: long, whatever the count.
    expect(snippetIndicator(100, cut(500), 294)).toBe('ok');
    expect(snippetIndicator(40, cut(700, true), 294)).toBe('long');
  });

  test('draft-slots', () => {
    expect(firstFreeSlot([])).toBe(0);
    expect(firstFreeSlot([0, 1, 3])).toBe(2);
    expect(firstFreeSlot(Array.from({ length: MAX_SNIPPET_VARIANTS }, (_, i) => i))).toBeNull();
  });

  test('content-inputs-capped', () => {
    expect(capQuery('q'.repeat(TARGET_QUERY_MAX_CHARS + 5))).toHaveLength(TARGET_QUERY_MAX_CHARS);
    expect(capInput('ab😀', 3)).toBe('ab');
    expect(capInput('abc', 3)).toBe('abc');
  });

  test('count-labels', () => {
    expect(countLabel(1, 'word', 'words')).toBe('1 word');
    expect(countLabel(1200, 'word', 'words')).toBe('1,200 words');
    expect(ratio(120, 20)).toBe('6');
    expect(ratio(1, 0)).toBe('0');
  });

  test('readability-view-formula-and-band', () => {
    const scored = (formula: Extract<Readability, { status: 'ok' }>['formula'], score: number, band: string): Extract<Readability, { status: 'ok' }> => ({ status: 'ok', formula, score, band, words: 120, sentences: 8, syllables: 190 });
    expect(readabilityView(scored('szigriszt-pazos', 58.24, 'Normal'))).toEqual({ formula: 'Szigriszt-Pazos', score: '58.2', band: 'Normal' });
    expect(readabilityView(scored('flesch', 64, 'Plain English'))).toEqual({ formula: 'Flesch reading ease', score: '64.0', band: 'Plain English' });
    expect(readabilityView(scored('amstad', -12.5, 'Very difficult')).score).toBe('-12.5');
    // Every formula is named by its own spec entry.
    for (const formula of Object.values(READABILITY_FORMULAS)) expect(readabilityView(scored(formula.id, 50, 'x')).formula).toBe(formula.name);
  });

  test('sentence-stats-view', () => {
    const report = (changes: Partial<Extract<SentenceReport, { status: 'ok' }>> = {}): SentenceReport => ({
      status: 'ok',
      sentences: 1234,
      averageWords: 14.25,
      longestWords: 41,
      longCount: 3,
      complexWordShare: 0.125,
      difficult: { total: 0, items: [] },
      ...changes,
    });
    expect(sentenceStatsView(report())).toEqual([
      { label: 'Sentences', value: '1,234' },
      { label: 'Words per sentence', value: '14.3' },
      { label: 'Longest sentence', value: '41 words' },
      { label: `Over ${SENTENCE_LIMITS.longSentenceWords} words`, value: '3' },
      { label: 'Complex words', value: '12.5%' },
    ]);
    // No syllable heuristic for the language: no complex-word share.
    expect(sentenceStatsView(report({ complexWordShare: null }))!.map((row) => row.label)).not.toContain('Complex words');
    expect(sentenceStatsView(report({ longestWords: 1, longCount: 0 }))).toContainEqual({ label: 'Longest sentence', value: '1 word' });
    expect(sentenceStatsView({ status: 'not-available', reason: 'no-text' })).toBeNull();
  });

  test('difficult-sentence-items', () => {
    const items = [
      { text: 'A <b>long</b> one, as the page wrote it.', words: 31, reason: 'long' as const },
      { text: 'A dense one.', words: 12, reason: 'complex' as const },
    ];
    const view = difficultSentenceItems({ status: 'ok', sentences: 40, averageWords: 12, longestWords: 31, longCount: 1, complexWordShare: 0.2, difficult: { total: 25, items } });
    expect(view).toEqual({
      heading: 'Difficult sentences (25)',
      items: [
        { text: 'A <b>long</b> one, as the page wrote it.', reason: 'long', chip: 'Long', words: '31 words' },
        { text: 'A dense one.', reason: 'complex', chip: 'Complex', words: '12 words' },
      ],
      more: 'and 23 more',
    });
    // Every difficult sentence listed: nothing more to say; none at all: no list.
    expect(difficultSentenceItems({ status: 'ok', sentences: 2, averageWords: 12, longestWords: 31, longCount: 1, complexWordShare: 0.2, difficult: { total: 2, items } })!.more).toBeNull();
    expect(difficultSentenceItems({ status: 'ok', sentences: 2, averageWords: 5, longestWords: 6, longCount: 0, complexWordShare: 0.1, difficult: { total: 0, items: [] } })).toBeNull();
    expect(difficultSentenceItems({ status: 'not-available', reason: 'no-text' })).toBeNull();
  });
});
