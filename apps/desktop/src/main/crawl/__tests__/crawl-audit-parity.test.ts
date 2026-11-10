// Spec: specs/site-crawl.spec.ts (CRAWL_RULE_IDS, CRAWL_EXCLUDED_RULES), specs/seo-rules.spec.ts (SEO_RULE_SPECS),
// specs/seo-snapshot.spec.ts (PageSnapshotSchema, PageContextSchema)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: The audit, K-B2); plan
// docs/plans/phase-12-big-bets.md Decision 3 (K-B2: on static fixture pages the served-HTML audit agrees with the sidebar's
// rendered audit for every rule in CRAWL_RULE_IDS; a rule that disagrees is removed from the crawl set) and Task 6b
//
// The sidebar's path is the one its own tests run: the extractor over the page's DOM (jsdom, with Chromium's visibility
// answer), then the analysis worker's audit with what main collected beside it. The crawl's path is the crawl worker's job
// over the same bytes. Both get the same response and robots.txt (the crawl's context builds them from the fetch). The pages
// are static (no script changes the DOM), so the served HTML and the rendered DOM hold the same document.
//
// K-B2's outcome (recorded in CRAWL_EXCLUDED_RULES): CSS-hidden headings made `h1-multiple`, `h1-empty` and
// `heading-level-skipped` report what the sidebar does not, so they left the crawl set; every other rule agrees.
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { crawlContext } from '@app/seo-core';
import { EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SNAPSHOT_LIMITS, SOCIAL_TAGS, SOCIAL_URL_TAGS } from '@app/specs/seo-limits.spec';
import { SECURITY_LIMITS } from '@app/specs/seo-compliance.spec';
import type { PageSnapshot, RobotsFetch } from '@app/specs/seo-snapshot.spec';
import type { CrawlPageJob } from '@app/specs/site-crawl.schema';
import { CRAWL_EXCLUDED_RULES, CRAWL_RULE_IDS } from '@app/specs/site-crawl.spec';
import { analyseSnapshot } from '../../seo/analyse';
import { extractPage, type PageDocument } from '../../seo/extract';
import { extractSecurity, RESOURCE_SELECTOR, type SecurityDocument } from '../../seo/security-extract';
import { analyseCrawlPage } from '../analyse';

const encoder = new TextEncoder();
const CRAWL: ReadonlySet<string> = new Set(CRAWL_RULE_IDS);
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 50}`).join(' ');

interface Fixture {
  readonly name: string;
  readonly url: string;
  readonly html: string;
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly xRobotsTag?: readonly string[];
  readonly chain?: readonly { url: string; status: number; location: string }[];
  readonly robots?: string | 'unreachable' | 'none';
}

const doc = (head: string, body: string, lang = ' lang="en"') => `<!doctype html><html${lang}><head>${head}</head><body>${body}</body></html>`;
const GOOD_HEAD = '<meta charset="utf-8"><title>A complete guide to green tea</title><meta name="description" content="How to choose, brew and store green tea, with the temperatures and times that work for each kind of leaf."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://example.com/tea/green"><meta property="og:url" content="https://example.com/tea/green">';
const HREFLANG_OK = '<link rel="alternate" hreflang="en" href="https://example.com/tea/green"><link rel="alternate" hreflang="de" href="https://example.com/de/tea/green"><link rel="alternate" hreflang="x-default" href="https://example.com/tea/green">';
const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

const FIXTURES: readonly Fixture[] = [
  {
    name: 'a complete page',
    url: 'https://example.com/tea/green',
    html: doc(
      `${GOOD_HEAD}${HREFLANG_OK}${ld('{"@context":"https://schema.org","@type":"Article","headline":"Green tea","author":{"@type":"Person","name":"A. Writer"},"datePublished":"2026-01-02","image":"https://example.com/tea.png"}')}`,
      `<h1>Green tea</h1><h2>Choosing</h2><p>${words(320)}</p><img src="/tea.png" alt="A cup of green tea"><a href="/tea/black">Black tea</a><a href="https://other.example.org/">A friend</a>`,
    ),
    robots: 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n',
  },
  {
    name: 'a bare page',
    url: 'https://example.com/bare',
    html: doc('', `<p>${words(40)}</p><img src="/a.png"><img src="/b.png" alt="${'long alt text '.repeat(20)}"><a href="/x"></a><a href="javascript:void(0)">Run</a><a href="/y" rel="nofollow">Y</a><a href="/z"><img src="/z.png" alt=""></a>`, ''),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'repeated and conflicting head tags',
    url: 'https://example.com/dupes?ref=1',
    html: doc(
      '<title>Short</title><title>Second title</title><meta name="description" content="Short."><meta name="description" content="Another description that is long enough to count as one here."><link rel="canonical" href="/dupes?ref=1"><link rel="canonical" href="https://elsewhere.example.org/dupes"><meta property="og:url" content="https://example.com/other"><meta name="robots" content="noindex, nofollow"><meta name="googlebot" content="noindex"><meta name="viewport" content="width=device-width">',
      `<h1>One</h1><h1></h1><h3>Skipped a level</h3><p>${words(310)}</p>`,
    ),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'a canonical with a query, elsewhere, and a header that disagrees',
    url: 'https://example.com/page',
    html: doc(`${GOOD_HEAD.replace('https://example.com/tea/green', 'https://example.com/other?sort=1')}`, `<h1>Page</h1><p>${words(310)}</p>`),
    headers: { link: '<https://example.com/third>; rel="canonical"' },
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'hreflang problems',
    url: 'https://example.com/intl',
    html: doc(`${GOOD_HEAD}<link rel="alternate" hreflang="english" href="https://example.com/en"><link rel="alternate" hreflang="de" href="/de/intl"><link rel="alternate" hreflang="de" href="https://example.com/de2/intl">`, `<h1>Intl</h1><p>${words(310)}</p>`),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'JSON-LD problems',
    url: 'https://example.com/products/kettle',
    html: doc(
      `${GOOD_HEAD}${ld('{"@context":"https://schema.org","@type":"Product"')}${ld('{"@type":"Product","name":"Kettle"}')}${ld('{"@context":"https://example.org/vocab","@type":"Thing"}')}${ld('{"@context":"https://schema.org","name":"No type"}')}${ld('{"@context":"https://schema.org","@type":"Gadget"}')}${ld('{"@context":"https://schema.org","@type":"Product","url":"/relative","offers":{"@type":"Offer","price":"cheap","priceCurrency":"EUR"}}')}${ld('{"@context":"https://schema.org","@type":"Article","headline":"H","datePublished":"yesterday"}')}${ld('{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":2,"name":"A","item":"https://example.com/a"},{"@type":"ListItem","position":2,"name":"B","item":"https://example.com/b"}]}')}`,
      `<h1>Kettle</h1><p>${words(310)}</p>`,
    ),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'a long, uppercase URL with underscores, behind a redirect chain',
    url: `https://example.com/Guides/Green_Tea/${'segment-'.repeat(20)}end`,
    html: doc(GOOD_HEAD, `<h1>Long</h1><p>${words(310)}</p>`),
    chain: [
      { url: 'http://example.com/old', status: 301, location: 'https://example.com/old' },
      { url: 'https://example.com/old', status: 302, location: `https://example.com/Guides/Green_Tea/${'segment-'.repeat(20)}end` },
    ],
    robots: 'User-agent: Googlebot\nDisallow: /\n',
  },
  {
    name: 'X-Robots-Tag headers and a server error',
    url: 'https://example.com/headers',
    status: 503,
    html: doc(GOOD_HEAD, `<h1>Headers</h1><p>${words(310)}</p>`),
    xRobotsTag: ['noindex', 'googlebot: noindex', 'nofollow'],
    robots: 'unreachable',
  },
  {
    name: 'a client error, robots.txt blocking everyone',
    url: 'https://example.com/missing',
    status: 404,
    html: doc('<title>Not found here at all</title>', '<h1>Not found</h1>'),
    robots: 'User-agent: *\nDisallow: /\n',
  },
  {
    name: 'an empty title, an off-host canonical, another bot\'s noindex',
    url: 'https://example.com/other-bots',
    html: doc('<title>   </title><meta name="description" content="A description that is long enough to count as a real one for this page."><meta name="viewport" content="width=device-width"><link rel="canonical" href="https://elsewhere.example.org/other-bots"><meta name="bingbot" content="noindex">', `<h1>Other bots</h1><p>${words(310)}</p>`),
    xRobotsTag: ['bingbot: noindex'],
    robots: 'User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n',
  },
  {
    name: 'a redirect answered with a body',
    url: 'https://example.com/moved',
    status: 301,
    html: doc(GOOD_HEAD, `<h1>Moved</h1><p>${words(310)}</p>`),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'a JSON-LD block over its cap',
    url: 'https://example.com/huge',
    html: doc(`${GOOD_HEAD}${ld(`{"@context":"https://schema.org","@type":"Article","headline":"${'x'.repeat(SNAPSHOT_LIMITS.maxJsonLdChars)}"}`)}`, `<h1>Huge</h1><p>${words(310)}</p>`),
    robots: 'User-agent: *\nAllow: /\n',
  },
  {
    name: 'a page with no robots.txt',
    url: 'https://example.com/none',
    html: doc(GOOD_HEAD, `<h1>None</h1><p>${words(310)}</p><a href="/a">A</a>`),
    robots: 'none',
  },
];

function robotsOf(fixture: Fixture): RobotsFetch | null {
  const url = `${new URL(fixture.url).origin}/robots.txt`;
  if (fixture.robots === undefined) return null;
  if (fixture.robots === 'unreachable') return { url, outcome: 'server-error', status: 500, finalUrl: url, redirects: 0, body: new Uint8Array(0), truncated: false };
  if (fixture.robots === 'none') return { url, outcome: 'unavailable', status: 404, finalUrl: url, redirects: 0, body: new Uint8Array(0), truncated: false };
  return { url, outcome: 'ok', status: 200, finalUrl: url, redirects: 0, body: encoder.encode(fixture.robots), truncated: false };
}

/** Chromium's `checkVisibility()` (jsdom has none): `false` without a box (`display: none` on it or an ancestor). */
function chromiumVisibility(window: JSDOM['window']): void {
  window.Element.prototype.checkVisibility = function (this: Element) {
    for (let el: Element | null = this; el !== null; el = el.parentElement) if (window.getComputedStyle(el).getPropertyValue('display') === 'none') return false;
    return true;
  };
}

/** The sidebar's rendered audit of `fixture`: the extractor over its DOM, then the worker's audit with the same context. */
function sidebarFindings(fixture: Fixture, headers: Record<string, string>): Set<string> {
  const dom = new JSDOM(fixture.html, { url: fixture.url });
  chromiumVisibility(dom.window);
  const document = dom.window.document;
  const page = extractPage(document as unknown as PageDocument, SNAPSHOT_LIMITS, EXTRACT_BUDGET_MS, ROBOTS_META_NAMES, SOCIAL_TAGS, SOCIAL_URL_TAGS) as PageSnapshot;
  const snapshot = { ...page, security: extractSecurity(document as unknown as SecurityDocument, SECURITY_LIMITS, RESOURCE_SELECTOR) as PageSnapshot['security'] };
  const context = crawlContext({ url: fixture.url, status: fixture.status ?? 200, headers, xRobotsTag: fixture.xRobotsTag ?? [], chain: fixture.chain ?? [] }, robotsOf(fixture));
  const answer = analyseSnapshot(snapshot, context);
  if (!answer.ok) throw new Error(`${fixture.name}: the sidebar's audit did not run (${answer.reason})`);
  return new Set(answer.audit.findings.map((finding) => finding.ruleId).filter((id) => CRAWL.has(id)));
}

/** The crawl's served-HTML audit of `fixture`: the crawl worker's job over the same bytes. */
function crawlFindings(fixture: Fixture, headers: Record<string, string>): Set<string> {
  const job: CrawlPageJob = {
    url: fixture.url,
    contentType: headers['content-type'] ?? null,
    body: encoder.encode(fixture.html),
    status: fixture.status ?? 200,
    headers: headers as CrawlPageJob['headers'],
    xRobotsTag: [...(fixture.xRobotsTag ?? [])],
    chain: [...(fixture.chain ?? [])],
    extractedAt: 1_800_000_000_000,
    durationMs: 10,
    robots: robotsOf(fixture),
  };
  const answer = analyseCrawlPage(job);
  if (!answer.ok) throw new Error(`${fixture.name}: the crawl's audit did not run (${answer.reason})`);
  return new Set(answer.page.findings.map((finding) => finding.id));
}

describe('the served-HTML audit', () => {
  test('crawl-audit-matches-sidebar-on-static-pages', () => {
    const fired = new Set<string>();
    const disagreements: Record<string, { sidebarOnly: string[]; crawlOnly: string[] }> = {};
    for (const fixture of FIXTURES) {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...fixture.headers, ...(fixture.xRobotsTag ? { 'x-robots-tag': fixture.xRobotsTag.join('\n') } : {}) };
      const sidebar = sidebarFindings(fixture, headers);
      const crawl = crawlFindings(fixture, headers);
      for (const id of [...sidebar, ...crawl]) fired.add(id);
      const sidebarOnly = [...sidebar].filter((id) => !crawl.has(id)).sort();
      const crawlOnly = [...crawl].filter((id) => !sidebar.has(id)).sort();
      if (sidebarOnly.length > 0 || crawlOnly.length > 0) disagreements[fixture.name] = { sidebarOnly, crawlOnly };
    }
    // K-B2: never a crawl finding the sidebar would not show, nor one it would show that the crawl misses.
    expect(disagreements).toEqual({});
    // The fixtures exercise the whole rule set: every crawl rule fires somewhere (and agrees there).
    expect(CRAWL_RULE_IDS.filter((id) => !fired.has(id))).toEqual([]);
  });

  test('crawl-audit-never-adds-a-finding-on-hidden-or-microdata-pages', () => {
    // Static pages the served parse reads differently: CSS hiding (no layout) and microdata / RDFa (JSON-LD only). The crawl
    // may miss a finding there, never add one (K-B2 removed the rules that did: h1-multiple, h1-empty, heading-level-skipped).
    const pages: readonly Fixture[] = [
      {
        name: 'headings, words, an image and a link hidden by CSS',
        url: 'https://example.com/hidden',
        html: doc(GOOD_HEAD, `<h1>Visible</h1><div style="display:none"><h1></h1><h4>Deep</h4><p>${words(400)}</p><img src="/h.png"><a href="/e"></a></div><p>${words(100)}</p>`),
        robots: 'User-agent: *\nAllow: /\n',
      },
      {
        name: 'the only H1 hidden by CSS',
        url: 'https://example.com/hidden-h1',
        html: doc(GOOD_HEAD, `<h1 style="display:none">Hidden</h1><h2>Shown</h2><p>${words(310)}</p>`),
        robots: 'User-agent: *\nAllow: /\n',
      },
      {
        name: 'microdata and RDFa with problems',
        url: 'https://example.com/micro',
        html: doc(GOOD_HEAD, `<h1>Micro</h1><p>${words(310)}</p><div itemscope itemtype="https://schema.org/Product"><span itemprop="description">No name</span><a itemprop="url" href="/rel">x</a></div><div vocab="https://schema.org/" typeof="Event"><span property="startDate">soon</span></div>`),
        robots: 'User-agent: *\nAllow: /\n',
      },
    ];
    const missed = new Set<string>();
    for (const fixture of pages) {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      const sidebar = sidebarFindings(fixture, headers);
      const crawl = crawlFindings(fixture, headers);
      expect([...crawl].filter((id) => !sidebar.has(id)), fixture.name).toEqual([]);
      for (const id of sidebar) if (!crawl.has(id)) missed.add(id);
    }
    // What the crawl misses there, and only that: hidden headings and words count for it; it reads JSON-LD only.
    expect([...missed].sort()).toEqual(['content-thin', 'h1-missing', 'schema-date-invalid', 'schema-recommended-missing', 'schema-required-missing']);
    for (const id of ['h1-multiple', 'h1-empty', 'heading-level-skipped']) expect(CRAWL_EXCLUDED_RULES).toHaveProperty(id);
  });
});
