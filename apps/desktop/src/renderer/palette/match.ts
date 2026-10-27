import { PALETTE_GROUPS, PALETTE_QUERY_MAX_CHARS, PALETTE_RECENT_BOOST, PALETTE_RECENT_LABEL, type PaletteGroupId } from '@app/specs/command-palette.spec';

// The command palette's search (acceptance `command-palette.feature.md`, Registry, matcher and
// recents): frost's own fuzzy matcher and ranking. Pure. Every query word must match the label or
// a keyword: as the label's prefix, at a word start, as a substring, or as a subsequence scored by
// an alignment that rewards word starts and runs and penalises gaps. Tiers are far apart, so a
// better kind of match always wins; inside a tier, earlier and shorter wins.

/** A match: its score (higher is better) and the label characters it matched (code point indices). */
export interface PaletteMatch {
  readonly score: number;
  readonly indices: readonly number[];
}

/** What the matcher reads of an action. */
export interface Matchable {
  readonly id: string;
  readonly label: string;
  readonly group: PaletteGroupId;
  readonly keywords?: readonly string[];
}

const TIER_PREFIX = 3_000;
const TIER_WORD = 2_000;
const TIER_SUBSTRING = 1_000;
/** Subsequence scores stay below the substring tier. */
const SUBSEQUENCE_MAX = 900;
const CHAR_SCORE = 10;
const WORD_START_BONUS = 12;
const RUN_BONUS = 8;
const GAP_PENALTY = 1;
const LEAD_PENALTY = 0.5;
const POSITION_PENALTY = 0.5;
const LENGTH_PENALTY = 0.5;
/** A keyword match counts this much of a label match (and highlights nothing). */
const KEYWORD_WEIGHT = 0.6;
/** Longest text matched against (labels and keywords are short; this bounds the alignment). */
const TEXT_MAX = 256;

/** One code point folded for matching: lowercase, accents removed (`é` → `e`). */
function foldChar(char: string): string {
  const folded = char.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
  return folded === '' ? char : folded;
}

/** `text` as folded code points (index `i` is the label's `i`-th code point). */
function folded(text: string, max: number): string[] {
  return Array.from(text.slice(0, max * 2)).slice(0, max).map(foldChar);
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Where `needle` occurs in `hay` from `from` on, or -1. */
function indexOf(hay: readonly string[], needle: readonly string[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const range = (start: number, length: number): number[] => Array.from({ length }, (_, i) => start + i);

/**
 * The best alignment of `query` as a subsequence of `text` (every query character in order),
 * by dynamic programming: a matched character scores `CHAR_SCORE`, more at a word start, more
 * right after the previous match; skipped characters between matches cost `GAP_PENALTY` each.
 */
function subsequence(query: readonly string[], text: readonly string[], starts: readonly boolean[]): PaletteMatch | null {
  const n = query.length;
  const m = text.length;
  if (n === 0 || n > m) return null;
  const NONE = Number.NEGATIVE_INFINITY;
  const score = new Float64Array(n * m).fill(NONE);
  const from = new Int32Array(n * m).fill(-1);
  const charScore = (j: number) => CHAR_SCORE + (starts[j] ? WORD_START_BONUS : 0);
  for (let j = 0; j < m; j++) if (text[j] === query[0]) score[j] = charScore(j) - LEAD_PENALTY * j;
  for (let i = 1; i < n; i++) {
    const row = i * m;
    const prev = (i - 1) * m;
    // The best earlier match at least two characters back, with the gap paid up to `j - 1`.
    let gapBest = NONE;
    let gapFrom = -1;
    for (let j = 1; j < m; j++) {
      if (j >= 2) {
        const candidate = score[prev + j - 2]! - GAP_PENALTY;
        gapBest -= GAP_PENALTY;
        if (candidate > gapBest) {
          gapBest = candidate;
          gapFrom = j - 2;
        }
      }
      if (text[j] !== query[i]) continue;
      const run = score[prev + j - 1]! + RUN_BONUS;
      const best = run >= gapBest ? run : gapBest;
      if (best === NONE) continue;
      score[row + j] = best + charScore(j);
      from[row + j] = run >= gapBest ? j - 1 : gapFrom;
    }
  }
  let end = -1;
  let best = NONE;
  const last = (n - 1) * m;
  for (let j = 0; j < m; j++) {
    if (score[last + j]! > best) {
      best = score[last + j]!;
      end = j;
    }
  }
  if (end < 0) return null;
  const indices: number[] = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i * m + j]!;
  }
  return { score: Math.min(SUBSEQUENCE_MAX, Math.max(0, best)), indices };
}

/** How `word` (folded) matches `text` (folded), or `null`. */
function matchWord(word: readonly string[], text: readonly string[]): PaletteMatch | null {
  const starts = text.map((_, j) => j === 0 || (!isWordChar(text[j - 1]) && isWordChar(text[j])));
  const length = LENGTH_PENALTY * text.length;
  const at = indexOf(text, word);
  if (at === 0) return { score: TIER_PREFIX - length, indices: range(0, word.length) };
  if (at > 0) {
    for (let i = at; i >= 0; i = indexOf(text, word, i + 1)) {
      if (starts[i]) return { score: TIER_WORD - POSITION_PENALTY * i - length, indices: range(i, word.length) };
    }
    return { score: TIER_SUBSTRING - POSITION_PENALTY * at - length, indices: range(at, word.length) };
  }
  const sub = subsequence(word, text, starts);
  return sub && { score: sub.score - length, indices: sub.indices };
}

/** The query's words (folded), cut to `PALETTE_QUERY_MAX_CHARS`. */
function queryWords(query: string): string[][] {
  return query
    .slice(0, PALETTE_QUERY_MAX_CHARS * 2)
    .split(/\s+/)
    .reduce<{ words: string[][]; left: number }>(
      (acc, part) => {
        if (part === '' || acc.left <= 0) return acc;
        const word = folded(part, acc.left);
        acc.left -= word.length;
        acc.words.push(word);
        return acc;
      },
      { words: [], left: PALETTE_QUERY_MAX_CHARS },
    ).words;
}

/**
 * How `query` matches `action` (`null`: some word matches neither the label nor a keyword). A
 * whitespace-only query matches everything with score 0.
 */
export function matchAction(query: string, action: { readonly label: string; readonly keywords?: readonly string[] }): PaletteMatch | null {
  const words = queryWords(query);
  if (words.length === 0) return { score: 0, indices: [] };
  const label = folded(action.label, TEXT_MAX);
  const keywords = (action.keywords ?? []).map((keyword) => folded(keyword, TEXT_MAX));
  let total = 0;
  const indices = new Set<number>();
  for (const word of words) {
    const onLabel = matchWord(word, label);
    let best = onLabel ? onLabel.score : Number.NEGATIVE_INFINITY;
    let fromLabel = onLabel !== null;
    for (const keyword of keywords) {
      const onKeyword = matchWord(word, keyword);
      if (onKeyword && onKeyword.score * KEYWORD_WEIGHT > best) {
        best = onKeyword.score * KEYWORD_WEIGHT;
        fromLabel = false;
      }
    }
    if (best === Number.NEGATIVE_INFINITY) return null;
    total += best;
    if (fromLabel && onLabel) for (const index of onLabel.indices) indices.add(index);
  }
  return { score: total, indices: [...indices].sort((a, b) => a - b) };
}

export interface RankedAction<T extends Matchable> {
  readonly action: T;
  readonly score: number;
  readonly indices: readonly number[];
  /** One of the recent actions. */
  readonly recent: boolean;
}

/**
 * The actions `query` matches, best first. With an empty query: every action, the recent ones first
 * (most recent first), then in registration order. With one: by score, a recent action getting
 * `PALETTE_RECENT_BOOST`; ties keep registration order.
 */
export function rankActions<T extends Matchable>(query: string, actions: readonly T[], recents: readonly string[]): RankedAction<T>[] {
  const recentRank = new Map(recents.map((id, i) => [id, i]));
  const empty = queryWords(query).length === 0;
  const ranked: (RankedAction<T> & { readonly order: number })[] = [];
  actions.forEach((action, order) => {
    const match = matchAction(query, action);
    if (!match) return;
    const recent = recentRank.has(action.id);
    ranked.push({ action, score: match.score + (recent && !empty ? PALETTE_RECENT_BOOST : 0), indices: match.indices, recent, order });
  });
  if (empty) {
    const rank = (r: { action: T; order: number }) => recentRank.get(r.action.id) ?? recents.length + r.order;
    ranked.sort((a, b) => rank(a) - rank(b));
  } else {
    ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  }
  return ranked.map(({ order: _order, ...rest }) => rest);
}

export interface PaletteSection<T extends Matchable> {
  /** `recent`, a group id, or `results` (a query's flat list). */
  readonly id: string;
  /** The heading; `null` for a query's flat list. */
  readonly label: string | null;
  readonly items: readonly RankedAction<T>[];
}

/**
 * The list as the palette shows it: with an empty query, the recent actions under
 * `PALETTE_RECENT_LABEL`, then each group in `PALETTE_GROUPS` order (empty groups left out, recent
 * ones not repeated); with a query, one flat list without a heading.
 */
export function paletteSections<T extends Matchable>(query: string, ranked: readonly RankedAction<T>[]): PaletteSection<T>[] {
  if (queryWords(query).length > 0) return ranked.length === 0 ? [] : [{ id: 'results', label: null, items: ranked }];
  const sections: PaletteSection<T>[] = [];
  const recent = ranked.filter((r) => r.recent);
  if (recent.length > 0) sections.push({ id: 'recent', label: PALETTE_RECENT_LABEL, items: recent });
  for (const group of PALETTE_GROUPS) {
    const items = ranked.filter((r) => !r.recent && r.action.group === group.id);
    if (items.length > 0) sections.push({ id: group.id, label: group.label, items });
  }
  return sections;
}
