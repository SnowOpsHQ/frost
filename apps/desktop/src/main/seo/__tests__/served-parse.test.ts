// Spec: specs/seo-javascript.spec.ts (SERVED_PARSE_LIMITS, SERVED_LEAD_TEXT_MAX_CHARS), specs/seo-javascript.schema.ts (ServedSnapshotSchema)
// Acceptance: specs/seo-javascript.feature.md (Parsing); review focus served-html-is-bounded
import { describe, expect, test } from 'vitest';
import { SERVED_LEAD_TEXT_MAX_CHARS, SERVED_PARSE_LIMITS } from '@app/specs/seo-javascript.spec';
import { ServedSnapshotSchema, type ServedSnapshot } from '@app/specs/seo-javascript.schema';
import { charsetOf, countWords, decodeServed, parseServedHtml, type ParseLimits } from '../served-parse';

const URL_A = 'https://www.example.com/guides/tea?x=1';
const encode = (html: string) => new TextEncoder().encode(html);

function served(html: string | Uint8Array, contentType: string | null = 'text/html; charset=utf-8', url = URL_A, limits: ParseLimits = SERVED_PARSE_LIMITS): ServedSnapshot {
  const result = parseServedHtml({ url, contentType, body: typeof html === 'string' ? encode(html) : html }, limits);
  if (!result.ok) throw new Error(`parse failed: ${result.reason}`);
  expect(ServedSnapshotSchema.safeParse(result.snapshot).success).toBe(true);
  return result.snapshot;
}

describe('served HTML parse', () => {
  test('served-parse-reads-fields', () => {
    const s = served(`<!doctype html><html lang=" en-GB "><head>
      <title>  Tea,
        brewed well </title>
      <meta name="Description" content="How to   brew tea.">
      <meta name="robots" content="NOINDEX, follow"><meta name="googlebot" content="nosnippet"><meta name="other" content="x">
      <link rel="canonical" href=" /guides/tea ">
      <meta property="og:url" content=" https://example.com/og ">
      <meta name="viewport" content="width=device-width,  initial-scale=1">
      <link rel="alternate" hreflang="de" href="/de/tee">
      <base href="https://cdn.example.com/base/">
      <script type="application/LD+json">{"@type":"Article"}</script>
    </head><body>
      <h1>Tea <span>guide</span></h1><h2 hidden>Hidden heading</h2>
      <a href="next">Next page</a>
      <a href="https://www.example.com/x" rel="NoFollow Sponsored" target="_blank"><img src="i.png" alt="Pic"></a>
      <a href="https://other.example/" aria-label="Elsewhere"></a>
      <a href="mailto:a@example.com" title="Mail"></a>
      <a>no href</a>
      <map><area href="/area" alt="Area"></map>
      <img src="/a.png"><img alt="">
      <template><a href="/in-template">t</a><h1>T</h1></template>
      <svg><a href="/svg-link"><text>s</text></a><title>svg title</title></svg>
    </body></html>`);
    expect(s.url).toBe(URL_A);
    expect(s.lang).toBe('en-GB');
    expect(s.titles).toEqual([{ text: 'Tea, brewed well', length: 16 }]);
    expect(s.titleTotal).toBe(1);
    expect(s.metaDescriptions).toEqual([{ text: 'How to brew tea.', length: 16 }]);
    expect(s.metaRobots).toEqual([
      { name: 'robots', content: 'noindex, follow' },
      { name: 'googlebot', content: 'nosnippet' },
    ]);
    // Resolved against the `<base href>`, as the browser resolves it.
    expect(s.canonicals).toEqual([{ href: '/guides/tea', resolved: 'https://cdn.example.com/guides/tea' }]);
    expect(s.ogUrl).toBe('https://example.com/og');
    expect(s.viewport).toBe('width=device-width, initial-scale=1');
    expect(s.hreflang).toEqual([{ hreflang: 'de', href: '/de/tee', resolved: 'https://cdn.example.com/de/tee' }]);
    expect(s.jsonLd).toEqual([{ text: '{"@type":"Article"}', length: 19 }]);
    // Every heading (no visibility check), never a template's.
    expect(s.headings).toEqual([
      { level: 1, text: 'Tea guide' },
      { level: 2, text: 'Hidden heading' },
    ]);
    expect(s.links).toEqual([
      { href: 'https://cdn.example.com/base/next', scheme: 'https:', rel: '', text: 'Next page', kind: 'external', target: null },
      { href: 'https://www.example.com/x', scheme: 'https:', rel: 'nofollow sponsored', text: 'Pic', kind: 'internal', target: '_blank' },
      { href: 'https://other.example/', scheme: 'https:', rel: '', text: 'Elsewhere', kind: 'external', target: null },
      { href: 'mailto:a@example.com', scheme: 'mailto:', rel: '', text: 'Mail', kind: 'other', target: null },
      { href: 'https://cdn.example.com/area', scheme: 'https:', rel: '', text: '', kind: 'external', target: null },
    ]);
    expect(s.linkTotal).toBe(5);
    expect(s.images).toEqual([
      { src: 'https://cdn.example.com/base/i.png', alt: { text: 'Pic', length: 3 } },
      { src: 'https://cdn.example.com/a.png', alt: null },
      { src: '', alt: { text: '', length: 0 } },
    ]);
    expect(s.partial).toBe(false);
  });

  test('served-parse-word-count', () => {
    const s = served(`<html><head><title>Not counted</title></head><body>
      <p>One two three</p><div hidden>four five</div>
      <script>var six = 7;</script><style>.x{}</style><template>eight</template>
      <svg><text>nine</text></svg><iframe>ten</iframe>
      <p>东京是日本的首都</p>
      <noscript><p>Please enable JavaScript to read this article</p><a href="/static">Static version</a></noscript>
      <noscript></noscript>
    </body></html>`);
    expect(s.wordCount).toBe(3 + countWords('东京是日本的首都'));
    expect(countWords('东京是日本的首都')).toBeGreaterThan(1);
    expect(s.textTruncated).toBe(false);
    expect(s.noscript).toEqual({ count: 2, wordCount: 9, linkCount: 1 });
  });

  test('lead-text-capped-and-hidden-text-skipped', () => {
    // The body's text in the word count's walk: skipped subtrees and `[hidden]` are left out,
    // whitespace collapses, and text nodes join with one space.
    const s = served(`<html><head><title>Not lead</title></head><body>
      <h1>Brewing   green
        tea</h1><p>Use <b>water</b> at 80°C.</p><div hidden>Signed-in secret</div>
      <script>var secret = 1;</script><style>.secret{}</style><template>secret</template>
      <svg><text>secret</text></svg><iframe>secret</iframe><noscript>secret</noscript>
      <p>东京</p>
    </body></html>`);
    expect(s.leadText).toBe('Brewing green tea Use water at 80°C. 东京');
    expect(ServedSnapshotSchema.safeParse(s).success).toBe(true);
    // Capped at SERVED_LEAD_TEXT_MAX_CHARS, never splitting a surrogate pair.
    const long = served(`<body><p>${'word '.repeat(2_000)}</p><p>${'😀'.repeat(3_000)}</p></body>`);
    expect(long.leadText!.length).toBeLessThanOrEqual(SERVED_LEAD_TEXT_MAX_CHARS);
    expect(long.leadText!.length).toBeGreaterThan(SERVED_LEAD_TEXT_MAX_CHARS - 2);
    expect(long.leadText!.startsWith('word word')).toBe(true);
    expect(/[\ud800-\udbff]$/.test(long.leadText!)).toBe(false);
    // A huge whitespace run costs nothing extra and adds nothing.
    expect(served(`<body><p>${' \n'.repeat(50_000)}</p><p>After</p></body>`).leadText).toBe('After');
    // No body text: empty.
    expect(served('<html><head><title>T</title></head><body></body></html>').leadText).toBe('');
  });

  test('served-parse-decodes', () => {
    expect(charsetOf('text/html; charset="ISO-8859-1"')).toBe('ISO-8859-1');
    expect(charsetOf('text/html')).toBeNull();
    const latin1 = Uint8Array.from([...encode('<title>caf'), 0xe9, ...encode('</title>')]);
    expect(decodeServed(latin1, 'text/html; charset=iso-8859-1')).toContain('café');
    // A meta charset in the first bytes.
    const meta = Uint8Array.from([...encode('<meta charset="windows-1252"><title>caf'), 0xe9, ...encode('</title>')]);
    expect(served(meta, 'text/html').titles[0]!.text).toBe('café');
    // A BOM wins over the header.
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...encode('<title>naïve</title>')]);
    expect(served(bom, 'text/html; charset=iso-8859-1').titles[0]!.text).toBe('naïve');
    // An unknown label, or none: UTF-8.
    expect(served(encode('<title>naïve</title>'), 'text/html; charset=x-made-up').titles[0]!.text).toBe('naïve');
    expect(served(encode('<title>naïve</title>'), null).titles[0]!.text).toBe('naïve');
  });

  test('served-html-is-bounded', () => {
    // Deep nesting stops at maxDepth.
    const depth = 100_000;
    const deep = `<html><head><title>Deep</title></head><body>${'<div>'.repeat(depth)}deep text${'</div>'.repeat(depth)}<a href="/after">after</a></body></html>`;
    const started = performance.now();
    const nested = served(deep);
    expect(nested.partial).toBe(true);
    expect(nested.titles[0]!.text).toBe('Deep');
    expect(nested.nodes).toBeLessThanOrEqual(SERVED_PARSE_LIMITS.maxDepth + 10);
    // A flood of elements stops at maxNodes.
    const flood = `<html><body>${'<p>w</p>'.repeat(SERVED_PARSE_LIMITS.maxNodes)}</body></html>`;
    const flooded = served(flood);
    expect(flooded.partial).toBe(true);
    expect(flooded.nodes).toBe(SERVED_PARSE_LIMITS.maxNodes + 1);
    expect(flooded.wordCount).toBeLessThanOrEqual(SERVED_PARSE_LIMITS.maxNodes);
    // Both well within the worker's analysis timeout.
    expect(performance.now() - started).toBeLessThan(2_000);
    // Smaller caps (as a test may set them).
    expect(served('<p>a</p><p>b</p><p>c</p>', 'text/html', URL_A, { ...SERVED_PARSE_LIMITS, maxNodes: 6 }).partial).toBe(true);
    // Lists keep their caps, and totals the page's count.
    const links = served(`<body>${'<a href="/x">x</a>'.repeat(1_500)}</body>`);
    expect(links.links).toHaveLength(1_000);
    expect(links.linkTotal).toBe(1_500);
    // Garbage never throws.
    expect(parseServedHtml({ url: URL_A, contentType: null, body: Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256) }).ok).toBe(true);
    expect(parseServedHtml({ url: 'file:///etc/passwd', contentType: null, body: encode('<p>x') })).toEqual({ ok: false, reason: 'parse-failed' });
    expect(parseServedHtml(null as never)).toEqual({ ok: false, reason: 'parse-failed' });
    expect(parseServedHtml({ url: URL_A, contentType: null, body: 'not bytes' as never })).toEqual({ ok: false, reason: 'parse-failed' });
  });

  test('served-parse-attribute-bomb', () => {
    // A tag with 300,000 distinct attributes (about 3 MB): only the first `maxAttributes` are kept,
    // and the tokenizer never compares each new one with all the others.
    const attributes = Array.from({ length: 300_000 }, (_, i) => `a${i}`).join(' ');
    const html = `<html><head><title>Bomb</title></head><body><a href="/first" ${attributes}>link</a><p>after</p></body></html>`;
    const started = performance.now();
    const s = served(html);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(s.links.map((l) => l.href)).toEqual(['https://www.example.com/first']);
    expect(s.wordCount).toBe(2);
    expect(SERVED_PARSE_LIMITS.maxAttributes).toBe(256);
    // The attribute after the cap is not read (an `href` placed late is dropped as a browser would not).
    const late = served(`<body><a ${Array.from({ length: 300 }, (_, i) => `x${i}`).join(' ')} href="/late">late</a></body>`);
    expect(late.linkTotal).toBe(0);
  });

  test('served-parse-template-depth', () => {
    // `<template>` contents count from the template's own depth: nesting cannot hide in them.
    const limits: ParseLimits = { ...SERVED_PARSE_LIMITS, maxDepth: 20 };
    const nested = (n: number) => `${'<div>'.repeat(n)}x${'</div>'.repeat(n)}`;
    const inside = served(`<body>${'<div>'.repeat(10)}<template>${nested(15)}</template>${'</div>'.repeat(10)}</body>`, 'text/html', URL_A, limits);
    expect(inside.partial).toBe(true);
    const shallow = served(`<body><template>${nested(5)}</template><p>ok</p></body>`, 'text/html', URL_A, limits);
    expect(shallow.partial).toBe(false);
    expect(shallow.wordCount).toBe(1);
  });
});
