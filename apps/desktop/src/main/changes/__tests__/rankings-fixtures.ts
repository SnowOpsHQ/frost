// Shared by the rankings tests (`rankings.test.ts`, `rank-csv.test.ts`): a real session store in a temporary
// folder, a rankings service over it with fake clipboard, dialog and writer, and readings stored the way a
// capture stores them (or planted with raw SQL, as another source or a tampered row would be).
// Spec: specs/rankings.spec.ts, specs/rankings.schema.ts, specs/workspace-db.spec.ts (SEARCH_KEY_VERSION)
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { openSessionStore, uuidv7 } from '@app/db';
import type { SerpFilters } from '@app/specs/rankings.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpReady, SerpSnapshot } from '@app/specs/serp-snapshot.schema';
import { SEARCH_KEY_VERSION } from '@app/specs/workspace-db.spec';
import { savedSearchParams } from '../projects';
import { createRankingsService, searchKeyOf } from '../rankings';
import { readyReading } from './fakes';

export const clock = { now: 5_000_000 };
export const tick = () => (clock.now += 1_000);
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

export function setup(options: { readonly tableReadBytes?: number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-rankings-'));
  const opened = openSessionStore({ dir });
  const raw = new DatabaseSync(opened.file);
  cleanups.push(async () => {
    raw.close();
    await opened.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const log = vi.fn((_message: string) => undefined);
  const clipboard = { writeText: vi.fn((_text: string) => undefined) };
  const chooseCsvPath = vi.fn(async (_windowId: number | null, _name: string, _kind: string): Promise<string | null> => null);
  const writeCsv = vi.fn(async (_file: string, _text: string) => undefined);
  const rankings = createRankingsService({ store: opened.changeIntel, clipboard, chooseCsvPath, writeCsv, now: () => clock.now, log, ...options });
  return { rankings, repo: opened.changeIntel, raw, log, clipboard, chooseCsvPath, writeCsv, dir };
}
export type T = ReturnType<typeof setup>;

/** The saved search the tests track (through the one saved-search path, so `get` keeps it). */
export const SEARCH = savedSearchParams({ engine: 'google', query: 'green tea', country: 'de', language: 'de', device: 'desktop' })!;

/** A ready reading with organic results of `domains` (in order), as Phase 3 would store it. */
export function readingOf(params: SearchParams, domains: readonly string[]): SerpReady {
  const results = domains.map((domain, index) => ({ rank: index + 1, type: 'organic' as const, position: index + 1, featureSlot: null, title: `Result ${index + 1}`, url: `https://${domain}/tea`, redirected: false, domain }));
  const owners = [...new Set(domains)];
  const base = readyReading(params);
  return {
    ...base,
    results,
    composition: { ...base.composition, counts: { ...base.composition.counts, organic: domains.length } },
    ownership: {
      page: params.page,
      organic: domains.length,
      complete: true,
      domains: owners.map((domain) => {
        const positions = domains.flatMap((d, i) => (d === domain ? [i + 1] : []));
        return { domain, count: positions.length, share: positions.length / domains.length, positions, best: positions[0]! };
      }),
    },
  };
}

/** A capture of `params`' result page into `projectId` with its reading (each in a lane of its own). */
export async function captured(t: T, projectId: string, params: SearchParams, snapshot: SerpSnapshot = readingOf(params, ['example.com']), filters: SerpFilters = {}, at = tick()) {
  const readingId = uuidv7(at);
  const json = `{"capture":"${readingId}"}`;
  const result = await t.repo.appendCapture({
    captureId: uuidv7(at),
    versionId: uuidv7(at),
    projectId,
    laneKey: sha(`lane ${readingId}`),
    pageUrl: params.url,
    renderProfileJson: null,
    renderProfilePartial: false,
    searchParamsJson: canonicalJson(params),
    source: 'manual',
    auditTakenAt: at,
    snapshotJson: json,
    snapshotHash: sha(json),
    schemaVersion: 1,
    createdAt: at,
    reading: {
      id: readingId,
      searchKey: searchKeyOf(params, filters)!,
      searchKeyVersion: SEARCH_KEY_VERSION,
      searchParamsJson: canonicalJson(params),
      filtersJson: canonicalJson(filters),
      status: snapshot.status,
      packVersion: snapshot.packVersion,
      readingJson: canonicalJson(snapshot),
    },
  });
  if (result?.status !== 'appended') throw new Error('not appended');
  return { readingId, captureId: result.captureId, at };
}

/** Plants a reading row with raw SQL (another source, or a tampered row). */
export function plant(t: T, projectId: string, row: Partial<Record<string, SQLInputValue>> = {}): string {
  const at = tick();
  const id = uuidv7(at);
  const snapshot = canonicalJson(readingOf(SEARCH, ['example.com']));
  const full: Record<string, SQLInputValue> = {
    id,
    project_id: projectId,
    capture_id: null,
    source: 'serp-api',
    search_key: searchKeyOf(SEARCH, {})!,
    search_key_version: SEARCH_KEY_VERSION,
    search_params: canonicalJson(SEARCH),
    filters: '{}',
    page_url: null,
    status: 'ready',
    pack_version: 3,
    reading: snapshot,
    reading_bytes: Buffer.byteLength(snapshot, 'utf8'),
    observed_at: at,
    created_at: at,
    ...row,
  };
  if (typeof full['reading'] === 'string' && row['reading_bytes'] === undefined) full['reading_bytes'] = Buffer.byteLength(full['reading'], 'utf8');
  const columns = Object.keys(full);
  t.raw.prepare(`INSERT INTO ci_serp_readings (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...Object.values(full));
  return id;
}

/** Deletes a capture the way a pulled tombstone does on this device: a recorded purge and its tombstone, then the delete. */
export function deleteCaptureAsSyncDoes(t: T, captureId: string): void {
  const at = tick();
  const purgeId = uuidv7(at);
  t.raw.prepare("INSERT INTO ci_purges (id, reason, project_id, policy, captures, versions, diffs, screenshots, bytes, created_at) VALUES (?, 'purge-now', NULL, NULL, 1, 0, 0, 0, 0, ?)").run(purgeId, at);
  t.raw.prepare("INSERT INTO ci_tombstones (id, purge_id, table_name, row_id, created_at) VALUES (?, ?, 'ci_captures', ?, ?)").run(uuidv7(at), purgeId, captureId, at);
  t.raw.prepare('DELETE FROM ci_captures WHERE id = ?').run(captureId);
}

export const readingIds = (t: T, projectId?: string): string[] =>
  (projectId === undefined ? t.raw.prepare('SELECT id FROM ci_serp_readings').all() : t.raw.prepare('SELECT id FROM ci_serp_readings WHERE project_id = ?').all(projectId)).map((row) => String(row['id']));

/** A project with a site, a competitor, a tagged saved search and a retention policy. */
export async function project(t: T, name: string): Promise<string> {
  const created = (await t.repo.createProject(name, tick()))!;
  expect(await t.repo.setProjectSite(created.id, 'example.com', true)).toBe(true);
  expect(await t.repo.addCompetitor(created.id, 'rival.com', tick())).not.toBeNull();
  const query = (await t.repo.addQuery(created.id, SEARCH.query, canonicalJson(SEARCH), tick()))!;
  expect(await t.repo.setEntryTags({ projectId: created.id, entryKind: 'search', entryId: query.id, tags: ['tea'], now: tick() })).not.toBeNull();
  expect(await t.repo.setRetention(created.id, 'versions', 5, tick())).toBe(true);
  return created.id;
}

