// Fixtures of the rank tracking e2e suite (rankings.e2e.ts; acceptance specs/rankings.feature.md, End to
// end; plan phase-10 Task 11): frost's own synthetic result pages whose organic order changes with the
// request count, a challenge page, the signed test pack of serp-fixtures.ts, and the switches that keep
// every request on loopback. Test code only: no real engine's markup, no real host is ever reached.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH } from '@app/specs/serp-selector-pack.spec';
import { PACK_PATH, SEARCH_HOST, engineAnswer, signedTestPack } from './serp-fixtures';

export { PACK_VERSION, SEARCH_HOST } from './serp-fixtures';

/** The project's site and its competitor: each its own registrable domain (Decision 7's owner rule keeps them apart). */
export const SITE_HOST = 'leafhouse-frost-e2e.net';
export const COMPETITOR_HOST = 'brewguide-frost-e2e.net';
/** A domain on every result page, below the site once it moved up. */
export const OTHER_HOST = 'steepdaily-frost-e2e.net';
/** A domain only on the later result pages (Compare's `new`). */
export const NEW_HOST = 'kettlenotes-frost-e2e.net';
/**
 * Every host a result page links to: mapped to loopback too, so nothing of theirs reaches the network.
 * Nothing listens on their ports (80, 443), so a request for one fails there; the fixture server does not see it.
 */
export const RESULT_HOSTS = [SITE_HOST, COMPETITOR_HOST, OTHER_HOST, NEW_HOST] as const;
/** Real hosts frost could open (the AI destinations, Google): never resolved (`~NOTFOUND`, as every other name is), so nothing loads. */
export const NOT_FOUND_HOSTS = ['www.perplexity.ai', 'chatgpt.com', 'www.google.com'] as const;

/** The path of the challenge page (a run's challenge stop is unit-tested; the page is here for a run that reaches it). */
export const CHALLENGE_PATH = '/sorry';

interface Organic {
  readonly url: string;
  readonly title: string;
}

/** The organic order of a query's first request: the site third (the ad above is the site's too, and never counts). */
export const FIRST_ORDER: readonly Organic[] = [
  { url: `https://${COMPETITOR_HOST}/guide`, title: 'A guide to green tea' },
  { url: `https://${OTHER_HOST}/`, title: 'Steep daily' },
  { url: `https://${SITE_HOST}/`, title: 'Leaf house' },
  { url: `https://${COMPETITOR_HOST}/more`, title: 'More about brewing' },
];

/** The organic order of every later request for the query: the site moved up to second, a new domain third, the other one down. */
export const LATER_ORDER: readonly Organic[] = [
  { url: `https://${COMPETITOR_HOST}/guide`, title: 'A guide to green tea' },
  { url: `https://${SITE_HOST}/`, title: 'Leaf house' },
  { url: `https://${NEW_HOST}/`, title: 'Kettle notes' },
  { url: `https://${OTHER_HOST}/`, title: 'Steep daily' },
  { url: `https://${COMPETITOR_HOST}/more`, title: 'More about brewing' },
];

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** frost's own minimal result page (the markup serp-fixtures.ts's test pack reads): an ad, then `organic` in order. */
export function rankPage(query: string, organic: readonly Organic[]): string {
  const q = escape(query);
  const results = organic.map((result) => `  <div class="result"><a href="${escape(result.url)}"><h3>${escape(result.title)}</h3></a></div>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${q} · frost test search</title>
<meta name="description" content="Results of the frost test search for ${q}.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<form action="/search"><input name="q" value="${q}"></form>
<div id="ads"><div class="ad"><a href="https://${SITE_HOST}/shop"><h3>Leaf house tea shop</h3></a></div></div>
<main id="results">
${results}
</main></body></html>`;
}

/** A challenge page in place of results (status 429, nothing the pack reads). */
export const CHALLENGE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Please confirm you are not a robot</title></head><body><main><h1>Unusual traffic</h1><p>Confirm you are a person to continue.</p></main></body></html>';

/** One request the fixture server answered. */
export interface SeenRequest {
  /** The `Host` header without its port. */
  readonly host: string;
  /** Path and query as requested. */
  readonly url: string;
  readonly path: string;
}

export interface RankEngine {
  /** `http://SEARCH_HOST:port`. */
  readonly origin: string;
  /** Every request, in order. */
  readonly seen: SeenRequest[];
  /** How many requests of `/search` named query `q`. */
  requestsFor(q: string): number;
  close(): Promise<void>;
  /** The launch arguments: host rules, public names and the test pack's URL and key. */
  readonly args: readonly string[];
}

/**
 * Starts the synthetic engine on loopback: the signed test pack and its signature, robots.txt, result
 * pages (`/search`: a query's first request gets `FIRST_ORDER`, every later one `LATER_ORDER`, so a
 * reload moves the site up) and the challenge page. Anything else, on any host, is a 404 (and counted).
 */
export async function startRankEngine(): Promise<RankEngine> {
  const pack = signedTestPack();
  const seen: SeenRequest[] = [];
  const counts = new Map<string, number>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push({ host, url: request.url ?? '/', path: url.pathname });
    const html = (status: number, body: string) => response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    if (host !== SEARCH_HOST) return response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      const count = (counts.get(q) ?? 0) + 1;
      counts.set(q, count);
      return html(200, rankPage(q, count === 1 ? FIRST_ORDER : LATER_ORDER));
    }
    if (url.pathname === CHALLENGE_PATH) return html(429, CHALLENGE_PAGE);
    const answer = engineAnswer(url, pack);
    if (answer) return response.writeHead(answer.status, { 'Content-Type': answer.type }).end(answer.body);
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://${SEARCH_HOST}:${port}`;
  const loopback = [SEARCH_HOST, ...RESULT_HOSTS];
  // The named hosts first, then every other name: none resolves (`localhost` stays as it is).
  const rules = [...loopback.map((name) => `MAP ${name} 127.0.0.1`), ...NOT_FOUND_HOSTS.map((name) => `MAP ${name} ~NOTFOUND`), 'MAP * ~NOTFOUND', 'EXCLUDE localhost'].join(', ');
  return {
    origin,
    seen,
    requestsFor: (q) => counts.get(q) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    args: [`--host-resolver-rules=${rules}`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${loopback.join(',')}`, `--${SERP_E2E_PACK_URL_SWITCH}=${origin}${PACK_PATH}`, `--${SERP_E2E_PACK_KEY_SWITCH}=${pack.spki}`],
  };
}
