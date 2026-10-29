// Spec: specs/seo-content.spec.ts (TARGET_QUERY_MAX_CHARS, MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_*_MAX_CHARS,
// MAX_CONTENT_NOTE_URLS, CONTENT_TABLES)
// Acceptance: specs/seo-content.feature.md (Store)
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { CONTENT_TABLES, MAX_CONTENT_NOTE_URLS, MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { createDrizzle } from '../client';
import { createContentNotesRepository, EMPTY_NOTES, noteUrl, type ContentNotesRepository } from '../content-notes';
import { MIGRATIONS, runMigrations } from '../migrations';
import { createSessionRepository } from '../repository';

let raw: DatabaseSync;
let notes: ContentNotesRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  notes = createContentNotesRepository(createDrizzle(raw));
});

const PAGE = 'https://example.com/guides/tea';
const count = (table: string) => Number(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()!['n']);

describe('content notes', () => {
  test('content-tables-migrate', () => {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'seo_%' ORDER BY name").all().map((row) => String(row['name']));
    expect(tables).toEqual([...CONTENT_TABLES]);
    expect(MIGRATIONS.map((m) => m.id)).toContain('0004_seo_content_notes');
    // The drafts' key is (url, slot): no second draft in a slot.
    const insert = raw.prepare('INSERT INTO seo_snippet_variants (url, slot, title, description, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(PAGE, 0, 'a', 'b', 1);
    expect(() => insert.run(PAGE, 0, 'c', 'd', 2)).toThrow();
  });

  test('target-query-round-trip', async () => {
    expect(await notes.notes(PAGE)).toEqual(EMPTY_NOTES);
    expect(await notes.setTargetQuery(PAGE, '  green tea  ', 1)).toBe(true);
    expect((await notes.notes(PAGE)).query).toBe('green tea');
    // Keyed without the fragment (and without userinfo).
    expect((await notes.notes(`${PAGE}#brewing`)).query).toBe('green tea');
    expect(noteUrl('https://user:pw@example.com/a#x')).toBe('https://example.com/a');
    expect(await notes.setTargetQuery(`${PAGE}#other`, 'oolong', 2)).toBe(true);
    expect((await notes.notes(PAGE)).query).toBe('oolong');
    expect(count('seo_target_queries')).toBe(1);
    // '' clears it.
    expect(await notes.setTargetQuery(PAGE, ' ', 3)).toBe(true);
    expect((await notes.notes(PAGE)).query).toBe('');
    expect(count('seo_target_queries')).toBe(0);
    // Refused: not http(s), over-long, not a string.
    expect(await notes.setTargetQuery('file:///etc/passwd', 'x', 4)).toBe(false);
    expect(await notes.setTargetQuery('javascript:alert(1)', 'x', 4)).toBe(false);
    expect(await notes.setTargetQuery(PAGE, 'q'.repeat(TARGET_QUERY_MAX_CHARS + 1), 4)).toBe(false);
    expect(await notes.setTargetQuery(PAGE, 7 as never, 4)).toBe(false);
    expect(count('seo_target_queries')).toBe(0);
    expect(await notes.notes('not a url')).toEqual(EMPTY_NOTES);
  });

  test('variants-round-trip', async () => {
    expect(await notes.saveVariant(PAGE, { slot: 2, title: 'Second', description: 'Two' }, 10)).toBe(true);
    expect(await notes.saveVariant(PAGE, { slot: 0, title: 'First', description: '' }, 11)).toBe(true);
    expect((await notes.notes(PAGE)).variants).toEqual([
      { slot: 0, title: 'First', description: '', updatedAt: 11 },
      { slot: 2, title: 'Second', description: 'Two', updatedAt: 10 },
    ]);
    // Overwrite a slot, delete another.
    expect(await notes.saveVariant(PAGE, { slot: 2, title: 'Second, again', description: 'Two!' }, 12)).toBe(true);
    expect(await notes.deleteVariant(PAGE, 0)).toBe(true);
    expect((await notes.notes(PAGE)).variants).toEqual([{ slot: 2, title: 'Second, again', description: 'Two!', updatedAt: 12 }]);
    // Other URLs keep their own.
    expect((await notes.notes('https://example.com/other')).variants).toEqual([]);
    // Refused: a bad slot, an over-long value, a bad URL.
    for (const slot of [-1, MAX_SNIPPET_VARIANTS, 1.5, Number.NaN]) expect(await notes.saveVariant(PAGE, { slot, title: 't', description: 'd' }, 13), String(slot)).toBe(false);
    expect(await notes.saveVariant(PAGE, { slot: 1, title: 't'.repeat(SNIPPET_VARIANT_TITLE_MAX_CHARS + 1), description: '' }, 13)).toBe(false);
    expect(await notes.saveVariant(PAGE, { slot: 1, title: '', description: 'd'.repeat(SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS + 1) }, 13)).toBe(false);
    expect(await notes.saveVariant('ftp://example.com/', { slot: 1, title: 't', description: 'd' }, 13)).toBe(false);
    expect(await notes.deleteVariant(PAGE, MAX_SNIPPET_VARIANTS)).toBe(false);
    expect(count('seo_snippet_variants')).toBe(1);
  });

  test('tampered-rows-are-skipped', async () => {
    const insert = raw.prepare('INSERT INTO seo_snippet_variants (url, slot, title, description, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(PAGE, 0, 'Fine', 'Fine', 1);
    insert.run(PAGE, 1, 't'.repeat(SNIPPET_VARIANT_TITLE_MAX_CHARS + 5), 'd', 1);
    insert.run(PAGE, 2, 'Fine', 'd'.repeat(SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS + 5), 1);
    insert.run(PAGE, 99, 'Bad slot', '', 1);
    insert.run(PAGE, 3, 'Bad time', '', -5);
    raw.prepare('INSERT INTO seo_target_queries (url, query, updated_at) VALUES (?, ?, ?)').run(PAGE, 'q'.repeat(TARGET_QUERY_MAX_CHARS + 10), 1);
    const read = await notes.notes(PAGE);
    expect(read.variants.map((v) => v.slot)).toEqual([0]);
    expect(read.query).toBe('');
    // A URL stored outside frost's form is never looked up.
    raw.prepare('INSERT INTO seo_target_queries (url, query, updated_at) VALUES (?, ?, ?)').run('javascript:alert(1)', 'x', 1);
    expect(await notes.notes('javascript:alert(1)')).toEqual(EMPTY_NOTES);
  });

  // 1,000 sequential writes: well under a second alone, but past the 5 s default on a loaded CI
  // runner while the package's file-backed driver suites run beside it.
  test('notes-are-pruned', { timeout: 30_000 }, async () => {
    const url = (i: number) => `https://example.com/p/${i}`;
    for (let i = 0; i <= MAX_CONTENT_NOTE_URLS; i++) {
      await notes.setTargetQuery(url(i), `query ${i}`, 1_000 + i);
      await notes.saveVariant(url(i), { slot: 0, title: `t${i}`, description: '' }, 1_000 + i);
    }
    expect(count('seo_target_queries')).toBe(MAX_CONTENT_NOTE_URLS);
    expect(count('seo_snippet_variants')).toBe(MAX_CONTENT_NOTE_URLS);
    // The least recently changed URL went; the newest stayed.
    expect(await notes.notes(url(0))).toEqual(EMPTY_NOTES);
    expect((await notes.notes(url(MAX_CONTENT_NOTE_URLS))).query).toBe(`query ${MAX_CONTENT_NOTE_URLS}`);
  });

  test('notes-survive-clear-browsing-data', async () => {
    await notes.setTargetQuery(PAGE, 'green tea', 1);
    await notes.saveVariant(PAGE, { slot: 0, title: 'Draft', description: 'Kept' }, 2);
    await createSessionRepository(createDrizzle(raw)).clearBrowsingData();
    expect(await notes.notes(PAGE)).toEqual({ query: 'green tea', variants: [{ slot: 0, title: 'Draft', description: 'Kept', updatedAt: 2 }] });
    // The confirmation says so.
    expect(CLEAR_BROWSING_DATA.dialog.detail).toMatch(/target queries and snippet drafts are kept/);
  });

  // Phase 2.5 Task 3 review.
  test('clear-all-notes', async () => {
    for (const url of [PAGE, 'https://example.org/other']) {
      await notes.setTargetQuery(url, 'tea', 1);
      await notes.saveVariant(url, { slot: 0, title: 'T', description: 'D' }, 1);
    }
    await notes.clearAll();
    expect(count('seo_target_queries')).toBe(0);
    expect(count('seo_snippet_variants')).toBe(0);
    expect(await notes.notes(PAGE)).toEqual(EMPTY_NOTES);
  });

  test('migration-tolerates-pre-merge-tables', () => {
    // A dev profile from before the merge: the tables exist, recorded under the old id.
    const old = new DatabaseSync(':memory:');
    const pre = MIGRATIONS.filter((m) => m.id < '0003');
    runMigrations(old, pre);
    old.exec(MIGRATIONS.find((m) => m.id === '0004_seo_content_notes')!.sql);
    old.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES ('0003_seo_content_notes', 1)").run();
    old.prepare("INSERT INTO seo_target_queries (url, query, updated_at) VALUES (?, 'kept', 1)").run(PAGE);
    expect(runMigrations(old)).toEqual(MIGRATIONS.map((m) => m.id).filter((id) => id >= '0003'));
    expect(old.prepare('SELECT query FROM seo_target_queries').all().map((row) => row['query'])).toEqual(['kept']);
  });
});
