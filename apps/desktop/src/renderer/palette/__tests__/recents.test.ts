// Spec: specs/command-palette.spec.ts (PALETTE_RECENT_STORAGE_KEY, PALETTE_RECENT_MAX, PALETTE_ACTION_ID_PATTERN)
// Acceptance: specs/command-palette.feature.md (Registry, matcher and recents)
import { describe, expect, test } from 'vitest';
import { PALETTE_RECENT_MAX, PALETTE_RECENT_STORAGE_KEY } from '@app/specs/command-palette.spec';
import { parseRecents, pushRecent, readRecents, writeRecents } from '../recents';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('recent actions', () => {
  test('recents-parse-defensively', () => {
    for (const raw of [null, '', 'not json', '{"a":1}', '42', 'null', '"page.reload"']) expect(parseRecents(raw), String(raw)).toEqual([]);
    expect(parseRecents(JSON.stringify(['page.reload', 7, null, 'Bad Id', 'x'.repeat(200), 'tab.new', 'page.reload', { id: 'a' }]))).toEqual(['page.reload', 'tab.new']);
    const many = Array.from({ length: PALETTE_RECENT_MAX + 5 }, (_, i) => `a.n${i}`);
    expect(parseRecents(JSON.stringify(many))).toEqual(many.slice(0, PALETTE_RECENT_MAX));
    // Reading never throws, even when storage does.
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(readRecents(broken)).toEqual([]);
    expect(readRecents(null)).toEqual([]);
    expect(readRecents(memoryStorage({ [PALETTE_RECENT_STORAGE_KEY]: '["tab.new"]' }))).toEqual(['tab.new']);
  });

  test('recents-push-dedupes-and-caps', () => {
    expect(pushRecent([], 'page.reload')).toEqual(['page.reload']);
    expect(pushRecent(['tab.new', 'page.reload', 'copy.title'], 'page.reload')).toEqual(['page.reload', 'tab.new', 'copy.title']);
    const full = Array.from({ length: PALETTE_RECENT_MAX }, (_, i) => `a.n${i}`);
    const next = pushRecent(full, 'b.new');
    expect(next).toHaveLength(PALETTE_RECENT_MAX);
    expect(next[0]).toBe('b.new');
    expect(next).not.toContain(`a.n${PALETTE_RECENT_MAX - 1}`);
    // A bad id is never stored.
    expect(pushRecent(['tab.new'], 'Bad Id')).toEqual(['tab.new']);
    const storage = memoryStorage();
    writeRecents(storage, ['tab.new', 'page.reload']);
    expect(JSON.parse(storage.data.get(PALETTE_RECENT_STORAGE_KEY)!)).toEqual(['tab.new', 'page.reload']);
    // Writing never throws either.
    writeRecents(
      {
        setItem: () => {
          throw new Error('quota');
        },
      },
      ['tab.new'],
    );
    writeRecents(null, ['tab.new']);
  });
});
