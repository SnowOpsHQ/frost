// Spec: specs/seo-checks.spec.ts (SITEMAP_LIMITS, SITEMAP_NAMESPACE, SITEMAP_ERROR_KINDS, HREFLANG_CHECK_LIMITS,
// LINK_ROBOTS_AGENT), specs/seo-checks.schema.ts (ChecksJobSchema)
// Acceptance: specs/seo-checks.feature.md (Worker parsing)
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { SITEMAP_LIMITS, SITEMAP_NAMESPACE } from '@app/specs/seo-checks.spec';
import type { SitemapJob } from '@app/specs/seo-checks.schema';
import { analyseCheck, parseSitemap } from '../checks-analyse';

const NOW = Date.UTC(2026, 9, 27);
const PAGE = 'https://example.com/guides/tea';
const encode = (text: string) => new TextEncoder().encode(text);
const job = (xml: string | Uint8Array, changes: Partial<SitemapJob> = {}): SitemapJob => ({ kind: 'sitemap', bytes: typeof xml === 'string' ? encode(xml) : new Uint8Array(xml), fileUrl: 'https://example.com/sitemap.xml', pageUrl: PAGE, urlBudget: SITEMAP_LIMITS.maxUrls, now: NOW, ...changes });
const urlset = (body: string, ns = SITEMAP_NAMESPACE) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="${ns}">${body}</urlset>`;
const url = (loc: string, lastmod?: string) => `<url><loc>${loc}</loc>${lastmod === undefined ? '' : `<lastmod>${lastmod}</lastmod>`}</url>`;

describe('sitemaps', () => {
  test('sitemap-urlset-listed', () => {
    const read = parseSitemap(job(urlset(`${url('https://example.com/')}${url('  https://example.com/guides/tea#x  ', '2026-10-01')}${url('https://example.com/b', 'last tuesday')}${url('https://example.com/c', '2099-01-01')}<url><loc><![CDATA[https://example.com/d]]></loc></url>`)));
    expect(read).toMatchObject({ type: 'urlset', gzip: false, entries: 5, counted: 5, listed: true, lastmodInvalid: 1, lastmodFuture: 1, error: null });
    expect(read.lastmodSamples).toEqual(['last tuesday (invalid)', '2099-01-01 (future)']);
    expect(parseSitemap(job(urlset(url('https://example.com/other')))).listed).toBe(false);
    // A gzip file (by its magic bytes) is inflated first.
    expect(parseSitemap(job(gzipSync(encode(urlset(url(PAGE))))))).toMatchObject({ gzip: true, counted: 1, listed: true, error: null });
  });

  test('sitemap-index-children', () => {
    const index = `<sitemapindex xmlns="${SITEMAP_NAMESPACE}">${Array.from({ length: 25 }, (_, i) => `<sitemap><loc>https://example.com/s${i}.xml</loc><lastmod>2026-01-01</lastmod></sitemap>`).join('')}<sitemap><loc>javascript:alert(1)</loc></sitemap></sitemapindex>`;
    const read = parseSitemap(job(index));
    expect(read).toMatchObject({ type: 'index', entries: 26, counted: 0, listed: false, error: null });
    expect(read.children).toHaveLength(SITEMAP_LIMITS.maxFiles);
    expect(read.children[0]).toBe('https://example.com/s0.xml');
  });

  test('sitemap-dtd-refused', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset xmlns="${SITEMAP_NAMESPACE}"><url><loc>&xxe;</loc></url></urlset>`;
    expect(parseSitemap(job(xxe))).toMatchObject({ error: 'dtd-refused', counted: 0, type: null });
    expect(parseSitemap(job(`<!DOCTYPE html><urlset xmlns="${SITEMAP_NAMESPACE}"></urlset>`))).toMatchObject({ error: 'dtd-refused' });
  });

  test('sitemap-entity-bomb', () => {
    const levels = Array.from({ length: 10 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i};`.repeat(10)}">`).join('');
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol0 "lol">${levels}]><urlset xmlns="${SITEMAP_NAMESPACE}"><url><loc>&lol10;</loc></url></urlset>`;
    const started = performance.now();
    expect(parseSitemap(job(bomb))).toMatchObject({ error: 'dtd-refused', counted: 0 });
    // Without a DOCTYPE an entity has no definition: malformed, never expanded.
    expect(parseSitemap(job(urlset(url('&lol10;'))))).toMatchObject({ error: 'malformed' });
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('sitemap-gzip-bomb-capped', () => {
    // 60 MB of zeros compress to about 60 KB.
    const bomb = gzipSync(Buffer.alloc(SITEMAP_LIMITS.maxBytes + 10 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const started = performance.now();
    expect(parseSitemap(job(bomb))).toMatchObject({ gzip: true, error: 'too-large', counted: 0 });
    expect(performance.now() - started).toBeLessThan(5_000);
    // Not gzip at all after the magic bytes: malformed.
    expect(parseSitemap(job(new Uint8Array([0x1f, 0x8b, 1, 2, 3])))).toMatchObject({ gzip: true, error: 'malformed' });
  });

  test('sitemap-wrong-namespace', () => {
    expect(parseSitemap(job(urlset(url(PAGE), 'http://example.com/schemas/sitemap/0.84')))).toMatchObject({ error: 'wrong-namespace', type: 'urlset', counted: 1 });
    expect(parseSitemap(job('<urlset><url><loc>x</loc></url></urlset>'))).toMatchObject({ error: 'wrong-namespace' });
    expect(parseSitemap(job('<html><body>Not found</body></html>'))).toMatchObject({ error: 'not-sitemap' });
    expect(parseSitemap(job(urlset(`${url(PAGE)}<url><loc>unclosed`)))).toMatchObject({ error: 'malformed', counted: 1, listed: true });
    expect(parseSitemap(job(''))).toMatchObject({ error: 'malformed' });
    expect(parseSitemap(job('not xml at all'))).toMatchObject({ error: 'malformed' });
  });

  test('sitemap-url-budget', () => {
    const read = parseSitemap(job(urlset(Array.from({ length: 10 }, (_, i) => url(`https://example.com/${i}`)).join('')), { urlBudget: 4 }));
    expect(read).toMatchObject({ counted: 4, error: 'too-many-urls' });
    // A <loc> past the URL cap is not read.
    expect(parseSitemap(job(urlset(url(`https://example.com/${'a'.repeat(SITEMAP_LIMITS.maxLocChars)}`))))).toMatchObject({ counted: 1, listed: false, error: null });
  });
});

describe('alternates and robots.txt', () => {
  test('alternate-return-links', () => {
    const run = (html: string, link: string | null = null) => analyseCheck({ kind: 'hreflang', bytes: encode(html), url: 'https://example.com/de/', link, pageKeys: ['https://example.com/en/'], selfLangs: ['en'] });
    expect(run('<head><link rel="alternate" hreflang="en" href="../en/#top"></head>')).toEqual({ ok: true, kind: 'hreflang', hreflang: { status: 'reciprocal', returnLangs: ['en'] } });
    expect(run('<head><link rel="alternate" hreflang="en-gb" href="/en/"></head>')).toMatchObject({ hreflang: { status: 'wrong-language' } });
    expect(run('<head></head><body><link rel="alternate" hreflang="en" href="/en/"></body>')).toMatchObject({ hreflang: { status: 'missing-return' } });
    expect(run('', '<https://example.com/en/>; rel="alternate"; hreflang="en", </fr/>; rel="alternate"; hreflang="fr"')).toMatchObject({ hreflang: { status: 'reciprocal', returnLangs: ['en'] } });
  });

  test('robots-job-blocks-and-lists-sitemaps', () => {
    const robots = (text: string, outcome = 'ok') => ({ url: 'https://example.com/robots.txt', outcome, status: outcome === 'ok' ? 200 : 404, finalUrl: 'https://example.com/robots.txt', redirects: 0, body: outcome === 'ok' ? encode(text) : new Uint8Array(0), truncated: false });
    const text = 'User-agent: Googlebot\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n\nSitemap: /sitemap_index.xml\nSitemap: https://cdn.example.com/s.xml.gz\nSitemap: ftp://x/y\n';
    expect(analyseCheck({ kind: 'robots', robots: robots(text), urls: ['https://example.com/private/a', 'https://example.com/public', 'https://example.com/'] })).toEqual({
      ok: true,
      kind: 'robots',
      robots: { blocked: [true, false, false], sitemaps: ['https://example.com/sitemap_index.xml', 'https://cdn.example.com/s.xml.gz'] },
    });
    // No fetched file: nothing blocked, no sitemaps.
    expect(analyseCheck({ kind: 'robots', robots: robots('', 'unavailable'), urls: ['https://example.com/x'] })).toMatchObject({ robots: { blocked: [false], sitemaps: [] } });
    expect(analyseCheck({ kind: 'robots', robots: { not: 'robots' }, urls: [] })).toMatchObject({ ok: true, robots: { blocked: [], sitemaps: [] } });
  });

  test('checks-job-validated', () => {
    for (const raw of [null, 'x', {}, { kind: 'sitemap' }, { kind: 'shell', cmd: 'rm' }, { ...job('<x/>'), extra: 1 }, { ...job('<x/>'), fileUrl: 'file:///etc/passwd' }, { ...job('<x/>'), bytes: [1, 2] }, { kind: 'robots', robots: null, urls: ['javascript:x'] }]) {
      expect(analyseCheck(raw)).toEqual({ ok: false, reason: 'invalid-job' });
    }
  });
});

describe('sitemap parse review fixes', () => {
  test('sitemap-depth-capped', () => {
    // 40,000 nested elements: stopped past SITEMAP_LIMITS.maxXmlDepth, fast.
    const deep = `<urlset xmlns="${SITEMAP_NAMESPACE}">${'<a>'.repeat(40_000)}${'</a>'.repeat(40_000)}</urlset>`;
    const started = performance.now();
    expect(parseSitemap(job(deep))).toMatchObject({ error: 'malformed' });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(SITEMAP_LIMITS.maxXmlDepth).toBe(16);
  });

  test('sitemap-listed-by-canonical-and-root', () => {
    const url = (loc: string) => `<url><loc>${loc}</loc></url>`;
    expect(parseSitemap(job(urlset(url('https://example.com/canonical')), { canonicalUrl: 'https://example.com/canonical' })).listed).toBe(true);
    expect(parseSitemap(job(urlset(url('https://example.com/canonical')), { canonicalUrl: null })).listed).toBe(false);
    // The root with or without its slash is one URL; other paths keep theirs.
    expect(parseSitemap(job(urlset(url('https://example.com')), { pageUrl: 'https://example.com/' })).listed).toBe(true);
    expect(parseSitemap(job(urlset(url('https://example.com/guides/tea/')))).listed).toBe(false);
  });
});
