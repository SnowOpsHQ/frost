// Spec: specs/projects.spec.ts (PROJECT_REFUSALS, RUN_REFUSALS, searchUrlFor, queryLabel, DELETE_PROJECT),
// specs/projects.schema.ts (answers), specs/capture-db.spec.ts (UNFILED_PROJECT_ID, MAX_PROJECT_PAGES)
// Acceptance: specs/projects.feature.md (The service; Deleting a project; Scenarios: service)
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { openSessionStore, uuidv7, type ChangeIntelRepository } from '@app/db';
import { MAX_PROJECT_PAGES, PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { CreateProjectAnswerSchema, ProjectDetailSchema, ProjectsAnswerSchema, searchUrlFor, type RunState, type StartRunAnswer } from '@app/specs/projects.schema';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import type { CaptureRuns, RunPlan } from '../capture-run';
import { createProjectsService, type ProjectsServiceDeps } from '../projects';

const A = 'https://example.com/a';
const B = 'https://example.com/b';
const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const PARAMS: SearchParams = { engine: 'bing', query: 'green tea', country: 'de', language: 'de', location: 'Berlin', device: 'mobile' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let clock = 2_000_000;
const tick = () => (clock += 1_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const IDLE: RunState = { version: 1, runId: null, projectId: null, state: 'idle', current: 0, total: 0, omitted: 0, screenshot: false, targets: [] };

function setup(deps: Partial<ProjectsServiceDeps> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-projects-'));
  const opened = openSessionStore({ dir });
  const raw = new DatabaseSync(opened.file, { readOnly: true });
  cleanups.push(() => {
    raw.close();
    void opened.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const unlinked: string[] = [];
  // No files on disk here: the lock is a no-op and nothing is measured.
  const files = { unlink: vi.fn(async (hash: string) => (unlinked.push(hash), true)), lock: async (_hash: string) => () => undefined, fileFor: (hash: string) => path.join(dir, 'none', `${hash}.png`) };
  const confirmDelete = vi.fn(async (_name: string) => true);
  const state = { activeUrl: A as string | null, running: null as string | null };
  const runs = {
    start: vi.fn(async (_plan: RunPlan): Promise<StartRunAnswer> => ({ status: 'started', runId: uuidv7(tick()) })),
    cancel: vi.fn(() => true),
    running: vi.fn(() => state.running),
    state: vi.fn(() => IDLE),
    watch: vi.fn(async (_since: number) => IDLE),
  } satisfies CaptureRuns;
  const log = vi.fn((_message: string) => undefined);
  const service = createProjectsService({ store: opened.changeIntel, files, confirmDelete, activeUrl: () => state.activeUrl, runs, now: tick, log, ...deps });
  const count = (sql: string, ...args: string[]) => (raw.prepare(sql).get(...args) as { n: number }).n;
  return { service, repo: opened.changeIntel, files, unlinked, confirmDelete, state, runs, log, count };
}

/** Creates a project and answers its id. */
async function created(service: ReturnType<typeof setup>['service'], name: string): Promise<string> {
  const answer = await service.create(name);
  if (answer.status !== 'created') throw new Error(`refused: ${answer.reason}`);
  return answer.project.id;
}

/** A capture of `url` straight into the repository (with a diff when the lane had a version). */
async function capture(repo: ChangeIntelRepository, projectId: string, url: string, snapshot: string, options: { searchParams?: SearchParams | null; changeCount?: number } = {}) {
  const searchParamsJson = options.searchParams ? canonicalJson(options.searchParams) : null;
  const laneKey = sha(`${url} ${searchParamsJson}`);
  const head = await repo.latestVersion(laneKey);
  const at = tick();
  const versionId = uuidv7(at);
  const result = await repo.appendCapture({
    captureId: uuidv7(at),
    versionId,
    projectId,
    laneKey,
    pageUrl: url,
    renderProfileJson: null,
    renderProfilePartial: false,
    searchParamsJson,
    source: 'project',
    auditTakenAt: at,
    snapshotJson: JSON.stringify({ snapshot }),
    snapshotHash: sha(snapshot),
    schemaVersion: 1,
    createdAt: at,
    ...(head && head.snapshotHash !== sha(snapshot) ? { diff: { id: uuidv7(at), fromVersionId: head.id, engineVersion: 1, diffJson: '{}', summaryJson: '{}', changeCount: options.changeCount ?? 1 } } : {}),
  });
  if (result?.status !== 'appended') throw new Error('not appended');
  return result;
}

async function screenshot(repo: ChangeIntelRepository, projectId: string, url: string, png: string, captureId: string | null = null) {
  const at = tick();
  expect(await repo.appendScreenshot({ id: uuidv7(at), projectId, pageUrl: url, captureId, kind: 'viewport', rectJson: null, width: 10, height: 10, bytes: 100, sha256: sha(png), segments: 1, renderProfileJson: null, searchParamsJson: null, createdAt: at })).toBe(true);
}

describe('projects service', () => {
  test('project-crud-validates', async () => {
    const { service } = setup();
    // Unfiled is there from the start, first.
    const first = ProjectsAnswerSchema.parse(await service.list());
    expect(first.projects).toEqual([{ id: UNFILED_PROJECT_ID, name: UNFILED_PROJECT_NAME, unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null } }]);
    const made = CreateProjectAnswerSchema.parse(await service.create('  Coffee guides  '));
    expect(made).toMatchObject({ status: 'created', project: { name: 'Coffee guides', unfiled: false, renderProfile: null } });
    const id = made.status === 'created' ? made.project.id : '';
    expect(await service.create('   ')).toEqual({ status: 'refused', reason: 'invalid-name' });
    expect(await service.create('x'.repeat(PROJECT_NAME_MAX_CHARS + 1))).toEqual({ status: 'refused', reason: 'invalid-name' });
    // Rename, inline; Unfiled keeps its name.
    expect(await service.rename(id, 'Tea guides')).toEqual({ status: 'ok' });
    expect(await service.rename(id, ' ')).toEqual({ status: 'refused', reason: 'invalid-name' });
    expect(await service.rename(UNFILED_PROJECT_ID, 'Inbox')).toEqual({ status: 'refused', reason: 'unfiled' });
    expect(await service.rename(uuidv7(tick()), 'Nope')).toEqual({ status: 'refused', reason: 'not-found' });
    // The render profile: a profile, or null (the default profile is stored as null).
    expect(await service.setRenderProfile(id, PHONE)).toEqual({ status: 'ok' });
    expect((await service.get(id))?.project.renderProfile).toEqual(PHONE);
    expect(await service.setRenderProfile(id, DEFAULT_RENDER_PROFILE)).toEqual({ status: 'ok' });
    expect((await service.get(id))?.project.renderProfile).toBeNull();
    expect(await service.setRenderProfile(id, { ...PHONE, userAgent: 'custom', customUserAgent: '' })).toEqual({ status: 'refused', reason: 'invalid-profile' });
    expect((await service.list()).projects.map((p) => p.name)).toEqual([UNFILED_PROJECT_NAME, 'Tea guides']);
  });

  test('project-pages-and-queries', async () => {
    const { service, state } = setup();
    const id = await created(service, 'Guides');
    const added = await service.addPage(id, `${A}#section`);
    // Stored without its fragment; adding it again answers the same row.
    expect(added).toMatchObject({ status: 'added', page: { url: A } });
    expect(await service.addPage(id, A)).toEqual(added);
    expect(await service.addPage(id, 'javascript:alert(1)')).toEqual({ status: 'refused', reason: 'invalid-url' });
    expect(await service.addPage(id, 'file:///etc/passwd')).toEqual({ status: 'refused', reason: 'invalid-url' });
    expect(await service.addPage(id, 'https://user:pass@example.com/b')).toMatchObject({ status: 'added', page: { url: B } });
    expect(await service.addPage(uuidv7(tick()), A)).toEqual({ status: 'refused', reason: 'not-found' });
    // The current page: the active tab's web page.
    state.activeUrl = 'https://example.com/c?x=1';
    expect(await service.addCurrentPage(id)).toMatchObject({ status: 'added', page: { url: 'https://example.com/c?x=1' } });
    state.activeUrl = 'about:blank';
    expect(await service.addCurrentPage(id)).toEqual({ status: 'refused', reason: 'no-page' });
    state.activeUrl = null;
    expect(await service.addCurrentPage(id)).toEqual({ status: 'refused', reason: 'no-page' });
    // A query: the search parameters, location recorded only.
    const query = await service.addQuery(id, PARAMS);
    expect(query).toMatchObject({ status: 'added' });
    expect(await service.addQuery(id, { ...PARAMS, query: '  padded  ' })).toEqual({ status: 'refused', reason: 'invalid-query' });
    const detail = ProjectDetailSchema.parse(await service.get(id))!;
    expect(detail.pages.map((p) => p.url)).toEqual([A, B, 'https://example.com/c?x=1']);
    expect(detail.queries).toEqual([{ id: query.status === 'added' ? query.query.id : '', params: PARAMS, url: searchUrlFor(PARAMS), lastCapturedAt: null, changeCount: null }]);
    expect(detail.queries[0]!.url).not.toContain('Berlin');
    // Remove.
    expect(await service.removePage(id, detail.pages[0]!.id)).toEqual({ status: 'ok' });
    expect(await service.removePage(id, detail.pages[0]!.id)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await service.removeQuery(id, detail.queries[0]!.id)).toEqual({ status: 'ok' });
    expect(await service.removeQuery(id, detail.queries[0]!.id)).toEqual({ status: 'refused', reason: 'not-found' });
    expect((await service.get(id))!.pages.map((p) => p.url)).toEqual([B, 'https://example.com/c?x=1']);
    // Which projects list a page.
    expect((await service.forPage(B)).projects.map((p) => p.id)).toEqual([id]);
    expect((await service.forPage(A)).projects).toEqual([]);
    expect(await service.get(uuidv7(tick()))).toBeNull();
  });

  test('project-page-cap', async () => {
    const { service } = setup();
    const id = await created(service, 'Many');
    for (let i = 0; i < MAX_PROJECT_PAGES; i++) expect((await service.addPage(id, `https://example.com/${i}`)).status).toBe('added');
    expect(await service.addPage(id, 'https://example.com/one-more')).toEqual({ status: 'refused', reason: 'limit' });
  });

  test('project-detail-shows-last-capture', async () => {
    const { service, repo } = setup();
    const id = await created(service, 'Guides');
    await service.addPage(id, A);
    await service.addPage(id, B);
    await service.addQuery(id, PARAMS);
    await service.addQuery(id, { ...PARAMS, device: 'desktop' });
    await capture(repo, id, A, 'one');
    await capture(repo, id, A, 'two', { changeCount: 4 });
    const last = await capture(repo, id, A, 'two');
    // Captured into another project only: not this project's capture.
    await capture(repo, UNFILED_PROJECT_ID, B, 'b');
    // The mobile query captured twice; the desktop one shares its URL but not its lane.
    await capture(repo, id, searchUrlFor(PARAMS), 'serp 1', { searchParams: PARAMS });
    await capture(repo, id, searchUrlFor(PARAMS), 'serp 2', { searchParams: PARAMS, changeCount: 7 });
    const detail = (await service.get(id))!;
    const lastAt = (await repo.history({ pageUrl: A, projectId: id, limit: 1 })).entries[0]!.lastCapturedAt;
    expect(last.newVersion).toBe(false);
    expect(detail.pages).toMatchObject([
      { url: A, changeCount: 4, lastCapturedAt: lastAt },
      { url: B, changeCount: null, lastCapturedAt: null },
    ]);
    expect(detail.queries.map((q) => [q.params.device, q.changeCount, q.lastCapturedAt === null])).toEqual([
      ['mobile', 7, false],
      ['desktop', null, true],
    ]);
  });

  test('delete-project-purges-and-unlinks', async () => {
    const { service, repo, files, unlinked, confirmDelete, count } = setup();
    const id = await created(service, 'To delete');
    const other = await created(service, 'Keeps');
    await service.addPage(id, A);
    const first = await capture(repo, id, A, 'one');
    await capture(repo, id, A, 'two');
    // The other project captured the same version of B as this one: it stays with the other project.
    await capture(repo, other, B, 'shared');
    await capture(repo, id, B, 'shared');
    await screenshot(repo, id, A, 'png only here', first.captureId);
    await screenshot(repo, id, A, 'png shared');
    await screenshot(repo, other, B, 'png shared');
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(3);

    const answer = await service.remove(id);
    expect(confirmDelete).toHaveBeenCalledExactlyOnceWith('To delete');
    expect(answer).toEqual({ status: 'deleted', purged: { captures: 3, versions: 2, diffs: 1, screenshots: 2 } });
    // Tombstoned, with its pages; every capture and screenshot of it gone, recorded as one purge.
    expect((await service.list()).projects.map((p) => p.name)).toEqual([UNFILED_PROJECT_NAME, 'Keeps']);
    expect(count('SELECT count(*) AS n FROM ci_projects WHERE id = ? AND deleted_at IS NOT NULL', id)).toBe(1);
    expect(count('SELECT count(*) AS n FROM ci_project_pages WHERE project_id = ? AND deleted_at IS NULL', id)).toBe(0);
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(0);
    expect(count('SELECT count(*) AS n FROM ci_screenshots WHERE project_id = ?', id)).toBe(0);
    expect(count("SELECT count(*) AS n FROM ci_purges WHERE project_id = ? AND reason = 'project-deleted'", id)).toBe(1);
    // The shared version and screenshot stay; only the file no row names any more is unlinked.
    expect(count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', other)).toBe(1);
    expect(count('SELECT count(*) AS n FROM ci_versions WHERE page_url = ?', B)).toBe(1);
    expect(unlinked).toEqual([sha('png only here')]);
    expect(files.unlink).toHaveBeenCalledOnce();
    // Gone: a second delete finds nothing.
    expect(await service.remove(id)).toEqual({ status: 'refused', reason: 'not-found' });
  });

  test('delete-project-unlinks-only-unreferenced', async () => {
    // A row naming the file again between the purge and the unlink keeps it: each hash is checked again first.
    const first = setup();
    const id = await created(first.service, 'To delete');
    await screenshot(first.repo, id, A, 'png raced');
    const isHashReferenced = vi.fn(async (_hash: string) => true);
    const second = setup({ store: Object.assign(Object.create(first.repo) as ChangeIntelRepository, { isHashReferenced }) });
    expect(await second.service.remove(id)).toMatchObject({ status: 'deleted', purged: { screenshots: 1 } });
    expect(isHashReferenced).toHaveBeenCalledWith(sha('png raced'));
    expect(second.files.unlink).not.toHaveBeenCalled();
  });

  test('deleted-project-purge-is-retried', async () => {
    // The purge fails as the project is deleted: deleted (and said so), its rows kept for now.
    const first = setup();
    const id = await created(first.service, 'To delete');
    await capture(first.repo, id, A, 'one');
    await screenshot(first.repo, id, A, 'png left');
    const failing = Object.assign(Object.create(first.repo) as ChangeIntelRepository, {
      executePurge: vi.fn(async () => {
        throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      }),
    });
    const broken = setup({ store: failing });
    expect(await broken.service.remove(id)).toEqual({ status: 'deleted', purged: null });
    expect(first.count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(1);
    expect(await first.repo.deletedProjectsWithRows()).toEqual([id]);
    // The retry (at startup, and before each run) purges it, and its file goes.
    const retry = setup({ store: first.repo });
    expect(await retry.service.purgeDeleted()).toBe(1);
    expect(first.count('SELECT count(*) AS n FROM ci_captures WHERE project_id = ?', id)).toBe(0);
    expect(first.count('SELECT count(*) AS n FROM ci_screenshots WHERE project_id = ?', id)).toBe(0);
    expect(first.count("SELECT count(*) AS n FROM ci_purges WHERE project_id = ? AND reason = 'project-deleted'", id)).toBe(1);
    expect(retry.unlinked).toEqual([sha('png left')]);
    expect(await retry.service.purgeDeleted()).toBe(0);
    // Starting a run retries it first.
    const deletedProjectsWithRows = vi.fn(async () => [] as string[]);
    const before = setup({ store: Object.assign(Object.create(first.repo) as ChangeIntelRepository, { deletedProjectsWithRows }) });
    await before.service.startRun(id, false);
    expect(deletedProjectsWithRows).toHaveBeenCalledOnce();
  });

  test('delete-project-asks-first', async () => {
    const { service, confirmDelete, state, count } = setup();
    const id = await created(service, 'Kept');
    confirmDelete.mockResolvedValueOnce(false);
    expect(await service.remove(id)).toEqual({ status: 'refused', reason: 'declined' });
    expect(count('SELECT count(*) AS n FROM ci_projects WHERE id = ? AND deleted_at IS NULL', id)).toBe(1);
    // A project whose run is under way is not deleted (and not asked about).
    state.running = id;
    expect(await service.remove(id)).toEqual({ status: 'refused', reason: 'running' });
    expect(confirmDelete).toHaveBeenCalledOnce();
  });

  test('unfiled-cannot-be-deleted', async () => {
    const { service, confirmDelete, count } = setup();
    expect(await service.remove(UNFILED_PROJECT_ID)).toEqual({ status: 'refused', reason: 'unfiled' });
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(count('SELECT count(*) AS n FROM ci_projects WHERE id = ? AND deleted_at IS NULL', UNFILED_PROJECT_ID)).toBe(1);
  });

  test('start-run-plans-pages-then-queries', async () => {
    const { service, runs } = setup();
    const id = await created(service, 'Guides');
    expect(await service.startRun(id, false)).toEqual({ status: 'refused', reason: 'no-targets' });
    await service.addQuery(id, PARAMS);
    await service.addPage(id, A);
    await service.setRenderProfile(id, PHONE);
    expect(await service.startRun(id, true)).toMatchObject({ status: 'started' });
    expect(runs.start).toHaveBeenCalledExactlyOnceWith({
      projectId: id,
      profile: PHONE,
      screenshot: true,
      targets: [
        { kind: 'page', label: A, url: A, searchParams: null },
        { kind: 'query', label: '“green tea” on Bing (DE, de, mobile, Berlin)', url: searchUrlFor(PARAMS), searchParams: PARAMS },
      ],
    });
    expect(await service.startRun(uuidv7(tick()), false)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(service.cancelRun()).toBe(true);
    await expect(service.runState(0)).resolves.toBe(IDLE);
    expect(runs.watch).toHaveBeenCalledWith(0);
  });

  test('projects-never-reject', async () => {
    const broken = new Proxy({} as ChangeIntelRepository, {
      get: () => async () => {
        throw Object.assign(new Error('SECRET https://example.com/private'), { code: 'SQLITE_IOERR' });
      },
    });
    const { service, log } = setup({ store: broken });
    const id = uuidv7(tick());
    expect(await service.list()).toEqual({ projects: [] });
    expect(await service.get(id)).toBeNull();
    expect(await service.create('Name')).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(await service.rename(id, 'Name')).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(await service.remove(id)).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(await service.addPage(id, A)).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(await service.addQuery(id, PARAMS)).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(await service.forPage(A)).toEqual({ projects: [] });
    expect(await service.startRun(id, false)).toEqual({ status: 'refused', reason: 'store-failed' });
    // The log says what failed, never the error's message.
    expect(log).toHaveBeenCalled();
    for (const [line] of log.mock.calls) expect(line).not.toContain('SECRET');
  });
});
