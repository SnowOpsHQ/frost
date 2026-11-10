// Spec: specs/serp-api.spec.ts (SERP_API_TYPE_MAP, SERP_API_LIMITS, SERP_API_ORGANIC_RANK_FIELD,
// SERP_API_METADATA_KEYS, DATAFORSEO_TASK_OK), specs/serp-api.schema.ts (the vendor response schemas,
// SerpApiJobSchema), specs/serp-snapshot.schema.ts (SerpReadSchema, SerpSnapshotSchema)
// Plan: docs/plans/phase-12-big-bets.md, Decisions 3 (K-A1) and 7, Global constraints "Untrusted text",
// Threat model "Hostile vendor JSON", Task 3
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { SERP_API_LIMITS, SERP_API_PROVIDER_IDS, SERP_API_TYPE_MAP, type SerpApiProvider } from '@app/specs/serp-api.spec';
import type { SerpApiJob } from '@app/specs/serp-api.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { SerpSnapshotSchema, type SerpReadBlock, type SerpSnapshot } from '@app/specs/serp-snapshot.schema';
import type { AnalysisWorker } from '../../seo/analysis';
import { analyseSerp } from '../serp-analyse';
import { createSerpAnalyzer } from '../serp-analyzer';
import { runSerpApiJob, serpApiRead } from '../serp-api-parse';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureText = (provider: SerpApiProvider): string => readFileSync(path.join(HERE, 'fixtures', 'serp-api', `${provider}.json`), 'utf8');
const fixture = (provider: SerpApiProvider): Record<string, unknown> => JSON.parse(fixtureText(provider)) as Record<string, unknown>;

const PARAMS: SearchParams = { engine: 'google', engineLabel: 'Google', query: 'frost browser', gl: 'us', hl: 'en', device: 'desktop', page: 1, offset: null, url: 'https://www.google.com/search?q=frost%20browser&gl=us&hl=en' };
const job = (provider: SerpApiProvider, body: string, extra: Partial<SerpApiJob> = {}): SerpApiJob => ({ provider, body, params: PARAMS, packVersion: 1, ...extra });
const ready = (snapshot: SerpSnapshot) => {
  expect(SerpSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(snapshot.status).toBe('ready');
  if (snapshot.status !== 'ready') throw new Error('not ready');
  return snapshot;
};

/** The vendor's own organic rank field for each organic result, in the vendor's page order (K-A1). */
function vendorOrganicRanks(provider: SerpApiProvider): { rank: number; url: string }[] {
  const json = fixture(provider);
  if (provider === 'serpapi') return (json.organic_results as { position: number; link: string }[]).map((r) => ({ rank: r.position, url: r.link }));
  if (provider === 'serper') return (json.organic as { position: number; link: string }[]).map((r) => ({ rank: r.position, url: r.link }));
  const items = (json.tasks as { result: { items: { type: string; rank_group: number; rank_absolute: number; url: string }[] }[] }[])[0]!.result[0]!.items;
  return items
    .filter((item) => item.type === 'organic')
    .sort((a, b) => a.rank_absolute - b.rank_absolute)
    .map((item) => ({ rank: item.rank_group, url: item.url }));
}

const item = (title: string, url: string | null = null) => ({ title, url });
const block = (type: SerpReadBlock['type'], ...items: ReturnType<typeof item>[]): SerpReadBlock => ({ type, items });
const ORGANIC = [
  item('Frost — the SEO browser', 'https://www.example.com/frost'),
  item('Ten frost tips', 'https://blog.example.org/frost-tips'),
  item('Frost history', 'https://example.com/history'),
  item('Frostline guide', 'https://www.frostline.example/'),
  item('Alice on frost', 'https://alice.github.io/frost'),
];

/** Each fixture's blocks as a tab would read the same page (the expected mapping). */
const EXPECTED_BLOCKS: Readonly<Record<SerpApiProvider, readonly SerpReadBlock[]>> = {
  serpapi: [
    block('ad', item('Frost Gear Winter Sale', 'https://ads.example.net/frost-gear')),
    block('featured-snippet', item('What frost is, in one line', 'https://www.icecrystal.example/what-is-frost')),
    block('knowledge-panel', item('Frost (browser)', 'https://frost.example.com/')),
    block('local-pack', item('Frost Outfitters', 'https://outfitters.example.net/'), item('Glacier Supply')),
    block('organic', ...ORGANIC),
    block('people-also-ask', item('Is frost a web browser?', 'https://www.example.com/faq'), item('Does frost run on Linux?')),
    block('video', item('Frost in ten minutes', 'https://video.example.net/watch?v=frost10')),
    block('related-searches', item('frost browser download', 'https://www.google.com/search?q=frost+browser+download'), item('frost browser linux', 'https://www.google.com/search?q=frost+browser+linux')),
    block('ad', item('Frost Kit for Windows', 'https://shop.example.org/frost-kit')),
  ],
  dataforseo: [
    block('ad', item('Frost Gear Winter Sale', 'https://ads.example.net/frost-gear')),
    block('featured-snippet', item('What frost is, in one line', 'https://www.icecrystal.example/what-is-frost')),
    block('organic', ORGANIC[0]!, ORGANIC[1]!),
    block('people-also-ask', item('Is frost a web browser?'), item('Does frost run on Linux?')),
    block('organic', ORGANIC[2]!),
    block('video', item('Frost in ten minutes', 'https://video.example.net/watch?v=frost10')),
    block('organic', ORGANIC[3]!),
    block('images', item('Frost window screenshot', 'https://img.example.net/frost-1'), item('Frost sidebar', 'https://img.example.net/frost-2')),
    block('organic', ORGANIC[4]!),
    block('related-searches', item('frost browser download'), item('frost browser linux')),
    block('knowledge-panel', item('Frost (browser)', 'https://frost.example.com/')),
  ],
  serper: [
    block('knowledge-panel', item('Frost (browser)')),
    block('organic', ...ORGANIC),
    block('people-also-ask', item('Is frost a web browser?', 'https://www.example.com/faq'), item('Does frost run on Linux?', 'https://blog.example.org/frost-linux')),
    block('related-searches', item('frost browser download'), item('frost browser linux')),
  ],
};
/** The one unknown type each fixture carries. */
const UNKNOWN: Readonly<Record<SerpApiProvider, string>> = { serpapi: 'perspectives', dataforseo: 'discussions_and_forums', serper: 'topStories' };

describe('serp api parse', () => {
  test.each(SERP_API_PROVIDER_IDS)('serp-api-maps-to-a-ready-snapshot (%s)', (provider) => {
    const { snapshot } = runSerpApiJob(job(provider, fixtureText(provider)));
    const out = ready(snapshot);
    expect(out.params).toEqual(PARAMS);
    expect(out.packVersion).toBe(1);
    // K-A1: organic positions equal the vendor's own rank field, result for result.
    const organic = out.results.filter((result) => result.type === 'organic').map((result) => ({ rank: result.position, url: result.url }));
    expect(organic).toEqual(vendorOrganicRanks(provider));
    expect(organic.length).toBe(5);
    // Acceptance: ownership and composition are what the same results read from a tab give.
    const tab = analyseSerp({ ok: true, blocks: EXPECTED_BLOCKS[provider], stats: { nodes: 0, elapsedMs: 0, truncated: false, organicCut: false } }, { params: PARAMS, packVersion: 1, redirects: [] });
    expect(tab.status).toBe('ready');
    if (tab.status !== 'ready') return;
    expect(out.ownership).toEqual(tab.ownership);
    expect(out.composition).toEqual(tab.composition);
    expect(out.results).toEqual(tab.results);
    expect(out.ownership.domains.map((d) => [d.domain, d.positions])).toEqual([
      ['example.com', [1, 3]],
      ['example.org', [2]],
      ['frostline.example', [4]],
      ['alice.github.io', [5]],
    ]);
  });

  test.each(SERP_API_PROVIDER_IDS)('serp-api-features-mapped-unknown-skipped (%s)', (provider) => {
    const read = serpApiRead(provider, fixtureText(provider));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.read.ok && read.read.blocks).toEqual(EXPECTED_BLOCKS[provider]);
    // The one unknown type is skipped and counted; metadata keys are neither.
    expect(read.skipped).toBe(1);
    expect(Object.keys(SERP_API_TYPE_MAP[provider])).not.toContain(UNKNOWN[provider]);
    const { snapshot, skipped } = runSerpApiJob(job(provider, fixtureText(provider)));
    expect(skipped).toBe(1);
    const features = ready(snapshot).composition.features.map((feature) => feature.type);
    expect(features.length).toBeGreaterThanOrEqual(3);
    // Every mapped feature type is frost's own; nothing of the unknown type shows.
    expect(ready(snapshot).results.some((result) => result.title === 'What I learned using frost' || result.title === 'Frost 12 ships')).toBe(false);
  });

  test('serp-api-maps-to-a-ready-snapshot: page order and ranks within a section', () => {
    // SerpApi organic results out of array order are placed by their position; DataForSEO elements by rank_absolute.
    const serpapi = fixture('serpapi');
    serpapi.organic_results = [...(serpapi.organic_results as unknown[])].reverse();
    const out = ready(runSerpApiJob(job('serpapi', JSON.stringify(serpapi))).snapshot);
    expect(out.results.filter((r) => r.type === 'organic').map((r) => r.title)).toEqual(ORGANIC.map((o) => o.title));
    const dfs = fixture('dataforseo') as { tasks: { result: { items: unknown[] }[] }[] };
    dfs.tasks[0]!.result[0]!.items.reverse();
    const fromDfs = ready(runSerpApiJob(job('dataforseo', JSON.stringify(dfs))).snapshot);
    expect(fromDfs.results.map((r) => r.title)).toEqual(ready(runSerpApiJob(job('dataforseo', fixtureText('dataforseo'))).snapshot).results.map((r) => r.title));
  });

  test('serp-api-maps-to-a-ready-snapshot: no organic ranks 1 … n, no snapshot (K-A1)', () => {
    const gap = fixture('serper');
    (gap.organic as { position: number }[])[2]!.position = 4;
    (gap.organic as { position: number }[])[3]!.position = 5;
    (gap.organic as { position: number }[])[4]!.position = 6;
    expect(runSerpApiJob(job('serper', JSON.stringify(gap))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    const twice = fixture('serpapi');
    (twice.organic_results as { position: number }[])[1]!.position = 1;
    expect(runSerpApiJob(job('serpapi', JSON.stringify(twice))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    const dfs = fixture('dataforseo') as { tasks: { result: { items: { type: string; rank_group: number }[] }[] }[] };
    dfs.tasks[0]!.result[0]!.items.find((i) => i.type === 'organic')!.rank_group = 7;
    expect(runSerpApiJob(job('dataforseo', JSON.stringify(dfs))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
  });

  test('serp-api-empty-or-error-answers: no-results only with the organic container; vendor errors; nothing else is a snapshot', () => {
    const outcome = (provider: SerpApiProvider, body: unknown) => runSerpApiJob(job(provider, typeof body === 'string' ? body : JSON.stringify(body)));
    const noResults = { vendorError: false, snapshot: { status: 'unreadable', reason: 'no-results' } };
    const vendorError = { vendorError: true, snapshot: { status: 'unreadable', reason: 'invalid-answer' } };
    const invalid = { vendorError: false, snapshot: { status: 'unreadable', reason: 'invalid-answer' } };
    // The organic container present but empty, or SerpApi saying the page was empty: `no-results`.
    expect(outcome('serper', { searchParameters: { q: 'x' }, organic: [], credits: 1 })).toMatchObject(noResults);
    expect(outcome('serpapi', { search_metadata: { status: 'Success' }, organic_results: [] })).toMatchObject(noResults);
    expect(outcome('serpapi', { search_metadata: { status: 'Success' }, search_information: { organic_results_state: 'Fully empty' } })).toMatchObject(noResults);
    const dfsEmpty = fixture('dataforseo') as { tasks: { result: { items: unknown }[] }[] };
    dfsEmpty.tasks[0]!.result[0]!.items = [];
    expect(outcome('dataforseo', dfsEmpty)).toMatchObject(noResults);
    // The vendors' own error answers: a vendor error.
    expect(outcome('serpapi', '{"search_metadata":{"status":"Error"},"error":"Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}')).toMatchObject(vendorError);
    expect(outcome('serpapi', { search_metadata: { status: 'Success' }, error: 'Google hasn’t returned any results for this query.' })).toMatchObject(vendorError);
    expect(outcome('serpapi', { search_metadata: { status: 'Processing' }, organic_results: [] })).toMatchObject(vendorError);
    expect(outcome('serper', '{"message":"Not enough credits"}')).toMatchObject(vendorError);
    const failed = fixture('dataforseo') as { status_code: number; tasks: { status_code: number; result: unknown }[] };
    failed.tasks[0]!.status_code = 40501;
    failed.tasks[0]!.result = null;
    expect(outcome('dataforseo', failed)).toMatchObject(vendorError);
    failed.tasks[0]!.status_code = 20000;
    failed.status_code = 40100;
    expect(outcome('dataforseo', failed)).toMatchObject(vendorError);
    // Anything else without the organic container: `invalid-answer`, never a "not ranking" point.
    for (const provider of SERP_API_PROVIDER_IDS) expect(outcome(provider, '{}'), provider).toMatchObject(invalid);
    expect(outcome('serper', { searchParameters: { q: 'x' }, credits: 1 })).toMatchObject(invalid);
    expect(outcome('serper', { knowledgeGraph: { title: 'Frost' }, relatedSearches: [{ query: 'frost' }] })).toMatchObject(invalid);
    expect(outcome('serpapi', { search_metadata: { status: 'Success' }, related_searches: [{ query: 'frost' }] })).toMatchObject(invalid);
    expect(outcome('serpapi', { search_metadata: { status: 'Success' }, search_information: { organic_results_state: 'Results for exact spelling' } })).toMatchObject(invalid);
    const dfsNull = fixture('dataforseo') as { tasks: { result: { items: unknown }[] }[] };
    dfsNull.tasks[0]!.result[0]!.items = null;
    expect(outcome('dataforseo', dfsNull)).toMatchObject(invalid);
    const dfsNoResult = fixture('dataforseo') as { tasks: { result: unknown }[] };
    dfsNoResult.tasks[0]!.result = null;
    expect(outcome('dataforseo', dfsNoResult)).toMatchObject(invalid);
  });

  test('serp-api-ads-without-a-link-skipped', () => {
    const serpapi = fixture('serpapi');
    const ads = serpapi.ads as Record<string, unknown>[];
    ads.push({ position: 3, block_position: 'top', title: 'No link' }, { position: 4, block_position: 'top', title: 'Script', link: 'javascript:void(0)' });
    const out = runSerpApiJob(job('serpapi', JSON.stringify(serpapi)));
    expect(out.skipped).toBe(3);
    expect(ready(out.snapshot).results.filter((r) => r.type === 'ad').map((r) => r.title)).toEqual(['Frost Gear Winter Sale', 'Frost Kit for Windows']);
    const dfs = fixture('dataforseo') as { tasks: { result: { items: Record<string, unknown>[] }[] }[] };
    dfs.tasks[0]!.result[0]!.items[0]!.url = 'ftp://ads.example.net/frost';
    const fromDfs = runSerpApiJob(job('dataforseo', JSON.stringify(dfs)));
    expect(fromDfs.skipped).toBe(2);
    expect(ready(fromDfs.snapshot).composition.counts.ad).toBe(0);
    // An organic result without a web link still refuses the answer (K-A1).
    (dfs.tasks[0]!.result[0]!.items[2]!).url = 'ftp://www.example.com/frost';
    expect(runSerpApiJob(job('dataforseo', JSON.stringify(dfs))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
  });

  test('serp-api-links-with-credentials-refused', () => {
    // Council review (item 9): a link carrying a user name or password is never kept, as in
    // `ai-search/parse.ts`. An ad with one is skipped and counted (like a non-web link); an organic
    // result with one refuses the answer (K-A1); any other item keeps its title without the link.
    const serpapi = fixture('serpapi');
    (serpapi.ads as Record<string, unknown>[]).push(
      { position: 3, block_position: 'top', title: 'With a password', link: 'http://user:pass@ads.example.net/frost' },
      { position: 4, block_position: 'top', title: 'With a user name', link: 'https://user@ads.example.net/frost' },
    );
    (serpapi.related_questions as Record<string, unknown>[])[0]!.link = 'https://me:pw@answers.example.org/frost';
    const out = runSerpApiJob(job('serpapi', JSON.stringify(serpapi)));
    expect(out.skipped).toBe(3);
    const snapshot = ready(out.snapshot);
    expect(snapshot.results.filter((r) => r.type === 'ad').map((r) => r.title)).toEqual(['Frost Gear Winter Sale', 'Frost Kit for Windows']);
    expect(JSON.stringify(snapshot)).not.toMatch(/user|pass|me:pw/);
    const dfs = fixture('dataforseo') as { tasks: { result: { items: Record<string, unknown>[] }[] }[] };
    dfs.tasks[0]!.result[0]!.items[0]!.url = 'https://user:pass@ads.example.net/frost';
    const fromDfs = runSerpApiJob(job('dataforseo', JSON.stringify(dfs)));
    expect(fromDfs.skipped).toBe(2);
    expect(ready(fromDfs.snapshot).composition.counts.ad).toBe(0);
    // An organic result with credentials refuses the answer, for every vendor.
    const organicDfs = fixture('dataforseo') as { tasks: { result: { items: Record<string, unknown>[] }[] }[] };
    organicDfs.tasks[0]!.result[0]!.items.find((i) => i.type === 'organic')!.url = 'http://user:pass@www.example.com/frost';
    expect(runSerpApiJob(job('dataforseo', JSON.stringify(organicDfs))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    const organicSerpApi = fixture('serpapi');
    (organicSerpApi.organic_results as Record<string, unknown>[])[0]!.link = 'https://user@www.example.com/';
    expect(runSerpApiJob(job('serpapi', JSON.stringify(organicSerpApi))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
    const organicSerper = fixture('serper');
    (organicSerper.organic as Record<string, unknown>[])[1]!.link = 'https://:secret@www.example.com/';
    expect(runSerpApiJob(job('serper', JSON.stringify(organicSerper))).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
  });

  test('serp-api-dataforseo-local-pack-is-one-block', () => {
    const text = readFileSync(path.join(HERE, 'fixtures', 'serp-api', 'dataforseo-local-pack.json'), 'utf8');
    const read = serpApiRead('dataforseo', text);
    const expected = [
      block('local-pack', item('Frost Outfitters', 'https://outfitters.example.net/'), item('Glacier Supply'), item('Polar Gear Co.', 'https://polargear.example.org/store')),
      block('organic', item('Frost Outfitters — winter gear', 'https://outfitters.example.net/winter'), item('Best frost gear shops', 'https://www.example.com/frost-shops'), item('Polar Gear Co. reviews', 'https://reviews.example.org/polar-gear')),
      block('related-searches', item('frost outfitters hours'), item('frost gear store')),
    ];
    expect(read.ok && read.read.ok && read.read.blocks).toEqual(expected);
    // The link-less ad is dropped and counted.
    expect(read.ok && read.skipped).toBe(1);
    const out = ready(runSerpApiJob(job('dataforseo', text)).snapshot);
    const tab = analyseSerp({ ok: true, blocks: expected, stats: { nodes: 0, elapsedMs: 0, truncated: false, organicCut: false } }, { params: PARAMS, packVersion: 1, redirects: [] });
    if (tab.status !== 'ready') throw new Error('tab not ready');
    expect(out.composition).toEqual(tab.composition);
    expect(out.composition.features).toEqual([
      { slot: 1, type: 'local-pack', results: 3 },
      { slot: 2, type: 'related-searches', results: 2 },
    ]);
    expect(out.ownership).toEqual(tab.ownership);
    expect(out.results).toEqual(tab.results);
  });

  test('serp-api-parse-is-bounded', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const invalid = (provider: SerpApiProvider, body: string) => {
        const outcome = runSerpApiJob(job(provider, body));
        expect(outcome.snapshot, body.slice(0, 80)).toMatchObject({ status: 'unreadable', reason: 'invalid-answer' });
        expect(outcome.vendorError).toBe(false);
      };
      // Oversize: refused before JSON.parse ever sees it (multi-byte characters count as their UTF-8 bytes).
      const pad = 'é'.repeat(Math.ceil(SERP_API_LIMITS.maxResponseBytes / 2) + 1);
      expect(Buffer.byteLength(pad, 'utf8')).toBeGreaterThan(SERP_API_LIMITS.maxResponseBytes);
      parse.mockClear();
      invalid('serper', `{"organic":[],"pad":"${pad}"}`);
      expect(serpApiRead('serper', `{"pad":"${pad}"}`)).toEqual({ ok: false, vendorError: false });
      expect(parse).not.toHaveBeenCalled();
      // Deep: refused before JSON.parse too, however deep (no stack overflow, no throw).
      for (const depth of [SERP_API_LIMITS.maxDepth + 1, 200_000]) {
        invalid('serpapi', `{"organic_results":${'['.repeat(depth)}${']'.repeat(depth)}}`);
        invalid('dataforseo', `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`);
      }
      // Brackets inside strings are text, not nesting.
      expect(serpApiRead('serper', JSON.stringify({ organic: [{ position: 1, title: '['.repeat(500), link: 'https://www.example.com/' }] })).ok).toBe(true);
      expect(parse).toHaveBeenCalledTimes(1);
      // Wrong types, anywhere a field is read.
      const serpapi = (patch: (json: Record<string, unknown>) => void) => {
        const json = fixture('serpapi');
        patch(json);
        return JSON.stringify(json);
      };
      for (const body of [
        'not json',
        '',
        'null',
        '[]',
        '"text"',
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.position = '1')),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.position = 0)),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.position = 1.5)),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.title = 7)),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.link = { href: 'https://x.example/' })),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.link = 'javascript:alert(1)')),
        serpapi((j) => (j.organic_results = { 0: { position: 1 } })),
        serpapi((j) => (j.ads = 'ads')),
        serpapi((j) => (j.answer_box = [])),
        serpapi((j) => (j.related_questions = [{ question: ['?'] }])),
        serpapi((j) => (j.organic_results = Array.from({ length: SERP_API_LIMITS.maxItems + 1 }, (_, i) => ({ position: i + 1, title: 't', link: 'https://www.example.com/' })))),
        serpapi((j) => ((j.organic_results as Record<string, unknown>[])[0]!.title = 'x'.repeat(SERP_API_LIMITS.maxStringChars + 1))),
      ]) {
        invalid('serpapi', body);
      }
      const dfs = (patch: (json: { status_code: unknown; tasks: { status_code?: unknown; result: { items: Record<string, unknown>[] }[] }[] }) => void) => {
        const json = fixture('dataforseo') as unknown as Parameters<typeof patch>[0];
        patch(json);
        return JSON.stringify(json);
      };
      for (const body of [
        dfs((j) => (j.tasks = 'tasks' as never)),
        dfs((j) => (j.tasks = [])),
        dfs((j) => (j.tasks[0]!.result[0]!.items[2]!.rank_group = '1')),
        dfs((j) => (j.tasks[0]!.result[0]!.items[2]!.rank_absolute = null)),
        dfs((j) => (j.tasks[0]!.result[0]!.items[2]!.type = 5)),
        dfs((j) => (j.tasks[0]!.result[0]!.items[4]!.items = { title: 'x' })),
        dfs((j) => (j.status_code = 'ok')),
      ]) {
        invalid('dataforseo', body);
      }
      invalid('serper', JSON.stringify({ organic: [{ position: 1, title: 't' }] }));
    } finally {
      parse.mockRestore();
    }
  });

  test('serp-api-parse-is-bounded: never throws, whatever the job', () => {
    for (const raw of [undefined, null, 1, 'job', {}, { provider: 'serpapi' }, { provider: 'nope', body: '{}', params: PARAMS, packVersion: 1 }, { ...job('serpapi', '{}'), params: { engine: 'google' } }, { ...job('serpapi', '{}'), packVersion: 0 }, { ...job('serpapi', '{}'), extra: true }]) {
      const out = runSerpApiJob(raw);
      expect(out.snapshot.status).toBe('unreadable');
      expect(SerpSnapshotSchema.safeParse(out.snapshot).success).toBe(true);
    }
  });

  test('serp-api-maps-to-a-ready-snapshot: parsed in the SERP worker (job kind api)', async () => {
    class FakeWorker extends EventEmitter implements AnalysisWorker {
      readonly posted: unknown[] = [];
      postMessage(message: unknown): void {
        this.posted.push(message);
        // As `serp-worker.ts` answers an `api` job.
        const { id, kind, job: posted } = message as { id: number; kind: string; job: unknown };
        if (kind !== 'api') return;
        const out = runSerpApiJob(posted);
        queueMicrotask(() => this.emit('message', { id, result: out.snapshot, skipped: out.skipped, vendorError: out.vendorError }));
      }
      terminate = () => Promise.resolve(1);
      unref(): void {}
    }
    const worker = new FakeWorker();
    const analyzer = createSerpAnalyzer({ spawn: () => worker });
    const sent = job('serpapi', fixtureText('serpapi'));
    const out = await analyzer.analyseApi(sent);
    expect(worker.posted).toEqual([{ id: 1, kind: 'api', job: sent }]);
    expect(ready(out.snapshot).results.filter((r) => r.type === 'organic')).toHaveLength(5);
    expect(out.skipped).toBe(1);
    expect(out.vendorError).toBe(false);
    analyzer.dispose();
    expect((await analyzer.analyseApi(sent)).snapshot).toMatchObject({ status: 'unreadable', reason: 'invalid-answer', params: PARAMS, packVersion: 1 });
  });

  test('serp-worker routes api jobs to runSerpApiJob', () => {
    const source = readFileSync(path.join(HERE, '..', 'serp-worker.ts'), 'utf8');
    expect(source).toMatch(/kind === 'api'/);
    expect(source).toMatch(/runSerpApiJob\(job\)/);
  });
});
