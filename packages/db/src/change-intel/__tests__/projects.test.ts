// Spec: specs/capture-db.spec.ts (UNFILED_PROJECT_ID, UNFILED_PROJECT_NAME, MAX_PROJECTS, MAX_PROJECT_PAGES, MAX_PROJECT_QUERIES,
// PROJECT_NAME_MAX_CHARS, PROJECT_QUERY_MAX_CHARS, MAX_PROFILE_JSON_BYTES, MAX_SEARCH_PARAMS_JSON_BYTES, MAX_RETENTION_VERSIONS,
// MAX_RETENTION_DAYS)
// Acceptance: specs/capture-db.feature.md (Projects)
import { beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_PROFILE_JSON_BYTES,
  MAX_PROJECT_PAGES,
  MAX_PROJECT_QUERIES,
  MAX_PROJECTS,
  MAX_RETENTION_DAYS,
  MAX_RETENTION_VERSIONS,
  MAX_SEARCH_PARAMS_JSON_BYTES,
  PROJECT_NAME_MAX_CHARS,
  PROJECT_QUERY_MAX_CHARS,
  UNFILED_PROJECT_ID,
  UNFILED_PROJECT_NAME,
  UUIDV7_PATTERN,
} from '@app/specs/capture-db.spec';
import { capture, count, counts, openTestDb, screenshotInput, type TestDb } from './fixtures';

const PAGE = 'https://example.com/guides/tea';
const PARAMS = '{"country":"us","engine":"x"}';
let t: TestDb;

beforeEach(() => {
  t = openTestDb();
});

describe('projects', () => {
  test('projects-crud', async () => {
    expect(await t.repo.projects()).toEqual([
      { id: UNFILED_PROJECT_ID, name: UNFILED_PROJECT_NAME, renderProfileJson: null, retention: { mode: 'forever', value: null }, createdAt: 0, updatedAt: 0 },
    ]);
    const site = await t.repo.createProject('  Tea site  ', 1_000);
    expect(site).toEqual({ id: expect.stringMatching(UUIDV7_PATTERN), name: 'Tea site', renderProfileJson: null, retention: { mode: 'forever', value: null }, createdAt: 1_000, updatedAt: 1_000 });
    const blog = (await t.repo.createProject('Blog', 900))!;
    // Unfiled first, then by creation.
    expect((await t.repo.projects()).map((p) => p.name)).toEqual([UNFILED_PROJECT_NAME, 'Blog', 'Tea site']);
    expect(await t.repo.project(blog.id)).toEqual(blog);

    expect(await t.repo.renameProject(site!.id, ' Tea shop ', 2_000)).toBe(true);
    expect(await t.repo.project(site!.id)).toMatchObject({ name: 'Tea shop', updatedAt: 2_000, createdAt: 1_000 });
    // Names: trimmed, non-blank, capped; Unfiled keeps its name.
    for (const name of ['', '   ', 'x'.repeat(PROJECT_NAME_MAX_CHARS + 1), 7 as never]) {
      expect(await t.repo.createProject(name, 3_000), String(name)).toBeNull();
      expect(await t.repo.renameProject(site!.id, name, 3_000), String(name)).toBe(false);
    }
    expect(await t.repo.createProject('x'.repeat(PROJECT_NAME_MAX_CHARS), 3_000)).not.toBeNull();
    expect(await t.repo.renameProject(UNFILED_PROJECT_ID, 'Inbox', 3_000)).toBe(false);
    expect(await t.repo.renameProject('nope', 'Inbox', 3_000)).toBe(false);

    // Tombstoned: gone from the lists, the row kept with deleted_at, no more writes.
    await t.repo.addPage(blog.id, PAGE, 3_500);
    await t.repo.addQuery(blog.id, 'tea', PARAMS, 3_500);
    expect(await t.repo.tombstoneProject(blog.id, 4_000)).toBe(true);
    expect(await t.repo.tombstoneProject(blog.id, 4_000)).toBe(false);
    expect(await t.repo.project(blog.id)).toBeNull();
    expect((await t.repo.projects()).map((p) => p.id)).not.toContain(blog.id);
    expect({ ...t.raw.prepare('SELECT deleted_at, updated_at FROM ci_projects WHERE id = ?').get(blog.id) }).toEqual({ deleted_at: 4_000, updated_at: 4_000 });
    // Its pages and queries are tombstoned with it.
    expect(count(t.raw, 'ci_project_pages', 'deleted_at = 4000 AND updated_at = 4000')).toBe(1);
    expect(count(t.raw, 'ci_project_queries', 'deleted_at = 4000 AND updated_at = 4000')).toBe(1);
    const before = counts(t.raw);
    expect(await t.repo.renameProject(blog.id, 'Again', 5_000)).toBe(false);
    expect(await t.repo.addPage(blog.id, PAGE, 5_000)).toBeNull();
    expect(await t.repo.setRetention(blog.id, 'days', 3, 5_000)).toBe(false);
    expect(await capture(t.repo, { url: PAGE, snapshot: '{}', at: 5_000, projectId: blog.id })).toBeNull();
    expect(await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 5_000, projectId: blog.id }))).toBe(false);
    expect(counts(t.raw)).toEqual(before);
    // A tombstoned project can still be planned for (its project-deleted purge).
    expect(await t.repo.planPurge({ projectId: blog.id, policy: { mode: 'all' }, now: 6_000 })).not.toBeNull();

    // At most MAX_PROJECTS live, Unfiled included.
    const live = (await t.repo.projects()).length;
    for (let i = live; i < MAX_PROJECTS; i++) expect(await t.repo.createProject(`P${i}`, 7_000 + i)).not.toBeNull();
    expect(await t.repo.createProject('One too many', 9_000)).toBeNull();
    expect(await t.repo.projects()).toHaveLength(MAX_PROJECTS);
  });

  test('project-settings', async () => {
    const site = (await t.repo.createProject('Site', 1_000))!;
    const profile = '{"device":"phone","userAgent":"x"}';
    expect(await t.repo.setProjectRenderProfile(site.id, profile, 2_000)).toBe(true);
    expect(await t.repo.project(site.id)).toMatchObject({ renderProfileJson: profile, updatedAt: 2_000 });
    expect(await t.repo.setProjectRenderProfile(site.id, null, 3_000)).toBe(true);
    expect(await t.repo.project(site.id)).toMatchObject({ renderProfileJson: null, updatedAt: 3_000 });
    expect(await t.repo.setProjectRenderProfile(site.id, 'x'.repeat(MAX_PROFILE_JSON_BYTES + 1), 4_000)).toBe(false);

    expect(await t.repo.setRetention(site.id, 'versions', 5, 5_000)).toBe(true);
    expect(await t.repo.project(site.id)).toMatchObject({ retention: { mode: 'versions', value: 5 }, updatedAt: 5_000 });
    expect(await t.repo.setRetention(site.id, 'days', MAX_RETENTION_DAYS, 6_000)).toBe(true);
    expect((await t.repo.project(site.id))?.retention).toEqual({ mode: 'days', value: MAX_RETENTION_DAYS });
    expect(await t.repo.setRetention(UNFILED_PROJECT_ID, 'versions', MAX_RETENTION_VERSIONS, 6_000)).toBe(true);
    expect((await t.repo.project(UNFILED_PROJECT_ID))?.retention).toEqual({ mode: 'versions', value: MAX_RETENTION_VERSIONS });
    const bad: [string, number | null][] = [
      ['versions', 0],
      ['versions', MAX_RETENTION_VERSIONS + 1],
      ['versions', null],
      ['days', 1.5],
      ['days', MAX_RETENTION_DAYS + 1],
      ['forever', 3],
      ['sometimes', null],
    ];
    for (const [mode, value] of bad) expect(await t.repo.setRetention(site.id, mode as never, value, 7_000), `${mode} ${value}`).toBe(false);
    expect(await t.repo.setRetention(site.id, 'forever', null, 8_000)).toBe(true);
    expect(await t.repo.project(site.id)).toMatchObject({ retention: { mode: 'forever', value: null }, updatedAt: 8_000 });
    expect(await t.repo.setRetention(site.id, 'days', 2, -1)).toBe(false);
  });

  test('project-pages', async () => {
    const site = (await t.repo.createProject('Site', 1_000))!;
    const other = (await t.repo.createProject('Other', 1_000))!;
    const page = await t.repo.addPage(site.id, `${PAGE}#brewing`, 2_000);
    expect(page).toEqual({ id: expect.stringMatching(UUIDV7_PATTERN), projectId: site.id, url: PAGE, createdAt: 2_000, updatedAt: 2_000 });
    // Adding it again answers the live row unchanged.
    expect(await t.repo.addPage(site.id, PAGE, 3_000)).toEqual(page);
    expect(count(t.raw, 'ci_project_pages')).toBe(1);
    await t.repo.addPage(other.id, PAGE, 3_000);
    await t.repo.addPage(site.id, 'https://example.com/b', 3_000);
    expect((await t.repo.projectPages(site.id)).map((p) => p.url)).toEqual([PAGE, 'https://example.com/b']);
    expect((await t.repo.projectsForPage(`${PAGE}#x`)).map((p) => p.id)).toEqual([site.id, other.id]);
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) expect(await t.repo.addPage(site.id, url, 4_000), url).toBeNull();

    expect(await t.repo.removePage(other.id, page!.id, 5_000)).toBe(false);
    expect(await t.repo.removePage(site.id, page!.id, 5_000)).toBe(true);
    expect(await t.repo.removePage(site.id, page!.id, 5_000)).toBe(false);
    expect((await t.repo.projectPages(site.id)).map((p) => p.url)).toEqual(['https://example.com/b']);
    expect((await t.repo.projectsForPage(PAGE)).map((p) => p.id)).toEqual([other.id]);
    expect({ ...t.raw.prepare('SELECT deleted_at, updated_at FROM ci_project_pages WHERE id = ?').get(page!.id) }).toEqual({ deleted_at: 5_000, updated_at: 5_000 });
    // Re-added after removal: a new live row.
    const again = await t.repo.addPage(site.id, PAGE, 6_000);
    expect(again?.id).not.toBe(page!.id);

    // At most MAX_PROJECT_PAGES live per project.
    for (let i = (await t.repo.projectPages(site.id)).length; i < MAX_PROJECT_PAGES; i++) expect(await t.repo.addPage(site.id, `https://example.com/p/${i}`, 7_000)).not.toBeNull();
    expect(await t.repo.addPage(site.id, 'https://example.com/too-many', 8_000)).toBeNull();
    expect(await t.repo.addPage(other.id, 'https://example.com/too-many', 8_000)).not.toBeNull();
  });

  test('project-queries', async () => {
    const site = (await t.repo.createProject('Site', 1_000))!;
    const query = await t.repo.addQuery(site.id, '  green tea  ', PARAMS, 2_000);
    expect(query).toEqual({ id: expect.stringMatching(UUIDV7_PATTERN), projectId: site.id, query: 'green tea', searchParamsJson: PARAMS, createdAt: 2_000, updatedAt: 2_000 });
    expect(await t.repo.addQuery(site.id, 'green tea', PARAMS, 3_000)).toEqual(query);
    const uk = await t.repo.addQuery(site.id, 'green tea', '{"country":"uk","engine":"x"}', 3_000);
    expect(uk?.id).not.toBe(query!.id);
    expect((await t.repo.projectQueries(site.id)).map((q) => q.id)).toEqual([query!.id, uk!.id]);
    for (const [text, params] of [
      ['', PARAMS],
      ['q'.repeat(PROJECT_QUERY_MAX_CHARS + 1), PARAMS],
      ['tea', 'x'.repeat(MAX_SEARCH_PARAMS_JSON_BYTES + 1)],
      ['tea', null],
    ] as const) {
      expect(await t.repo.addQuery(site.id, text, params as never, 4_000)).toBeNull();
    }
    expect(await t.repo.removeQuery(site.id, query!.id, 5_000)).toBe(true);
    expect(await t.repo.removeQuery(site.id, query!.id, 5_000)).toBe(false);
    expect((await t.repo.projectQueries(site.id)).map((q) => q.id)).toEqual([uk!.id]);
    for (let i = 1; i < MAX_PROJECT_QUERIES; i++) expect(await t.repo.addQuery(site.id, `q${i}`, PARAMS, 6_000)).not.toBeNull();
    expect(await t.repo.addQuery(site.id, 'one more', PARAMS, 7_000)).toBeNull();
  });

  test('deleted-projects-with-rows', async () => {
    const kept = (await t.repo.createProject('Kept', 1_000))!;
    const purged = (await t.repo.createProject('Purged', 1_000))!;
    const leftover = (await t.repo.createProject('Leftover', 1_000))!;
    const shotOnly = (await t.repo.createProject('Shot only', 1_000))!;
    const empty = (await t.repo.createProject('Empty', 1_000))!;
    await capture(t.repo, { url: PAGE, snapshot: 'a', at: 1_100, projectId: kept.id });
    await capture(t.repo, { url: PAGE, snapshot: 'b', at: 1_200, projectId: purged.id });
    await capture(t.repo, { url: PAGE, snapshot: 'c', at: 1_300, projectId: leftover.id });
    await t.repo.appendScreenshot(screenshotInput({ pageUrl: PAGE, createdAt: 1_400, projectId: shotOnly.id }));
    for (const [project, at] of [[purged, 2_000], [leftover, 2_100], [shotOnly, 2_200], [empty, 2_300]] as const) expect(await t.repo.tombstoneProject(project.id, at)).toBe(true);
    const plan = (await t.repo.planPurge({ projectId: purged.id, policy: { mode: 'all' }, now: 3_000 }))!;
    expect((await t.repo.executePurge(plan, 'project-deleted', 3_000))?.status).toBe('purged');
    // Only tombstoned projects with rows left: never a live one, a purged one or an empty one.
    expect(await t.repo.deletedProjectsWithRows()).toEqual([leftover.id, shotOnly.id]);
  });
});
