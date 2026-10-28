import { INTENT_LIMITS } from '@app/specs/intent-classifier.spec';

// frost's own BERT-style tokenizer for the intent model (spec `intent-classifier.spec.ts`, How a
// query is classified: Embed; acceptance `intent-classifier.feature.md`, Tokenizer). Pure: the
// vocabulary comes in as text (main read and checked it). The uncased BERT rules, written from their
// description: clean the text (control and format characters dropped, every Unicode space a space),
// put spaces around CJK ideographs, split on whitespace, lowercase, strip accents (NFD, combining
// marks dropped), split off punctuation; then WordPiece each word, greedy longest match first with
// `##` continuations, a word with any unmatched piece (or longer than `maxWordChars`) one `[UNK]`;
// then `[CLS] … [SEP]`, at most `maxTokens` ids.

/** A WordPiece vocabulary: token → id (its line number in `vocab.txt`). */
export type Vocab = ReadonlyMap<string, number>;

export const SPECIAL_TOKENS = { cls: '[CLS]', sep: '[SEP]', unk: '[UNK]', pad: '[PAD]' } as const;

/** Reads `vocab.txt`: one token per line, ids from 0; `\r\n` line ends and a final newline are fine. */
export function parseVocab(text: string): Vocab {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const vocab = new Map<string, number>();
  lines.forEach((line, index) => vocab.set(line.endsWith('\r') ? line.slice(0, -1) : line, index));
  return vocab;
}

/** Control and format characters (`\p{C}`), except the tab and line breaks BERT treats as spaces. */
const CONTROL = /[\p{C}]/u;
/** Spaces: the ASCII ones, every space separator (`Zs`), and the line and paragraph separators U+2028 and U+2029. */
const WHITESPACE = /[ \t\n\r\u2028\u2029\p{Zs}]/u;
const COMBINING_MARK = /\p{Mn}/gu;
const PUNCTUATION = /\p{P}/u;

/** ASCII symbols BERT counts as punctuation too (`$`, `+`, `<`, `^`, `` ` ``, `|`, `~` …). */
function isPunctuation(char: string): boolean {
  const code = char.codePointAt(0)!;
  if ((code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126)) return true;
  return PUNCTUATION.test(char);
}

/** CJK Unified Ideographs and their extensions and compatibility blocks (not Hangul, kana …). */
function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x2f800 && code <= 0x2fa1f)
  );
}

/** Splits `text` into lowercased, accent-stripped words and punctuation marks. */
export function basicTokenize(text: string): string[] {
  let cleaned = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0 || code === 0xfffd) continue;
    if (WHITESPACE.test(char)) cleaned += ' ';
    else if (CONTROL.test(char)) continue;
    else if (isCjk(code)) cleaned += ` ${char} `;
    else cleaned += char;
  }
  const words: string[] = [];
  for (const raw of cleaned.split(' ')) {
    if (raw === '') continue;
    const word = raw.toLowerCase().normalize('NFD').replace(COMBINING_MARK, '');
    let current = '';
    for (const char of word) {
      if (isPunctuation(char)) {
        if (current !== '') words.push(current);
        words.push(char);
        current = '';
      } else {
        current += char;
      }
    }
    if (current !== '') words.push(current);
  }
  return words;
}

/** One word's WordPiece tokens: greedy longest match first; `[UNK]` alone if any piece is missing or the word is too long. */
export function wordPiece(word: string, vocab: Vocab, maxWordChars: number = INTENT_LIMITS.maxWordChars): string[] {
  const chars = Array.from(word);
  if (chars.length > maxWordChars) return [SPECIAL_TOKENS.unk];
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = chars.length;
    let piece: string | null = null;
    while (start < end) {
      const candidate = `${start > 0 ? '##' : ''}${chars.slice(start, end).join('')}`;
      if (vocab.has(candidate)) {
        piece = candidate;
        break;
      }
      end -= 1;
    }
    if (piece === null) return [SPECIAL_TOKENS.unk];
    pieces.push(piece);
    start = end;
  }
  return pieces;
}

export interface Tokenizer {
  /** The query's ids: `[CLS]`, its WordPiece tokens, `[SEP]`; at most `maxTokens` in all. */
  encode(text: string): number[];
}

export interface TokenizerOptions {
  readonly maxTokens?: number;
  readonly maxWordChars?: number;
}

/** A tokenizer over `vocab`; throws if the vocabulary lacks `[CLS]`, `[SEP]` or `[UNK]`. */
export function createTokenizer(vocab: Vocab, options: TokenizerOptions = {}): Tokenizer {
  const maxTokens = options.maxTokens ?? INTENT_LIMITS.maxTokens;
  const maxWordChars = options.maxWordChars ?? INTENT_LIMITS.maxWordChars;
  const special = (token: string): number => {
    const id = vocab.get(token);
    if (id === undefined) throw new Error(`the vocabulary has no ${token} token`);
    return id;
  };
  const cls = special(SPECIAL_TOKENS.cls);
  const sep = special(SPECIAL_TOKENS.sep);
  const unk = special(SPECIAL_TOKENS.unk);
  return {
    encode(text) {
      const room = Math.max(0, maxTokens - 2);
      const ids: number[] = [cls];
      outer: for (const word of basicTokenize(text)) {
        for (const piece of wordPiece(word, vocab, maxWordChars)) {
          if (ids.length - 1 >= room) break outer;
          ids.push(vocab.get(piece) ?? unk);
        }
      }
      ids.push(sep);
      return ids;
    },
  };
}
