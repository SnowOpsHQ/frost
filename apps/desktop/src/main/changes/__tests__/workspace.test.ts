// Spec: specs/projects.spec.ts (normalizeSiteDomain, normalizeTag, normalizeTags, BULK_SEARCH_LIMITS, BULK_LINE_OUTCOMES,
// splitBulkSearches, bulkSearchInputs, searchUrlFor, PROJECT_SORTS, sortProjects, PROJECT_REFUSALS), specs/projects.schema.ts
// (the answers), specs/workspace-db.spec.ts (MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, MAX_PROJECT_TAGS, TAG_MAX_CHARS),
// specs/capture-db.spec.ts (UNFILED_PROJECT_ID, MAX_PROJECT_QUERIES), specs/rankings.spec.ts (SiteMatch)
// Acceptance: specs/projects.feature.md (Site and competitors; Tags; Bulk add; Favorites and sort; Scenario: project workspace)
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { openSessionStore, uuidv7, type ChangeIntelRepository } from '@app/db';
import { MAX_PROJECT_QUERIES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  AddCompetitorAnswerSchema,
  BulkAddAnswerSchema,
  ProjectDetailSchema,
  ProjectsAnswerSchema,
  SetSiteAnswerSchema,
  SetTagsAnswerSchema,
  bulkSearchInputs,
  normalizeSiteDomain,
  searchUrlFor,
  sortProjects,
  type BulkSearchesInput,
  type RunState,
  type StartRunAnswer,
} from '@app/specs/projects.schema';
import { MAX_PROJECT_COMPETITORS, MAX_PROJECT_TAGS, MAX_TAGS_PER_ENTRY, TAG_MAX_CHARS } from '@app/specs/workspace-db.spec';
import type { CaptureRuns, RunPlan } from '../capture-run';
import { createProjectsService } from '../projects';
import * as serpParams from '../serp-params';
import { createWorkspaceService, siteMatchOf } from '../workspace';

// Every saved search goes through the real Phase 6 path; the spy only watches it.
vi.mock('../serp-params', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serp-params')>();
  return { ...actual, searchParamsForUrl: vi.fn(actual.searchParamsForUrl) };
});

let clock = 3_000_000;
const tick = () => (clock += 1_000);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const IDLE: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [] };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-workspace-'));
  const opened = openSessionStore({ dir });
  const raw = new DatabaseSync(opened.file, { readOnly: true });
  cleanups.push(async () => {
    raw.close();
    await opened.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const runs = {
    start: vi.fn(async (_plan: RunPlan): Promise<StartRunAnswer> => ({ status: 'started', runId: uuidv7(tick()) })),
    cancel: vi.fn(() => true),
    stop: vi.fn(() => undefined),
    running: vi.fn((): string | null => null),
    state: vi.fn(() => IDLE),
    watch: vi.fn(async (_since: number) => IDLE),
  } satisfies CaptureRuns;
  const files = { unlink: vi.fn(async () => true), lock: async () => () => undefined, fileFor: (hash: string) => path.join(dir, 'none', `${hash}.png`) };
  const log = vi.fn((_message: string) => undefined);
  const projects = createProjectsService({ store: opened.changeIntel, files, confirmDelete: async () => true, activeUrl: () => null, runs, now: tick, log });
  const workspace = createWorkspaceService({ store: opened.changeIntel, now: tick, log });
  return { projects, workspace, repo: opened.changeIntel, raw, log, file: opened.file };
}

async function created(t: ReturnType<typeof setup>, name: string): Promise<string> {
  const answer = await t.projects.create(name);
  if (answer.status !== 'created') throw new Error(`refused: ${answer.reason}`);
  return answer.project.id;
}

async function pageOf(t: ReturnType<typeof setup>, projectId: string, url: string): Promise<string> {
  const answer = await t.projects.addPage(projectId, url);
  if (answer.status !== 'added') throw new Error(`refused: ${answer.reason}`);
  return answer.page.id;
}

/** A capture of `url` straight into the repository (`project`: as a run files it; `manual`: the Changes panel's). */
async function captureInto(repo: ChangeIntelRepository, projectId: string, url: string, source: 'project' | 'manual'): Promise<number> {
  const at = tick();
  const result = await repo.appendCapture({
    captureId: uuidv7(at),
    versionId: uuidv7(at),
    projectId,
    laneKey: sha(`${url} null`),
    pageUrl: url,
    renderProfileJson: null,
    renderProfilePartial: false,
    searchParamsJson: null,
    source,
    auditTakenAt: at,
    snapshotJson: JSON.stringify({ at }),
    snapshotHash: sha(String(at)),
    schemaVersion: 1,
    createdAt: at,
  });
  if (result?.status !== 'appended') throw new Error('not appended');
  return at;
}

const BULK: BulkSearchesInput = { text: 'green tea', engine: 'google', locales: [{ country: null, language: null }], devices: ['desktop'], tags: [] };

describe('project workspace', () => {
  test('site-domain-normalized', async () => {
    // A host or a URL: its lowercase host, IDN as punycode; port, path, query, fragment and trailing dots dropped.
    expect(normalizeSiteDomain('Tea-Shop.COM')).toBe('tea-shop.com');
    expect(normalizeSiteDomain('  https://WWW.Tea-Shop.com/guides?q=1#top ')).toBe('www.tea-shop.com');
    expect(normalizeSiteDomain('http://tea-shop.com:8080')).toBe('tea-shop.com');
    expect(normalizeSiteDomain('tea-shop.com/guides/green')).toBe('tea-shop.com');
    expect(normalizeSiteDomain('tea-shop.com.')).toBe('tea-shop.com');
    expect(normalizeSiteDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeSiteDomain('https://Bücher.DE/x')).toBe('xn--bcher-kva.de');
    expect(normalizeSiteDomain('shop.co.uk')).toBe('shop.co.uk');
    // Private, local, reserved and odd hosts; other schemes; IP literals; userinfo; too long.
    for (const bad of [
      '',
      '   ',
      'localhost',
      'http://localhost:3000',
      'intranet',
      'printer.local',
      'tea.example',
      'shop.test',
      'router.home.arpa',
      '192.168.1.10',
      '10.0.0.1',
      '8.8.8.8',
      '[::1]',
      'http://[2001:4860::8888]/',
      'ftp://tea-shop.com',
      'javascript:alert(1)',
      'file:///etc/hosts',
      'mailto:me@tea-shop.com',
      'user@tea-shop.com',
      'tea shop.com',
      'tea!shop.com',
      'tea‮shop.com',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
      `${'a'.repeat(64)}.com`,
      '-tea.com',
      'tea-.com',
      'shop.-tea.com',
      'shop.tea-.com',
    ])
      expect(normalizeSiteDomain(bad), bad).toBeNull();

    // The service stores the normalized host and answers it.
    const t = setup();
    const id = await created(t, 'Tea');
    expect(SetSiteAnswerSchema.parse(await t.workspace.setSite(id, 'HTTPS://Tea-Shop.com/guides', false))).toEqual({ status: 'ok', site: { domain: 'tea-shop.com', subdomains: false } });
    expect((await t.projects.get(id))?.project.site).toEqual({ domain: 'tea-shop.com', subdomains: false });
    expect(await t.workspace.setSite(id, 'printer.local', true)).toEqual({ status: 'refused', reason: 'invalid-domain' });
    expect(await t.workspace.setSite(id, '192.168.1.10', true)).toEqual({ status: 'refused', reason: 'invalid-domain' });
    // A bare public suffix has nothing registrable; a site under it is fine.
    for (const suffix of ['co.uk', 'https://com.au/', 'CO.JP']) expect(await t.workspace.setSite(id, suffix, true), suffix).toEqual({ status: 'refused', reason: 'invalid-domain' });
    expect(await t.workspace.setSite(id, 'www.tea.co.uk', true)).toEqual({ status: 'ok', site: { domain: 'www.tea.co.uk', subdomains: true } });
    expect(await t.workspace.setSite(id, 'HTTPS://Tea-Shop.com/guides', false)).toEqual({ status: 'ok', site: { domain: 'tea-shop.com', subdomains: false } });
    expect((await t.projects.get(id))?.project.site).toEqual({ domain: 'tea-shop.com', subdomains: false });
    expect(await t.workspace.setSite(uuidv7(tick()), 'tea-shop.com', true)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.workspace.setSite(id, null, true)).toEqual({ status: 'ok', site: null });
    expect((await t.projects.get(id))?.project.site).toBeNull();
    // Whose positions they are: Phase 3's owner rule.
    expect(siteMatchOf('blog.tea-shop.com', true)).toEqual({ owner: 'tea-shop.com', host: 'blog.tea-shop.com', subdomains: true });
    expect(siteMatchOf('www.shop.co.uk', false)).toEqual({ owner: 'shop.co.uk', host: 'www.shop.co.uk', subdomains: false });
  });

  test('competitors-capped-and-unique', async () => {
    const t = setup();
    const id = await created(t, 'Tea');
    const first = AddCompetitorAnswerSchema.parse(await t.workspace.addCompetitor(id, 'Rival-Tea.com'));
    expect(first).toMatchObject({ status: 'added', competitor: { domain: 'rival-tea.com' } });
    // Stored as its owner domain: the same domain typed another way, or another host of the owner, is the same competitor.
    expect(await t.workspace.addCompetitor(id, 'https://rival-tea.com/shop')).toEqual(first);
    expect(await t.workspace.addCompetitor(id, 'shop.Rival-Tea.com')).toEqual(first);
    expect(await t.workspace.addCompetitor(id, 'www.rival-tea.com')).toEqual(first);
    expect(await t.workspace.addCompetitor(id, 'rival.local')).toEqual({ status: 'refused', reason: 'invalid-domain' });
    // A bare public suffix has nothing registrable.
    expect(await t.workspace.addCompetitor(id, 'co.uk')).toEqual({ status: 'refused', reason: 'invalid-domain' });
    for (let n = 2; n <= MAX_PROJECT_COMPETITORS; n++) expect((await t.workspace.addCompetitor(id, `rival-${n}.com`)).status).toBe('added');
    expect(await t.workspace.addCompetitor(id, 'one-too-many.com')).toEqual({ status: 'refused', reason: 'limit' });
    // At the cap, one already there (by its owner) still answers it.
    expect(await t.workspace.addCompetitor(id, 'blog.rival-tea.com')).toEqual(first);
    const detail = ProjectDetailSchema.parse(await t.projects.get(id));
    expect(detail?.competitors.map((c) => c.domain)).toEqual(['rival-tea.com', ...Array.from({ length: MAX_PROJECT_COMPETITORS - 1 }, (_, n) => `rival-${n + 2}.com`)]);
    // Removing one makes room; removing it again is `not-found`.
    const competitorId = first.status === 'added' ? first.competitor.id : '';
    expect(await t.workspace.removeCompetitor(id, competitorId)).toEqual({ status: 'ok' });
    expect(await t.workspace.removeCompetitor(id, competitorId)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.workspace.addCompetitor(id, 'shop.one-too-many.co.uk')).toMatchObject({ status: 'added', competitor: { domain: 'one-too-many.co.uk' } });
    // Another project's competitor cannot be removed through this one; an unknown project is `not-found`.
    const other = await created(t, 'Coffee');
    const theirs = await t.workspace.addCompetitor(other, 'rival-tea.com');
    expect(theirs.status === 'added' && theirs.competitor.id !== competitorId).toBe(true);
    if (theirs.status === 'added') expect(await t.workspace.removeCompetitor(id, theirs.competitor.id)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.workspace.addCompetitor(uuidv7(tick()), 'rival-tea.com')).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('tags-normalized-and-capped', async () => {
    const t = setup();
    const id = await created(t, 'Tea');
    const page = await pageOf(t, id, 'https://tea-shop.com/a');
    const added = await t.projects.addQuery(id, { engine: 'google', query: 'green tea', country: null, language: null, device: 'desktop' });
    const search = added.status === 'added' ? added.query.id : '';
    // Normalized (white space, case), repeats dropped, sorted.
    expect(SetTagsAnswerSchema.parse(await t.workspace.setTags(id, 'page', page, ['  Brand  ', 'brand', 'Top\t 10']))).toEqual({ status: 'ok', tags: ['brand', 'top 10'] });
    expect(await t.workspace.setTags(id, 'search', search, ['Money'])).toEqual({ status: 'ok', tags: ['money'] });
    let detail = await t.projects.get(id);
    expect(detail?.pages[0]?.tags).toEqual(['brand', 'top 10']);
    expect(detail?.queries[0]?.tags).toEqual(['money']);
    // Refused tags change nothing.
    for (const tags of [[''], ['   '], ['x'.repeat(TAG_MAX_CHARS + 1)], ['a\u0007b'], ['a‮b'], Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, n) => `t${n}`)])
      expect(await t.workspace.setTags(id, 'page', page, tags)).toEqual({ status: 'refused', reason: 'invalid-tag' });
    expect((await t.projects.get(id))?.pages[0]?.tags).toEqual(['brand', 'top 10']);
    // An entry that is not a live page or search of the project (or the wrong kind) is `not-found`.
    expect(await t.workspace.setTags(id, 'search', page, ['x'])).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.workspace.setTags(id, 'page', uuidv7(tick()), ['x'])).toEqual({ status: 'refused', reason: 'not-found' });
    const other = await created(t, 'Coffee');
    expect(await t.workspace.setTags(other, 'page', page, ['x'])).toEqual({ status: 'refused', reason: 'not-found' });
    // An empty list clears them.
    expect(await t.workspace.setTags(id, 'search', search, [])).toEqual({ status: 'ok', tags: [] });
    // A project holds at most MAX_PROJECT_TAGS distinct tags.
    let next = 0;
    while (next < MAX_PROJECT_TAGS - 2) {
      const entry = await pageOf(t, id, `https://tea-shop.com/p${next}`);
      const tags = Array.from({ length: Math.min(MAX_TAGS_PER_ENTRY, MAX_PROJECT_TAGS - 2 - next) }, (_, n) => `tag ${next + n}`);
      expect((await t.workspace.setTags(id, 'page', entry, tags)).status).toBe('ok');
      next += tags.length;
    }
    expect(new Set((await t.repo.projectTags(id)).map((tag) => tag.tag)).size).toBe(MAX_PROJECT_TAGS);
    expect(await t.workspace.setTags(id, 'search', search, ['one more'])).toEqual({ status: 'refused', reason: 'limit' });
    expect(await t.workspace.setTags(id, 'search', search, ['brand'])).toEqual({ status: 'ok', tags: ['brand'] });
    // A tampered surplus (rows written behind the repository's back) never breaks the detail answer.
    const full = await pageOf(t, id, 'https://tea-shop.com/tampered');
    expect((await t.workspace.setTags(id, 'page', full, ['brand'])).status).toBe('ok');
    const writer = new DatabaseSync(t.file);
    try {
      const insert = writer.prepare('INSERT INTO ci_entry_tags (id, project_id, entry_kind, entry_id, tag, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
      for (let n = 0; n < MAX_TAGS_PER_ENTRY + 3; n++) {
        const at = tick();
        insert.run(uuidv7(at), id, 'page', full, `tag ${n}`, at, at);
      }
    } finally {
      writer.close();
    }
    const tampered = ProjectDetailSchema.parse(await t.projects.get(id));
    expect(tampered?.pages.find((entry) => entry.id === full)?.tags).toHaveLength(MAX_TAGS_PER_ENTRY);
    // Removing a page (or search) through the service tombstones its tags.
    expect(await t.projects.removePage(id, full)).toEqual({ status: 'ok' });
    expect(await t.projects.removePage(id, page)).toEqual({ status: 'ok' });
    expect(await t.projects.removeQuery(id, search)).toEqual({ status: 'ok' });
    const left = await t.repo.projectTags(id);
    expect(left.some((tag) => tag.entryId === page || tag.entryId === search)).toBe(false);
    expect(await t.workspace.setTags(id, 'page', page, ['brand'])).toEqual({ status: 'refused', reason: 'not-found' });
    detail = await t.projects.get(id);
    expect(detail?.pages.every((entry) => entry.tags.length > 0)).toBe(true);
  });

  test('bulk-add-lines-and-combinations', { timeout: 60_000 }, async () => {
    const t = setup();
    const id = await created(t, 'Tea');
    const input: BulkSearchesInput = { text: 'green tea\nblack tea, oolong\n\n  green   tea ', engine: 'google', locales: [{ country: 'de', language: 'de' }, { country: null, language: null }], devices: ['desktop', 'mobile'], tags: ['Rank '] };
    // Three lines (blanks and repeats dropped), each one search per locale and device.
    const first = BulkAddAnswerSchema.parse(await t.workspace.addSearches(id, input));
    expect(first).toEqual({ status: 'done', lines: ['green tea', 'black tea', 'oolong'].map((query) => ({ query, outcome: 'added', added: 4 })) });
    let detail = await t.projects.get(id);
    expect(detail?.queries).toHaveLength(12);
    expect(detail?.queries.map((q) => [q.params.query, q.params.gl, q.params.hl, q.params.device]).slice(0, 4)).toEqual([
      ['green tea', 'de', 'de', 'desktop'],
      ['green tea', 'de', 'de', 'mobile'],
      ['green tea', null, null, 'desktop'],
      ['green tea', null, null, 'mobile'],
    ]);
    // The tags go on each search it added.
    expect(detail?.queries.every((q) => q.tags.join() === 'rank')).toBe(true);
    // Again: every search is there already; a new line is added; one frost cannot make is `invalid` (nothing of it stored).
    const again = await t.workspace.addSearches(id, { ...input, text: `green tea\nwhite tea\n${'x'.repeat(201)}`, tags: [] });
    expect(again).toEqual({
      status: 'done',
      lines: [
        { query: 'green tea', outcome: 'exists', added: 0 },
        { query: 'white tea', outcome: 'added', added: 4 },
        { query: 'x'.repeat(201), outcome: 'invalid', added: 0 },
      ],
    });
    detail = await t.projects.get(id);
    expect(detail?.queries).toHaveLength(16);
    // Searches already saved keep their tags; the new ones have none.
    expect(detail?.queries.filter((q) => q.params.query === 'white tea').every((q) => q.tags.length === 0)).toBe(true);
    expect(detail?.queries.filter((q) => q.params.query === 'green tea').every((q) => q.tags.join() === 'rank')).toBe(true);
    // The cap: 34 more fit; the line that reaches it is `limit` (what it added stays), every later one `limit` untried.
    const lines = Array.from({ length: 10 }, (_, n) => `tea ${n}`);
    const capped = await t.workspace.addSearches(id, { ...input, text: lines.join('\n'), tags: [] });
    expect(capped).toEqual({
      status: 'done',
      lines: lines.map((query, n) => ({ query, outcome: n < 8 ? 'added' : 'limit', added: n < 8 ? 4 : n === 8 ? 2 : 0 })),
    });
    expect((await t.projects.get(id))?.queries).toHaveLength(MAX_PROJECT_QUERIES);
    const full = await t.workspace.addSearches(id, { ...input, text: 'green tea\nrooibos', tags: [] });
    expect(full).toEqual({ status: 'done', lines: [{ query: 'green tea', outcome: 'exists', added: 0 }, { query: 'rooibos', outcome: 'limit', added: 0 }] });
    // Refused before anything is stored: bad tags, an unknown project.
    const other = await created(t, 'Coffee');
    expect(await t.workspace.addSearches(other, { ...BULK, tags: ['a\u0000b'] })).toEqual({ status: 'refused', reason: 'invalid-tag' });
    expect(await t.workspace.addSearches(uuidv7(tick()), BULK)).toEqual({ status: 'refused', reason: 'not-found' });
    expect((await t.projects.get(other))?.queries).toEqual([]);
  });

  test('bulk-add-uses-the-phase-6-path', async () => {
    const t = setup();
    const id = await created(t, 'Tea');
    const spy = vi.mocked(serpParams.searchParamsForUrl);
    spy.mockClear();
    // Nothing goes to the network: any fetch would fail the test.
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in bulk add'));
    const input: BulkSearchesInput = { text: 'green tea', engine: 'bing', locales: [{ country: 'fr', language: 'fr' }], devices: ['desktop', 'tablet'], tags: [] };
    expect(await t.workspace.addSearches(id, input)).toEqual({ status: 'done', lines: [{ query: 'green tea', outcome: 'added', added: 2 }] });
    const searches = bulkSearchInputs('green tea', input);
    expect(spy.mock.calls.map(([url, device]) => [url, device])).toEqual(searches.map((search) => [searchUrlFor(search), search.device]));
    // Stored exactly as Phase 3 reads the built URL, as `addSearch` stores it (so adding it again there finds it).
    const stored = (t.raw.prepare('SELECT search_params FROM ci_project_queries WHERE project_id = ? ORDER BY created_at, id').all(id) as { search_params: string }[]).map((row) => row.search_params);
    const actual = await vi.importActual<typeof import('../serp-params')>('../serp-params');
    expect(stored).toEqual(searches.map((search) => canonicalJson(actual.searchParamsForUrl(searchUrlFor(search), search.device))));
    const before = (await t.projects.get(id))?.queries.map((q) => q.id);
    const single = await t.projects.addQuery(id, searches[1]!);
    expect(single.status === 'added' && single.query.id).toBe(before?.[1]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('favorite-and-sort', async () => {
    const t = setup();
    const tea = await created(t, 'tea');
    const coffee = await created(t, 'Coffee');
    const herbs = await created(t, 'herbs');
    const before = await t.repo.project(coffee);
    expect(await t.workspace.setFavorite(coffee, true)).toEqual({ status: 'ok' });
    expect(await t.workspace.setFavorite(herbs, true)).toEqual({ status: 'ok' });
    expect(await t.workspace.setFavorite(herbs, false)).toEqual({ status: 'ok' });
    expect(await t.workspace.setFavorite(UNFILED_PROJECT_ID, true)).toEqual({ status: 'ok' });
    expect(await t.workspace.setFavorite(uuidv7(tick()), true)).toEqual({ status: 'refused', reason: 'not-found' });
    // Device-local: the star never changes the project's `updated_at` (sync's last-writer-wins).
    expect((await t.repo.project(coffee))?.updatedAt).toBe(before?.updatedAt);
    // The last capture of any source: a run's, or a manual one; the newest wins.
    await captureInto(t.repo, tea, 'https://tea-shop.com/a', 'project');
    const teaManual = await captureInto(t.repo, tea, 'https://tea-shop.com/b', 'manual');
    const herbsManual = await captureInto(t.repo, herbs, 'https://tea-shop.com/c', 'manual');
    // One grouped read for the whole list, not one per project.
    const grouped = vi.spyOn(t.repo, 'projectsLastCapturedAt');
    const perProject = vi.spyOn(t.repo, 'lastProjectRunAt');
    const list = ProjectsAnswerSchema.parse(await t.projects.list());
    expect(grouped).toHaveBeenCalledOnce();
    expect(perProject).not.toHaveBeenCalled();
    expect(list.projects.map((p) => [p.name, p.favorite, p.lastCapturedAt])).toEqual([
      ['Unfiled', true, null],
      ['tea', false, teaManual],
      ['Coffee', true, null],
      ['herbs', false, herbsManual],
    ]);
    expect(list.projects.find((p) => p.id === tea)?.createdAt).toBe((await t.repo.project(tea))?.createdAt);
    // The forPage and get summaries say the same.
    await pageOf(t, coffee, 'https://tea-shop.com/b');
    expect((await t.projects.forPage('https://tea-shop.com/b')).projects).toEqual([list.projects.find((p) => p.id === coffee)]);
    expect((await t.projects.get(coffee))?.project).toEqual(list.projects.find((p) => p.id === coffee));
    // Unfiled first, favorites next, then each sort.
    expect(sortProjects(list.projects, 'name').map((p) => p.name)).toEqual(['Unfiled', 'Coffee', 'herbs', 'tea']);
    expect(sortProjects(list.projects, 'last-captured').map((p) => p.name)).toEqual(['Unfiled', 'Coffee', 'herbs', 'tea']);
    expect(sortProjects(list.projects, 'created').map((p) => p.name)).toEqual(['Unfiled', 'Coffee', 'herbs', 'tea']);
  });

  test('unfiled-refuses-workspace-fields', async () => {
    const t = setup();
    expect(await t.workspace.setSite(UNFILED_PROJECT_ID, 'tea-shop.com', true)).toEqual({ status: 'refused', reason: 'unfiled' });
    expect(await t.workspace.setSite(UNFILED_PROJECT_ID, null, true)).toEqual({ status: 'refused', reason: 'unfiled' });
    expect(await t.workspace.addCompetitor(UNFILED_PROJECT_ID, 'rival-tea.com')).toEqual({ status: 'refused', reason: 'unfiled' });
    expect(await t.workspace.removeCompetitor(UNFILED_PROJECT_ID, uuidv7(tick()))).toEqual({ status: 'refused', reason: 'unfiled' });
    const unfiled = await t.projects.get(UNFILED_PROJECT_ID);
    expect(unfiled?.project.site).toBeNull();
    expect(unfiled?.competitors).toEqual([]);
    // Its pages and searches still take tags, and it can still be starred.
    const page = await pageOf(t, UNFILED_PROJECT_ID, 'https://tea-shop.com/a');
    expect(await t.workspace.setTags(UNFILED_PROJECT_ID, 'page', page, ['inbox'])).toEqual({ status: 'ok', tags: ['inbox'] });
    expect(await t.workspace.setFavorite(UNFILED_PROJECT_ID, true)).toEqual({ status: 'ok' });
  });

  test('workspace-never-rejects', async () => {
    const t = setup();
    const id = await created(t, 'Tea');
    // A store whose every call fails: each method answers `store-failed` and logs the error's code, never its message.
    const failing = new Proxy(t.repo, {
      get: (target, key) => (typeof target[key as keyof typeof target] === 'function' ? async () => Promise.reject(Object.assign(new Error('secret https://tea-shop.com/private'), { code: 'SQLITE_IOERR' })) : target[key as keyof typeof target]),
    }) as ChangeIntelRepository;
    const log = vi.fn((_message: string) => undefined);
    const workspace = createWorkspaceService({ store: failing, now: tick, log });
    const failed = { status: 'refused', reason: 'store-failed' };
    expect(await workspace.setFavorite(id, true)).toEqual(failed);
    expect(await workspace.setSite(id, 'tea-shop.com', true)).toEqual(failed);
    expect(await workspace.addCompetitor(id, 'rival-tea.com')).toEqual(failed);
    expect(await workspace.removeCompetitor(id, id)).toEqual(failed);
    expect(await workspace.setTags(id, 'page', id, ['x'])).toEqual(failed);
    expect(await workspace.addSearches(id, BULK)).toEqual(failed);
    expect(log).toHaveBeenCalled();
    for (const [line] of log.mock.calls) {
      expect(line).toContain('SQLITE_IOERR');
      expect(line).not.toContain('secret');
    }
    // Nonsense in (past the router's checks) is answered, never thrown.
    const odd = createWorkspaceService({ store: t.repo, now: tick });
    expect(await odd.setSite(id, 5 as unknown as string, true)).toEqual({ status: 'refused', reason: 'invalid-domain' });
    expect(await odd.setTags(id, 'page', id, null as unknown as string[])).toEqual({ status: 'refused', reason: 'invalid-tag' });
    expect((await odd.addSearches(id, { ...BULK, text: '' })).status).toBe('refused');
  });
});
