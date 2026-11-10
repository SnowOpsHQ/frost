// Spec: specs/site-crawl.spec.ts (CRAWL_ANALYSIS_TIMEOUT_MS, CRAWL_RULE_IDS, CRAWL_ROBOTS_TOKEN, CRAWL_LIMITS), specs/site-crawl.schema.ts
// (CrawlPageJobSchema, CrawlPageAnalysisSchema), specs/seo-javascript.schema.ts (ServedParseInput.skipExtraText)
// Acceptance: specs/site-crawl.feature.md (Runs, frontier, resume and the served-HTML audit: The crawl worker); plan
// docs/plans/phase-12-big-bets.md Decision 6 (a worker of its own, `skipExtraText`) and Task 6b
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CrawlPageAnalysisSchema, type CrawlPageJob } from '@app/specs/site-crawl.schema';
import { CRAWL_ANALYSIS_TIMEOUT_MS, CRAWL_LIMITS, CRAWL_ROBOTS_TOKEN } from '@app/specs/site-crawl.spec';
import { rawSnapshot } from '../../../test/seo-fakes';
import { analyseSnapshot } from '../../seo/analyse';
import { createAnalyzer, type AnalysisWorker } from '../../seo/analysis';
import { parseServedHtml } from '../../seo/served-parse';
import { analyseCrawlPage, crawlParseInput, crawlRobotsRulesOf, parseCrawlRobots } from '../analyse';
import { createCrawlAnalyzer } from '../index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const encoder = new TextEncoder();
const PAGE = 'https://example.com/guide';
const HTML = '<!doctype html><html lang="en"><head><title>Guide</title><link rel="canonical" href="/guide"></head><body><h1>Guide</h1><p>Some words here for the body text.</p><a href="/next">Next</a><a href="mailto:a@example.com">Mail</a><a href="/x" rel="nofollow">X</a></body></html>';

const job = (changes: Partial<CrawlPageJob> = {}): CrawlPageJob => ({
  url: PAGE,
  contentType: 'text/html; charset=utf-8',
  body: encoder.encode(HTML),
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  xRobotsTag: [],
  chain: [],
  extractedAt: 1_800_000_000_000,
  durationMs: 12,
  robots: null,
  ...changes,
});

/** A worker that records what it is sent and answers when told to (with the real job code). */
class FakeWorker extends EventEmitter implements AnalysisWorker {
  readonly posted: { id: number; kind?: string; raw: unknown }[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message as { id: number; kind?: string; raw: unknown });
  }
  terminate(): Promise<number> {
    return Promise.resolve(1);
  }
  unref(): void {}
  answer(): void {
    const last = this.posted.at(-1)!;
    this.emit('message', { id: last.id, result: last.kind === 'crawl' ? analyseCrawlPage(last.raw) : analyseSnapshot(last.raw) });
  }
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the crawl worker', () => {
  test('crawl-parse-carries-no-extra-text', () => {
    // The crawl job's parse asks for no extra text; the parse honours it (the sidebar's default keeps both).
    expect(crawlParseInput(job())).toEqual({ url: PAGE, contentType: 'text/html; charset=utf-8', body: job().body, skipExtraText: true });
    const crawl = parseServedHtml({ url: PAGE, contentType: 'text/html', body: encoder.encode(HTML), skipExtraText: true });
    expect(crawl.ok).toBe(true);
    if (crawl.ok) {
      expect(Object.hasOwn(crawl, 'sourceText')).toBe(false);
      expect(Object.hasOwn(crawl, 'sourceTruncated')).toBe(false);
      expect(Object.hasOwn(crawl.snapshot, 'leadText')).toBe(false);
      expect(crawl.snapshot.wordCount).toBeGreaterThan(5);
    }
    const sidebar = parseServedHtml({ url: PAGE, contentType: 'text/html', body: encoder.encode(HTML) });
    expect(sidebar.ok && typeof sidebar.sourceText === 'string' && typeof sidebar.snapshot.leadText === 'string').toBe(true);
    // The job's answer holds the audit and the row's facts only: nothing of the page's text.
    const answer = analyseCrawlPage(job());
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(CrawlPageAnalysisSchema.safeParse(answer.page).success).toBe(true);
      expect(Object.keys(answer.page).sort()).toEqual(['canonical', 'findings', 'indexable', 'linkTotal', 'links', 'score', 'title', 'wordCount']);
      expect(answer.page).toMatchObject({ title: 'Guide', canonical: PAGE, indexable: true, linkTotal: 3 });
      expect(answer.page.links).toEqual([
        { url: 'https://example.com/next', nofollow: false },
        { url: 'https://example.com/x', nofollow: true },
      ]);
    }
  });

  test('crawl-job-is-checked-in-the-worker', () => {
    for (const bad of [null, 'html', { ...job(), extra: 1 }, job({ body: new Uint8Array(CRAWL_LIMITS.maxBodyBytes + 1) }), job({ url: 'javascript:alert(1)' })]) expect(analyseCrawlPage(bad)).toEqual({ ok: false, reason: 'parse-failed' });
    // robots.txt that is not main's fetch reads as none.
    expect(analyseCrawlPage(job({ robots: { url: 'nope' } })).ok).toBe(true);
  });

  test('crawl-robots-parsed-in-the-worker', () => {
    const parsed = parseCrawlRobots({ text: 'User-agent: frost-crawl\nDisallow: /private\nCrawl-delay: 2\n\nUser-agent: Googlebot\nDisallow: /\nSitemap: /sitemap.xml\n' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The worker answers data (structured-cloneable), main matches with it: the bare token, never a header.
    expect(structuredClone(parsed.robots)).toEqual(parsed.robots);
    const rules = crawlRobotsRulesOf(parsed.robots);
    expect(rules.crawlDelayMs).toBe(2_000);
    expect(rules.allowed('https://example.com/private/a', CRAWL_ROBOTS_TOKEN)).toBe(false);
    expect(rules.allowed('https://example.com/open', CRAWL_ROBOTS_TOKEN)).toBe(true);
    expect(rules.allowed('https://example.com/open', 'googlebot')).toBe(false);
    expect(parsed.robots.file.sitemaps.map((s) => s.raw)).toEqual(['/sitemap.xml']);
    expect(parseCrawlRobots({ text: 42 })).toEqual({ ok: false, reason: 'invalid-job' });
  });

  test('crawl-worker-is-separate', async () => {
    // The sidebar's audits and the crawl each have a worker of their own (the same bundle, two instances).
    const sidebarWorkers: FakeWorker[] = [];
    const crawlWorkers: FakeWorker[] = [];
    const sidebar = createAnalyzer({ spawn: () => (sidebarWorkers.push(new FakeWorker()), sidebarWorkers.at(-1)!) });
    const crawl = createCrawlAnalyzer(() => (crawlWorkers.push(new FakeWorker()), crawlWorkers.at(-1)!));
    // A crawl job that takes long (its worker has not answered)…
    const pending = crawl.analyseCrawlPage(job());
    expect(crawlWorkers).toHaveLength(1);
    expect(crawlWorkers[0]!.posted.map((m) => m.kind)).toEqual(['crawl']);
    // …never delays a sidebar audit: it goes to the sidebar's worker and is answered at once.
    const audit = sidebar.analyse(rawSnapshot(PAGE));
    expect(sidebarWorkers).toHaveLength(1);
    sidebarWorkers[0]!.answer();
    expect((await audit).ok).toBe(true);
    expect(sidebarWorkers[0]!.posted.some((m) => m.kind === 'crawl')).toBe(false);
    crawlWorkers[0]!.answer();
    expect((await pending).ok).toBe(true);
    // The crawl's deadline is its own.
    const slow = crawl.analyseCrawlPage(job());
    vi.advanceTimersByTime(CRAWL_ANALYSIS_TIMEOUT_MS);
    expect(await slow).toEqual({ ok: false, reason: 'parse-failed' });
    // The worker code has no Electron, and the crawl's setup never takes the sidebar's analyzer.
    for (const file of ['../analyse.ts', '../../seo/analysis-worker.ts']) expect(readFileSync(path.join(HERE, file), 'utf8'), file).not.toMatch(/from 'electron'|require\('electron'\)/);
    expect(readFileSync(path.join(HERE, '../index.ts'), 'utf8')).toMatch(/createCrawlAnalyzer\(deps\.spawnWorker\)/);
    sidebar.dispose();
    crawl.dispose();
  });
});
