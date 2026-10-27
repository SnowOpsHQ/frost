import { SNIPPET_BUDGETS_PX, SNIPPET_ELLIPSIS, SNIPPET_FONT, type SnippetTextKind } from '@app/specs/seo-content.spec';
import { SNIPPET_FONT_TABLE } from './snippet-font';

// Result-snippet widths from frost's committed character-width table (spec `seo-content.spec.ts`,
// `SNIPPET_FONT`, `SNIPPET_BUDGETS_PX`): the sum of each character's advance, no kerning, nothing
// measured at runtime. Pure: the analysis worker measures the page's title and description with it;
// the chrome measures only the user's own drafts.

const INDEX: ReadonlyMap<number, number> = new Map([...SNIPPET_FONT_TABLE.chars].map((char, i) => [char.codePointAt(0)!, i]));

/** Full-width characters (CJK ideographs, kana, Hangul, full-width forms): `SNIPPET_FONT.wideEm` em. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿！-｠￠-￦]/u;
/** Marks that combine with the character before them take no width of their own. */
const COMBINING = /\p{M}/u;
/** Joiners, direction marks and other invisible format characters. */
const INVISIBLE = /\p{Cf}/u;

function sizeOf(kind: SnippetTextKind): number {
  return kind === 'title' ? SNIPPET_FONT.titlePx : SNIPPET_FONT.descriptionPx;
}

/** One character's advance in 1/100 px at `kind`'s size. */
function advance(char: string, kind: SnippetTextKind): number {
  const index = INDEX.get(char.codePointAt(0)!);
  if (index !== undefined) return SNIPPET_FONT_TABLE.widths[kind][index]!;
  if (COMBINING.test(char) || INVISIBLE.test(char)) return 0;
  if (WIDE.test(char)) return Math.round(sizeOf(kind) * SNIPPET_FONT.wideEm * 100);
  return SNIPPET_FONT_TABLE.averageLower[kind];
}

/** `text`'s width in px at `kind`'s size (white space as written: callers pass normalised text). */
export function textWidth(text: string, kind: SnippetTextKind): number {
  let sum = 0;
  for (const char of text) sum += advance(char, kind);
  return sum / 100;
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
  const chars = [...text];
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

/** `value` safe as HTML text and as a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/**
 * Copy as HTML's text (spec `seo-content.spec.ts`): a `<title>` line and a
 * `<meta name="description">` line, values normalised and escaped, empty ones left out; `''` when
 * both are empty.
 */
export function snippetHtml(title: string, description: string): string {
  const t = snippetText(title);
  const d = snippetText(description);
  const lines: string[] = [];
  if (t !== '') lines.push(`<title>${escapeHtml(t)}</title>`);
  if (d !== '') lines.push(`<meta name="description" content="${escapeHtml(d)}">`);
  return lines.join('\n');
}
