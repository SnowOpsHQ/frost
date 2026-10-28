// Spec: specs/intent-classifier.spec.ts (How a query is classified: Embed; INTENT_LIMITS.maxTokens,
// maxWordChars) · Acceptance: specs/intent-classifier.feature.md (Tokenizer)
import { describe, expect, test } from 'vitest';
import { INTENT_LIMITS } from '@app/specs/intent-classifier.spec';
import { basicTokenize, createTokenizer, parseVocab, wordPiece } from '../tokenizer';

/** A small vocabulary: one token per line, its id is its line number. */
const VOCAB_LINES = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'hello', 'world', 'un', '##aff', '##able', 'cafe', 'creme', ',', '!', '中', '国', 'run', '##ning', 'a', 'abc', '.', 'b', 'c', "'", 's'];
const VOCAB = parseVocab(`${VOCAB_LINES.join('\n')}\n`);
const id = (token: string): number => {
  const value = VOCAB.get(token);
  if (value === undefined) throw new Error(`not in the test vocabulary: ${token}`);
  return value;
};

describe('intent tokenizer', () => {
  test('intent-tokenizer-vocab', () => {
    expect(VOCAB.get('[PAD]')).toBe(0);
    expect(VOCAB.get('hello')).toBe(4);
    expect(VOCAB.size).toBe(VOCAB_LINES.length);
    // CRLF line ends and a missing final newline read the same.
    const crlf = parseVocab(VOCAB_LINES.join('\r\n'));
    expect([...crlf.entries()]).toEqual([...VOCAB.entries()]);
    // Without the special tokens there is no tokenizer.
    expect(() => createTokenizer(parseVocab('hello\nworld\n'))).toThrow(/\[CLS\]/);
  });

  test('intent-tokenizer-basic', () => {
    // Lowercase, punctuation split off.
    expect(basicTokenize('Hello, World!')).toEqual(['hello', ',', 'world', '!']);
    // Accents stripped (NFD, combining marks dropped).
    expect(basicTokenize('Café Crème')).toEqual(['cafe', 'creme']);
    // CJK ideographs are words of their own.
    expect(basicTokenize('中国abc')).toEqual(['中', '国', 'abc']);
    // Control and format characters removed; tabs, newlines and no-break spaces are whitespace.
    expect(basicTokenize('a\u0000b\u200bc')).toEqual(['abc']);
    expect(basicTokenize(' a\tb\u00a0c\n')).toEqual(['a', 'b', 'c']);
    // The line and paragraph separators too.
    expect(basicTokenize('a\u2028b\u2029c')).toEqual(['a', 'b', 'c']);
    // Every Unicode punctuation and ASCII symbol is split off.
    expect(basicTokenize("it's 1.5$ «x»")).toEqual(['it', "'", 's', '1', '.', '5', '$', '«', 'x', '»']);
    expect(basicTokenize('')).toEqual([]);
  });

  test('intent-tokenizer-wordpiece', () => {
    // Greedy longest match first, continuations prefixed with ##.
    expect(wordPiece('unaffable', VOCAB)).toEqual(['un', '##aff', '##able']);
    expect(wordPiece('running', VOCAB)).toEqual(['run', '##ning']);
    // A word with any piece missing is one [UNK], never a partial guess.
    expect(wordPiece('xyz', VOCAB)).toEqual(['[UNK]']);
    expect(wordPiece('unxyz', VOCAB)).toEqual(['[UNK]']);
    // A word longer than maxWordChars (in code points) is [UNK] unread.
    expect(wordPiece('a'.repeat(INTENT_LIMITS.maxWordChars), VOCAB)).toEqual(['[UNK]']);
    expect(wordPiece('a'.repeat(INTENT_LIMITS.maxWordChars + 1), VOCAB)).toEqual(['[UNK]']);
    expect(wordPiece('abc', VOCAB)).toEqual(['abc']);
  });

  test('intent-tokenizer-caps-length', () => {
    const tokenizer = createTokenizer(VOCAB);
    expect(tokenizer.encode('Hello, World!')).toEqual([id('[CLS]'), id('hello'), id(','), id('world'), id('!'), id('[SEP]')]);
    expect(tokenizer.encode('')).toEqual([id('[CLS]'), id('[SEP]')]);
    expect(tokenizer.encode('unaffable zzz')).toEqual([id('[CLS]'), id('un'), id('##aff'), id('##able'), id('[UNK]'), id('[SEP]')]);
    // At most maxTokens ids, [CLS] and [SEP] included; the rest of the query is dropped.
    const long = createTokenizer(VOCAB).encode('hello '.repeat(500));
    expect(long).toHaveLength(INTENT_LIMITS.maxTokens);
    expect(long[0]).toBe(id('[CLS]'));
    expect(long.at(-1)).toBe(id('[SEP]'));
    expect(createTokenizer(VOCAB, { maxTokens: 4 }).encode('hello world hello')).toEqual([id('[CLS]'), id('hello'), id('world'), id('[SEP]')]);
  });
});
