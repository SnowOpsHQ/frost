// Spec: specs/capture-db.spec.ts (UUIDV7_PATTERN, UNFILED_PROJECT_ID)
// Acceptance: specs/capture-db.feature.md (Ids)
import { describe, expect, test } from 'vitest';
import { UNFILED_PROJECT_ID, UUIDV7_PATTERN } from '@app/specs/capture-db.spec';
import { createUuidv7, isUuidv7, uuidv7 } from '../ids';

/** The 48-bit millisecond time at the front of a UUIDv7. */
const timeOf = (id: string): number => Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);

describe('ids', () => {
  test('uuidv7-ids-are-time-ordered', () => {
    const next = createUuidv7();
    const at = Date.UTC(2026, 9, 28, 12, 0, 0);
    const first = next(at);
    expect(first).toMatch(UUIDV7_PATTERN);
    expect(timeOf(first)).toBe(at);
    expect(isUuidv7(first)).toBe(true);
    expect(isUuidv7(uuidv7())).toBe(true);

    // A tight loop in one millisecond: strictly increasing, the counter overflowing into the next ms.
    const burst = Array.from({ length: 10_000 }, () => next(at));
    for (let i = 1; i < burst.length; i++) expect(burst[i]! > burst[i - 1]!, `${i}`).toBe(true);
    expect(burst.every((id) => UUIDV7_PATTERN.test(id))).toBe(true);
    expect(timeOf(burst[burst.length - 1]!)).toBeGreaterThan(at);
    expect(new Set(burst).size).toBe(burst.length);

    // Later milliseconds sort after earlier ones.
    const later = next(at + 60_000);
    expect(later > burst[burst.length - 1]!).toBe(true);
    expect(timeOf(later)).toBe(at + 60_000);
    // A clock going back still gives a later id (its time is the last one's).
    const back = next(at);
    expect(back > later).toBe(true);
    expect(timeOf(back)).toBe(at + 60_000);

    // Two generators' ids of different milliseconds order by time.
    const other = createUuidv7();
    expect(other(at + 1) > createUuidv7()(at)).toBe(true);

    // The pattern: lowercase, version 7, variant 10.
    expect(isUuidv7(UNFILED_PROJECT_ID)).toBe(true);
    expect(isUuidv7(first.toUpperCase())).toBe(false);
    expect(isUuidv7(`${first.slice(0, 14)}4${first.slice(15)}`)).toBe(false);
    expect(isUuidv7(`${first.slice(0, 19)}c${first.slice(20)}`)).toBe(false);
    expect(isUuidv7(first.replace(/-/g, ''))).toBe(false);
    expect(isUuidv7(42)).toBe(false);
  });
});
