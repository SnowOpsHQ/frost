// Spec: specs/screenshot.spec.ts (SCREENSHOT_REFUSALS, SCREENSHOT_LIMITS), specs/screenshot.schema.ts
// (ScreenshotsAnswerSchema), specs/changes.schema.ts (CHANGES_READ_API.listScreenshots),
// specs/capture-db.spec.ts (UNFILED_PROJECT_ID, CAPTURES_DIR_NAME)
// Acceptance: specs/screenshot.feature.md (Taking one, Images, Listing; Scenarios take-records-profile-and-params,
// take-refuses-what-it-cannot-take, one-screenshot-per-tab, image-checks-hash, read-api-lists-screenshots)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { uuidv7 } from '@app/db';
import { CAPTURES_DIR_NAME, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { CHANGES_READ_API } from '@app/specs/changes.schema';
import { DEFAULT_RENDER_PROFILE, type RenderProfile } from '@app/specs/render-profile.spec';
import { SCREENSHOT_LIMITS, SCREENSHOTS_DIR_NAME, ScreenshotsAnswerSchema, type TakeScreenshotAnswer } from '@app/specs/screenshot.schema';
import { createChangesService } from '../../changes/service';
import { previewSize, thumbnailPlan } from '../imaging';
import { screenshotTabs } from '../service';
import { serviceSetup, until, type ServiceSetup } from './fakes';

const PHONE: RenderProfile = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' };
const PARAMS: SearchParams = { engine: 'google', query: 'green tea', country: 'de', language: 'de', location: null, device: 'mobile' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let setup: ServiceSetup | null = null;
const others: ServiceSetup[] = [];
afterEach(() => {
  for (const one of [setup, ...others.splice(0)]) one?.cleanup();
  setup = null;
});
const start = (deps: Parameters<typeof serviceSetup>[0] = {}) => (setup = serviceSetup(deps));
/** One more service (its own profile), cleaned up with the test's. */
const also = (deps: Parameters<typeof serviceSetup>[0] = {}) => {
  const one = serviceSetup(deps);
  others.push(one);
  return one;
};

const saved = (answer: TakeScreenshotAnswer) => {
  if (answer.status !== 'saved') throw new Error(`refused: ${answer.reason}`);
  return answer;
};
type Row = Record<string, unknown>;
const rows = (raw: DatabaseSync): Row[] => raw.prepare('SELECT * FROM ci_screenshots ORDER BY created_at').all() as Row[];

describe('screenshots service', () => {
  test('take-records-profile-and-params', async () => {
    const { service, raw, files, state, imaging, tabs } = start({ searchParamsOf: (tabId) => (tabId === 1 ? PARAMS : null) });
    state.profiles.set(1, PHONE);
    const project = await setup!.opened.changeIntel.createProject('Tea shop', Date.now());

    // A viewport, into a project, with the tab's render profile and search parameters.
    const viewport = saved(await service.take(1, { kind: 'viewport', projectId: project!.id }));
    expect(viewport).toMatchObject({ kind: 'viewport', width: 230, height: 160, truncated: false });
    const png = imaging.encoded.length === 1 ? Buffer.from(`PNG 230x160 ${sha(imaging.encoded[0]!.bitmap)}`) : null;
    expect(viewport.bytes).toBe(png!.length);
    let [row] = rows(raw);
    expect(row).toMatchObject({
      id: viewport.id,
      project_id: project!.id,
      page_url: 'https://example.com/page',
      capture_id: null,
      kind: 'viewport',
      rect: null,
      width: 230,
      height: 160,
      bytes: png!.length,
      sha256: sha(png!),
      segments: 1,
      render_profile: canonicalJson(PHONE),
      search_params: canonicalJson(PARAMS),
    });
    // The file is the PNG, named by its own hash, under the profile directory.
    const file = path.join(setup!.userData, CAPTURES_DIR_NAME, SCREENSHOTS_DIR_NAME, `${sha(png!)}.png`);
    expect(readFileSync(file)).toEqual(png);
    expect(files.fileFor(sha(png!))).toBe(file);

    // A full page into Unfiled (the default): its segments; a tab without a profile records none.
    tabs.get(1)!.page.url = 'https://example.com/page#section';
    state.profiles.set(1, null);
    const full = saved(await service.take(1, { kind: 'full' }));
    expect(full).toMatchObject({ kind: 'full', width: 200, height: 500, truncated: false });
    row = rows(raw)[1]!;
    expect(row).toMatchObject({ project_id: UNFILED_PROJECT_ID, page_url: 'https://example.com/page', kind: 'full', segments: 4, rect: null, render_profile: null, search_params: canonicalJson(PARAMS) });

    // An area: its rect as canonical JSON.
    const area = service.take(1, { kind: 'area' });
    await until(() => tabs.get(1)!.selection !== null);
    tabs.get(1)!.selection!.resolve({ x: 3, y: 4, width: 10, height: 12 });
    expect(saved(await area)).toMatchObject({ kind: 'area', width: 20, height: 24 });
    expect(rows(raw)[2]).toMatchObject({ kind: 'area', rect: canonicalJson({ x: 3, y: 4, width: 10, height: 12 }), segments: 1 });

    // A main-internal caller (Task 6's capture run): its capture and the query's search parameters.
    const capture = await setup!.opened.changeIntel.appendCapture({
      captureId: uuidv7(),
      versionId: uuidv7(),
      projectId: UNFILED_PROJECT_ID,
      laneKey: 'a'.repeat(64),
      pageUrl: 'https://example.com/page',
      renderProfileJson: null,
      renderProfilePartial: false,
      searchParamsJson: null,
      source: 'project',
      auditTakenAt: 1,
      snapshotJson: '{}',
      snapshotHash: 'b'.repeat(64),
      schemaVersion: 1,
      createdAt: 2,
    });
    const other: SearchParams = { ...PARAMS, query: 'black tea' };
    saved(await service.take(1, { kind: 'viewport', captureId: capture!.status === 'appended' ? capture!.captureId : '', searchParams: other }));
    expect(rows(raw)[3]).toMatchObject({ capture_id: capture!.status === 'appended' ? capture!.captureId : null, search_params: canonicalJson(other) });
    // Two equal images share one file.
    expect(readdirSync(files.dir).sort()).toEqual([...new Set(rows(raw).map((r) => `${r['sha256'] as string}.png`))].sort());
  });

  test('take-refuses-what-it-cannot-take', async () => {
    const { service, tabs, logs } = start();
    const refusal = async (tabId: number, kind: 'viewport' | 'full' | 'area' = 'viewport', projectId?: string) => {
      const answer = await service.take(tabId, { kind, ...(projectId === undefined ? {} : { projectId }) });
      return answer.status === 'refused' ? answer.reason : 'saved';
    };
    expect(await refusal(9)).toBe('no-tab');
    expect(await refusal(2)).toBe('not-active');
    tabs.get(1)!.page.url = 'about:blank';
    expect(await refusal(1)).toBe('no-page');
    tabs.get(1)!.page.url = 'https://example.com/page?q=SECRET-QUERY';
    expect(await refusal(1, 'viewport', '01920000-0000-7000-8000-0000000000aa')).toBe('no-project');
    // A capture that fails; a page whose script throws.
    tabs.get(1)!.beforeCapture = () => {
      throw new Error('GPU process gone with SECRET page text');
    };
    expect(await refusal(1)).toBe('capture-failed');
    tabs.get(1)!.beforeCapture = null;
    tabs.get(1)!.override = (kind) => (kind === 'measure' ? new Error('SECRET page error') : undefined);
    expect(await refusal(1, 'full')).toBe('capture-failed');
    expect(rows(setup!.raw)).toEqual([]);

    // Too large: nothing written.
    const small = also({ limits: { ...SCREENSHOT_LIMITS, maxPngBytes: 8 } });
    expect(await small.service.take(1, { kind: 'viewport' })).toEqual({ status: 'refused', reason: 'too-large' });
    expect(rows(small.raw)).toEqual([]);
    expect(existsSync(small.files.dir)).toBe(false);

    // The file store failing: no row.
    const broken = also({ files: { ...small.files, write: async () => Promise.reject(new Error('EACCES /home/someone/secret')) } });
    expect(await broken.service.take(1, { kind: 'viewport' })).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(rows(broken.raw)).toEqual([]);

    // The row failing after the file was written: the file stays for the orphan sweep (Task 7).
    const rowFails = also();
    const failingStore = { ...rowFails.opened.changeIntel, appendScreenshot: async () => false };
    const again = also({ store: failingStore, files: rowFails.files });
    expect(await again.service.take(1, { kind: 'viewport' })).toEqual({ status: 'refused', reason: 'store-failed' });
    expect(readdirSync(rowFails.files.dir)).toHaveLength(1);
    // A project deleted while the screenshot was taken is said so.
    let reads = 0;
    const repository = rowFails.opened.changeIntel;
    const gone = also({ store: { ...repository, appendScreenshot: async () => false, project: async (id: string) => (reads++ === 0 ? repository.project(id) : null) } });
    expect(await gone.service.take(1, { kind: 'viewport' })).toEqual({ status: 'refused', reason: 'no-project' });

    // Logs carry no page text, no query, no path.
    const lines = [...logs, ...small.logs, ...broken.logs, ...again.logs];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/SECRET|\/home\/|\/tmp\/|example\.com/);
      expect(line.startsWith('screenshots: ')).toBe(true);
    }
  });

  test('one-screenshot-per-tab', async () => {
    const { service, tabs } = start();
    let release!: () => void;
    tabs.get(1)!.beforeCapture = () => new Promise<void>((resolve) => (release = resolve));
    const first = service.take(1, { kind: 'viewport' });
    await until(() => tabs.get(1)!.captures === 1);
    // The same tab: busy, whatever the kind.
    for (const kind of ['viewport', 'full', 'area'] as const) await expect(service.take(1, { kind })).resolves.toEqual({ status: 'refused', reason: 'busy' });
    // Another tab is not held up (it is refused for not being active, not for being busy).
    await expect(service.take(2, { kind: 'viewport' })).resolves.toEqual({ status: 'refused', reason: 'not-active' });
    release();
    expect((await first).status).toBe('saved');
    // Done: the tab takes the next one.
    tabs.get(1)!.beforeCapture = null;
    expect((await service.take(1, { kind: 'viewport' })).status).toBe('saved');
  });

  test('image-checks-hash', async () => {
    const { service, files, imaging, revealed } = start();
    const shot = saved(await service.take(1, { kind: 'viewport' }));
    const thumb = await service.image(shot.id, 'thumb');
    expect(thumb).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(thumb!.split(',')[1]!, 'base64').toString()).toMatch(/^thumb:PNG /);
    expect(await service.image(shot.id, 'preview')).toMatch(/^data:image\/jpeg;base64,/);
    await expect(service.copy(shot.id)).resolves.toBe(true);
    expect(imaging.copied).toHaveLength(1);
    await expect(service.reveal(shot.id)).resolves.toBe(true);
    const [row] = rows(setup!.raw);
    expect(revealed).toEqual([files.fileFor(row!['sha256'] as string)]);
    // Unknown ids: nothing.
    const unknown = '01920000-0000-7000-8000-0000000000ff';
    await expect(service.image(unknown, 'thumb')).resolves.toBeNull();
    await expect(service.copy(unknown)).resolves.toBe(false);
    await expect(service.reveal(unknown)).resolves.toBe(false);
    // The file changed on disk: it no longer matches its name, so it is never shown or copied.
    const file = files.fileFor(row!['sha256'] as string);
    writeFileSync(file, 'PNG tampered');
    await expect(service.image(shot.id, 'thumb')).resolves.toBeNull();
    await expect(service.image(shot.id, 'preview')).resolves.toBeNull();
    await expect(service.copy(shot.id)).resolves.toBe(false);
    expect(imaging.copied).toHaveLength(1);
    // Missing: nothing either, and nothing to reveal.
    await files.unlink(row!['sha256'] as string);
    expect(existsSync(file)).toBe(false);
    await expect(service.image(shot.id, 'thumb')).resolves.toBeNull();
    await expect(service.reveal(shot.id)).resolves.toBe(false);
    expect(revealed).toHaveLength(1);
  });

  test('read-api-lists-screenshots', async () => {
    const { service, opened, tabs } = start();
    const first = saved(await service.take(1, { kind: 'viewport' }));
    const second = saved(await service.take(1, { kind: 'full' }));
    tabs.get(1)!.page.url = 'https://example.com/elsewhere';
    saved(await service.take(1, { kind: 'viewport' }));
    // A page's screenshots, newest first, a page at a time; no path, file name or hash.
    const page = await service.list({ url: 'https://example.com/page', limit: 1 });
    expect(ScreenshotsAnswerSchema.parse(page)).toEqual(page);
    expect(page.screenshots.map((s) => s.id)).toEqual([second.id]);
    expect(page.next).not.toBeNull();
    const rest = await service.list({ url: 'https://example.com/page', cursor: page.next!, limit: 10 });
    expect(rest.screenshots.map((s) => s.id)).toEqual([first.id]);
    expect(rest.next).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/[0-9a-f]{64}|\.png|frost-captures/);
    expect(page.screenshots[0]).toMatchObject({ kind: 'full', width: 200, height: 500, segments: 4, projectId: UNFILED_PROJECT_ID, captureId: null, rect: null, renderProfile: null, searchParams: null });
    // A tampered row is skipped (inserted raw: rows cannot be updated).
    const writable = new DatabaseSync(opened.file);
    writable
      .prepare('INSERT INTO ci_screenshots (id, project_id, page_url, capture_id, kind, rect, width, height, bytes, sha256, segments, render_profile, search_params, created_at) VALUES (?, ?, ?, NULL, ?, ?, 1, 1, 1, ?, 1, ?, NULL, ?)')
      .run(uuidv7(), UNFILED_PROJECT_ID, 'https://example.com/page', 'area', '{"x":-1}', 'c'.repeat(64), '{"device":"toaster"}', Date.now() + 10_000_000);
    writable.close();
    const all = await service.list({ url: 'https://example.com/page' });
    expect(all.screenshots.map((s) => s.id)).toEqual([second.id, first.id]);
    // Phase 5's read API: the same answers, through the changes service too, parsed by its schemas.
    const input = CHANGES_READ_API.listScreenshots.input.parse({ url: 'https://example.com/page' });
    expect(CHANGES_READ_API.listScreenshots.output.parse(await service.list(input))).toEqual(all);
    const changes = createChangesService({ store: opened.changeIntel, tabs: { activeTabId: () => null, contentsOf: () => null, getAudit: () => ({ status: 'pending', url: '' }), loadedAt: () => null }, extract: async () => null });
    expect(await changes.listScreenshots(input)).toEqual(all);
  });

  test('image-sizes-fit-their-limits', () => {
    // Thumbnails: thumbWidth wide (never upscaled); a tall shot shows its top thumbMaxHeight.
    expect(thumbnailPlan(1_280, 800)).toEqual({ crop: null, width: 320, height: 200 });
    expect(thumbnailPlan(200, 100)).toEqual({ crop: null, width: 200, height: 100 });
    expect(thumbnailPlan(1_280, 20_000)).toEqual({ crop: { x: 0, y: 0, width: 1_280, height: 1_920 }, width: 320, height: 480 });
    expect(thumbnailPlan(100, 5_000)).toEqual({ crop: { x: 0, y: 0, width: 100, height: 480 }, width: 100, height: 480 });
    // Previews: fit within previewMaxWidth × previewMaxHeight, never upscaled.
    expect(previewSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(previewSize(3_200, 1_000)).toEqual({ width: 1_600, height: 500 });
    expect(previewSize(1_000, 16_000)).toEqual({ width: 250, height: 4_000 });
    expect(SCREENSHOT_LIMITS.thumbWidth).toBe(320);
  });

  test('screenshot-tabs-read-the-profile-in-effect', () => {
    const state = { activeTabId: 1, tabs: [{ id: 1, renderProfile: { profile: PHONE, source: 'tab', pinned: false, needsReload: false, status: 'active' } }, { id: 2, renderProfile: { profile: PHONE, source: 'tab', pinned: false, needsReload: false, status: 'failed' } }, { id: 3, renderProfile: null }] };
    const tabs = screenshotTabs({ getState: () => state as never }, () => null);
    expect(tabs.activeTabId()).toBe(1);
    expect(tabs.renderProfileOf(1)).toEqual(PHONE);
    // A failed profile is not in effect: the page shows unemulated.
    expect(tabs.renderProfileOf(2)).toBeNull();
    expect(tabs.renderProfileOf(3)).toBeNull();
    expect(tabs.renderProfileOf(4)).toBeNull();
  });
});
