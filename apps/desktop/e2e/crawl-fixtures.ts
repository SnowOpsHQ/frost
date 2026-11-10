// The site crawl's loopback fixture site (Phase 12 Task 11; acceptance `specs/site-crawl.feature.md`,
// End to end; plan Task 11, `crawl.e2e.ts`): 50 pages under a public-looking name
// (`--host-resolver-rules` maps it, port included, to the loopback server; `--frost-e2e-public-hosts`
// exempts it from the fetcher's private-address check, as for a public site), with robots.txt (one
// disallowed path, a `Crawl-delay`, a `Sitemap:` line), a redirect, a 404, a noindex page, a PDF, an
// orphan only the sitemap names, and a log of every request with its start and end times, so the
// suite can check K-B1 (one fetch call in flight, the effective spacing) from the site's side.
// frost's own markup; loopback only.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { SITEMAP_NAMESPACE } from '@app/specs/seo-checks.spec';

/** The site's public-looking name (`http://crawl.frost-e2e.test/` reaches the loopback server). */
export const CRAWL_HOST = 'crawl.frost-e2e.test';
export const CRAWL_ORIGIN = `http://${CRAWL_HOST}`;
/** robots.txt's `Crawl-delay` (seconds): above the interval the suite picks (500 ms), so it decides the pacing. */
export const CRAWL_DELAY_SECONDS = 1;
/** robots.txt disallows this prefix (for every agent). */
export const DISALLOWED_PREFIX = '/private/';

const SECTIONS = ['tea', 'coffee', 'cocoa', 'herbs'] as const;
const ARTICLES_PER_SECTION = 9;
/** Section index pages answer this much later (calls of different lengths). */
const SLOW_SECTION_MS = 150;

/** The redirect (`301`, same host, followed inside one fetch call) and its target. */
export const REDIRECT = { from: '/old', to: '/new' } as const;
export const MISSING_PATH = '/missing';
export const NOINDEX_PATH = '/noindex';
export const BLOCKED_PATH = `${DISALLOWED_PREFIX}secret`;
export const PDF_PATH = '/files/guide.pdf';
/** Named only by the sitemap: an orphan. */
export const ORPHAN_PATH = '/orphan';

const articlePath = (section: string, n: number) => `/${section}/article-${n}`;

/** Every page the crawl records (one row each): 50 paths. `REDIRECT.to` is no row of its own (its hop is in `/old`'s call). */
export const CRAWL_PAGE_PATHS: readonly string[] = [
  '/',
  ...SECTIONS.flatMap((section) => [`/${section}/`, ...Array.from({ length: ARTICLES_PER_SECTION }, (_, i) => articlePath(section, i + 1))]),
  '/about',
  '/contact',
  '/team',
  REDIRECT.from,
  MISSING_PATH,
  NOINDEX_PATH,
  BLOCKED_PATH,
  PDF_PATH,
  ORPHAN_PATH,
];

/** One request the site answered: when it arrived and when its answer was finished (`Date.now()`). */
export interface CrawlSiteRequest {
  readonly method: string;
  readonly path: string;
  readonly userAgent: string;
  readonly start: number;
  end: number | null;
}

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 37}`).join(' ');

function html(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${title}: a page of frost's loopback crawl fixture site, written for the end-to-end suite."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="${CRAWL_ORIGIN}/">${head}</head><body><h1>${title}</h1><p>${words(320, title.toLowerCase().replace(/\W+/g, '') || 'word')}</p>${body}</body></html>`;
}

const link = (href: string, text: string) => `<a href="${href}">${text}</a>`;

function pageFor(path: string): { status: number; type: string; body: string | Buffer; headers?: Record<string, string>; delayMs?: number } | null {
  const page = (title: string, body: string, head = '') => ({ status: 200, type: 'text/html; charset=utf-8', body: html(title, body, head).replace(`href="${CRAWL_ORIGIN}/"`, `href="${CRAWL_ORIGIN}${path}"`) });
  if (path === '/') {
    const nav = [...SECTIONS.map((section) => link(`/${section}/`, `The ${section} section`)), link('/about', 'About'), link('/contact', 'Contact'), link('/team', 'Team'), link(REDIRECT.from, 'Our old page'), link(MISSING_PATH, 'A page that is gone'), link(NOINDEX_PATH, 'A page kept out of search'), link(BLOCKED_PATH, 'Members only'), link(PDF_PATH, 'The guide (PDF)')];
    return page('Home', `<nav>${nav.join(' ')}</nav>`);
  }
  for (const section of SECTIONS) {
    if (path === `/${section}/`) return { ...page(`The ${section} section`, Array.from({ length: ARTICLES_PER_SECTION }, (_, i) => link(articlePath(section, i + 1), `${section} article ${i + 1}`)).join(' ') + link('/', 'Home')), delayMs: SLOW_SECTION_MS };
    for (let n = 1; n <= ARTICLES_PER_SECTION; n++) {
      if (path === articlePath(section, n)) return page(`${section} article ${n}`, `${link(`/${section}/`, `Back to ${section}`)} ${link('/', 'Home')}${n < ARTICLES_PER_SECTION ? ` ${link(articlePath(section, n + 1), 'Next article')}` : ''}`);
    }
  }
  switch (path) {
    case '/about':
    case '/contact':
    case '/team':
      return page(path.slice(1), link('/', 'Home'));
    case REDIRECT.from:
      return { status: 301, type: 'text/plain', body: '', headers: { Location: REDIRECT.to } };
    case REDIRECT.to:
      return page('Our new page', link('/', 'Home'));
    case MISSING_PATH:
      return { status: 404, type: 'text/html; charset=utf-8', body: html('Not found', link('/', 'Home')) };
    case NOINDEX_PATH:
      return page('Kept out of search', link('/', 'Home'), '<meta name="robots" content="noindex">');
    case BLOCKED_PATH:
      return page('Members only', link('/', 'Home'));
    case PDF_PATH:
      return { status: 200, type: 'application/pdf', body: Buffer.from('%PDF-1.4\n% frost e2e fixture\n%%EOF\n', 'latin1') };
    case ORPHAN_PATH:
      return page('Only in the sitemap', link('/', 'Home'));
    case '/robots.txt':
      return { status: 200, type: 'text/plain', body: `User-agent: *\nDisallow: ${DISALLOWED_PREFIX}\nCrawl-delay: ${CRAWL_DELAY_SECONDS}\n\nSitemap: ${CRAWL_ORIGIN}/sitemap.xml\n` };
    case '/sitemap.xml': {
      const urls = ['/', ...SECTIONS.map((section) => `/${section}/`), '/about', ORPHAN_PATH];
      return { status: 200, type: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${SITEMAP_NAMESPACE}">${urls.map((url) => `<url><loc>${CRAWL_ORIGIN}${url}</loc></url>`).join('')}</urlset>` };
    }
    default:
      return null;
  }
}

/** Starts the site on a loopback port; `log` records every request in arrival order. */
export async function startCrawlSite(): Promise<{ port: number; log: CrawlSiteRequest[]; close(): Promise<void> }> {
  const log: CrawlSiteRequest[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const entry: CrawlSiteRequest = { method: request.method ?? '', path: new URL(request.url ?? '/', 'http://x').pathname, userAgent: request.headers['user-agent'] ?? '', start: Date.now(), end: null };
    log.push(entry);
    const finished = () => {
      if (entry.end === null) entry.end = Date.now();
    };
    response.once('finish', finished);
    response.once('close', finished);
    const answer = pageFor(entry.path) ?? { status: 404, type: 'text/plain', body: 'not here' };
    const send = () => response.writeHead(answer.status, { 'Content-Type': answer.type, ...answer.headers }).end(request.method === 'HEAD' ? undefined : answer.body);
    if (answer.delayMs === undefined) return send();
    const timer = setTimeout(() => {
      timers.delete(timer);
      send();
    }, answer.delayMs);
    timers.add(timer);
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** One fetch call as K-B1 counts it: a page's request and the redirect hops that followed it in the same call. */
export interface FetchCall {
  readonly paths: readonly string[];
  readonly start: number;
  readonly end: number;
}

/**
 * The crawl's fetch calls from the site's log: the crawl's own requests (its user agent carries
 * `token`; robots.txt is fetched by main's robots fetcher on the audit lane, not by the crawl lane, so
 * it is left out), in arrival order, with `REDIRECT.to` folded into the `REDIRECT.from` call it
 * directly follows (one call: its hops follow each other at once).
 */
export function fetchCallsOf(log: readonly CrawlSiteRequest[], token: string): FetchCall[] {
  const calls: { paths: string[]; start: number; end: number }[] = [];
  for (const entry of log) {
    if (!entry.userAgent.includes(token) || entry.path === '/robots.txt') continue;
    const end = entry.end ?? Number.POSITIVE_INFINITY;
    const last = calls.at(-1);
    if (last && entry.path === REDIRECT.to && last.paths.at(-1) === REDIRECT.from) {
      last.paths.push(entry.path);
      last.end = end;
      continue;
    }
    calls.push({ paths: [entry.path], start: entry.start, end });
  }
  return calls;
}
