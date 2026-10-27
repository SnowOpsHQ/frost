// Spec: specs/command-palette.spec.ts (COPY_VALUE_KEYS: what each key writes)
// Acceptance: specs/command-palette.feature.md (Copy values)
import { describe, expect, test } from 'vitest';
import { COPY_VALUE_KEYS } from '@app/specs/command-palette.spec';
import { copyValueOf, runAudit } from '../index';
import { header, okResponse, page, PAGE_URL, text } from './fixtures';

describe('copy values', () => {
  test('copy-value-of-each-key', () => {
    const audit = runAudit(page({ metaRobots: [{ name: 'robots', content: 'index, follow' }, { name: 'googlebot', content: 'noarchive' }] }));
    const values = Object.fromEntries(COPY_VALUE_KEYS.map((key) => [key, copyValueOf(audit, key)]));
    expect(values).toEqual({
      url: PAGE_URL,
      title: 'SEO basics: a practical guide for beginners',
      'meta-description': 'Learn how search engines read your pages, and the handful of on-page fixes that make the biggest difference.',
      canonical: PAGE_URL,
      h1: 'SEO basics',
      'robots-meta': 'robots: index, follow · googlebot: noarchive',
      'status-code': '200',
    });
    // The first H1 that has text, wherever it is in the outline.
    const later = runAudit(page({ headings: [{ level: 2, text: 'Intro' }, { level: 1, text: '' }, { level: 1, text: 'The real one' }], headingTotal: 3 }));
    expect(copyValueOf(later, 'h1')).toBe('The real one');
  });

  test('copy-value-missing-is-null', () => {
    const bare = runAudit(
      page({
        titles: [],
        titleTotal: 0,
        metaDescriptions: [text('')],
        metaDescriptionTotal: 1,
        metaRobots: [],
        headings: [{ level: 2, text: 'Only a section' }],
        headingTotal: 1,
        canonicals: [],
        canonicalTotal: 0,
        response: null,
      }),
    );
    for (const key of ['title', 'meta-description', 'h1', 'robots-meta', 'status-code', 'canonical'] as const) expect(copyValueOf(bare, key), key).toBeNull();
    expect(copyValueOf(bare, 'url')).toBe(PAGE_URL);
    // No status recorded (an in-page navigation): nothing.
    expect(copyValueOf(runAudit(page({ response: okResponse({ status: null, source: 'in-page', headersAvailable: false, headers: [] }) })), 'status-code')).toBeNull();
    // The HTTP Link canonical when the HTML has none (resolved against the page).
    const fromHeader = runAudit(page({ canonicals: [], canonicalTotal: 0, response: okResponse({ headers: [header('link', '</guides/seo>; rel="canonical"')] }) }));
    expect(copyValueOf(fromHeader, 'canonical')).toBe('https://example.com/guides/seo');
  });
});
