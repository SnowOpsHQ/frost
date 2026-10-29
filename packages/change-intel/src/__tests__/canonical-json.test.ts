// Spec: specs/capture-db.spec.ts (JSON is stored canonical), specs/capture.spec.ts (CaptureSnapshot)
// Acceptance: specs/changes-diff.feature.md (The snapshot: Identity, Canonical JSON)
import { expect, test } from 'vitest';
import { canonicalJson, CanonicalJsonError, snapshotIdentityJson } from '../index';
import type { CaptureSnapshot } from '@app/specs/capture.spec';
import { base, edited, sha } from './fixtures';

test('canonical-json-is-key-order-free', () => {
  const one = canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } });
  expect(one).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  expect(canonicalJson({ a: { c: 'x', d: [3, { y: null, z: true }] }, b: 1 })).toBe(one);
  expect(canonicalJson({ a: 1, skipped: undefined })).toBe('{"a":1}');
  expect(canonicalJson(['é', ' ', 'q"uote', -0, 1.5e300])).toBe(JSON.stringify(['é', ' ', 'q"uote', 0, 1.5e300]));
  expect(canonicalJson(Object.create(null))).toBe('{}');
  // A version's identity leaves out what the diff does not compare ...
  const id = snapshotIdentityJson(base());
  for (const [what, edit] of [
    ['takenAt', (s) => { s.takenAt = 1; }],
    ['partial', (s) => { s.partial = true; }],
    ['url', (s) => { s.url = 'https://example.com/other'; }],
    ['truncated', (s) => { s.regions.main.truncated = true; }],
    ['link order', (s) => { s.links.list.reverse(); }],
    ['hreflang order', (s) => { s.head.hreflang.reverse(); }],
    ['JSON-LD order', (s) => { s.structuredData.blocks.reverse(); }],
    ['heading order across regions', (s) => { s.headings = [s.headings[3]!, ...s.headings.slice(0, 3)]; }],
  ] as [string, (s: CaptureSnapshot) => void][]) expect(snapshotIdentityJson(edited(edit)), what).toBe(id);
  // ... and keeps the order the diff compares.
  expect(snapshotIdentityJson(edited((s) => { [s.headings[1], s.headings[2]] = [s.headings[2]!, s.headings[1]!]; }))).not.toBe(id);
  expect(snapshotIdentityJson(edited((s) => { s.regions.main.blocks.reverse(); }))).not.toBe(id);
  expect(snapshotIdentityJson(edited((s) => { s.regions.main.textHash = sha('x'); }))).not.toBe(id);
  for (const key of ['takenAt', 'partial', 'url', 'truncated']) expect(id).not.toContain(`"${key}"`);
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
    [{ [Symbol('k')]: 1 }, '$'],
    [{ list: Object.assign([1, 2], { extra: true }) }, '$.list'],
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
