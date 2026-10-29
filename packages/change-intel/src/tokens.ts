// Words and tokens (acceptance `specs/changes-diff.feature.md`: Text blocks, Inline diffs). Text
// arrives NFC-normalised from the extractor; segmenting it with `Intl.Segmenter` (ECMAScript, no
// host API) splits CJK, Thai and text with combining marks into real words, where a regex on
// letters or spaces would not.

/** Word boundaries of the root locale, so a diff never depends on the machine's language. */
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'word' });
const WHITESPACE = /^\s+$/;

/** `text` as tokens: words, punctuation, and runs of whitespace (merged into one token). Joined, they are `text`. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of SEGMENTER.segment(text)) {
    const last = out.length - 1;
    if (last >= 0 && WHITESPACE.test(segment) && WHITESPACE.test(out[last]!)) out[last] += segment;
    else out.push(segment);
  }
  return out;
}

/** The set of `text`'s words (word-like segments), lowercased. */
export function wordSet(text: string): Set<string> {
  const words = new Set<string>();
  for (const { segment, isWordLike } of SEGMENTER.segment(text)) if (isWordLike) words.add(segment.toLowerCase());
  return words;
}

/** The Jaccard index of two word sets (0 when both are empty), and what computing it cost (the smaller set's size, plus one). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): { index: number; cost: number } {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  const union = a.size + b.size - shared;
  return { index: union === 0 ? 0 : shared / union, cost: small.size + 1 };
}
