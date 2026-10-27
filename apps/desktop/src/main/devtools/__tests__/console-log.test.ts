// Spec: specs/devtools.spec.ts (CONSOLE_LIMITS, CONSOLE_LEVELS)
// Acceptance: specs/devtools.feature.md (Console)
import { describe, expect, test, vi } from 'vitest';
import { CONSOLE_LIMITS } from '@app/specs/devtools.spec';
import { consoleLevelOf, createConsoleLog } from '../console-log';

const TAB = 3;

describe('console log', () => {
  test('console-dedupes-and-caps', () => {
    const changed = vi.fn();
    const log = createConsoleLog({ changed });
    const hello = { level: 'info', message: 'hello', sourceId: 'https://a.test/app.js', lineNumber: 4 };
    log.add(TAB, hello, 10);
    log.add(TAB, hello, 20);
    log.add(TAB, hello, 30);
    // Same text, another level or line: another entry.
    log.add(TAB, { ...hello, level: 'error' }, 40);
    log.add(TAB, { ...hello, lineNumber: 5 }, 50);
    let snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries.map((e) => [e.level, e.message, e.line, e.count])).toEqual([
      ['info', 'hello', 4, 3],
      ['error', 'hello', 4, 1],
      ['info', 'hello', 5, 1],
    ]);
    expect(snapshot.entries[0]).toMatchObject({ firstAt: 10, lastAt: 30, source: 'https://a.test/app.js', truncated: false });
    expect(snapshot.total).toBe(5);
    expect(changed).toHaveBeenCalledTimes(5);
    // Caps: text and source cut; at most `maxEntries` distinct entries, the rest counted.
    const long = 'x'.repeat(CONSOLE_LIMITS.maxMessageChars + 50);
    log.add(TAB, { level: 'warning', message: long, sourceId: 's'.repeat(CONSOLE_LIMITS.maxSourceChars + 9), lineNumber: 1 });
    const cutEntry = log.snapshot(TAB)!.entries.at(-1)!;
    expect(cutEntry.message).toHaveLength(CONSOLE_LIMITS.maxMessageChars);
    expect(cutEntry.truncated).toBe(true);
    expect(cutEntry.source).toHaveLength(CONSOLE_LIMITS.maxSourceChars);
    for (let i = 0; i < CONSOLE_LIMITS.maxEntries + 10; i++) log.add(TAB, { level: 'debug', message: `m${i}`, sourceId: '', lineNumber: 0 });
    snapshot = log.snapshot(TAB)!;
    expect(snapshot.entries).toHaveLength(CONSOLE_LIMITS.maxEntries);
    expect(snapshot.dropped).toBe(4 + 10);
    // A known message still counts past the cap.
    log.add(TAB, hello);
    expect(log.snapshot(TAB)!.entries[0]!.count).toBe(4);
    // Levels: Electron's names, older numbers, anything else is info.
    expect([consoleLevelOf('warning'), consoleLevelOf(3), consoleLevelOf('verbose'), consoleLevelOf(undefined)]).toEqual(['warning', 'error', 'info', 'info']);
    // Not text: made text, never an object.
    log.reset(TAB);
    log.add(TAB, { level: 'info', message: { toString: () => '[object]' }, sourceId: 42, lineNumber: -1 });
    expect(log.snapshot(TAB)!.entries[0]).toMatchObject({ message: '[object]', source: '', line: 0 });
  });

  test('console-resets-on-commit', () => {
    const log = createConsoleLog();
    log.add(TAB, { level: 'info', message: 'old page' });
    log.add(4, { level: 'info', message: 'other tab' });
    log.reset(TAB);
    expect(log.snapshot(TAB)).toEqual({ entries: [], total: 0, dropped: 0 });
    expect(log.snapshot(4)!.entries).toHaveLength(1);
    log.forget(4);
    expect(log.snapshot(4)).toBeNull();
  });
});
