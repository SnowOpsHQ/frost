// Spec: specs/site-crawl.spec.ts (MAX_CRAWL_DELAY_MS, CRAWL_ROBOTS_TOKEN, CRAWL_USER_AGENT_TOKEN)
// Acceptance: specs/site-crawl.feature.md (Fetching, politeness and robots: Crawl-delay (Q13), crawl-delay-parsed,
// crawl-robots-matches-the-bare-token); plan docs/plans/phase-12-big-bets.md Decision 6 and Task 6a
import { describe, expect, test } from 'vitest';
import { CRAWL_ROBOTS_TOKEN, CRAWL_USER_AGENT_TOKEN, MAX_CRAWL_DELAY_MS } from '@app/specs/site-crawl.spec';
import { crawlDelayFor, crawlRobotsRules } from '../crawl-delay';

const delay = (text: string) => crawlDelayFor(text, CRAWL_ROBOTS_TOKEN);

describe('crawl-delay', () => {
  test('crawl-delay-parsed', () => {
    // The frost-crawl group, else `*`.
    expect(delay('User-agent: *\nCrawl-delay: 9\nDisallow: /y\n\nUser-agent: frost-crawl\nCrawl-delay: 3\nDisallow: /x\n')).toBe(3_000);
    expect(delay('User-agent: *\nCrawl-delay: 2\nDisallow: /x\n')).toBe(2_000);
    // A frost-crawl group without a value: none, even though `*` has one (the group is chosen first).
    expect(delay('User-agent: *\nCrawl-delay: 2\nDisallow: /y\n\nUser-agent: frost-crawl\nDisallow: /x\n')).toBeNull();
    // Without a rule between them, `*` and frost-crawl are one group (as the parser groups them): its value applies.
    expect(delay('User-agent: *\nCrawl-delay: 2\n\nUser-agent: frost-crawl\nDisallow: /x\n')).toBe(2_000);
    // Another bot's group is not ours.
    expect(delay('User-agent: googlebot\nCrawl-delay: 7\n')).toBeNull();
    // Token comparison is case-insensitive, on the product token of the line.
    expect(delay('User-agent: Frost-Crawl/2.0\nCrawl-delay: 4\n')).toBe(4_000);
    // Seconds and decimals, rounded up to whole milliseconds.
    expect(delay('User-agent: *\nCrawl-delay: 0.5\n')).toBe(500);
    expect(delay('User-agent: *\nCrawl-delay: .25\n')).toBe(250);
    expect(delay('User-agent: *\nCrawl-delay: 2.\n')).toBe(2_000);
    expect(delay('User-agent: *\nCrawl-delay: 0.0001\n')).toBe(1);
    expect(delay('User-agent: *\nCrawl-delay: 0\n')).toBe(0);
    expect(delay('User-agent: *\ncrawl-delay:1 # one second\n')).toBe(1_000);
    // Absent, negative, non-numeric: none.
    for (const value of ['', '-1', '+1', 'soon', '5s', '1e3', '1,5', 'NaN', 'Infinity', '0x10', '1 2']) {
      expect(delay(`User-agent: *\nCrawl-delay: ${value}\n`), value).toBeNull();
    }
    expect(delay('User-agent: *\nDisallow: /\n')).toBeNull();
    expect(delay('')).toBeNull();
    // An invalid line is ignored, a valid one in the same group still counts.
    expect(delay('User-agent: *\nCrawl-delay: soon\nCrawl-delay: 1.5\n')).toBe(1_500);
    // Several values: the largest wins (Q13), across merged groups too.
    expect(delay('User-agent: frost-crawl\nCrawl-delay: 1\nCrawl-delay: 3\nCrawl-delay: 2\n')).toBe(3_000);
    expect(delay('User-agent: frost-crawl\nCrawl-delay: 1\nDisallow: /a\n\nUser-agent: frost-crawl\nCrawl-delay: 6\n')).toBe(6_000);
    // Capped.
    expect(delay('User-agent: *\nCrawl-delay: 60\n')).toBe(MAX_CRAWL_DELAY_MS);
    expect(delay(`User-agent: *\nCrawl-delay: ${'9'.repeat(400)}\n`)).toBe(MAX_CRAWL_DELAY_MS);
    // Grouped as the parser groups: a crawl-delay between two user-agent lines keeps them in one group.
    expect(delay('User-agent: googlebot\nCrawl-delay: 5\nUser-agent: frost-crawl\nDisallow: /x\n')).toBe(5_000);
    // A rule ends the agents: the next user-agent starts a new group.
    expect(delay('User-agent: frost-crawl\nDisallow: /x\nUser-agent: googlebot\nCrawl-delay: 5\n')).toBeNull();
    // Before any user-agent line: no group.
    expect(delay('Crawl-delay: 5\nUser-agent: *\nDisallow: /x\n')).toBeNull();
    // CR, CRLF, a byte order mark.
    expect(delay('﻿User-agent: *\r\nCrawl-delay: 2\r\n')).toBe(2_000);
    expect(delay('User-agent: *\rCrawl-delay: 2\r')).toBe(2_000);
    // An over-long line is ignored, as the parser ignores it.
    expect(delay(`User-agent: *\nCrawl-delay: 2${' '.repeat(5_000)}\n`)).toBeNull();
  });

  test('crawl-delay-is-linear', () => {
    const text = 'User-agent: *\nCrawl-delay: 1\n'.repeat(20_000);
    const started = performance.now();
    expect(delay(text)).toBe(1_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test('crawl-robots-matches-the-bare-token', () => {
    const header = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 ${CRAWL_USER_AGENT_TOKEN}`;
    const ours = crawlRobotsRules('User-agent: *\nAllow: /\n\nUser-agent: frost-crawl\nDisallow: /\nCrawl-delay: 2\n');
    expect(ours.allowed('https://example.com/a', CRAWL_ROBOTS_TOKEN)).toBe(false);
    expect(ours.crawlDelayMs).toBe(2_000);
    // A mozilla group is not the crawl's: it would be, were the header ever given as the token.
    const mozilla = crawlRobotsRules('User-agent: *\nAllow: /\n\nUser-agent: mozilla\nDisallow: /\nCrawl-delay: 9\n');
    expect(mozilla.allowed('https://example.com/a', CRAWL_ROBOTS_TOKEN)).toBe(true);
    expect(mozilla.crawlDelayMs).toBeNull();
    expect(mozilla.allowed('https://example.com/a', header)).toBe(false);
    expect(crawlDelayFor('User-agent: mozilla\nCrawl-delay: 9\n', header)).toBe(9_000);
    // Googlebot's verdict from the same file.
    const google = crawlRobotsRules('User-agent: googlebot\nDisallow: /private\n');
    expect(google.allowed('https://example.com/private/x', 'googlebot')).toBe(false);
    expect(google.allowed('https://example.com/private/x', CRAWL_ROBOTS_TOKEN)).toBe(true);
    // Path and query are matched as the parser normalises them; a URL that does not parse is not allowed.
    const query = crawlRobotsRules('User-agent: *\nDisallow: /*?sort=\n');
    expect(query.allowed('https://example.com/list?sort=asc', CRAWL_ROBOTS_TOKEN)).toBe(false);
    expect(query.allowed('https://example.com/list', CRAWL_ROBOTS_TOKEN)).toBe(true);
    expect(query.allowed('not a url', CRAWL_ROBOTS_TOKEN)).toBe(false);
  });
});
