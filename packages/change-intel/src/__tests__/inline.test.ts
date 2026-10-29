// Spec: specs/capture.spec.ts (DIFF_LIMITS.maxInlineWords, DIFF_LIMITS.maxLcsCells, InlineSegment; tokens are Intl.Segmenter words)
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
    ['東京都に住んでいます。', '大阪に住んでいます。'],
    ['ภาษาไทยง่าย', 'ภาษาไทยยาก'],
    ['cafe\u0301 au lait', 'cafe\u0301 noir'],
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
  // Punctuation is a token of its own.
  expect(inlineDiff('Hello, world.', 'Hello world.')).toEqual([
    { op: 'same', text: 'Hello' },
    { op: 'del', text: ',' },
    { op: 'same', text: ' world.' },
  ]);
  // Text without spaces still diffs by word, not wholesale.
  const cjk = inlineDiff('東京都に住んでいます。', '大阪に住んでいます。');
  expect(cjk.at(-1)).toEqual({ op: 'same', text: 'に住んでいます。' });
  expect(inlineDiff('ภาษาไทยง่าย', 'ภาษาไทยยาก')[0]).toEqual({ op: 'same', text: 'ภาษาไทย' });
  // A combining mark stays with its letter.
  expect(inlineDiff('cafe\u0301 au lait', 'cafe\u0301 noir')[0]).toEqual({ op: 'same', text: 'cafe\u0301 ' });
  expect(inlineDiff('a b', 'a b')).toEqual([{ op: 'same', text: 'a b' }]);
  expect(inlineDiff('', '')).toEqual([]);
  expect(inlineDiff('', 'new text')).toEqual([{ op: 'ins', text: 'new text' }]);
  expect(inlineDiff('old text', '')).toEqual([{ op: 'del', text: 'old text' }]);

  // Too many tokens on a side (each word and each space is one) ...
  const many = 'w '.repeat(D.maxInlineWords / 2 + 1);
  expect(inlineDiff(many, `${many}end`)).toEqual([{ op: 'del', text: many }, { op: 'ins', text: `${many}end` }]);
  // ... while a side at the cap, with nothing in common, still fits one LCS.
  expect(D.maxInlineWords ** 2).toBe(D.maxLcsCells);
  const a = Array.from({ length: D.maxInlineWords / 2 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: D.maxInlineWords / 2 }, (_, i) => `b${i}`).join(' ');
  const segments = inlineDiff(a, b);
  expect(side(segments, 'del')).toBe(a);
  expect(segments).toEqual([{ op: 'del', text: a }, { op: 'ins', text: b }]); // all different: one group
});
