// Test-only: the loopback fixture site of `visibility.e2e.ts` and `ai-checks.e2e.ts`, served under a
// public-looking name (`--host-resolver-rules`, `--frost-e2e-public-hosts`: `E2E_PUBLIC_HOSTS_SWITCH`)
// and, for the SERP panel, the synthetic engine of `serp-fixtures.ts` on `SEARCH_HOST`. Every request
// to the site is recorded (path, user agent, whether it carried a cookie), so a test can count what
// frost asked for and as whom. frost's own markup and words; no real site's.
//
// - `/robots.txt`: GPTBot disallowed everywhere, OAI-SearchBot on `/ai/`, everyone else allowed.
// - `/llms.txt`: a file in llmstxt.org's proposed shape (an H1, a summary, a section of links).
// - `/page`: Googlebot alone is told `noindex`; ClaudeBot gets a much shorter page.
// - `/slow`: answers crawlers only after `slowMs` (browsers at once).
// - `/ai/guide`: a plain, indexable article (its own canonical, no script).
// - `/club`: one page, two versions: with the `club=member` cookie (set by `/club/login`) a member's
//   page (`CLUB.member`), without it the public one (`CLUB.visitor`), as a signed-in site does.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SEARCH_HOST, engineAnswer } from './serp-fixtures';

/** The probed site's public-looking name. */
export const SITE_HOST = 'probes.frost-e2e.net';
/**
 * A second name for the same site: its own origin, so its `/llms.txt` and robots.txt are cached apart
 * from `SITE_HOST`'s (main keeps both per origin), whatever ran on `SITE_HOST` before.
 */
export const SECOND_HOST = 'readiness.frost-e2e.net';

/** A crawler's user agent (frost's own and a browser's are not). */
export const CRAWLER = /googlebot|bingbot|gptbot|claudebot|perplexitybot|oai-searchbot|chatgpt-user/i;

export const ROBOTS_TXT = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /ai/\n\nUser-agent: *\nAllow: /\n';

export const LLMS_TXT_TITLE = 'Frost test tea house';
export const LLMS_TXT = `# ${LLMS_TXT_TITLE}\n\n> A loopback tea shop frost's tests probe.\n\n## Guides\n\n- [Green tea guide](/ai/guide): how to brew green tea\n- [Visiting](/page): the shop's page\n`;

/** The two versions of `/club`: the member's (cookie) text never reaches an anonymous visitor. */
export const CLUB = {
  visitor: { title: 'The tea club: join us', text: 'Members get a new loose leaf tea every month. Join the club to start.' },
  member: { title: 'Welcome back, Ada', text: 'Your order history: MEMBER-ONLY-ORDER-7731, a tin of sencha shipped to 12 Leaf Lane.' },
} as const;
export const CLUB_COOKIE = 'club=member';

export interface Seen {
  readonly host: string;
  readonly path: string;
  readonly userAgent: string;
  readonly cookie: boolean;
}

const words = (n: number) => Array.from({ length: n }, (_, i) => `leaf${i % 60} brew${i % 7}`).join(' ');
const page = (title: string, body: string, canonical = '/page') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="A loopback page frost probes as each crawler."><link rel="canonical" href="${canonical}"></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export interface ProbeSite {
  readonly origin: string;
  /** The same site on `SECOND_HOST`. */
  readonly secondOrigin: string;
  readonly searchOrigin: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

/** Starts the site; `pack` serves the SERP engine's signed selector pack (`serp-fixtures.ts`). */
export async function startProbeSite(options: { readonly pack?: { readonly bytes: Buffer; readonly signature: string }; readonly slowMs?: number } = {}): Promise<ProbeSite> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = (request.headers.host ?? '').split(':')[0]!;
    const url = new URL(request.url ?? '/', 'http://x');
    const path = url.pathname;
    const userAgent = request.headers['user-agent'] ?? '';
    const html = (body: string, headers: Record<string, string> = {}) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(body);
    // The synthetic engine (serp-fixtures.ts), for the SERP panel's intent state.
    if (host === SEARCH_HOST && options.pack) {
      const answer = engineAnswer(url, options.pack);
      if (answer) response.writeHead(answer.status, { 'Content-Type': answer.type }).end(answer.body);
      else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
      return;
    }
    const cookie = request.headers.cookie ?? '';
    seen.push({ host, path, userAgent, cookie: cookie !== '' });
    if (path === '/robots.txt') return void response.writeHead(200, { 'Content-Type': 'text/plain' }).end(ROBOTS_TXT);
    if (path === '/llms.txt') return void response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end(LLMS_TXT);
    if (path === '/page') {
      // Googlebot alone is told not to index; ClaudeBot gets a much shorter page.
      const short = /claudebot/i.test(userAgent);
      return html(page('Green tea leaves', words(short ? 12 : 300)), { 'X-Robots-Tag': 'googlebot: noindex' });
    }
    if (path === '/ai/guide') return html(page('A guide to green tea', words(300), '/ai/guide'));
    if (path === '/club/login') return void response.writeHead(302, { Location: '/club', 'Set-Cookie': `${CLUB_COOKIE}; Path=/; HttpOnly` }).end();
    if (path === '/club') {
      const version = cookie.split(/;\s*/).includes(CLUB_COOKIE) ? CLUB.member : CLUB.visitor;
      return html(page(version.title, `${version.text} ${words(120)}`, '/club'));
    }
    if (path === '/slow') {
      if (!CRAWLER.test(userAgent)) return html(page('A page slow for crawlers', words(200)));
      const timer = setTimeout(() => html(page('Late', words(200))), options.slowMs ?? 0);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${SITE_HOST}:${port}`,
    secondOrigin: `http://${SECOND_HOST}:${port}`,
    searchOrigin: `http://${SEARCH_HOST}:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
