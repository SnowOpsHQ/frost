// Spec: specs/rankings.spec.ts (RANKINGS_REFUSALS, RankTableAnswer, RankSeriesAnswer, ReadingDatesAnswer, CompareAnswer,
// MAX_READING_DATES), specs/rankings.schema.ts (StoredReadingSchema, RankTableSchema, RankSeriesSchema, ReadingDatesSchema,
// CompareAnswerSchema, SaveCsvAnswerSchema), specs/workspace-db.spec.ts (SEARCH_KEY_VERSION, MAX_READINGS_PER_READ)
// Acceptance: specs/rankings.feature.md (Router; Scenarios: rank-table-reads-live-project-only, tampered-reading-skipped,
// orphan-reading-ignored-and-swept, compare-refuses-readings-of-another-project, rankings-never-reject)
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { uuidv7, type ChangeIntelRepository } from '@app/db';
import type { RankingsService } from '@app/ipc-contract';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { RANK_LIMITS } from '@app/specs/rankings.spec';
import { MAX_READINGS_PER_READ } from '@app/specs/workspace-db.spec';
import { CompareAnswerSchema, RankSeriesSchema, RankTableSchema, ReadingDatesSchema, SaveCsvAnswerSchema } from '@app/specs/rankings.schema';
import { createRankingsService, searchKeyOf } from '../rankings';
import { SEARCH, captured, clock, deleteCaptureAsSyncDoes, plant, project, readingIds, readingOf, setup, tick, type T } from './rankings-fixtures';

// Real SQLite files: Windows runners are slow at file I/O.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ok = <A extends { status: string }>(answer: A): Extract<A, { status: 'ok' }> => {
  expect(answer.status).toBe('ok');
  return answer as Extract<A, { status: 'ok' }>;
};

/** Every procedure of `rankings` on `projectId`: each answers `not-found` (`null` for Copy CSV) and asks no dialog. */
async function expectNotFound(t: T, projectId: string, reading: string) {
  const key = searchKeyOf(SEARCH, {})!;
  const refused = { status: 'refused', reason: 'not-found' };
  expect(await t.rankings.table(projectId, 'all', null)).toEqual(refused);
  expect(await t.rankings.series(projectId, key, 'all')).toEqual(refused);
  expect(await t.rankings.readingDates(projectId, key)).toEqual(refused);
  expect(await t.rankings.compare(projectId, reading, reading)).toEqual(refused);
  expect(await t.rankings.copyCsv(projectId, 'table', 'all', null)).toBeNull();
  expect(await t.rankings.saveCsv(1, projectId, 'table', 'all', null)).toEqual(refused);
  expect(t.chooseCsvPath).not.toHaveBeenCalled();
  expect(t.clipboard.writeText).not.toHaveBeenCalled();
  expect(t.writeCsv).not.toHaveBeenCalled();
}

describe('rankings service', () => {
  test('rank-table-reads-live-project-only', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    const b = await project(t, 'Coffee');
    const key = searchKeyOf(SEARCH, {})!;
    const a1 = await captured(t, a, SEARCH, readingOf(SEARCH, ['other.com', 'rival.com', 'example.com']));
    const a2 = await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com', 'rival.com']));
    const black = { ...SEARCH, query: 'black tea', url: 'https://www.google.com/search?q=black+tea&gl=de&hl=de' };
    const a3 = await captured(t, a, black, readingOf(black, ['rival.com']));
    // Project B holds a reading of the very same search (the same key): never in A's answers.
    const b1 = await captured(t, b, SEARCH, readingOf(SEARCH, ['example.com']));
    expect(searchKeyOf(SEARCH, {})).toBe(key);

    const table = ok(await t.rankings.table(a, 'all', null));
    expect(RankTableSchema.parse(table)).toEqual(table);
    expect(table.retention).toEqual({ mode: 'versions', value: 5 });
    expect(table.site).toEqual({ domain: 'example.com', subdomains: true });
    expect(table.competitors).toEqual(['rival.com']);
    expect(table.tags).toEqual(['tea']);
    expect(table.rows.map((row) => row.capped)).toEqual([false, false]);
    expect(table.rows.map((row) => row.params.query)).toEqual(['green tea', 'black tea']);
    const [saved, observed] = table.rows;
    expect(saved!.saved?.tags).toEqual(['tea']);
    expect(saved!.points.map((point) => point.readingId)).toEqual([a1.readingId, a2.readingId]);
    expect(saved!.latest).toMatchObject({ readingId: a2.readingId, outcome: 'ranked', position: 1 });
    expect(saved!.change).toBe(2);
    expect(saved!.competitors['rival.com']).toMatchObject({ outcome: 'ranked', position: 2 });
    expect(observed!.saved).toBeNull();
    expect(observed!.latest).toMatchObject({ readingId: a3.readingId, outcome: 'not-found' });
    const allIds = table.rows.flatMap((row) => row.points.map((point) => point.readingId));
    expect(allIds).not.toContain(b1.readingId);
    // The tag filter keeps the tagged saved search only.
    expect(ok(await t.rankings.table(a, 'all', 'tea')).rows.map((row) => row.searchKey)).toEqual([key]);
    expect(ok(await t.rankings.table(a, 'all', 'coffee')).rows).toEqual([]);

    // Series and dates: by project and key, never another project's.
    const series = ok(await t.rankings.series(a, key, 'all'));
    expect(RankSeriesSchema.parse(series)).toEqual(series);
    expect(series.points.map((point) => point.readingId)).toEqual([a1.readingId, a2.readingId]);
    const dates = ok(await t.rankings.readingDates(a, key));
    expect(ReadingDatesSchema.parse(dates)).toEqual(dates);
    expect(dates.dates).toEqual([
      { readingId: a2.readingId, at: a2.at, status: 'ready' },
      { readingId: a1.readingId, at: a1.at, status: 'ready' },
    ]);
    expect(ok(await t.rankings.readingDates(b, key)).dates.map((date) => date.readingId)).toEqual([b1.readingId]);
    // The 7-day range at a later clock keeps no point, but latest and change still answer.
    clock.now += 30 * 86_400_000;
    const week = ok(await t.rankings.table(a, '7d', null));
    expect(week.rows[0]!.points).toEqual([]);
    expect(week.rows[0]!.latest?.readingId).toBe(a2.readingId);
    expect(ok(await t.rankings.series(a, key, '7d')).points).toEqual([]);

    // A deleted project, and an id that names none, read nothing.
    expect(await t.repo.tombstoneProject(b, tick())).toBe(true);
    await expectNotFound(t, b, b1.readingId);
    await expectNotFound(t, uuidv7(tick()), a1.readingId);
    // Unfiled is a live project: its readings rank with no site.
    const unfiled = ok(await t.rankings.table(UNFILED_PROJECT_ID, 'all', null));
    expect(unfiled.site).toBeNull();
  });

  test('tampered-reading-skipped', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    const key = searchKeyOf(SEARCH, {})!;
    const good = await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com']));
    const ready = readingOf(SEARCH, ['example.com']);
    const tampered = [
      // Not JSON at all.
      plant(t, a, { reading: '{"status":"ready",' }),
      // A snapshot that is not a SerpSnapshot (a script URL as a result).
      plant(t, a, { reading: canonicalJson({ ...ready, results: [{ ...ready.results[0]!, url: 'javascript:alert(1)' }] }) }),
      // A snapshot of another status than its row's.
      plant(t, a, { status: 'unreadable', pack_version: null }),
      // A snapshot of another search than its row's.
      plant(t, a, { search_params: canonicalJson({ ...SEARCH, query: 'black tea' }) }),
      // Filters of another engine, unsorted or unknown.
      plant(t, a, { filters: '{"df":"w"}' }),
      plant(t, a, { filters: '{"secret":"x"}' }),
      // A reading whose own JSON names another search than its row's key would file it under.
      plant(t, a, { reading: canonicalJson(readingOf({ ...SEARCH, engine: 'bing', engineLabel: 'Bing' }, ['example.com'])) }),
    ].filter((id) => readingIds(t, a).includes(id));
    expect(tampered.length).toBeGreaterThanOrEqual(5);
    // The repository hands them out (its checks are of the columns, not the JSON): main's parse is what skips them.
    expect((await t.repo.readings({ projectId: a, limit: 100 })).length).toBeGreaterThanOrEqual(5);

    const table = ok(await t.rankings.table(a, 'all', null));
    expect(RankTableSchema.parse(table)).toEqual(table);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.points.map((point) => point.readingId)).toEqual([good.readingId]);
    // Every in-range reading was read (the tampered ones skipped after): not capped.
    expect(table.rows[0]!.capped).toBe(false);
    expect(ok(await t.rankings.series(a, key, 'all')).points.map((point) => point.readingId)).toEqual([good.readingId]);
    // The dates are metadata only (no reading JSON is loaded for the picker): a tampered row may be
    // listed, never compared.
    const listed = ok(await t.rankings.readingDates(a, key)).dates.map((date) => date.readingId);
    expect(listed).toContain(good.readingId);
    for (const id of listed) if (id !== good.readingId) expect(tampered).toContain(id);
    for (const id of tampered) expect(await t.rankings.compare(a, good.readingId, id)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(await t.rankings.copyCsv(a, 'history', 'all', null)).toBe(1);
    // Nothing of a tampered row reaches the clipboard.
    expect(t.clipboard.writeText.mock.calls[0]![0]).not.toMatch(/javascript:|black tea|secret/);
  });

  test('rank-table-latest-is-independent-of-history-size', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    const key = searchKeyOf(SEARCH, {})!;
    // The saved search's only readings are older than the newest 1 000+ readings of the project.
    const first = await captured(t, a, SEARCH, readingOf(SEARCH, ['rival.com', 'example.com']));
    const last = await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com']));
    const black = { ...SEARCH, query: 'black tea', url: 'https://www.google.com/search?q=black+tea&gl=de&hl=de' };
    const json = canonicalJson(readingOf(black, ['example.com']));
    t.raw.exec('BEGIN');
    for (let n = 0; n < MAX_READINGS_PER_READ + 5; n++) plant(t, a, { search_key: searchKeyOf(black, {})!, search_params: canonicalJson(black), reading: json });
    t.raw.exec('COMMIT');

    const table = ok(await t.rankings.table(a, 'all', null));
    const [saved, observed] = table.rows;
    expect(saved!.searchKey).toBe(key);
    expect(saved!.latest).toMatchObject({ readingId: last.readingId, outcome: 'ranked', position: 1 });
    expect(saved!.previous?.readingId).toBe(first.readingId);
    expect(saved!.change).toBe(1);
    expect(saved!.capped).toBe(false);
    // The busy search shows its newest maxPointsPerSeries points, and says it has more.
    expect(observed!.points).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
    expect(observed!.capped).toBe(true);
    // In a range the old search has no point, but still its latest and change.
    clock.now += 30 * 86_400_000;
    const month = ok(await t.rankings.table(a, '7d', null));
    expect(month.rows[0]!.points).toEqual([]);
    expect(month.rows[0]!.latest?.readingId).toBe(last.readingId);
    expect(month.rows[0]!.change).toBe(1);
  });

  test('rank-table-read-is-bounded', async () => {
    // A small budget: the size of five readings (each of these is the same size).
    const sizeOf = Buffer.byteLength(canonicalJson(readingOf(SEARCH, ['example.com'])), 'utf8');
    const t = setup({ tableReadBytes: sizeOf * 5 + 1 });
    const a = await project(t, 'Tea');
    const queries = ['green tea', 'black tea', 'white tea'];
    const searches = queries.map((query) => ({ ...SEARCH, query, url: `https://www.google.com/search?q=${query.replace(' ', '+')}&gl=de&hl=de` }));
    // Three readings per search, the newest search last.
    for (const params of searches) for (let i = 0; i < 3; i++) await captured(t, a, params, readingOf(params, ['example.com']));
    const reads = vi.spyOn(t.repo, 'readings');

    const table = ok(await t.rankings.table(a, 'all', null));
    // Every points read asks for no more than what is left of the budget; the bytes they load stay within it.
    let pointsBytes = 0;
    for (const [index, [filter]] of reads.mock.calls.entries()) {
      if (filter.limit <= 2) continue;
      expect(filter.maxBytes).toBeGreaterThan(0);
      expect(filter.maxBytes).toBeLessThanOrEqual(sizeOf * 5 + 1);
      pointsBytes += (await reads.mock.results[index]!.value).reduce((sum: number, row: { readingBytes: number }) => sum + row.readingBytes, 0);
    }
    expect(pointsBytes).toBeLessThanOrEqual(sizeOf * 5 + 1);
    // The first row (the saved search) is read whole; once the budget is spent the rows keep their
    // latest and change, get no points beyond their newest readings, and say so.
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0]!.points).toHaveLength(3);
    expect(table.rows[0]!.capped).toBe(false);
    for (const row of table.rows.slice(1)) {
      expect(row.latest).not.toBeNull();
      expect(row.points.length).toBeLessThan(3);
      expect(row.capped).toBe(true);
    }
    expect(RankTableSchema.parse(table)).toEqual(table);
  });

  test('orphan-reading-ignored-and-swept', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    const b = await project(t, 'Coffee');
    const key = searchKeyOf(SEARCH, {})!;
    const gone = await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com']));
    const stays = await captured(t, a, SEARCH, readingOf(SEARCH, ['rival.com', 'example.com']));
    // A capture-less reading of another source: never an orphan.
    const api = plant(t, a);
    const elsewhere = await captured(t, b, SEARCH);
    deleteCaptureAsSyncDoes(t, gone.captureId);
    deleteCaptureAsSyncDoes(t, elsewhere.captureId);
    const sweep = vi.spyOn(t.repo, 'deleteOrphanReadings');

    const table = ok(await t.rankings.table(a, 'all', null));
    expect(table.rows[0]!.points.map((point) => point.readingId)).toEqual([stays.readingId, api]);
    // Swept for this project before the read: the orphan is gone, the API reading kept, B's orphan untouched.
    expect(sweep).toHaveBeenCalledWith(a);
    expect(readingIds(t, a).sort()).toEqual([stays.readingId, api].sort());
    expect(readingIds(t, b)).toEqual([elsewhere.readingId]);
    expect(ok(await t.rankings.readingDates(a, key)).dates.map((date) => date.readingId)).toEqual([api, stays.readingId]);
    expect(await t.rankings.compare(a, stays.readingId, gone.readingId)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(ok(await t.rankings.compare(a, stays.readingId, api)).comparison.b.readingId).toBe(api);
    // Every read sweeps first, Copy and Save CSV too.
    sweep.mockClear();
    await t.rankings.series(a, key, 'all');
    await t.rankings.readingDates(a, key);
    await t.rankings.compare(a, stays.readingId, api);
    await t.rankings.copyCsv(a, 'table', 'all', null);
    await t.rankings.saveCsv(null, a, 'table', 'all', null);
    expect(sweep.mock.calls).toEqual([[a], [a], [a], [a], [a]]);
    // A sweep that fails is logged, and the read goes on (the reads skip orphans anyway).
    sweep.mockRejectedValueOnce(new Error('SQLITE_BUSY /home/user/db'));
    expect(ok(await t.rankings.table(a, 'all', null)).rows[0]!.points).toHaveLength(2);
    expect(t.log.mock.calls.flat().join('\n')).not.toContain('/home/user');
  });

  test('compare-refuses-readings-of-another-project', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    const b = await project(t, 'Coffee');
    const a1 = await captured(t, a, SEARCH, readingOf(SEARCH, ['other.com', 'example.com', 'rival.com']));
    const a2 = await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com', 'rival.com', 'new.com']));
    const b1 = await captured(t, b, SEARCH, readingOf(SEARCH, ['example.com']));
    const refused = { status: 'refused', reason: 'not-found' };

    const answer = ok(await t.rankings.compare(a, a1.readingId, a2.readingId));
    expect(CompareAnswerSchema.parse(answer)).toEqual(answer);
    expect(answer.comparison.a.readingId).toBe(a1.readingId);
    expect(answer.comparison.rows.find((row) => row.domain === 'example.com')).toMatchObject({ movement: 'up', change: 1, role: 'site' });
    expect(answer.comparison.rows.find((row) => row.domain === 'rival.com')).toMatchObject({ role: 'competitor' });
    expect(answer.comparison.site?.b).toMatchObject({ outcome: 'ranked', position: 1 });
    // Another project's reading, by id alone, never: on either side, and from either project.
    expect(await t.rankings.compare(a, a1.readingId, b1.readingId)).toEqual(refused);
    expect(await t.rankings.compare(a, b1.readingId, a1.readingId)).toEqual(refused);
    expect(await t.rankings.compare(b, a1.readingId, a2.readingId)).toEqual(refused);
    expect(await t.rankings.compare(b, b1.readingId, a2.readingId)).toEqual(refused);
    // An id that names no reading, or a project id that names no project.
    expect(await t.rankings.compare(a, a1.readingId, uuidv7(tick()))).toEqual(refused);
    expect(await t.rankings.compare(uuidv7(tick()), a1.readingId, a2.readingId)).toEqual(refused);
    // A deleted project's readings compare no more.
    expect(await t.repo.tombstoneProject(a, tick())).toBe(true);
    expect(await t.rankings.compare(a, a1.readingId, a2.readingId)).toEqual(refused);
  });

  test('rankings-never-reject', async () => {
    const secret = 'SELECT * FROM ci_serp_readings /home/user/frost.db';
    // A store whose every method throws (or rejects).
    const throwing = new Proxy({} as ChangeIntelRepository, {
      get: (_target, name) => (name === 'then' ? undefined : () => Promise.reject(Object.assign(new Error(secret), { code: 'SQLITE_CORRUPT' }))),
    });
    // A store answering garbage.
    const garbage = new Proxy({} as ChangeIntelRepository, {
      get: (_target, name) => {
        if (name === 'then') return undefined;
        if (name === 'project') return async () => ({ id: 'x', name: 'Tea', renderProfileJson: null, retention: { mode: 'forever', value: null }, createdAt: 1, updatedAt: 1 });
        return async () => [{ id: 1, readingJson: '{', searchParamsJson: null }, null, 'x'];
      },
    });
    const PROJECT = uuidv7(1);
    for (const store of [throwing, garbage]) {
      const log = vi.fn((_message: string) => undefined);
      const clipboard = { writeText: vi.fn() };
      const chooseCsvPath = vi.fn(async () => '/tmp/never.csv');
      const writeCsv = vi.fn(async () => undefined);
      const rankings: RankingsService = createRankingsService({ store, clipboard, chooseCsvPath, writeCsv, now: () => 1_000, log });
      const answers = await Promise.all([
        rankings.table(PROJECT, 'all', null),
        rankings.series(PROJECT, 'a'.repeat(64), '30d'),
        rankings.readingDates(PROJECT, 'a'.repeat(64)),
        rankings.compare(PROJECT, PROJECT, PROJECT),
        rankings.copyCsv(PROJECT, 'table', 'all', null),
        rankings.saveCsv(null, PROJECT, 'history', 'all', 'tea'),
      ]);
      if (store === throwing) {
        const failed = { status: 'refused', reason: 'store-failed' };
        expect(answers).toEqual([failed, failed, failed, failed, null, failed]);
        expect(log).toHaveBeenCalled();
        expect(log.mock.calls.flat().join('\n')).not.toMatch(/SELECT|\/home\//);
        expect(log.mock.calls.flat().join('\n')).toContain('SQLITE_CORRUPT');
        expect(chooseCsvPath).not.toHaveBeenCalled();
      } else {
        // Garbage is skipped: every answer still fits its schema.
        expect(RankTableSchema.safeParse(answers[0]).success).toBe(true);
        expect(RankSeriesSchema.safeParse(answers[1]).success).toBe(true);
        expect(ReadingDatesSchema.safeParse(answers[2]).success).toBe(true);
        expect(CompareAnswerSchema.safeParse(answers[3]).success).toBe(true);
        expect(SaveCsvAnswerSchema.safeParse(answers[5]).success).toBe(true);
      }
    }
    // A clipboard, dialog or writer that throws: an answer, never a rejection.
    const t = setup();
    const a = await project(t, 'Tea');
    await captured(t, a, SEARCH);
    t.clipboard.writeText.mockImplementationOnce(() => {
      throw new Error(secret);
    });
    expect(await t.rankings.copyCsv(a, 'table', 'all', null)).toBeNull();
    t.chooseCsvPath.mockRejectedValueOnce(new Error(secret));
    expect(await t.rankings.saveCsv(null, a, 'table', 'all', null)).toEqual({ status: 'refused', reason: 'write-failed' });
    t.chooseCsvPath.mockResolvedValueOnce(path.join(t.dir, 'out.csv'));
    t.writeCsv.mockRejectedValueOnce(Object.assign(new Error(secret), { code: 'EACCES' }));
    expect(await t.rankings.saveCsv(null, a, 'table', 'all', null)).toEqual({ status: 'refused', reason: 'write-failed' });
    expect(t.log.mock.calls.flat().join('\n')).not.toMatch(/SELECT|\/home\/|out\.csv/);
  });
});
