import { ROBOTS_PARSE_LIMITS } from '@app/specs/seo-indexability.spec';
import { CRAWL_ROBOTS_TOKEN, MAX_CRAWL_DELAY_MS } from '@app/specs/site-crawl.spec';
import { matchRobots, parseRobotsTxt, productToken, robotsPathOf } from '../indexability/robots';

// The crawl's own reading of robots.txt (spec `site-crawl.spec.ts`; acceptance `site-crawl.feature.md`,
// Crawl-delay (Q13); plan Decision 6). Phase 2's parser deliberately ignores `Crawl-delay` and the
// sidebar must not change, so the crawl reads it here, over the decoded text (`decodeRobotsBytes`).
// Groups are formed exactly as `parseRobotsTxt` forms them (only an `allow` / `disallow` line ends a
// group's agents; a line before any `user-agent` belongs to no group) and chosen like `groupsFor`
// (every group naming the token, merged, else every `*` group). The value is seconds, whole or
// decimal; anything else is ignored. Several values in the chosen groups: the largest wins (the
// politest reading). Pure and linear in the text.

/** A `Crawl-delay` value: seconds, whole or decimal, nothing else (no sign, unit or exponent). */
const SECONDS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The `Crawl-delay` `token` (a product token, always `CRAWL_ROBOTS_TOKEN` for the crawl, never a user
 * agent header) is asked to keep, in milliseconds (rounded up, at most `MAX_CRAWL_DELAY_MS`); `null`
 * when no valid value applies to it.
 */
export function crawlDelayFor(text: string, token: string): number | null {
  const want = token === '*' ? '*' : productToken(token);
  const groups: { tokens: string[]; delays: number[] }[] = [];
  /** Whether the current group has taken a rule (a `user-agent` line then starts a new group). */
  let inRules = true;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let start = 0;
  while (start <= source.length) {
    let end = start;
    while (end < source.length) {
      const c = source.charCodeAt(end);
      if (c === 0x0a || c === 0x0d) break;
      end++;
    }
    if (end - start <= ROBOTS_PARSE_LIMITS.maxLineChars) handle(source.slice(start, end));
    if (end >= source.length) break;
    start = source.charCodeAt(end) === 0x0d && source.charCodeAt(end + 1) === 0x0a ? end + 2 : end + 1;
  }

  function handle(rawLine: string): void {
    const hash = rawLine.indexOf('#');
    const content = (hash < 0 ? rawLine : rawLine.slice(0, hash)).trim();
    const colon = content.indexOf(':');
    if (colon < 0) return;
    const key = content.slice(0, colon).trim().toLowerCase();
    const value = content.slice(colon + 1).trim();
    switch (key) {
      case 'user-agent':
        if (inRules || groups.length === 0) {
          groups.push({ tokens: [], delays: [] });
          inRules = false;
        }
        groups[groups.length - 1]!.tokens.push(productToken(value));
        return;
      case 'allow':
      case 'disallow':
        if (groups.length > 0) inRules = true;
        return;
      case 'crawl-delay': {
        if (groups.length === 0 || !SECONDS.test(value)) return;
        // A value too long for a double is `Infinity`: capped below like any other large value.
        groups[groups.length - 1]!.delays.push(Number(value));
        return;
      }
      default:
        return;
    }
  }

  const own = want === '*' ? [] : groups.filter((group) => group.tokens.includes(want));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.tokens.includes('*'));
  let largest: number | null = null;
  for (const group of chosen) for (const seconds of group.delays) if (largest === null || seconds > largest) largest = seconds;
  if (largest === null) return null;
  return Math.min(MAX_CRAWL_DELAY_MS, Math.ceil(largest * 1_000));
}

/**
 * What the crawl needs from one robots.txt (Task 6a; Task 6b moves the parse into the crawl's worker):
 * whether `url` may be fetched by `token` (`CRAWL_ROBOTS_TOKEN` for the crawl's own verdict,
 * `googlebot` for the second verdict the Pages view shows; never a user agent header), and the
 * crawl's `Crawl-delay` in milliseconds (`null`: none).
 */
export interface CrawlRobotsRules {
  allowed(url: string, token: string): boolean;
  readonly crawlDelayMs: number | null;
}

/** `CrawlRobotsRules` from robots.txt `text` (decoded, `decodeRobotsBytes`). A URL that does not parse is not allowed. */
export function crawlRobotsRules(text: string): CrawlRobotsRules {
  const file = parseRobotsTxt(text);
  return {
    allowed(url, token) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      return matchRobots(file, token, robotsPathOf(parsed)).allowed;
    },
    crawlDelayMs: crawlDelayFor(text, CRAWL_ROBOTS_TOKEN),
  };
}
