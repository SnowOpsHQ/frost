// Spec: specs/capture-db.spec.ts (JSON is stored canonical), specs/capture.spec.ts (CaptureSnapshot)
// Acceptance: specs/changes-diff.feature.md (The snapshot: Identity, Canonical JSON)
import { expect, test } from 'vitest';
import { canonicalJson, CanonicalJsonError, snapshotIdentityJson } from '../index';
import { base, edited } from './fixtures';

test('canonical-json-is-key-order-free', () => {
  const one = canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } });
  expect(one).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  expect(canonicalJson({ a: { c: 'x', d: [3, { y: null, z: true }] }, b: 1 })).toBe(one);
  expect(canonicalJson({ a: 1, skipped: undefined })).toBe('{"a":1}');
  expect(canonicalJson(['é', ' ', 'q"uote', -0, 1.5e300])).toBe(JSON.stringify(['é', ' ', 'q"uote', 0, 1.5e300]));
  expect(canonicalJson(Object.create(null))).toBe('{}');
  // A version's identity ignores when it was taken, and nothing else.
  expect(snapshotIdentityJson(edited((s) => { s.takenAt = 1; }))).toBe(snapshotIdentityJson(base()));
  expect(snapshotIdentityJson(edited((s) => { s.partial = true; }))).not.toBe(snapshotIdentityJson(base()));
  expect(snapshotIdentityJson(base())).not.toContain('takenAt');
  expect(JSON.parse(snapshotIdentityJson(base()))).toEqual(JSON.parse(JSON.stringify({ ...base(), takenAt: undefined })));
});

test('canonical-json-rejects-non-json', () => {
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = { back: cycle };
  const cases: [unknown, string][] = [
    [{ a: Number.NaN }, '$.a'],
    [{ a: [1, Number.POSITIVE_INFINITY] }, '$.a[1]'],
    [[1, undefined], '$[1]'],
    [undefined, '$'],
    [{ f: () => 1 }, '$.f'],
    [{ s: Symbol('x') }, '$.s'],
    [{ n: 1n }, '$.n'],
    [{ d: new Date(0) }, '$.d'],
    [{ m: new Map() }, '$.m'],
    [cycle, '$.self.back'],
  ];
  for (const [value, path] of cases) {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(value)).toThrow(path);
  }
  // Shared but acyclic is fine.
  const shared = { x: 1 };
  expect(canonicalJson({ a: shared, b: [shared, shared] })).toBe('{"a":{"x":1},"b":[{"x":1},{"x":1}]}');
});
