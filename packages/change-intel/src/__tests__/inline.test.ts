// Spec: specs/capture.spec.ts (DIFF_LIMITS.maxInlineWords, DIFF_LIMITS.maxLcsCells, InlineSegment)
// Acceptance: specs/changes-diff.feature.md (Inline diffs)
import { expect, test } from 'vitest';
import { DIFF_LIMITS as D, type InlineSegment } from '@app/specs/capture.spec';
import { inlineDiff } from '../index';

const side = (segments: InlineSegment[], op: 'del' | 'ins') => segments.filter((s) => s.op === 'same' || s.op === op).map((s) => s.text).join('');

test('inline-diff-merges-and-falls-back', () => {
  // Segments rebuild both sides.
  const pairs: [string, string][] = [
    ['the quick brown fox', 'the slow red fox'],
    ['  leading and trailing  ', 'leading, and trailing'],
    ['a b c d e', 'a x c y e'],
    ['one', 'one two three'],
    ['line one\nline two', 'line one\n\nline 2'],
  ];
  for (const [a, b] of pairs) {
    const segments = inlineDiff(a, b);
    expect(side(segments, 'del'), a).toBe(a);
    expect(side(segments, 'ins'), b).toBe(b);
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.op, JSON.stringify(segments)).not.toBe(segments[i - 1]!.op);
    expect(segments.every((s) => s.text !== '')).toBe(true);
  }
  // Whitespace between edits is folded in; deletions come first.
  expect(inlineDiff('the quick brown fox', 'the slow red fox')).toEqual([
    { op: 'same', text: 'the ' },
    { op: 'del', text: 'quick brown' },
    { op: 'ins', text: 'slow red' },
    { op: 'same', text: ' fox' },
  ]);
  expect(inlineDiff('one', 'one two three')).toEqual([
    { op: 'same', text: 'one' },
    { op: 'ins', text: ' two three' },
  ]);
  expect(inlineDiff('a b', 'a b')).toEqual([{ op: 'same', text: 'a b' }]);
  expect(inlineDiff('', '')).toEqual([]);
  expect(inlineDiff('', 'new text')).toEqual([{ op: 'ins', text: 'new text' }]);
  expect(inlineDiff('old text', '')).toEqual([{ op: 'del', text: 'old text' }]);

  // Too many tokens on a side (each word and each space is one).
  const many = 'w '.repeat(D.maxInlineWords / 2 + 1);
  expect(inlineDiff(many, `${many}end`)).toEqual([{ op: 'del', text: many }, { op: 'ins', text: `${many}end` }]);
  // Few enough tokens, but the middle's LCS would be over the cell cap (≈ 1 000 × 1 000).
  const a = Array.from({ length: 500 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 500 }, (_, i) => `b${i}`).join(' ');
  expect(inlineDiff(a, b)).toEqual([{ op: 'del', text: a }, { op: 'ins', text: b }]);
});
