import { SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, SNIPPET_FONT, type SnippetTextKind } from '@app/specs/seo-content.spec';
import { DESCRIPTION_MIN_CHARS, TITLE_MIN_CHARS } from '@app/specs/seo-rules.spec';
import { SNIPPET_FONT_TABLE } from './snippet-font';

// Result-snippet widths from frost's committed character-width table (spec `seo-content.spec.ts`,
// `SNIPPET_FONT`, `SNIPPET_BUDGETS_PX`): the sum of each character's advance, no kerning, nothing
// measured at runtime. Pure: the analysis worker measures the page's title and description with it;
// the chrome measures only the user's own drafts.

const INDEX: ReadonlyMap<number, number> = new Map([...SNIPPET_FONT_TABLE.chars].map((char, i) => [char.codePointAt(0)!, i]));

/** Full-width characters (CJK ideographs, kana, Hangul, full-width forms): `SNIPPET_FONT.wideEm` em. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;
/** Emoji and flags (regional indicators): drawn one em wide, like full-width characters. */
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
/** Marks that take no width of their own: nonspacing and enclosing (`Mn`, `Me`). */
const ZERO_WIDTH_MARK = /[\p{Mn}\p{Me}]/u;
/** Spacing marks (`Mc`, such as Devanagari vowel signs): the average width. */
const SPACING_MARK = /\p{Mc}/u;
/** Joiners, direction marks and other invisible format characters, and control characters. */
const INVISIBLE = /[\p{Cf}\p{Cc}]/u;

function sizeOf(kind: SnippetTextKind): number {
  return kind === 'title' ? SNIPPET_FONT.titlePx : SNIPPET_FONT.descriptionPx;
}

/** A grapheme's first character's advance in 1/100 px at `kind`'s size. */
function baseAdvance(char: string, kind: SnippetTextKind): number {
  const index = INDEX.get(char.codePointAt(0)!);
  if (index !== undefined) return SNIPPET_FONT_TABLE.widths[kind][index]!;
  if (ZERO_WIDTH_MARK.test(char) || INVISIBLE.test(char)) return 0;
  if (WIDE.test(char) || PICTOGRAPHIC.test(char)) return Math.round(sizeOf(kind) * SNIPPET_FONT.wideEm * 100);
  return SNIPPET_FONT_TABLE.averageLower[kind];
}

/**
 * One grapheme's advance in 1/100 px: its first character's, plus the average for each spacing
 * mark after it; anything else after it (nonspacing marks, joiners, variation selectors, the rest
 * of an emoji ZWJ sequence) takes none.
 */
function advance(grapheme: string, kind: SnippetTextKind): number {
  let sum = 0;
  let first = true;
  for (const char of grapheme) {
    if (first) sum += baseAdvance(char, kind);
    else if (SPACING_MARK.test(char)) sum += SNIPPET_FONT_TABLE.averageLower[kind];
    first = false;
  }
  return sum;
}

let graphemeSegmenter: Intl.Segmenter | null | undefined;

/** `text`'s graphemes (`Intl.Segmenter`); without it, code points with their marks and joined characters. */
export function graphemesOf(text: string): string[] {
  if (graphemeSegmenter === undefined) graphemeSegmenter = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
  const out: string[] = [];
  let joined = false;
  for (const char of text) {
    if (out.length > 0 && (joined || /[\p{M}\u200d\ufe0e\ufe0f]/u.test(char))) out[out.length - 1] += char;
    else out.push(char);
    joined = char === '\u200d';
  }
  return out;
}

/** `text`'s width in px at `kind`'s size, summed per grapheme (white space as written: callers pass normalised text). */
export function textWidth(text: string, kind: SnippetTextKind): number {
  let sum = 0;
  for (const grapheme of graphemesOf(text)) sum += advance(grapheme, kind);
  return sum / 100;
}

/**
 * The width under which a title or description is too short (`title-too-short`,
 * `meta-description-too-short`): `TITLE_MIN_CHARS` / `DESCRIPTION_MIN_CHARS` average lowercase
 * Latin letters at the result size (the table's `averageLower`).
 */
export function minSnippetWidth(kind: SnippetTextKind): number {
  return ((kind === 'title' ? TITLE_MIN_CHARS : DESCRIPTION_MIN_CHARS) * SNIPPET_FONT_TABLE.averageLower[kind]) / 100;
}

/** What a result would show of a text at a budget: the text, cut or whole, and both widths. */
export interface SnippetCut {
  /** The text as shown: whole, or cut and ending in `SNIPPET_ELLIPSIS`. */
  readonly shown: string;
  readonly truncated: boolean;
  /** The whole text's width (px, two decimals). */
  readonly width: number;
  readonly budget: number;
}

/** Trailing characters dropped before the ellipsis. */
const TRAILING = /[\s,;:\-–—]+$/u;

/**
 * `text` cut at `budget` px (`SNIPPET_ELLIPSIS` rules): kept whole when it fits; otherwise its longest
 * prefix that fits with the ellipsis, taken back to a word boundary past half of it.
 */
export function truncateToWidth(text: string, budget: number, kind: SnippetTextKind): SnippetCut {
  const width = textWidth(text, kind);
  if (width <= budget) return { shown: text, truncated: false, width, budget };
  const limit = budget * 100 - textWidth(SNIPPET_ELLIPSIS, kind) * 100;
  // Cut between graphemes, never inside one.
  const chars = graphemesOf(text);
  let used = 0;
  let end = 0;
  while (end < chars.length && used + advance(chars[end]!, kind) <= limit) used += advance(chars[end++]!, kind);
  let prefix = chars.slice(0, end).join('');
  const space = prefix.search(/\s\S*$/u);
  if (space > prefix.length / 2 && end < chars.length && !/\s/u.test(chars[end]!)) prefix = prefix.slice(0, space);
  prefix = prefix.replace(TRAILING, '');
  return { shown: `${prefix}${SNIPPET_ELLIPSIS}`, truncated: true, width, budget };
}

/** A snippet's title and description against the desktop and mobile budgets. */
export interface SnippetMeasure {
  readonly title: SnippetCut;
  readonly descriptionDesktop: SnippetCut;
  readonly descriptionMobile: SnippetCut;
}

/** White space collapsed and trimmed, as a result shows a value. */
export function snippetText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** `title` and `description` (normalised) cut at `SNIPPET_BUDGETS_PX`. */
export function measureSnippet(title: string, description: string): SnippetMeasure {
  const t = snippetText(title);
  const d = snippetText(description);
  return {
    title: truncateToWidth(t, SNIPPET_BUDGETS_PX.titleDesktop, 'title'),
    descriptionDesktop: truncateToWidth(d, SNIPPET_BUDGETS_PX.descriptionDesktop, 'description'),
    descriptionMobile: truncateToWidth(d, SNIPPET_BUDGETS_PX.descriptionMobile, 'description'),
  };
}

/** `px` for display: whole pixels with thousands separators. */
export function formatPx(px: number): string {
  return `${Math.round(px).toLocaleString('en-US')} px`;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Bidi controls: written as numeric character references in copied HTML. */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** C0 and C1 control characters: removed from copied HTML. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * `value` safe as HTML text and as a double-quoted attribute value: `& < > " '` escaped, bidi
 * controls as numeric character references (`&#x202E;`), so they show and cannot reorder the markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!).replace(BIDI_CONTROLS, (char) => `&#x${char.codePointAt(0)!.toString(16).toUpperCase()};`);
}

/**
 * Copy as HTML's text (spec `seo-content.spec.ts`): a `<title>` line and a
 * `<meta name="description">` line, values normalised and escaped, empty ones left out; `''` when
 * both are empty.
 */
export function snippetHtml(title: string, description: string): string {
  // White space first (a tab is a space), then the other control characters go.
  const t = snippetText(title).replace(CONTROLS, '').trim();
  const d = snippetText(description).replace(CONTROLS, '').trim();
  const lines: string[] = [];
  if (t !== '') lines.push(`<title>${escapeHtml(t)}</title>`);
  if (d !== '') lines.push(`<meta name="description" content="${escapeHtml(d)}">`);
  return lines.join('\n');
}
