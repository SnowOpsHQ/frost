// Spec: specs/rankings.spec.ts (RANK_CSV_COLUMNS, RANK_HISTORY_CSV_COLUMNS, RANK_CSV_FILE_NAME, rankCsvFileName, RANK_LIMITS),
// specs/seo-sidebar.spec.ts (CSV_FORMULA_PREFIXES), specs/workspace-db.spec.ts (MAX_READINGS_PER_READ)
// Acceptance: specs/rankings.feature.md (Export; Scenarios: rank-csv-uses-csv-cell, rank-csv-copies-through-main,
// rank-csv-save-asks-for-the-path, rank-csv-bounded)
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { canonicalJson, rankCsvRows } from '@app/change-intel';
import { uuidv7, type ChangeIntelRepository, type StoredReading } from '@app/db';
import { MAX_READING_DATES, RANK_CSV_COLUMNS, RANK_HISTORY_CSV_COLUMNS, RANK_LIMITS, rankCsvFileName } from '@app/specs/rankings.spec';
import { CSV_FORMULA_PREFIXES } from '@app/specs/seo-sidebar.spec';
import { MAX_READING_BYTES_PER_READ, MAX_READINGS_PER_READ, SEARCH_KEY_VERSION } from '@app/specs/workspace-db.spec';
import { rankCsvText, writeOwnerOnly } from '../rank-csv';
import { createRankingsService, searchKeyOf } from '../rankings';
import { SEARCH, captured, clock, project, readingOf, setup } from './rankings-fixtures';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const lines = (text: string): string[] => text.split('\r\n').slice(0, -1);

describe('rank CSV', () => {
  test('rank-csv-uses-csv-cell', async () => {
    // Every string cell through `csvCell`: a formula prefix gets a leading `'`; numbers are numbers.
    for (const prefix of CSV_FORMULA_PREFIXES) expect(rankCsvText([[`${prefix}cmd`]])).toBe(`${prefix === '\r' ? `"'\rcmd"` : `'${prefix}cmd`}\r\n`);
    expect(rankCsvText([['=SUM(1,2)', -3, 0, 12, '', 'plain', 'a "quote"']])).toBe(`"'=SUM(1,2)",-3,0,12,,plain,"a ""quote"""\r\n`);
    expect(rankCsvText([[Number.NaN, Number.POSITIVE_INFINITY]])).toBe(',\r\n');
    expect(rankCsvText([])).toBe('');

    // Through the service: a search whose query starts with `=`, and a negative change.
    const t = setup();
    const a = await project(t, 'Tea');
    const evil = { ...SEARCH, query: '=HYPERLINK("https://evil.com","x")' };
    await captured(t, a, evil, readingOf(evil, ['other.com', 'other2.com', 'example.com']));
    await captured(t, a, evil, readingOf(evil, ['other.com', 'other2.com', 'other3.com', 'other4.com', 'other5.com', 'example.com']));
    for (const query of ['+cmd', '-cmd', '@cmd']) {
      const params = { ...SEARCH, query };
      await captured(t, a, params, readingOf(params, ['example.com']));
    }
    expect(await t.rankings.copyCsv(a, 'table', 'all', null)).toBe(5);
    const text = t.clipboard.writeText.mock.calls[0]![0];
    const rows = lines(text);
    expect(rows[0]).toBe(`${RANK_CSV_COLUMNS.join(',')},rival.com`);
    const evilRow = rows.find((row) => row.includes('HYPERLINK'))!;
    expect(evilRow.startsWith(`"'=HYPERLINK(""https://evil.com"",""x"")",google,de,de,desktop,1,,,ranked,6,-3,3,https://example.com/tea,`)).toBe(true);
    for (const query of ['+cmd', '-cmd', '@cmd']) expect(rows.some((row) => row.startsWith(`'${query},`))).toBe(true);
    // Nothing starts a cell with a formula prefix unguarded.
    for (const row of rows) for (const cell of row.split(',')) expect(/^[=+@\t\r]/.test(cell) || /^-[^0-9]/.test(cell), cell).toBe(false);
    // CRLF only, with a final one.
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });

  test('rank-csv-copies-through-main', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    await captured(t, a, SEARCH, readingOf(SEARCH, ['rival.com', 'example.com']));
    await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com']));
    // Written to main's clipboard, as the table answers it; the count is the lines, header aside.
    expect(await t.rankings.copyCsv(a, 'table', 'all', null)).toBe(1);
    const table = await t.rankings.table(a, 'all', null);
    if (table.status !== 'ok') throw new Error('refused');
    expect(t.clipboard.writeText).toHaveBeenLastCalledWith(rankCsvText(rankCsvRows(table.rows, 'table')));
    expect(await t.rankings.copyCsv(a, 'history', 'all', null)).toBe(2);
    const history = lines(t.clipboard.writeText.mock.calls[1]![0]);
    expect(history[0]).toBe(RANK_HISTORY_CSV_COLUMNS.join(','));
    expect(history).toHaveLength(3);
    // The tag filter applies as in the table.
    expect(await t.rankings.copyCsv(a, 'table', 'all', 'coffee')).toBe(0);
    expect(lines(t.clipboard.writeText.mock.calls[2]![0])).toHaveLength(1);
    expect(t.clipboard.writeText).toHaveBeenCalledTimes(3);
    // A project that is not live: nothing written.
    expect(await t.rankings.copyCsv(uuidv7(), 'table', 'all', null)).toBeNull();
    expect(t.clipboard.writeText).toHaveBeenCalledTimes(3);
    // Without a clipboard (main gives one), nothing is written and nothing answered.
    const bare = createRankingsService({ store: t.repo, now: () => clock.now });
    expect(await bare.copyCsv(a, 'table', 'all', null)).toBeNull();
    // Nothing is written to any file by Copy.
    expect(t.writeCsv).not.toHaveBeenCalled();
    expect(t.chooseCsvPath).not.toHaveBeenCalled();
  });

  test('rank-csv-save-asks-for-the-path', async () => {
    const t = setup();
    const a = await project(t, 'Tea');
    await captured(t, a, SEARCH, readingOf(SEARCH, ['example.com']));
    const chosen = path.join(t.dir, 'chosen.csv');

    // Cancel: nothing written.
    expect(await t.rankings.saveCsv(7, a, 'table', 'all', null)).toEqual({ status: 'cancelled' });
    expect(t.chooseCsvPath).toHaveBeenCalledExactlyOnceWith(7, rankCsvFileName('table', clock.now), 'table');
    expect(t.writeCsv).not.toHaveBeenCalled();
    // The name offered is a bare file name, never a path, whatever the kind.
    for (const kind of ['table', 'history'] as const) expect(path.basename(rankCsvFileName(kind, clock.now))).toBe(rankCsvFileName(kind, clock.now));
    expect(rankCsvFileName('history', Date.UTC(2026, 10, 9))).toBe('frost-rank-history-2026-11-09.csv');

    // Saved only where the dialog said, with the CSV main formatted.
    t.chooseCsvPath.mockResolvedValueOnce(chosen);
    expect(await t.rankings.saveCsv(null, a, 'history', 'all', null)).toEqual({ status: 'saved', rows: 1 });
    expect(t.chooseCsvPath).toHaveBeenLastCalledWith(null, rankCsvFileName('history', clock.now), 'history');
    expect(t.writeCsv).toHaveBeenCalledExactlyOnceWith(chosen, expect.stringMatching(/^Search,Engine,.*\r\n$/s));
    // A project that is not live is refused before any dialog.
    t.chooseCsvPath.mockClear();
    expect(await t.rankings.saveCsv(null, uuidv7(), 'table', 'all', null)).toEqual({ status: 'refused', reason: 'not-found' });
    expect(t.chooseCsvPath).not.toHaveBeenCalled();
    // A dialog answering something that is not an absolute path writes nothing.
    t.writeCsv.mockClear();
    for (const odd of ['relative.csv', '', 42 as never]) {
      t.chooseCsvPath.mockResolvedValueOnce(odd);
      expect((await t.rankings.saveCsv(null, a, 'table', 'all', null)).status, String(odd)).toBe('cancelled');
    }
    expect(t.writeCsv).not.toHaveBeenCalled();

    // The default writer: owner-only, on a new file and on one that existed.
    const real = createRankingsService({ store: t.repo, chooseCsvPath: async () => chosen, now: () => clock.now });
    expect(await real.saveCsv(null, a, 'table', 'all', null)).toEqual({ status: 'saved', rows: 1 });
    const shown = await t.rankings.table(a, 'all', null);
    if (shown.status !== 'ok') throw new Error('refused');
    expect(readFileSync(chosen, 'utf8')).toBe(rankCsvText(rankCsvRows(shown.rows, 'table')));
    expect(readFileSync(chosen, 'utf8').startsWith(`${RANK_CSV_COLUMNS.join(',')},rival.com\r\n`)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(chosen).mode & 0o777).toBe(0o600);
    const existing = path.join(t.dir, 'existing.csv');
    writeFileSync(existing, 'old', { mode: 0o644 });
    await writeOwnerOnly(existing, 'new\r\n');
    expect(readFileSync(existing, 'utf8')).toBe('new\r\n');
    if (process.platform !== 'win32') expect(statSync(existing).mode & 0o777).toBe(0o600);
    // A file system that refuses the mode change (EPERM, ENOTSUP, EINVAL): still written. Any other
    // failure stops before the old content is replaced: an existing file is never emptied.
    const refusing = path.join(t.dir, 'refusing.csv');
    writeFileSync(refusing, 'old');
    const eperm = vi.fn(async () => Promise.reject(Object.assign(new Error('not permitted'), { code: 'EPERM' })));
    await writeOwnerOnly(refusing, 'new\r\n', eperm);
    expect(readFileSync(refusing, 'utf8')).toBe('new\r\n');
    if (process.platform !== 'win32') {
      expect(eperm).toHaveBeenCalledOnce();
      const eacces = vi.fn(async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })));
      await expect(writeOwnerOnly(refusing, 'newer\r\n', eacces)).rejects.toMatchObject({ code: 'EACCES' });
      expect(readFileSync(refusing, 'utf8')).toBe('new\r\n');
    }
    // Without a dialog (main gives one), nothing is ever written.
    const blind = createRankingsService({ store: t.repo, now: () => clock.now });
    const nowhere = path.join(t.dir, 'nowhere.csv');
    expect(await blind.saveCsv(null, a, 'table', 'all', null)).toEqual({ status: 'cancelled' });
    expect(existsSync(nowhere)).toBe(false);
  });

  test('rank-csv-bounded', async () => {
    // A store with 400 searches (more than a table shows): the first with 450 readings, the rest two each.
    const PROJECT = uuidv7(1);
    const all: StoredReading[] = [];
    for (let q = 0; q < 400; q++) {
      const params = { ...SEARCH, query: `tea ${q}`, url: `https://www.google.com/search?q=tea+${q}&gl=de&hl=de` };
      const json = canonicalJson(readingOf(params, ['example.com']));
      for (let i = 0; i < (q === 0 ? 450 : 2); i++) {
        const at = 1_000_000 - q * 1_000 + i;
        all.push({ id: uuidv7(at), projectId: PROJECT, captureId: uuidv7(at), source: 'capture', searchKey: searchKeyOf(params, {})!, searchKeyVersion: SEARCH_KEY_VERSION, searchParamsJson: canonicalJson(params), filtersJson: '{}', pageUrl: params.url, status: 'ready', packVersion: 3, readingJson: json, readingBytes: Buffer.byteLength(json), observedAt: at, createdAt: at });
      }
    }
    // The repository's semantics: by key and time, newest first, at most `limit`, within the byte budget.
    const select = (filter: { searchKey?: string; from?: number }) => all.filter((r) => (filter.searchKey === undefined || r.searchKey === filter.searchKey) && (filter.from === undefined || r.observedAt >= filter.from)).sort((a, b) => b.observedAt - a.observedAt);
    const readings = vi.fn(async (filter: { searchKey?: string; from?: number; limit: number; maxBytes?: number }) => {
      const out: StoredReading[] = [];
      let bytes = 0;
      for (const r of select(filter).slice(0, Math.min(filter.limit, MAX_READINGS_PER_READ))) {
        bytes += r.readingBytes;
        if (bytes > Math.min(filter.maxBytes ?? MAX_READING_BYTES_PER_READ, MAX_READING_BYTES_PER_READ)) break;
        out.push(r);
      }
      return out;
    });
    const keys = [...new Set(all.map((r) => r.searchKey))];
    const store = {
      project: async () => ({ id: PROJECT, name: 'Tea', renderProfileJson: null, retention: { mode: 'forever' as const, value: null }, createdAt: 1, updatedAt: 1 }),
      projectWorkspace: async () => ({ projectId: PROJECT, favorite: false, siteDomain: 'example.com', siteSubdomains: true, cadence: 'off' as const, autoCapture: false }),
      competitors: async () => [],
      projectQueries: async () => [],
      projectTags: async () => [],
      readings,
      countReadings: async (filter: { searchKey?: string; from?: number }) => select(filter).length,
      readingDates: async (filter: { searchKey: string; limit: number }) => select(filter).slice(0, filter.limit).map((r) => ({ id: r.id, observedAt: r.observedAt, status: r.status })),
      readingSearches: async () => keys.map((key) => ({ searchKey: key, searchKeyVersion: SEARCH_KEY_VERSION, searchParamsJson: all.find((r) => r.searchKey === key)!.searchParamsJson, filtersJson: '{}', readings: select({ searchKey: key }).length, lastObservedAt: select({ searchKey: key })[0]!.observedAt })),
      reading: async () => null,
      deleteOrphanReadings: async () => 0,
    } as unknown as ChangeIntelRepository;
    const clipboard = { writeText: vi.fn((_text: string) => undefined) };
    const rankings = createRankingsService({ store, clipboard, now: () => 2_000_000 });

    const table = await rankings.table(PROJECT, 'all', null);
    if (table.status !== 'ok') throw new Error('refused');
    expect(table.rows).toHaveLength(RANK_LIMITS.maxRows);
    expect(table.truncated).toBe(true);
    // Each read is one search's, at most its points' bound; the long one is capped, the others are not.
    for (const [filter] of readings.mock.calls) {
      expect(filter.searchKey).toMatch(/^[0-9a-f]{64}$/);
      expect(filter.limit).toBeLessThanOrEqual(RANK_LIMITS.maxPointsPerSeries);
    }
    expect(table.rows[0]!.points).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
    expect(table.rows.map((row) => row.capped)).toEqual([true, ...Array.from({ length: RANK_LIMITS.maxRows - 1 }, () => false)]);
    expect(await rankings.copyCsv(PROJECT, 'table', 'all', null)).toBe(RANK_LIMITS.maxRows);
    expect(lines(clipboard.writeText.mock.calls[0]![0])).toHaveLength(RANK_LIMITS.maxRows + 1);
    expect(await rankings.copyCsv(PROJECT, 'history', 'all', null)).toBe(RANK_LIMITS.maxPointsPerSeries + 2 * (RANK_LIMITS.maxRows - 1));
    // Series and dates are bounded too.
    readings.mockClear();
    const series = await rankings.series(PROJECT, keys[0]!, 'all');
    if (series.status !== 'ok') throw new Error('refused');
    expect(series.points).toHaveLength(RANK_LIMITS.maxPointsPerSeries);
    for (const [filter] of readings.mock.calls) expect(filter.limit).toBeLessThanOrEqual(RANK_LIMITS.maxPointsPerSeries);
    const dates = await rankings.readingDates(PROJECT, keys[0]!);
    if (dates.status !== 'ok') throw new Error('refused');
    expect(dates.dates).toHaveLength(MAX_READING_DATES);
  });
});
