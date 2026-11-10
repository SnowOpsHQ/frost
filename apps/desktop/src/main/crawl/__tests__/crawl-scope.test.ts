// Spec: specs/site-crawl.spec.ts (CRAWL_SCOPES, CRAWL_PRIVATE_START_SCOPES, CRAWL_TRACKING_PARAMS, CRAWL_LIMITS)
// Acceptance: specs/site-crawl.feature.md (Fetching, politeness and robots: crawl-scope-host-site-path,
// crawl-strips-tracking-params, crawl-caps-query-variants, crawl-private-start-is-origin-only); plan
// docs/plans/phase-12-big-bets.md Decision 6 and Task 6a
import { describe, expect, test } from 'vitest';
import { CRAWL_LIMITS, CRAWL_TRACKING_PARAMS } from '@app/specs/site-crawl.spec';
import { createCrawlScope, createQueryVariantCap, normaliseCrawlUrl } from '../scope';

const scope = (startUrl: string, kind: 'host' | 'site' | 'path' = 'host', include: string[] = [], exclude: string[] = []) => createCrawlScope({ startUrl, scope: kind, include, exclude });

describe('crawl scope', () => {
  test('crawl-scope-host-site-path', () => {
    const host = scope('https://www.example.com/blog/post');
    expect(host.check('https://www.example.com/')).toBe('in');
    // A public start: either scheme, on the start's own port or a default port only.
    expect(host.check('http://www.example.com/a')).toBe('in');
    expect(host.check('http://www.example.com:80/a')).toBe('in');
    expect(host.check('https://www.example.com:8443/a')).toBe('out-of-scope');
    expect(host.check('http://www.example.com:443/a')).toBe('out-of-scope');
    const onPort = scope('https://www.example.com:8443/');
    expect(onPort.check('http://www.example.com:8443/a')).toBe('in');
    expect(onPort.check('https://www.example.com/a')).toBe('in');
    expect(onPort.check('http://www.example.com/a')).toBe('in');
    expect(onPort.check('https://www.example.com:9000/a')).toBe('out-of-scope');
    // The same port rule for site and path scopes.
    expect(scope('https://example.com/', 'site').check('https://shop.example.com:9229/')).toBe('out-of-scope');
    expect(scope('https://example.com/docs/', 'path').check('https://example.com:9229/docs/x')).toBe('out-of-scope');
    expect(host.check('https://example.com/')).toBe('out-of-scope');
    expect(host.check('https://shop.example.com/')).toBe('out-of-scope');
    expect(host.check('https://other.test.example.org/')).toBe('out-of-scope');

    const site = scope('https://www.example.co.uk/', 'site');
    expect(site.check('https://example.co.uk/a')).toBe('in');
    expect(site.check('https://shop.example.co.uk/a')).toBe('in');
    expect(site.check('https://other.co.uk/a')).toBe('out-of-scope');
    expect(site.check('https://example.com/a')).toBe('out-of-scope');

    const path = scope('https://example.com/docs/guide/intro', 'path');
    expect(path.check('https://example.com/docs/guide/')).toBe('in');
    expect(path.check('https://example.com/docs/guide/more/deep?x=1')).toBe('in');
    expect(path.check('https://example.com/docs/other')).toBe('out-of-scope');
    expect(path.check('https://example.com/docs/guidebook')).toBe('out-of-scope');
    expect(path.check('https://shop.example.com/docs/guide/x')).toBe('out-of-scope');

    // Include (any one) and exclude (none) prefixes, on path and query, literally.
    const prefixed = scope('https://example.com/', 'host', ['/blog', '/news?page='], ['/blog/drafts', '/blog/*']);
    expect(prefixed.check('https://example.com/blog/post')).toBe('in');
    expect(prefixed.check('https://example.com/news?page=2')).toBe('in');
    expect(prefixed.check('https://example.com/news')).toBe('out-of-scope');
    expect(prefixed.check('https://example.com/shop')).toBe('out-of-scope');
    expect(prefixed.check('https://example.com/blog/drafts/1')).toBe('out-of-scope');
    // `*` is a plain character.
    expect(prefixed.check('https://example.com/blog/x')).toBe('in');
    expect(prefixed.check('https://example.com/blog/*x')).toBe('out-of-scope');
    // The start URL itself is always in scope (the crawl begins there).
    expect(prefixed.check('https://example.com/')).toBe('in');

    // A public start never reaches a private host, whatever the scope.
    expect(scope('https://example.com/', 'site').check('http://127.0.0.1/')).toBe('private');
    expect(host.check('http://localhost:3000/')).toBe('private');
    // Not a crawl URL at all.
    expect(host.check('ftp://www.example.com/')).toBe('out-of-scope');
    expect(host.check('not a url')).toBe('out-of-scope');
  });

  test('crawl-private-start-is-origin-only', () => {
    const local = scope('http://127.0.0.1:3000/app/');
    expect(local.privateStart).toBe(true);
    expect(local.check('http://127.0.0.1:3000/')).toBe('in');
    expect(local.check('http://127.0.0.1:3000/app/x?y=1')).toBe('in');
    // Another port, scheme or private host: off the exact origin.
    expect(local.check('http://127.0.0.1:9229/json')).toBe('private');
    expect(local.check('https://127.0.0.1:3000/')).toBe('private');
    expect(local.check('http://127.0.0.2:3000/')).toBe('private');
    expect(local.check('http://192.168.1.10:3000/')).toBe('private');
    expect(local.check('http://localhost:3000/')).toBe('private');
    // A public host is off the exact origin too.
    expect(local.check('https://example.com/')).toBe('private');
    // A name start: the same.
    const dev = scope('http://dev.local/');
    expect(dev.check('http://dev.local:80/a')).toBe('in');
    expect(dev.check('http://dev.local:8080/a')).toBe('private');
    expect(dev.check('http://api.dev.local/a')).toBe('private');
    // The settings schema refuses site and path for a private start; the scope refuses them too.
    expect(() => scope('http://127.0.0.1:3000/', 'site')).toThrow();
    expect(() => scope('http://localhost:3000/', 'path')).toThrow();
    expect(scope('https://example.com/').privateStart).toBe(false);
  });

  test('crawl-strips-tracking-params', () => {
    expect(normaliseCrawlUrl('https://Example.COM:443/a?utm_source=x&id=7&UTM_Medium=y&gclid=abc#top')).toBe('https://example.com/a?id=7');
    // Every listed parameter, any case; the rest kept byte for byte, in order.
    const tracking = CRAWL_TRACKING_PARAMS.map((name, i) => `${i % 2 === 0 ? name.toUpperCase() : name}=v`).join('&');
    expect(normaliseCrawlUrl(`https://example.com/p?b=2&${tracking}&a=%20x+y&flag&a=1`)).toBe('https://example.com/p?b=2&a=%20x+y&flag&a=1');
    // Only tracking parameters: no query left.
    expect(normaliseCrawlUrl('https://example.com/p?utm_campaign=z&fbclid=1')).toBe('https://example.com/p');
    expect(normaliseCrawlUrl('https://example.com/p?')).toBe('https://example.com/p');
    // A parameter whose name only starts like one is kept.
    expect(normaliseCrawlUrl('https://example.com/p?utm_sourcex=1')).toBe('https://example.com/p?utm_sourcex=1');
    // An encoded name is compared decoded.
    expect(normaliseCrawlUrl('https://example.com/p?utm%5Fsource=1&k=v')).toBe('https://example.com/p?k=v');
    // Default ports dropped, fragment dropped, host lowercased, relative URLs resolved against a base.
    expect(normaliseCrawlUrl('HTTP://Example.com:80/x#y')).toBe('http://example.com/x');
    expect(normaliseCrawlUrl('http://example.com:8080/x')).toBe('http://example.com:8080/x');
    expect(normaliseCrawlUrl('../b?utm_id=1', 'https://example.com/a/c/d')).toBe('https://example.com/a/b');
    // Not crawl URLs.
    for (const bad of ['mailto:a@example.com', 'javascript:void(0)', 'ftp://example.com/', 'https://user:pass@example.com/', 'not a url', '']) {
      expect(normaliseCrawlUrl(bad), bad).toBeNull();
    }
    expect(normaliseCrawlUrl(`https://example.com/${'a'.repeat(CRAWL_LIMITS.maxUrlChars)}`)).toBeNull();
  });

  test('crawl-caps-query-variants', () => {
    const cap = createQueryVariantCap();
    for (let i = 0; i < CRAWL_LIMITS.maxQueryVariantsPerPath; i++) expect(cap.admit(`https://example.com/cal?d=${i}`), String(i)).toBe(true);
    expect(cap.admit('https://example.com/cal?d=999')).toBe(false);
    expect(cap.admit('https://example.com/cal?other=1')).toBe(false);
    // The URL without a query is always admitted; another path has its own count; so does another origin.
    expect(cap.admit('https://example.com/cal')).toBe(true);
    expect(cap.admit('https://example.com/list?page=2')).toBe(true);
    expect(cap.admit('https://shop.example.com/cal?d=1')).toBe(true);
    // Bounded: the counter never holds more paths than its limit.
    const small = createQueryVariantCap({ maxPerPath: 2, maxPaths: 10 });
    for (let i = 0; i < 1_000; i++) small.admit(`https://example.com/p${i}?q=1`);
    expect(small.size()).toBeLessThanOrEqual(10);
    expect(small.admit('not a url')).toBe(false);
  });
});
