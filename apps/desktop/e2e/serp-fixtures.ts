// Shared fixtures of the SERP e2e suites (serp.e2e.ts, visibility.e2e.ts; acceptance
// specs/serp-panels.feature.md, End to end): frost's own synthetic result page markup, a selector
// pack for it and an ephemeral Ed25519 key to sign it with. Test code only: the real signing key
// never enters the repo or a test.
import { generateKeyPairSync, sign } from 'node:crypto';
import { packSignatureUrl } from '@app/specs/serp-selector-pack.spec';

/** The synthetic search engine's public-looking name (`--host-resolver-rules`, `--frost-e2e-public-hosts`). */
export const SEARCH_HOST = 'search.frost-e2e.net';
export const PACK_PATH = '/serp-selectors.json';
/** Above the bundled pack's version, so the test pack installs. */
export const PACK_VERSION = 1000;

/** frost's own minimal result page markup (no real engine's): ads, a snippet, organic results and related questions. */
export function resultPage(query: string): string {
  const q = query.replace(/[<>&"]/g, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${q} · frost test search</title></head><body>
<form action="/search"><input name="q" value="${q}"></form>
<div id="ads"><div class="ad"><a href="https://teashop.example/buy"><h3>Buy tea online</h3></a></div></div>
<main id="results">
  <div class="snippet"><a href="https://brewguide.example/what"><h3>What green tea is</h3></a><p>Green tea is tea made from leaves that are not oxidised.</p></div>
  <div class="result"><a href="https://brewguide.example/guide"><h3>A guide to green tea</h3></a></div>
  <div class="result"><a href="https://leafhouse.example/"><h3>Leaf house</h3></a></div>
  <div class="questions"><div class="q">Is green tea good for you?</div><div class="q">How long should green tea brew?</div></div>
  <div class="result"><a href="https://brewguide.example/more"><h3>More about brewing</h3></a></div>
</main></body></html>`;
}

/** A result page whose results area is not there (the pack cannot read it). */
export const UNREADABLE_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A new layout</title></head><body><section id="something-else"><p>Results moved somewhere the selectors do not look.</p></section></body></html>';

/** The test pack: one engine on the synthetic host (frost's own selectors for the markup above). */
export function testPack(): string {
  const pack = {
    format: 1,
    version: PACK_VERSION,
    published: '2026-10-28',
    engines: [
      {
        id: 'frost-e2e',
        label: 'Frost test search',
        hosts: [SEARCH_HOST],
        paths: ['/search'],
        params: { query: ['q'], gl: ['gl'], hl: ['hl'], page: { param: 'start', kind: 'offset', perPage: 10, offsetBase: 0 } },
        layout: {
          results: '#results',
          blocks: [
            { type: 'ad', container: '#ads', item: '.ad', link: 'a[href]', title: 'h3' },
            { type: 'featured-snippet', container: '#results .snippet', link: 'a[href]', title: 'h3' },
            { type: 'people-also-ask', container: '#results .questions', item: '.q' },
            { type: 'organic', container: '#results', item: '.result', link: 'a[href]', title: 'h3', required: true },
          ],
        },
      },
    ],
  };
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/** An ephemeral Ed25519 key (SPKI base64, as `--frost-e2e-serp-pack-key` takes it), and the pack signed with it. */
export function signedTestPack(): { spki: string; bytes: Buffer; signature: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(testPack(), 'utf8');
  return { spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}

/**
 * The synthetic engine's answer for `url` (on `SEARCH_HOST`): the pack and its signature, robots.txt,
 * result pages (`?layout=new`: one the pack cannot read) and a page that is no result page; `null`
 * for anything else.
 */
export function engineAnswer(url: URL, pack: { readonly bytes: Buffer; readonly signature: string }): { status: number; type: string; body: string | Buffer } | null {
  if (url.pathname === PACK_PATH) return { status: 200, type: 'application/json', body: pack.bytes };
  if (url.pathname === packSignatureUrl(PACK_PATH)) return { status: 200, type: 'text/plain', body: pack.signature };
  if (url.pathname === '/robots.txt') return { status: 200, type: 'text/plain', body: 'User-agent: *\nAllow: /\n' };
  if (url.pathname === '/search') return { status: 200, type: 'text/html; charset=utf-8', body: url.searchParams.get('layout') === 'new' ? UNREADABLE_PAGE : resultPage(url.searchParams.get('q') ?? '') };
  if (url.pathname === '/about') return { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About this test search</title></head><body><h1>About</h1><p>Not a result page.</p></body></html>' };
  return null;
}
