// Spec: specs/seo-content.spec.ts (MAX_SNIPPET_VARIANTS, input caps, SNIPPET_BUDGETS_PX; READABILITY_FORMULAS,
// SENTENCE_LIMITS, DIFFICULT_SENTENCE_REASONS, Phase 8)
// Acceptance: specs/seo-content.feature.md (Panel)
import { describe, expect, test } from 'vitest';
import { truncateToWidth, type Readability, type SentenceReport } from '@app/seo-core';
import { MAX_SNIPPET_VARIANTS, READABILITY_FORMULAS, SENTENCE_LIMITS, SNIPPET_BUDGETS_PX, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { breadcrumb, capInput, capQuery, countLabel, difficultSentenceItems, firstFreeSlot, ngramBar, ratio, readabilityView, sentenceStatsView, snippetIndicator, widthMeter } from '../content-view';

describe('content view', () => {
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

  test('breadcrumb-and-labels', () => {
    expect(breadcrumb('https://example.com/guides/green%20tea/')).toEqual({ host: 'example.com', path: ' › guides › green tea' });
    expect(breadcrumb('https://example.com/')).toEqual({ host: 'example.com', path: '' });
    expect(breadcrumb('https://example.com/%E0%A4%A')).toEqual({ host: 'example.com', path: ' › %E0%A4%A' });
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
