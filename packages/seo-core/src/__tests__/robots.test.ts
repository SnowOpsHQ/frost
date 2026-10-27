// Spec: specs/seo-indexability.spec.ts (ROBOTS_AGENTS, ROBOTS_PARSE_LIMITS, ROBOTS_FETCH_LIMITS)
// Acceptance: specs/seo-indexability.feature.md (robots.txt parser)
import { describe, expect, test } from 'vitest';
import { ROBOTS_PARSE_LIMITS } from '@app/specs/seo-indexability.spec';
import { decodeRobotsBytes, matchRobots, normaliseRobotsPath, parseRobotsTxt, productToken, robotsPathOf, robotsPatternMatches } from '../index';

/** Whether `agent` may crawl `path` (a URL path and query, normalised here) under `text`. */
function allowed(text: string, agent: string, path: string): boolean {
  return matchRobots(parseRobotsTxt(text), agent, normaliseRobotsPath(path)).allowed;
}

// A file in the spirit of RFC 9309's example (frost's own paths and crawler names).
const EXAMPLE = [
  'User-Agent: *',
  'Disallow: *.gif$',
  'Disallow: /archive/',
  'Allow: /press/',
  '',
  'User-Agent: crawlerone',
  'Disallow:/',
  'Allow:/archive/page.html',
  'Allow:/archive/allowed.gif',
  '',
  'User-Agent: crawlertwo',
  'User-Agent: crawlerthree',
  'Disallow: /archive/page.html',
  '',
  'User-Agent: crawlerfour',
].join('\n');

describe('robots.txt parser', () => {
  test('robots-groups-and-consecutive-agents', () => {
    const file = parseRobotsTxt(EXAMPLE);
    expect(file.groups.map((group) => group.tokens)).toEqual([['*'], ['crawlerone'], ['crawlertwo', 'crawlerthree'], ['crawlerfour']]);
    expect(file.groups.map((group) => group.line)).toEqual([1, 6, 11, 15]);
    expect(file.ruleCount).toBe(7);
    // crawlertwo and crawlerthree share one group.
    expect(allowed(EXAMPLE, 'crawlertwo', '/archive/page.html')).toBe(false);
    expect(allowed(EXAMPLE, 'crawlerthree', '/archive/page.html')).toBe(false);
    expect(allowed(EXAMPLE, 'crawlerthree', '/archive/other.html')).toBe(true);
    // crawlerone: everything but the two allowed files.
    expect(allowed(EXAMPLE, 'crawlerone', '/')).toBe(false);
    expect(allowed(EXAMPLE, 'crawlerone', '/archive/page.html')).toBe(true);
    expect(allowed(EXAMPLE, 'crawlerone', '/archive/allowed.gif')).toBe(true);
    expect(allowed(EXAMPLE, 'crawlerone', '/archive/other.gif')).toBe(false);
    // An empty group of its own: everything allowed, the `*` group does not apply.
    expect(allowed(EXAMPLE, 'crawlerfour', '/archive/')).toBe(true);
    expect(allowed(EXAMPLE, 'crawlerfour', '/x.gif')).toBe(true);
    // Any other crawler follows `*`.
    expect(allowed(EXAMPLE, 'othercrawler', '/archive/x')).toBe(false);
    expect(allowed(EXAMPLE, 'othercrawler', '/press/x.html')).toBe(true);
    // `Allow: /press/` (7 characters) is more specific than `Disallow: *.gif$` (6).
    expect(allowed(EXAMPLE, 'othercrawler', '/press/x.gif')).toBe(true);
    expect(allowed(EXAMPLE, 'othercrawler', '/img/x.gif')).toBe(false);
    expect(allowed(EXAMPLE, 'othercrawler', '/elsewhere')).toBe(true);
  });

  test('robots-user-agent-after-rules-starts-a-group', () => {
    const text = 'User-agent: a\nDisallow: /a\nUser-agent: b\nDisallow: /b\n';
    expect(parseRobotsTxt(text).groups.map((group) => group.tokens)).toEqual([['a'], ['b']]);
    expect(allowed(text, 'a', '/b')).toBe(true);
    expect(allowed(text, 'b', '/a')).toBe(true);
    // A blank line between agents does not split them; an empty Disallow still ends the agent list.
    const blank = 'User-agent: a\n\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow:\nUser-agent: d\nDisallow: /d';
    expect(parseRobotsTxt(blank).groups.map((group) => group.tokens)).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(allowed(blank, 'a', '/x')).toBe(false);
    expect(allowed(blank, 'c', '/d')).toBe(true);
  });

  test('robots-only-rules-end-an-agent-list', () => {
    // Crawl-delay (or any key frost does not read) between agents keeps them in one group.
    const delay = 'User-agent: Googlebot\nCrawl-delay: 10\nUser-agent: Bingbot\nDisallow: /\n';
    expect(parseRobotsTxt(delay).groups.map((group) => group.tokens)).toEqual([['googlebot', 'bingbot']]);
    expect(allowed(delay, 'Googlebot', '/page')).toBe(false);
    expect(allowed(delay, 'Bingbot', '/page')).toBe(false);
    // So does a Sitemap line.
    const sitemap = 'User-agent: a\nSitemap: https://example.com/s.xml\nUser-agent: b\nDisallow: /';
    expect(parseRobotsTxt(sitemap).groups.map((group) => group.tokens)).toEqual([['a', 'b']]);
    expect(parseRobotsTxt(sitemap).sitemapTotal).toBe(1);
    expect(allowed(sitemap, 'a', '/x')).toBe(false);
    // A crawl-delay-only crawler listed just before `*` follows the `*` group's rules (RFC 9309).
    const merged = 'User-agent: slowbot\nCrawl-delay: 5\n\nUser-agent: *\nDisallow: /w/\n';
    expect(parseRobotsTxt(merged).groups.map((group) => group.tokens)).toEqual([['slowbot', '*']]);
    expect(allowed(merged, 'slowbot', '/w/x')).toBe(false);
    expect(allowed(merged, 'Googlebot', '/w/x')).toBe(false);
  });

  test('robots-rules-before-any-group-are-ignored', () => {
    const text = 'Disallow: /\nUser-agent: *\nDisallow: /private';
    expect(parseRobotsTxt(text).ruleCount).toBe(1);
    expect(allowed(text, 'Googlebot', '/public')).toBe(true);
    expect(allowed(text, 'Googlebot', '/private/x')).toBe(false);
  });

  test('robots-matching-groups-merge', () => {
    const text = 'User-agent: googlebot\nDisallow: /a\n\nUser-agent: *\nDisallow: /b\n\nUser-agent: Googlebot\nDisallow: /c\n';
    const match = matchRobots(parseRobotsTxt(text), 'Googlebot', '/c');
    expect(match.groups).toHaveLength(2);
    expect(match.allowed).toBe(false);
    expect(allowed(text, 'Googlebot', '/a')).toBe(false);
    // The crawler's own groups replace `*`.
    expect(allowed(text, 'Googlebot', '/b')).toBe(true);
    expect(allowed(text, 'Bingbot', '/b')).toBe(false);
    expect(matchRobots(parseRobotsTxt(text), 'Bingbot', '/b').fallback).toBe(true);
  });

  test('robots-product-token-matching', () => {
    expect(productToken('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe('googlebot');
    expect(productToken('*')).toBe('*');
    expect(productToken('Googlebot-News')).toBe('googlebot-news');
    expect(productToken('123bot')).toBe('');
    // Only `*` alone is every crawler.
    expect(productToken('*foo')).toBe('');
    expect(productToken('* ')).toBe('*');
    expect(allowed('User-agent: *foo\nDisallow: /', 'Googlebot', '/x')).toBe(true);
    const text = 'User-agent: GOOGLEBOT/2.1\nDisallow: /g\n\nUser-agent: Googlebot-News\nDisallow: /n\n\nUser-agent: *\nDisallow: /all\n';
    expect(allowed(text, 'Googlebot', '/g')).toBe(false);
    // Googlebot-News is another crawler: its group is not Googlebot's.
    expect(allowed(text, 'Googlebot', '/n')).toBe(true);
    expect(allowed(text, 'Googlebot', '/all')).toBe(true);
    expect(allowed(text, 'googlebot', '/g')).toBe(false);
  });

  test('robots-no-group-allows-everything', () => {
    expect(allowed('', 'Googlebot', '/anything')).toBe(true);
    expect(allowed('User-agent: other\nDisallow: /', 'Googlebot', '/anything')).toBe(true);
    const match = matchRobots(parseRobotsTxt('User-agent: other\nDisallow: /'), 'Googlebot', '/');
    expect(match.groups).toEqual([]);
    expect(match.rule).toBeNull();
  });

  test('robots-directives-are-case-insensitive', () => {
    const text = 'USER-AGENT: *\nDISALLOW: /a\nallow: /a/b\nDisAllow : /c\nSITEMAP: https://example.com/s.xml';
    const file = parseRobotsTxt(text);
    expect(file.ruleCount).toBe(3);
    expect(file.sitemaps).toEqual([{ raw: 'https://example.com/s.xml', line: 5 }]);
    expect(allowed(text, 'x', '/a/x')).toBe(false);
    expect(allowed(text, 'x', '/a/b')).toBe(true);
    expect(allowed(text, 'x', '/c')).toBe(false);
    // Paths are case-sensitive.
    expect(allowed(text, 'x', '/A/x')).toBe(true);
  });

  test('robots-comments-bom-and-line-endings', () => {
    const text = '﻿User-agent: * # everyone\r\nDisallow: /tmp/ # scratch\rDisallow: /old#fragment-like\n# Disallow: /commented\nAllow: /tmp/keep';
    const file = parseRobotsTxt(text);
    expect(file.groups[0]!.tokens).toEqual(['*']);
    expect(file.groups[0]!.rules.map((rule) => [rule.raw, rule.line])).toEqual([
      ['/tmp/', 2],
      ['/old', 3],
      ['/tmp/keep', 5],
    ]);
    expect(allowed(text, 'x', '/tmp/a')).toBe(false);
    expect(allowed(text, 'x', '/tmp/keep')).toBe(true);
    expect(allowed(text, 'x', '/commented')).toBe(true);
    // Lines without a colon and unknown keys are ignored.
    expect(parseRobotsTxt('User-agent: *\nDisallow /x\nCrawl-delay: 10\nDisallow: /y').ruleCount).toBe(1);
  });

  test('robots-longest-match-wins-allow-on-tie', () => {
    const text = 'User-agent: *\nAllow: /p\nDisallow: /\n';
    expect(allowed(text, 'x', '/page')).toBe(true);
    expect(allowed(text, 'x', '/other')).toBe(false);
    const longer = 'User-agent: *\nAllow: /folder\nDisallow: /folder/\n';
    expect(allowed(longer, 'x', '/folder/page')).toBe(false);
    expect(allowed(longer, 'x', '/folder')).toBe(true);
    // Equally long: Allow wins, whatever the order.
    expect(allowed('User-agent: *\nDisallow: /page\nAllow: /page\n', 'x', '/page')).toBe(true);
    expect(allowed('User-agent: *\nAllow: /page\nDisallow: /page\n', 'x', '/page')).toBe(true);
    expect(allowed('User-agent: *\nAllow: /$\nDisallow: /\n', 'x', '/')).toBe(true);
    expect(allowed('User-agent: *\nAllow: /$\nDisallow: /\n', 'x', '/page.htm')).toBe(false);
    // Length is counted in normalised octets: `/ツ` is `/%E3%83%84` (10), longer than `/%E3%83` (7).
    expect(allowed('User-agent: *\nAllow: /ツ\nDisallow: /%E3%83\n', 'x', '/ツ')).toBe(true);
    // Wildcard length counts like any character.
    expect(allowed('User-agent: *\nDisallow: /*.php\nAllow: /x/\n', 'x', '/x/a.php')).toBe(false);
    const match = matchRobots(parseRobotsTxt(text), 'x', '/page');
    expect(match.rule).toMatchObject({ allow: true, raw: '/p', line: 2 });
  });

  test('robots-wildcards-and-end-anchor', () => {
    expect(robotsPatternMatches('/fish', '/fish.html')).toBe(true);
    expect(robotsPatternMatches('/fish', '/Fish.asp')).toBe(false);
    expect(robotsPatternMatches('/fish*', '/fishheads/yummy.html')).toBe(true);
    expect(robotsPatternMatches('/fish/', '/fish')).toBe(false);
    expect(robotsPatternMatches('/*.php', '/folder/filename.php?parameters')).toBe(true);
    expect(robotsPatternMatches('/*.php', '/windows.PHP')).toBe(false);
    expect(robotsPatternMatches('/*.php$', '/filename.php')).toBe(true);
    expect(robotsPatternMatches('/*.php$', '/filename.php?parameters')).toBe(false);
    expect(robotsPatternMatches('/*.php$', '/filename.php5')).toBe(false);
    expect(robotsPatternMatches('/fish*.php', '/fish.php')).toBe(true);
    expect(robotsPatternMatches('/fish*.php', '/fishheads/catfish.php?parameters')).toBe(true);
    expect(robotsPatternMatches('/fish*.php', '/Fish.PHP')).toBe(false);
    expect(robotsPatternMatches('/exact$', '/exact')).toBe(true);
    expect(robotsPatternMatches('/exact$', '/exactly')).toBe(false);
    expect(robotsPatternMatches('*', '/anything')).toBe(true);
    expect(robotsPatternMatches('/a*b*b$', '/abb')).toBe(true);
    expect(robotsPatternMatches('/a*b*b$', '/ab')).toBe(false);
    expect(robotsPatternMatches('/a**b', '/axxb')).toBe(true);
    // `$` other than last is an ordinary character.
    expect(robotsPatternMatches('/a$b', '/a$b')).toBe(true);
    expect(robotsPatternMatches('/a$b', '/a')).toBe(false);
    // A rule without a leading slash is read as starting at the root.
    expect(allowed('User-agent: *\nDisallow: private', 'x', '/private/a')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: *.gif$', 'x', '/img/a.gif')).toBe(false);
  });

  test('robots-percent-encoding-is-normalised', () => {
    // Characters outside ASCII are matched in their UTF-8 percent-encoded form.
    expect(normaliseRobotsPath('/foo/bar/ツ')).toBe('/foo/bar/%E3%83%84');
    expect(allowed('User-agent: *\nDisallow: /foo/bar/ツ', 'x', '/foo/bar/%E3%83%84')).toBe(false);
    expect(allowed('User-agent: *\nDisallow: /foo/bar/%E3%83%84', 'x', '/foo/bar/%e3%83%84')).toBe(false);
    // An encoded unreserved character is the character itself; a reserved one stays encoded.
    expect(normaliseRobotsPath('/foo/bar/%62%61%7A')).toBe('/foo/bar/baz');
    expect(allowed('User-agent: *\nDisallow: /foo/bar/%62%61%7A', 'x', '/foo/bar/baz')).toBe(false);
    expect(normaliseRobotsPath('/a%2fb')).toBe('/a%2Fb');
    expect(allowed('User-agent: *\nDisallow: /a/b', 'x', '/a%2Fb')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /foo/bar?baz=quz', 'x', '/foo/bar?baz=quz')).toBe(false);
    // Spaces and lone surrogates are encoded, never thrown on.
    expect(normaliseRobotsPath('/a b')).toBe('/a%20b');
    expect(normaliseRobotsPath('/\uD800')).toBe('/%EF%BF%BD');
    expect(normaliseRobotsPath('/%zz%4')).toBe('/%zz%4');
  });

  test('robots-bytes-decode-without-loss', () => {
    // Valid UTF-8 decodes; a BOM is kept for the parser to drop.
    expect(decodeRobotsBytes(new TextEncoder().encode('\uFEFFUser-agent: *\nDisallow: /ü\n'))).toBe('\uFEFFUser-agent: *\nDisallow: /ü\n');
    // A byte that is not UTF-8 (a Latin-1 file) is kept as its percent-encoding.
    const latin1 = Uint8Array.from([...'User-agent: *\nDisallow: /caf'].map((c) => c.charCodeAt(0)).concat([0xe9, 0x0a]));
    const text = decodeRobotsBytes(latin1);
    expect(text).toBe('User-agent: *\nDisallow: /caf%E9\n');
    expect(matchRobots(parseRobotsTxt(text), 'x', normaliseRobotsPath('/caf%E9')).allowed).toBe(false);
    expect(matchRobots(parseRobotsTxt(text), 'x', normaliseRobotsPath('/café')).allowed).toBe(true);
    // Overlong forms, surrogates, truncated and stray continuation bytes are bytes, not characters.
    expect(decodeRobotsBytes(Uint8Array.from([0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xe3, 0x83, 0x80, 0xf0, 0x9f, 0x98]))).toBe('%C0%AF%ED%A0%80ダ%F0%9F%98');
    expect(decodeRobotsBytes(Uint8Array.from([0xe3, 0x83, 0x84, 0xf0, 0x9f, 0x98, 0x80]))).toBe('ツ😀');
    // Linear on 500 KiB of garbage.
    const started = performance.now();
    expect(decodeRobotsBytes(new Uint8Array(512_000).fill(0xff))).toHaveLength(512_000 * 3);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('robots-matches-path-and-query-of-url', () => {
    expect(robotsPathOf(new URL('https://example.com'))).toBe('/');
    expect(robotsPathOf(new URL('https://example.com/a b?x=ü#frag'))).toBe('/a%20b?x=%C3%BC');
    const text = 'User-agent: *\nDisallow: /*?sort=\n';
    expect(matchRobots(parseRobotsTxt(text), 'x', robotsPathOf(new URL('https://example.com/list?sort=asc'))).allowed).toBe(false);
    expect(matchRobots(parseRobotsTxt(text), 'x', robotsPathOf(new URL('https://example.com/list'))).allowed).toBe(true);
  });

  test('robots-txt-itself-is-always-allowed', () => {
    expect(allowed('User-agent: *\nDisallow: /', 'Googlebot', '/robots.txt')).toBe(true);
    expect(allowed('User-agent: *\nDisallow: /', 'Googlebot', '/robots.txt.bak')).toBe(false);
  });

  test('robots-sitemaps-are-listed-outside-groups', () => {
    const text = 'Sitemap: https://example.com/a.xml\nUser-agent: *\nSitemap: https://example.com/b.xml\nDisallow: /x\nSitemap:\n';
    const file = parseRobotsTxt(text);
    expect(file.sitemaps.map((sitemap) => sitemap.raw)).toEqual(['https://example.com/a.xml', 'https://example.com/b.xml']);
    expect(file.sitemapTotal).toBe(2);
    // A Sitemap line does not end the group's agents or rules.
    expect(file.groups).toHaveLength(1);
    expect(file.ruleCount).toBe(1);
    const many = Array.from({ length: ROBOTS_PARSE_LIMITS.maxSitemaps + 5 }, (_, i) => `Sitemap: https://example.com/${i}.xml`).join('\n');
    expect(parseRobotsTxt(many).sitemaps).toHaveLength(ROBOTS_PARSE_LIMITS.maxSitemaps);
    expect(parseRobotsTxt(many).sitemapTotal).toBe(ROBOTS_PARSE_LIMITS.maxSitemaps + 5);
  });

  test('robots-size-limits-hold', () => {
    // An over-long line is ignored; the rest still parses.
    const long = `User-agent: *\nDisallow: /${'x'.repeat(ROBOTS_PARSE_LIMITS.maxLineChars)}\nDisallow: /short`;
    expect(parseRobotsTxt(long).ruleCount).toBe(1);
    // A 500 KiB file of rules parses, and matching it stays fast.
    const big = `User-agent: *\n${Array.from({ length: 30_000 }, (_, i) => `Disallow: /p${i}/*a*b*c$`).join('\n')}`;
    const started = performance.now();
    const file = parseRobotsTxt(big);
    expect(file.ruleCount).toBe(30_000);
    expect(matchRobots(file, 'Googlebot', `/${'a'.repeat(2_000)}`).allowed).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
    // A file of only newlines (or garbage) parses to nothing, linearly.
    expect(parseRobotsTxt('\n'.repeat(500_000)).groups).toEqual([]);
    expect(parseRobotsTxt('\u0000:\u0000'.repeat(100_000)).groups).toEqual([]);
  });
});
