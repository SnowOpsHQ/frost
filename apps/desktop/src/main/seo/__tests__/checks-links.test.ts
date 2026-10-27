// Spec: specs/seo-checks.spec.ts (LINK_CHECK_LIMITS, HEAD_FALLBACK_STATUSES, LINK_SKIP_REASONS)
// Acceptance: specs/seo-checks.feature.md (Link checks); review focus link-checks-are-bounded
import { describe, expect, test } from 'vitest';
import type { PageLink } from '@app/seo-core';
import { LINK_CHECK_LIMITS } from '@app/specs/seo-checks.spec';
import type { CheckFetch, CheckFetchOptions, CheckFetchResult } from '../checks-fetch';
import { checkLink, planLinks } from '../checks-links';

const link = (href: string): PageLink => ({ href, scheme: '', rel: '', text: 'x', kind: 'internal', target: null });
const answer = (status: number, changes: Partial<CheckFetchResult> = {}): CheckFetchResult => ({ outcome: 'response', status, finalUrl: '', redirects: 0, body: new Uint8Array(0), truncated: false, headers: { contentType: null, contentEncoding: null, link: null }, ...changes });

describe('link checks', () => {
  test('link-plan-dedupes-and-skips', () => {
    const plan = planLinks(
      [link('https://example.com/a#one'), link('https://example.com/a#two'), link('mailto:x@example.com'), link('mailto:x@example.com'), link(''), link('http://127.0.0.1:8080/admin'), link('http://192.168.0.1/'), link('http://router.local/'), link('https://other.test/')],
      'https://example.com/page',
    );
    expect(plan.order).toEqual(['https://example.com/a', 'mailto:x@example.com', 'http://127.0.0.1:8080/admin', 'http://192.168.0.1/', 'http://router.local/', 'https://other.test/']);
    expect(plan.candidates).toEqual(['https://example.com/a', 'https://other.test/']);
    expect([...plan.skipped.values()].map((r) => [r.url, r.reason])).toEqual([
      ['mailto:x@example.com', 'not-http'],
      ['http://127.0.0.1:8080/admin', 'private'],
      ['http://192.168.0.1/', 'private'],
      ['http://router.local/', 'private'],
    ]);
    // The cap counts targets that may be fetched; the rest are over it.
    const many = planLinks(Array.from({ length: LINK_CHECK_LIMITS.maxLinks + 7 }, (_, i) => link(`https://example.com/${i}`)), 'https://example.com/');
    expect(many.candidates).toHaveLength(LINK_CHECK_LIMITS.maxLinks);
    expect([...many.skipped.values()].every((r) => r.reason === 'over-cap')).toBe(true);
    expect(many.skipped.size).toBe(7);
  });

  test('link-plan-private-page', () => {
    const plan = planLinks([link('http://127.0.0.1:9/a'), link('http://localhost:3000/')], 'http://127.0.0.1:9/');
    expect(plan.candidates).toEqual(['http://127.0.0.1:9/a', 'http://localhost:3000/']);
  });

  test('head-get-fallback', async () => {
    const asked: CheckFetchOptions[] = [];
    const fetch: CheckFetch = async (_url, options) => {
      asked.push(options);
      return options.method === 'HEAD' ? answer(405) : answer(200, { redirects: 1, finalUrl: 'https://example.com/b/' });
    };
    const getOnly = new Set<string>();
    const signal = new AbortController().signal;
    const result = await checkLink('https://example.com/b', { fetch, page: 'https://example.com/a', userAgent: 'UA', getOnly, signal });
    expect(result).toMatchObject({ kind: 'redirect', status: 200, method: 'GET', finalUrl: 'https://example.com/b/' });
    expect(asked.map((o) => [o.method, o.maxBytes])).toEqual([
      ['HEAD', 0],
      ['GET', LINK_CHECK_LIMITS.getBodyBytes],
    ]);
    expect(asked.every((o) => o.userAgent === 'UA' && o.page === 'https://example.com/a' && o.maxRedirects === LINK_CHECK_LIMITS.maxRedirects && o.timeoutMs <= LINK_CHECK_LIMITS.requestTimeoutMs)).toBe(true);
    // The origin is remembered: its next link goes straight to GET.
    expect(getOnly.has('https://example.com')).toBe(true);
    asked.length = 0;
    await checkLink('https://example.com/c', { fetch, page: 'https://example.com/a', userAgent: null, getOnly, signal });
    expect(asked.map((o) => o.method)).toEqual(['GET']);
    // Any other HEAD answer stands (no GET).
    asked.length = 0;
    const notFound: CheckFetch = async (_url, options) => (asked.push(options), answer(404));
    await expect(checkLink('https://other.test/x', { fetch: notFound, page: 'https://example.com/a', userAgent: null, getOnly, signal })).resolves.toMatchObject({ kind: 'broken', status: 404, method: 'HEAD' });
    expect(asked).toHaveLength(1);
    // A stopped run has no result.
    const controller = new AbortController();
    controller.abort();
    await expect(checkLink('https://other.test/x', { fetch: async () => answer(0, { outcome: 'aborted', status: null }), page: 'https://example.com/a', userAgent: null, getOnly, signal: controller.signal })).resolves.toBeNull();
  });
});
