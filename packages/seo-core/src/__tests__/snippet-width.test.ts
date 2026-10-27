// Spec: specs/seo-content.spec.ts (SNIPPET_FONT, SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, Copy as HTML)
// Acceptance: specs/seo-content.feature.md (Widths)
import { describe, expect, test } from 'vitest';
import { SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, SNIPPET_FONT } from '@app/specs/seo-content.spec';
import { escapeHtml, measureSnippet, SNIPPET_FONT_TABLE, snippetHtml, textWidth, truncateToWidth } from '../index';

describe('widths', () => {
  test('width-table-is-generated-data', () => {
    expect(SNIPPET_FONT_TABLE.family).toBe(SNIPPET_FONT.family);
    expect(SNIPPET_FONT_TABLE.sizes).toEqual({ title: SNIPPET_FONT.titlePx, description: SNIPPET_FONT.descriptionPx });
    const chars = [...SNIPPET_FONT_TABLE.chars];
    for (let code = 0x20; code <= 0x7e; code++) expect(chars, `U+${code.toString(16)}`).toContain(String.fromCharCode(code));
    expect(new Set(chars).size).toBe(chars.length);
    for (const kind of ['title', 'description'] as const) {
      const widths = SNIPPET_FONT_TABLE.widths[kind];
      expect(widths).toHaveLength(chars.length);
      // Advances (1/100 px) between a hair and two ems; every one an integer.
      const em = SNIPPET_FONT_TABLE.sizes[kind] * 100;
      for (const width of widths) {
        expect(Number.isInteger(width)).toBe(true);
        expect(width).toBeGreaterThanOrEqual(0);
        expect(width).toBeLessThanOrEqual(em * 2);
      }
      // A sans-serif's proportions: `W` is wider than `i`; the lowercase average about half an em.
      expect(widths[chars.indexOf('W')]!).toBeGreaterThan(widths[chars.indexOf('i')]! * 3);
      expect(SNIPPET_FONT_TABLE.averageLower[kind] / em).toBeGreaterThan(0.4);
      expect(SNIPPET_FONT_TABLE.averageLower[kind] / em).toBeLessThan(0.6);
    }
  });

  test('text-width', () => {
    const at = (char: string) => SNIPPET_FONT_TABLE.widths.title[[...SNIPPET_FONT_TABLE.chars].indexOf(char)]! / 100;
    expect(textWidth('', 'title')).toBe(0);
    expect(textWidth('Wi', 'title')).toBeCloseTo(at('W') + at('i'), 5);
    expect(textWidth('xxxx', 'description')).toBeCloseTo(4 * textWidth('x', 'description'), 5);
    // Missing from the table: a full-width character is one em, any other the lowercase average.
    expect(textWidth('中', 'title')).toBe(SNIPPET_FONT.titlePx * SNIPPET_FONT.wideEm);
    expect(textWidth('ש', 'title')).toBe(SNIPPET_FONT_TABLE.averageLower.title / 100);
    // A combining mark and an invisible format character take no width.
    expect(textWidth('é​', 'title')).toBe(textWidth('e', 'title'));
  });

  test('truncate-at-budget', () => {
    const fits = truncateToWidth('A short title', SNIPPET_BUDGETS_PX.titleDesktop, 'title');
    expect(fits).toMatchObject({ shown: 'A short title', truncated: false });
    const long = 'Green tea for beginners: how to choose, brew and store loose leaf tea at home, step by step';
    const cut = truncateToWidth(long, SNIPPET_BUDGETS_PX.titleDesktop, 'title');
    expect(cut.truncated).toBe(true);
    expect(cut.width).toBeCloseTo(textWidth(long, 'title'), 5);
    expect(cut.shown.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
    expect(textWidth(cut.shown, 'title')).toBeLessThanOrEqual(SNIPPET_BUDGETS_PX.titleDesktop);
    // Cut between words, trailing punctuation dropped.
    const kept = cut.shown.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toMatch(/[\s,]/);
    expect(kept).not.toMatch(/[\s,;:]$/);
    // One unbroken word is cut inside it: `x` is 10 px and the ellipsis 20 px at the title size.
    const word = truncateToWidth('x'.repeat(200), 100, 'title');
    expect(word.shown).toBe(`${'x'.repeat(8)}${SNIPPET_ELLIPSIS}`);
  });

  test('snippet-measure', () => {
    const description = 'x'.repeat(110);
    const m = measureSnippet('  A   title\n with  spaces ', description);
    expect(m.title).toMatchObject({ shown: 'A title with spaces', truncated: false, budget: SNIPPET_BUDGETS_PX.titleDesktop });
    // 110 × 7 px = 770 px: whole on desktop, cut on mobile.
    expect(m.descriptionDesktop).toMatchObject({ truncated: false, width: 770, budget: SNIPPET_BUDGETS_PX.descriptionDesktop });
    expect(m.descriptionMobile).toMatchObject({ truncated: true, width: 770, budget: SNIPPET_BUDGETS_PX.descriptionMobile });
    expect(textWidth(m.descriptionMobile.shown, 'description')).toBeLessThanOrEqual(SNIPPET_BUDGETS_PX.descriptionMobile);
  });

  test('snippet-html-escaped', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    expect(snippetHtml('Fish & chips <best>', 'Say "hi"\n  to  \'everyone\'')).toBe('<title>Fish &amp; chips &lt;best&gt;</title>\n<meta name="description" content="Say &quot;hi&quot; to &#39;everyone&#39;">');
    expect(snippetHtml('Only a title', '  ')).toBe('<title>Only a title</title>');
    expect(snippetHtml('', 'Only a description')).toBe('<meta name="description" content="Only a description">');
    expect(snippetHtml(' ', '')).toBe('');
    // A script in the title stays text.
    expect(snippetHtml('</title><script>alert(1)</script>', '')).toBe('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
  });
});
