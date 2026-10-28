// Spec: specs/changes.spec.ts (CAPTURE_REFUSALS, CAPTURE_BUSY, CAPTURE_STALE_RETRIES), specs/changes.schema.ts
// (RegionAnswerSchema, CHANGES_READ_API), specs/capture-db.spec.ts (UNFILED_PROJECT_ID), specs/capture.spec.ts (DIFF_ENGINE_VERSION)
// Acceptance: specs/changes-capture.feature.md (The service, Scenarios: Service)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson, diffSnapshots } from '@app/change-intel';
import { openSessionStore, uuidv7, type AppendCaptureInput, type SessionStore } from '@app/db';
import type { SeoAuditResponse } from '@app/seo-core';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { CAPTURE_LIMITS, DIFF_ENGINE_VERSION, type CaptureSnapshot } from '@app/specs/capture-snapshot.schema';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { CAPTURE_BUSY, CHANGES_READ_API, type CaptureAnswer, type RegionAnswer } from '@app/specs/changes.schema';
import { DEFAULT_RENDER_PROFILE, type AuditRenderProfile, type RenderProfile } from '@app/specs/render-profile.spec';
import { auditOf, regionAnswer, regionText } from './fakes';
import { createChangesService, type ChangesServiceDeps } from '../service';
import { buildCaptureSnapshot, identityHash, laneKeyFor, sha256Hex } from '../snapshot';

const PAGE = 'https://example.com/guides/tea';
const OTHER = 'https://example.com/other';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const PARAMS: SearchParams = { engine: 'google', query: 'green tea', country: 'de', language: 'de', location: null, device: 'mobile' };
const SECRET = 'SECRET PAGE TEXT';

/** One clock for every service and direct append in a test file, so rows are in the order they were made. */
let clock = 1_000_000;
const tick = () => (clock += 1_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A session store on a fresh profile directory, and a second, read-only connection to look at its rows. */
function store(): { opened: SessionStore; raw: DatabaseSync } {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-changes-'));
  const opened = openSessionStore({ dir });
  const raw = new DatabaseSync(opened.file, { readOnly: true });
  cleanups.push(() => {
    raw.close();
    void opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { opened, raw };
}

const captured = (answer: CaptureAnswer) => {
  if (answer.status !== 'captured') throw new Error(`refused: ${answer.reason}`);
  return answer;
};
const refused = (answer: CaptureAnswer) => (answer.status === 'refused' ? answer.reason : 'captured');

/** The capture's tabs (1 and 2 open, 1 active), a real store, and a region extraction that answers `answer`. */
function setup(deps: Partial<ChangesServiceDeps> = {}) {
  const { opened, raw } = store();
  const state = {
    active: 1 as number | null,
    url: PAGE,
    response: { status: 'ready', url: PAGE, audit: auditOf(PAGE), renderProfile: null } as SeoAuditResponse,
    answer: regionAnswer(PAGE) as unknown,
    params: null as SearchParams | null,
    loadedAt: null as number | null,
  };
  const contents = new Map([1, 2].map((id) => [id, { executeJavaScriptInIsolatedWorld: vi.fn(async () => null), getURL: () => state.url }]));
  const extract = vi.fn(async (_contents: unknown): Promise<unknown> => state.answer);
  const log = vi.fn((_message: string) => undefined);
  const service = createChangesService({
    store: opened.changeIntel,
    tabs: {
      activeTabId: () => state.active,
      contentsOf: (tabId) => contents.get(tabId) ?? null,
      getAudit: (tabId) => (contents.has(tabId) ? state.response : { status: 'unavailable', url: '', reason: 'no-tab' }),
      loadedAt: () => state.loadedAt,
    },
    extract,
    now: tick,
    log,
    searchParamsOf: () => state.params,
    ...deps,
  });
  /** A fresh ready audit of the page (a new `takenAt`), with `title` and the main text `text`. */
  const changePage = (title: string, text: string, renderProfile: AuditRenderProfile | null = null) => {
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE, { titles: [{ text: title, length: title.length }], extractedAt: (clock += 1) }), renderProfile };
    state.answer = regionAnswer(PAGE, { main: regionText(['Main heading', text]) });
  };
  const rows = (table: string, where = '1', ...args: (string | number)[]) => raw.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at, id`).all(...args) as Record<string, unknown>[];
  return { service, state, extract, log, opened, raw, rows, changePage, repo: opened.changeIntel, tick };
}

/** A real snapshot of the page with `text` in main, as canonical JSON with its identity hash. */
function storedSnapshot(text: string) {
  const snapshot = buildCaptureSnapshot(auditOf(PAGE), regionAnswer(PAGE, { main: regionText(['Main heading', text]) }), sha256Hex);
  return { snapshot, json: canonicalJson(snapshot), hash: identityHash(snapshot) };
}

/** An append straight into the repository (another writer, or tampered JSON). */
function appendInput(at: number, changes: Partial<AppendCaptureInput>): AppendCaptureInput {
  return {
    captureId: uuidv7(at),
    versionId: uuidv7(at),
    projectId: UNFILED_PROJECT_ID,
    laneKey: laneKeyFor(PAGE, null, null)!,
    pageUrl: PAGE,
    renderProfileJson: null,
    renderProfilePartial: false,
    searchParamsJson: null,
    source: 'manual',
    auditTakenAt: at,
    snapshotJson: '{"version":1}',
    snapshotHash: sha256Hex(`${at}`),
    schemaVersion: 1,
    createdAt: at,
    ...changes,
  };
}

describe('changes service', () => {
  test('capture-needs-a-ready-audit', async () => {
    const { service, state, extract, rows, repo } = setup();
    state.response = { status: 'pending', url: PAGE };
    expect(refused(await service.capture(1))).toBe('no-audit');
    state.response = { status: 'unavailable', url: PAGE, reason: 'timeout' };
    expect(refused(await service.capture(1))).toBe('no-audit');
    // A ready audit of another URL (the tab moved on) is not this page's.
    state.response = { status: 'ready', url: OTHER, audit: auditOf(OTHER) };
    expect(refused(await service.capture(1))).toBe('no-audit');
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE) };
    expect(refused(await service.capture(2))).toBe('not-active');
    expect(refused(await service.capture(3))).toBe('no-tab');
    expect(refused(await service.capture(1, { projectId: uuidv7() }))).toBe('no-project');
    const gone = (await repo.createProject('Gone', 1))!;
    await repo.tombstoneProject(gone.id, 2);
    expect(refused(await service.capture(1, { projectId: gone.id }))).toBe('no-project');
    expect(extract).not.toHaveBeenCalled();

    // The page moved on while it was read: another URL answered, a new audit, or another tab in front.
    state.answer = regionAnswer(OTHER);
    expect(refused(await service.capture(1))).toBe('no-audit');
    extract.mockImplementationOnce(async () => {
      state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE, { extractedAt: 5 }) };
      return regionAnswer(PAGE);
    });
    expect(refused(await service.capture(1))).toBe('no-audit');
    extract.mockImplementationOnce(async () => {
      state.active = 2;
      return regionAnswer(PAGE);
    });
    expect(refused(await service.capture(1))).toBe('not-active');
    expect(rows('ci_captures')).toEqual([]);

    // The fragment aside, the tab's page is the audit's: captured into Unfiled.
    state.active = 1;
    state.url = `${PAGE}#brewing`;
    state.answer = regionAnswer(`${PAGE}#brewing`);
    const first = captured(await service.capture(1));
    expect(first).toMatchObject({ newVersion: true, changeCount: null });
    expect(rows('ci_captures')).toMatchObject([{ id: first.captureId, version_id: first.versionId, project_id: UNFILED_PROJECT_ID, page_url: PAGE, source: 'manual' }]);
  });

  test('capture-waits-for-a-settled-audit-of-this-load', async () => {
    const { service, state, extract, rows } = setup();
    const takenAt = (state.response as Extract<SeoAuditResponse, { status: 'ready' }>).audit.takenAt;
    // The tab loaded (or reloaded, same URL) after the audit was taken: that audit is the last load's.
    state.loadedAt = takenAt + 1;
    expect(refused(await service.capture(1))).toBe('no-audit');
    state.loadedAt = takenAt;
    expect(refused(await service.capture(1))).toBe('no-audit');
    // A provisional audit (robots.txt still on its way) is not settled.
    state.loadedAt = takenAt - 1;
    const robots = { url: 'https://example.com/robots.txt', status: null, finalUrl: null, redirects: 0, body: new Uint8Array(), truncated: false };
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE, {}, { response: null, robots: { ...robots, outcome: 'pending' } }) };
    expect(refused(await service.capture(1))).toBe('no-audit');
    expect(extract).not.toHaveBeenCalled();
    expect(rows('ci_captures')).toEqual([]);
    // Settled, and taken after the load: captured.
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE, {}, { response: null, robots: { ...robots, outcome: 'unavailable' } }) };
    expect((await service.capture(1)).status).toBe('captured');
  });

  test('long-urls-are-invalid-pages', async () => {
    const { service, state, extract, log } = setup();
    const long = `${PAGE}?q=${'x'.repeat(CAPTURE_LIMITS.maxUrlChars)}`;
    state.url = long;
    state.response = { status: 'ready', url: long, audit: { ...auditOf(PAGE), url: long } };
    expect(refused(await service.capture(1))).toBe('invalid-page');
    expect(extract).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  test('partial-capture-without-changes-reuses-version', async () => {
    const { service, state, rows } = setup();
    const full = regionAnswer(PAGE);
    full.links = { total: 2, internal: 2, external: 0, nofollow: 0, list: [...full.links.list, { href: 'https://example.com/last', text: 'Last', rel: '', region: 'nav' }] };
    state.answer = full;
    const one = captured(await service.capture(1));
    // The same page, read in part: the last link was not reached. Nothing changed, so no new version.
    state.answer = { ...full, partial: true, links: { ...full.links, list: full.links.list.slice(0, 1) } };
    const two = captured(await service.capture(1));
    expect(two).toMatchObject({ versionId: one.versionId, newVersion: false, changeCount: 0 });
    expect(rows('ci_versions')).toHaveLength(1);
    // A partial capture that did change still makes a version.
    state.answer = { ...full, partial: true, regions: { ...full.regions, main: regionText(['Main heading', 'A new first paragraph.']) } };
    expect(captured(await service.capture(1)).newVersion).toBe(true);
  });

  test('project-tombstoned-mid-capture', async () => {
    const { service, extract, repo, rows } = setup();
    const project = (await repo.createProject('Short-lived', 1))!;
    extract.mockImplementationOnce(async () => {
      await repo.tombstoneProject(project.id, 2);
      return regionAnswer(PAGE);
    });
    expect(refused(await service.capture(1, { projectId: project.id }))).toBe('no-project');
    expect(rows('ci_captures')).toEqual([]);
  });

  test('capture-records-profile-and-params', async () => {
    const { service, state, rows, repo } = setup();
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE), renderProfile: { profile: PHONE, partial: true } };
    state.params = PARAMS;
    const one = captured(await service.capture(1));
    const lane = laneKeyFor(PAGE, PHONE, PARAMS);
    expect(rows('ci_captures')).toMatchObject([
      { id: one.captureId, render_profile: canonicalJson(PHONE), render_profile_partial: 1, search_params: canonicalJson(PARAMS), source: 'manual', lane_key: lane, audit_taken_at: (state.response as { audit: { takenAt: number } }).audit.takenAt },
    ]);
    expect(rows('ci_versions')).toMatchObject([{ id: one.versionId, lane_key: lane, render_profile: canonicalJson(PHONE), search_params: canonicalJson(PARAMS), page_url: PAGE }]);
    const history = await service.history({ url: PAGE });
    expect(history.versions).toMatchObject([{ versionId: one.versionId, laneKey: lane, renderProfile: PHONE, searchParams: PARAMS, captureCount: 1, parentVersionId: null, summary: null, changeCount: null }]);

    // A project's capture run passes its source and the query's search parameters.
    const project = (await repo.createProject('Teas', 5))!;
    const query: SearchParams = { ...PARAMS, query: 'oolong', device: null };
    const run = captured(await service.capture(1, { projectId: project.id, source: 'project', searchParams: query }));
    expect(rows('ci_captures', 'id = ?', run.captureId)).toMatchObject([{ project_id: project.id, source: 'project', search_params: canonicalJson(query), lane_key: laneKeyFor(PAGE, PHONE, query) }]);
    expect(run.newVersion).toBe(true);
    // Search parameters that do not fit their schema are refused.
    expect(refused(await service.capture(1, { searchParams: { ...PARAMS, extra: 1 } as SearchParams }))).toBe('invalid-page');
    state.params = { ...PARAMS, country: 'DE' };
    expect(refused(await service.capture(1))).toBe('invalid-page');

    // No profile: `null`, not partial.
    state.params = null;
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE) };
    const plain = captured(await service.capture(1));
    expect(rows('ci_captures', 'id = ?', plain.captureId)).toMatchObject([{ render_profile: null, render_profile_partial: 0, search_params: null, lane_key: laneKeyFor(PAGE, null, null) }]);
  });

  test('unchanged-page-reuses-version', async () => {
    const { service, state, rows } = setup();
    const one = captured(await service.capture(1));
    // A fresh audit of the same page (another `takenAt`): the same version.
    state.response = { status: 'ready', url: PAGE, audit: auditOf(PAGE, { extractedAt: 1_770_000_000_000 }) };
    const two = captured(await service.capture(1));
    expect(two).toEqual({ status: 'captured', captureId: two.captureId, versionId: one.versionId, newVersion: false, changeCount: 0 });
    expect(rows('ci_versions')).toHaveLength(1);
    expect(rows('ci_captures')).toHaveLength(2);
    expect(rows('ci_diffs')).toEqual([]);
    expect((await service.history({ url: PAGE })).versions).toMatchObject([{ versionId: one.versionId, captureCount: 2 }]);
  });

  test('changed-page-stores-diff', async () => {
    const { service, rows, changePage } = setup();
    const one = captured(await service.capture(1));
    changePage('Green tea, brewed better', 'A first paragraph about green tea.');
    const two = captured(await service.capture(1));
    expect(two.newVersion).toBe(true);
    const [before, after] = [(await service.version({ versionId: one.versionId }))!, (await service.version({ versionId: two.versionId }))!];
    const expected = diffSnapshots(before, after);
    expect(expected.changeCount).toBeGreaterThan(0);
    expect(two.changeCount).toBe(expected.changeCount);
    expect(rows('ci_diffs')).toMatchObject([
      { from_version_id: one.versionId, to_version_id: two.versionId, engine_version: DIFF_ENGINE_VERSION, diff: canonicalJson(expected), summary: canonicalJson(expected.summary), change_count: expected.changeCount },
    ]);
    expect(expected.changes.some((change) => change.region === 'head' && change.field === 'title')).toBe(true);
    expect(expected.changes.some((change) => change.region === 'main' && change.field === 'text' && change.kind === 'changed')).toBe(true);
    const history = await service.history({ url: PAGE });
    expect(history.versions.map((v) => v.versionId)).toEqual([two.versionId, one.versionId]);
    expect(history.versions[0]).toMatchObject({ parentVersionId: one.versionId, summary: expected.summary, changeCount: expected.changeCount });
    expect(history.versions[1]).toMatchObject({ parentVersionId: null, summary: null, changeCount: null });
    expect(await service.diff({ fromVersionId: one.versionId, toVersionId: two.versionId })).toEqual(expected);
  });

  test('stale-head-retries-once', async () => {
    const { opened, rows, service } = setup();
    const real = opened.changeIntel;
    const one = captured(await service.capture(1));
    // Another writer makes a new version between this capture's head read and its append.
    const other = storedSnapshot('Written by someone else.');
    let raced = false;
    const appendCapture = vi.fn(async (input: AppendCaptureInput) => {
      if (!raced) {
        raced = true;
        const at = tick();
        const diff = { id: uuidv7(at), fromVersionId: one.versionId, engineVersion: DIFF_ENGINE_VERSION, diffJson: '{"x":1}', summaryJson: '{"x":1}', changeCount: 1 };
        await real.appendCapture(appendInput(at, { snapshotJson: other.json, snapshotHash: other.hash, diff }));
      }
      return real.appendCapture(input);
    });
    const racing = setup({ store: { ...real, appendCapture } });
    racing.changePage('Retitled', 'A first paragraph about green tea.');
    const two = captured(await racing.service.capture(1));
    expect(appendCapture).toHaveBeenCalledTimes(2);
    const versions = rows('ci_versions');
    expect(versions).toHaveLength(3);
    expect(versions[2]).toMatchObject({ id: two.versionId, parent_version_id: versions[1]!.id });
    expect(rows('ci_diffs', 'to_version_id = ?', two.versionId)).toMatchObject([{ from_version_id: versions[1]!.id }]);

    // A lane that keeps moving: two stale appends, then `store-failed`.
    const stale = vi.fn(async () => ({ status: 'stale' }) as const);
    const stuck = setup({ store: { ...real, appendCapture: stale } });
    stuck.changePage('Again', 'Another text.');
    expect(refused(await stuck.service.capture(1))).toBe('store-failed');
    expect(stale).toHaveBeenCalledTimes(2);
    expect(stuck.log).toHaveBeenCalledTimes(1);
  });

  test('unreadable-head-diffs-from-empty', async () => {
    const { service, repo, rows } = setup();
    // The lane's head does not read back as a snapshot (another snapshot version, or tampered).
    const head = appendInput(tick(), { snapshotJson: '{"version":1,"bogus":true}' });
    expect(await repo.appendCapture(head)).toMatchObject({ status: 'appended', newVersion: true });
    const next = captured(await service.capture(1));
    expect(next.newVersion).toBe(true);
    const snapshot = (await service.version({ versionId: next.versionId }))!;
    const expected = diffSnapshots(null, snapshot);
    expect(next.changeCount).toBe(expected.changeCount);
    expect(expected.changes.every((change) => change.kind === 'added')).toBe(true);
    expect(rows('ci_diffs')).toMatchObject([{ from_version_id: head.versionId, to_version_id: next.versionId, diff: canonicalJson(expected) }]);
    expect(await service.version({ versionId: head.versionId })).toBeNull();
  });

  test('capture-busy-per-tab', async () => {
    const { service, state, extract } = setup();
    let release: (value: unknown) => void = () => undefined;
    extract.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = service.capture(1);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    expect(await service.capture(1)).toEqual({ status: 'refused', reason: CAPTURE_BUSY });
    // Another tab is not busy (it is refused for its own reason).
    expect(refused(await service.capture(2))).toBe('not-active');
    release(state.answer);
    expect((await first).status).toBe('captured');
    expect((await service.capture(1)).status).toBe('captured');
    // A refused capture frees the tab too.
    extract.mockRejectedValueOnce(new Error('gone'));
    expect(refused(await service.capture(1))).toBe('extract-failed');
    expect((await service.capture(1)).status).toBe('captured');
  });

  test('capture-never-rejects', async () => {
    const failing = async (deps: Partial<ChangesServiceDeps>, prepare?: (t: ReturnType<typeof setup>) => void) => {
      const t = setup(deps);
      prepare?.(t);
      const answer = await t.service.capture(1);
      expect(t.log, JSON.stringify(t.log.mock.calls)).toHaveBeenCalledTimes(1);
      expect(t.log.mock.calls[0]![0]).not.toContain(SECRET);
      return refused(answer);
    };
    expect(await failing({}, (t) => t.extract.mockRejectedValueOnce(new Error(`Uncaught ${SECRET}`)))).toBe('extract-failed');
    expect(await failing({ extractTimeoutMs: 20 }, (t) => t.extract.mockImplementationOnce(() => new Promise(() => undefined)))).toBe('extract-failed');
    expect(await failing({}, (t) => (t.state.answer = { ...regionAnswer(PAGE), headings: [{ level: 1, text: SECRET.repeat(100), region: 'main' }] }))).toBe('extract-failed');
    const throwing = (name: 'appendCapture' | 'latestVersion' | 'project') => (t: ReturnType<typeof setup>) => {
      vi.spyOn(t.repo, name).mockRejectedValue(Object.assign(new Error(`Failed query: insert … params: ${SECRET}`), { code: 'ERR_SQLITE_ERROR' }));
    };
    expect(await failing({}, throwing('appendCapture'))).toBe('store-failed');
    expect(await failing({}, throwing('latestVersion'))).toBe('store-failed');
    expect(await failing({}, throwing('project'))).toBe('store-failed');
    const audit = setup();
    const broken = setup({
      tabs: {
        activeTabId: () => 1,
        contentsOf: () => ({ executeJavaScriptInIsolatedWorld: async () => null, getURL: () => PAGE }),
        getAudit: () => {
          throw new Error('controller gone');
        },
        loadedAt: () => null,
      },
    });
    await expect(broken.service.capture(1)).resolves.toEqual({ status: 'refused', reason: 'no-audit' });
    expect(broken.log).toHaveBeenCalledTimes(1);
    // Reads never reject either.
    vi.spyOn(audit.repo, 'history').mockRejectedValue(new Error('closed'));
    vi.spyOn(audit.repo, 'version').mockRejectedValue(new Error('closed'));
    vi.spyOn(audit.repo, 'pages').mockRejectedValue(new Error('closed'));
    await expect(audit.service.history({ url: PAGE })).resolves.toEqual({ versions: [], next: null });
    await expect(audit.service.version({ versionId: uuidv7() })).resolves.toBeNull();
    await expect(audit.service.diff({ fromVersionId: uuidv7(), toVersionId: uuidv7() })).resolves.toBeNull();
    await expect(audit.service.pages({})).resolves.toEqual({ pages: [] });
  });

  test('region-answer-is-validated', async () => {
    const { service, state, rows } = setup();
    const good = regionAnswer(PAGE);
    const tooMany = regionText(Array.from({ length: CAPTURE_LIMITS.maxBlocksPerRegion + 1 }, (_, i) => `Block ${i}`));
    const answers: unknown[] = [
      'garbage',
      null,
      {},
      [],
      { ...good, extra: 1 },
      { ...good, regions: { ...good.regions, main: tooMany } },
      { ...good, regions: { ...good.regions, main: { ...regionText(['a']), text: 'not the blocks' } } },
      { ...good, regions: { ...good.regions, main: { ...regionText(['a']), text: 'x'.repeat(CAPTURE_LIMITS.maxHashedRegionChars + 1), truncated: true } } },
      { ...good, links: { ...good.links, internal: 5 } },
      { ...good, headings: [{ level: 7, text: 'h', region: 'main' }] },
      { ...good, headings: [{ level: 1, text: 'h', region: 'sidebar' }] },
      { ...good, links: { ...good.links, list: Array.from({ length: CAPTURE_LIMITS.maxLinks + 1 }, () => good.links.list[0]) } },
    ];
    for (const answer of answers) {
      state.answer = answer;
      expect(refused(await service.capture(1)), JSON.stringify(answer)?.slice(0, 80)).toBe('extract-failed');
    }
    expect(rows('ci_captures')).toEqual([]);
    state.answer = good satisfies RegionAnswer;
    expect((await service.capture(1)).status).toBe('captured');
  });

  test('diff-needs-same-lane', async () => {
    const { service, state, changePage } = setup();
    const v1 = captured(await service.capture(1));
    changePage('Second title', 'Second text about tea.');
    const v2 = captured(await service.capture(1));
    changePage('Third title', 'Third text about tea.');
    const v3 = captured(await service.capture(1));
    // Same page, a phone profile: another lane.
    state.response = { ...(state.response as Extract<SeoAuditResponse, { status: 'ready' }>), renderProfile: { profile: PHONE, partial: false } };
    const p1 = captured(await service.capture(1));
    expect(p1.newVersion).toBe(true);
    const snap = async (id: string) => (await service.version({ versionId: id })) as CaptureSnapshot;
    const [s1, s2, s3] = [await snap(v1.versionId), await snap(v2.versionId), await snap(v3.versionId)];
    expect(await service.diff({ fromVersionId: v1.versionId, toVersionId: v2.versionId })).toEqual(diffSnapshots(s1, s2));
    // A pair with no stored diff is computed, either way round.
    expect(await service.diff({ fromVersionId: v1.versionId, toVersionId: v3.versionId })).toEqual(diffSnapshots(s1, s3));
    expect(await service.diff({ fromVersionId: v3.versionId, toVersionId: v1.versionId })).toEqual(diffSnapshots(s3, s1));
    // Two lanes, or a missing version: nothing.
    expect(await service.diff({ fromVersionId: v3.versionId, toVersionId: p1.versionId })).toBeNull();
    expect(await service.diff({ fromVersionId: v1.versionId, toVersionId: uuidv7() })).toBeNull();
    expect((await service.history({ url: PAGE })).versions.map((v) => v.versionId)).toEqual([p1.versionId, v3.versionId, v2.versionId, v1.versionId]);
  });

  test('tampered-json-is-skipped', async () => {
    const { service, repo, rows } = setup();
    const one = captured(await service.capture(1));
    // Another lane's rows written with JSON that does not fit its schema: skipped by history.
    const odd = (renderProfileJson: string | null, searchParamsJson: string | null) => appendInput(tick(), { laneKey: sha256Hex(`${renderProfileJson}${searchParamsJson}`), renderProfileJson, searchParamsJson });
    const badProfile = odd('{"device":"warp"}', null);
    const badParams = odd(null, '{"engine":"nope"}');
    const badSnapshot = odd(null, null);
    for (const input of [badProfile, badParams, badSnapshot]) expect(await repo.appendCapture(input)).toMatchObject({ status: 'appended' });
    const history = (await service.history({ url: PAGE })).versions.map((v) => v.versionId);
    expect(history).toEqual([badSnapshot.versionId, one.versionId]);
    // A snapshot that does not parse reads as nothing.
    expect(await service.version({ versionId: badSnapshot.versionId })).toBeNull();

    // A stored diff that does not parse, or is of another engine, is computed afresh.
    const next = storedSnapshot('A text written elsewhere.');
    for (const [engineVersion, diffJson] of [
      [DIFF_ENGINE_VERSION, '{"bad":1}'],
      [DIFF_ENGINE_VERSION + 1, canonicalJson(diffSnapshots(null, next.snapshot))],
    ] as const) {
      const at = tick();
      const head = rows('ci_versions', 'lane_key = ?', laneKeyFor(PAGE, null, null)!).at(-1)!;
      const input = appendInput(at, { snapshotJson: canonicalJson({ ...next.snapshot, takenAt: at }), snapshotHash: sha256Hex(`${at}-other`), diff: { id: uuidv7(at), fromVersionId: head.id as string, engineVersion, diffJson, summaryJson: '{"bad":1}', changeCount: 7 } });
      expect(await repo.appendCapture(input)).toMatchObject({ status: 'appended', newVersion: true });
      const before = (await service.version({ versionId: head.id as string }))!;
      const after = (await service.version({ versionId: input.versionId }))!;
      expect(await service.diff({ fromVersionId: head.id as string, toVersionId: input.versionId })).toEqual(diffSnapshots(before, after));
      // Its summary does not parse: history shows no counts for it.
      expect((await service.history({ url: PAGE })).versions.find((v) => v.versionId === input.versionId)).toMatchObject({ summary: null, changeCount: null });
    }
  });

  test('read-api-schemas-parse-answers', async () => {
    const { service, changePage } = setup();
    const one = captured(await service.capture(1));
    changePage('Another title', 'Another text.');
    const two = captured(await service.capture(1));
    for (const [name, operation] of Object.entries(CHANGES_READ_API)) {
      expect(operation.description.length, name).toBeGreaterThan(20);
      expect(typeof operation.input.parse, name).toBe('function');
      expect(typeof operation.output.parse, name).toBe('function');
    }
    const inputs = {
      listPages: [{}, { projectId: UNFILED_PROJECT_ID, limit: 1 }],
      history: [{ url: PAGE }, { url: PAGE, limit: 1 }],
      getVersion: [{ versionId: one.versionId }, { versionId: uuidv7() }],
      diff: [
        { fromVersionId: one.versionId, toVersionId: two.versionId },
        { fromVersionId: two.versionId, toVersionId: uuidv7() },
      ],
    };
    const answers: Record<string, unknown[]> = {};
    for (const [name, list] of Object.entries(inputs) as [keyof typeof CHANGES_READ_API, unknown[]][]) {
      for (const input of list) {
        const parsed = CHANGES_READ_API[name].input.parse(input) as never;
        const answer = await service[name](parsed);
        expect(CHANGES_READ_API[name].output.safeParse(answer).success, `${name} ${JSON.stringify(input)}`).toBe(true);
        (answers[name] ??= []).push(answer);
      }
    }
    expect(answers.listPages![0]).toMatchObject({ pages: [{ url: PAGE, captureCount: 2 }] });
    const page = answers.history![1] as { versions: unknown[]; next: unknown };
    expect(page.versions).toHaveLength(1);
    expect(await service.history({ url: PAGE, cursor: page.next as never })).toMatchObject({ versions: [{ versionId: one.versionId }], next: null });
    expect(answers.getVersion).toEqual([await service.version({ versionId: one.versionId }), null]);
    expect(answers.diff![1]).toBeNull();
  });
});
