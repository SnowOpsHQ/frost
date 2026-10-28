// Bounded sequence alignment (acceptance `specs/changes-diff.feature.md`, Bounds and the fallback;
// Inline diffs). Every LCS here is capped at `DIFF_LIMITS.maxLcsCells` and charged to the diff's
// work budget; a caller that is refused falls back to something cheaper.
import { DIFF_LIMITS, type InlineSegment } from '@app/specs/capture.spec';
import { tokens } from './tokens';

/**
 * What a test can learn about one diff's work: the cells spent (LCS cells, words compared while
 * pairing, inline cells) and each fallback taken (`text:main`, `pairing:nav`, `inline` …).
 */
export interface DiffProbe {
  work: number;
  fallbacks: string[];
}

/** The work one diff may still do (`DIFF_LIMITS.maxWorkCells`). */
export class Work {
  private spent = 0;
  constructor(
    private readonly limit: number,
    private readonly probe?: DiffProbe,
  ) {}

  /** Spends `cells` if the budget still has them; `false` (spending nothing) if not. */
  take(cells: number): boolean {
    if (this.spent + cells > this.limit) return false;
    this.spent += cells;
    if (this.probe) this.probe.work = this.spent;
    return true;
  }

  fellBack(what: string): void {
    this.probe?.fallbacks.push(what);
  }
}

/** Keep both (`same`), only the old item (`del`), or only the new one (`ins`). */
export type Op = 'same' | 'del' | 'ins';

/**
 * The edit script of an LCS of `a` and `b` (items compared with `===`), or `null` when the part
 * between their common start and end is over `maxLcsCells` or the budget refuses it. Deterministic:
 * on a tie the old item is deleted first.
 */
export function lcsOps<T>(a: readonly T[], b: readonly T[], work: Work): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const n = a.length - start - end;
  const m = b.length - start - end;
  const cells = n * m;
  if (cells > DIFF_LIMITS.maxLcsCells || !work.take(cells)) return null;
  // Suffix lengths: lengths[i * (m + 1) + j] is the LCS of a[start + i …] and b[start + j …].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[start + i];
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = ai === b[start + j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  const ops: Op[] = new Array<Op>(start).fill('same');
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push('same');
      i++;
      j++;
    } else if (j >= m || (i < n && lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
      ops.push('del');
      i++;
    } else {
      ops.push('ins');
      j++;
    }
  }
  for (let k = 0; k < end; k++) ops.push('same');
  return ops;
}

/** Strings as small integers (equal strings, equal ids), so an LCS compares numbers. */
export function interner(): (text: string) => number {
  const ids = new Map<string, number>();
  return (text) => {
    let id = ids.get(text);
    if (id === undefined) ids.set(text, (id = ids.size));
    return id;
  };
}

/**
 * One run of edits between two unchanged items: the indices removed from the old list and added
 * from the new, and the old index of the unchanged item just before it (`null` at the start, and
 * for a multiset run, which has no place).
 */
export interface Run {
  anchor: number | null;
  removed: number[];
  added: number[];
}

/** Index lists per key, handed out in order (a cursor per key, no array shifting). */
export class Queues {
  private readonly lists = new Map<string | number, { items: number[]; next: number }>();

  push(key: string | number, index: number): void {
    const list = this.lists.get(key);
    if (list) list.items.push(index);
    else this.lists.set(key, { items: [index], next: 0 });
  }

  /** The next index queued under `key` that `free` accepts (all are, by default), or `-1`. */
  take(key: string | number, free: (index: number) => boolean = () => true): number {
    const list = this.lists.get(key);
    if (!list) return -1;
    while (list.next < list.items.length) {
      const index = list.items[list.next++]!;
      if (free(index)) return index;
    }
    return -1;
  }
}

/**
 * How `before` and `after` (item keys) differ, as runs of edits: by an LCS when it fits, else (the
 * fallback, reported as `label`) as a multiset: an item the other side also has, matched by count,
 * is unchanged wherever it sits, and the rest is one run without a place.
 */
export function alignRuns(before: readonly string[], after: readonly string[], work: Work, label: string): Run[] {
  const id = interner();
  const a = before.map(id);
  const b = after.map(id);
  const ops = lcsOps(a, b, work);
  if (ops) {
    const runs: Run[] = [];
    let run: Run | null = null;

    let i = 0;
    let j = 0;
    for (const op of ops) {
      if (op === 'same') {
        run = null;
        i++;
        j++;
        continue;
      }
      if (!run) runs.push((run = { anchor: i > 0 ? i - 1 : null, removed: [], added: [] }));
      if (op === 'del') run.removed.push(i++);
      else run.added.push(j++);
    }
    return runs;
  }
  work.fellBack(label);
  const waiting = new Queues();
  b.forEach((key, index) => waiting.push(key, index));
  const matched = new Set<number>();
  const removed: number[] = [];
  a.forEach((key, index) => {
    const partner = waiting.take(key);
    if (partner === -1) removed.push(index);
    else matched.add(partner);
  });
  const added = b.map((_, index) => index).filter((index) => !matched.has(index));
  return removed.length || added.length ? [{ anchor: null, removed, added }] : [];
}

const WHITESPACE = /^\s+$/;

/** `[del a, ins b]`, leaving out an empty side. */
function wholesale(a: string, b: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  if (a) segments.push({ op: 'del', text: a });
  if (b) segments.push({ op: 'ins', text: b });
  return segments;
}

/** `inlineDiff`, charging its cells to `work` (the diff's budget). */
export function inlineSegments(a: string, b: string, work: Work): InlineSegment[] {
  if (a === b) return a ? [{ op: 'same', text: a }] : [];
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length > DIFF_LIMITS.maxInlineWords || tb.length > DIFF_LIMITS.maxInlineWords) return wholesale(a, b);
  const id = interner();
  const ops = lcsOps(ta.map(id), tb.map(id), work);
  if (!ops) {
    work.fellBack('inline');
    return wholesale(a, b);
  }
  // Token by token, then grouped: within a group of edits (whitespace-only common text between two
  // edits belongs to the group, on both sides) deletions come first, then insertions.
  const out: InlineSegment[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === 'same') {
      let text = '';
      while (k < ops.length && ops[k] === 'same') {
        text += ta[i++];
        j++;
        k++;
      }
      out.push({ op: 'same', text });
      continue;
    }
    let del = '';
    let ins = '';
    for (;;) {
      while (k < ops.length && ops[k] !== 'same') {
        if (ops[k] === 'del') del += ta[i++];
        else ins += tb[j++];
        k++;
      }
      if (k + 1 < ops.length && ops[k] === 'same' && ops[k + 1] !== 'same' && WHITESPACE.test(ta[i]!)) {
        del += ta[i];
        ins += tb[j];
        i++;
        j++;
        k++;
        continue;
      }
      break;
    }
    out.push(...wholesale(del, ins));
  }
  return out;
}

/**
 * A word-level diff of `a` and `b`: segments that give back `a` (`same` + `del`) and `b` (`same` +
 * `ins`), adjacent ops merged, deletions before insertions within a group of edits. Over
 * `maxInlineWords` tokens on a side it answers `[del a, ins b]` (within it, an LCS always fits
 * `maxLcsCells`).
 */
export function inlineDiff(a: string, b: string): InlineSegment[] {
  return inlineSegments(a, b, new Work(Number.POSITIVE_INFINITY));
}
