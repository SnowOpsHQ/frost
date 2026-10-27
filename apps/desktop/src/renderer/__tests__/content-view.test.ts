// Spec: specs/seo-content.spec.ts (MAX_SNIPPET_VARIANTS, input caps, SNIPPET_BUDGETS_PX)
// Acceptance: specs/seo-content.feature.md (Panel)
import { describe, expect, test } from 'vitest';
import { truncateToWidth } from '@app/seo-core';
import { MAX_SNIPPET_VARIANTS, SNIPPET_BUDGETS_PX, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { breadcrumb, capInput, capQuery, countLabel, firstFreeSlot, ngramBar, ratio, snippetIndicator, widthMeter } from '../content-view';

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
    expect(snippetIndicator(null, 30, false)).toBe('missing');
    expect(snippetIndicator(0, 30, false)).toBe('missing');
    expect(snippetIndicator(12, 30, false)).toBe('short');
    // Over 60 characters but narrow: fine; wide: long, whatever the count.
    expect(snippetIndicator(100, 30, false)).toBe('ok');
    expect(snippetIndicator(40, 30, true)).toBe('long');
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
});
