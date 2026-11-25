// Spec: specs/changes-diff.feature.md (a diff too large for MAX_DIFF_JSON_BYTES keeps fewer changes, `truncated`).
// Issue 25 (efficiency): fitting a diff serializes each change once, not the whole diff once per shrink round.
import { describe, expect, test, vi } from 'vitest';
import { canonicalJson } from '@app/change-intel';
import { MAX_DIFF_JSON_BYTES } from '@app/specs/capture-db.spec';
import type { Change, SnapshotDiff } from '@app/specs/capture.spec';
import { fitDiff } from '../service';

/** Characters `canonicalJson` has written (its results' lengths), the work serializing costs. */
const written = vi.hoisted(() => ({ chars: 0, calls: 0 }));
vi.mock('@app/change-intel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@app/change-intel')>();
  return {
    ...actual,
    canonicalJson: (value: unknown): string => {
      const json = actual.canonicalJson(value);
      written.chars += json.length;
      written.calls += 1;
      return json;
    },
  };
});

const change = (index: number, size: number): Change => ({ region: 'main', field: 'text', kind: 'changed', before: `é${index}`.padEnd(size, 'é'), after: `after ${index} ✓`, context: index % 3 === 0 ? null : `ctx ${index}` });
const diffOf = (changes: Change[], truncated = false): SnapshotDiff => ({
  engine: 1,
  changes,
  summary: { head: { added: 0, removed: 0, changed: changes.length }, main: { added: 0, removed: 0, changed: 0 } } as unknown as SnapshotDiff['summary'],
  changeCount: changes.length,
  truncated,
  partial: false,
});

/** What `fitDiff` was before: the whole diff serialized each round. */
function referenceFit(diff: SnapshotDiff): SnapshotDiff {
  let current = diff;
  while (current.changes.length > 0 && Buffer.byteLength(canonicalJson(current), 'utf8') > MAX_DIFF_JSON_BYTES) {
    current = { ...current, changes: current.changes.slice(0, Math.floor((current.changes.length * 3) / 4)), truncated: true };
  }
  return current;
}

describe('fitDiff', () => {
  test('answers what shrinking the whole diff round by round answers, for any sizes', () => {
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 60; run++) {
      const count = Math.floor(random() * 120);
      const changes = Array.from({ length: count }, (_, index) => change(index, 1 + Math.floor(random() * 20_000)));
      for (const truncated of [false, true]) {
        const diff = diffOf(changes, truncated);
        const before = structuredClone(diff);
        const fitted = fitDiff(diff);
        expect(fitted).toEqual(referenceFit(diff));
        expect(canonicalJson(fitted)).toBe(canonicalJson(referenceFit(diff)));
        expect(diff).toEqual(before);
      }
    }
  });

  test('keeps a diff that fits as it is, and empties one whose shell alone does not fit', () => {
    const small = diffOf([change(0, 10)]);
    expect(fitDiff(small)).toBe(small);
    expect(fitDiff(diffOf([]))).toEqual(diffOf([]));
    const huge = diffOf([change(0, MAX_DIFF_JSON_BYTES)]);
    expect(fitDiff(huge)).toEqual({ ...huge, changes: [], truncated: true });
  });

  test('a shrunk diff serializes about once (each change once), not once per round', () => {
    const diff = diffOf(Array.from({ length: 400 }, (_, index) => change(index, 6_000)));
    const whole = canonicalJson(diff).length;
    expect(whole).toBeGreaterThan(MAX_DIFF_JSON_BYTES * 4);
    written.chars = 0;
    const fitted = fitDiff(diff);
    const work = written.chars;
    expect(fitted.changes.length).toBeLessThan(diff.changes.length);
    // Before: every round wrote the diff it was testing (the first its whole length, about 4.5x the cap in all).
    expect(work).toBeLessThanOrEqual(whole * 1.1);
    written.chars = 0;
    referenceFit(diff);
    expect(written.chars).toBeGreaterThan(whole * 2);
  });
});
