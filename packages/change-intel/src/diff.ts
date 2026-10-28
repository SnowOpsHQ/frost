// The region-tagged diff of two capture snapshots (spec `specs/capture.spec.ts`; acceptance
// `specs/changes-diff.feature.md`, How each part is compared, Partial snapshots, Change order,
// Bounds and the fallback).
import {
  CAPTURE_LIMITS,
  CAPTURE_SNAPSHOT_VERSION,
  DIFF_ENGINE_VERSION,
  DIFF_FIELDS,
  DIFF_LIMITS,
  DIFF_REGIONS,
  PAGE_REGIONS,
  type CaptureJsonLdBlock,
  type CaptureSnapshot,
  type Change,
  type ChangeCounts,
  type ChangeKind,
  type DiffField,
  type DiffRegion,
  type PageRegion,
  type SnapshotDiff,
  type TotalCounter,
} from '@app/specs/capture.spec';
import { alignRuns, inlineSegments, Queues, Work, type DiffProbe, type Run } from './lcs';
import { jaccard, wordSet } from './tokens';

/** SHA-256 of the empty string: the text hash of a region with no text. */
const EMPTY_TEXT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** `value`, frozen all the way down (the empty snapshot is shared; nobody may change it). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * The snapshot a first version is diffed against (`diffSnapshots(null, …)`): no tags, no lists,
 * nothing counted, every region empty. It is not a page (its `url` is empty), so it never parses as
 * one and is never stored.
 */
export const EMPTY_CAPTURE_SNAPSHOT: CaptureSnapshot = deepFreeze({
  version: CAPTURE_SNAPSHOT_VERSION,
  url: '',
  takenAt: 0,
  partial: false,
  http: { status: null, xRobotsTag: null, indexable: false },
  head: { title: null, metaDescription: null, canonical: null, robotsMeta: null, lang: null, viewport: null, ogTitle: null, ogDescription: null, ogImage: null, hreflang: [] },
  audit: { score: 0, findings: [] },
  structuredData: { types: [], blocks: [] },
  headings: [],
  links: { total: 0, internal: 0, external: 0, nofollow: 0, list: [] },
  images: { total: 0, missingAlt: 0 },
  regions: Object.fromEntries(PAGE_REGIONS.map((region) => [region, { words: 0, textHash: EMPTY_TEXT_HASH, blocks: [] as string[], truncated: false }])) as CaptureSnapshot['regions'],
});

/** `text` cut to `max` UTF-16 units, ending in `…` when cut, never splitting a surrogate pair. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A change on its way out: its inline segments are worked out only if it is kept. */
interface Pending {
  change: Change;
  inline?: [string, string];
}

/** Collects changes by region and field, so they come out in change order whatever order they were found in. */
class Changes {
  private readonly buckets = new Map<string, Pending[]>();

  add(region: DiffRegion, field: DiffField, kind: ChangeKind, before: string | null, after: string | null, context: string | null = null, inline?: [string, string]): void {
    const change: Change = {
      region,
      field,
      kind,
      before: before === null ? null : cut(before, DIFF_LIMITS.maxChangeTextChars),
      after: after === null ? null : cut(after, DIFF_LIMITS.maxChangeTextChars),
      context: context === null ? null : cut(context, CAPTURE_LIMITS.maxUrlChars),
    };
    const key = `${region}\u0000${field}`;
    const bucket = this.buckets.get(key);
    const pending: Pending = inline ? { change, inline } : { change };
    if (bucket) bucket.push(pending);
    else this.buckets.set(key, [pending]);
  }

  /** A value compared by value: `null` → value is added, value → `null` removed, else changed. */
  value(region: DiffRegion, field: DiffField, before: string | null, after: string | null, context: string | null = null): void {
    if (before === after) return;
    this.add(region, field, before === null ? 'added' : after === null ? 'removed' : 'changed', before, after, context);
  }

  has(region: DiffRegion, field: DiffField): boolean {
    return this.buckets.has(`${region}\u0000${field}`);
  }

  ordered(): Pending[] {
    return DIFF_REGIONS.flatMap((region) => DIFF_FIELDS.flatMap((field) => this.buckets.get(`${region}\u0000${field}`) ?? []));
  }
}

/**
 * Matches `after`'s items to `before`'s: equal items first (`exact`, as many as both sides have),
 * then the rest by `key`, each in order. Answers each `after` item's partner (or `-1`) and whether
 * it is an exact one, and the `before` items left over, in order.
 */
function match<T>(before: readonly T[], after: readonly T[], exact: (item: T) => string, key: (item: T) => string): { partners: number[]; exactly: boolean[]; leftover: number[] } {
  const partners = after.map(() => -1);
  const exactly = after.map(() => false);
  const used = new Set<number>();
  const equal = new Queues();
  before.forEach((item, index) => equal.push(exact(item), index));
  after.forEach((item, index) => {
    const partner = equal.take(exact(item));
    if (partner === -1) return;
    partners[index] = partner;
    exactly[index] = true;
    used.add(partner);
  });
  const similar = new Queues();
  before.forEach((item, index) => {
    if (!used.has(index)) similar.push(key(item), index);
  });
  after.forEach((item, index) => {
    if (partners[index] !== -1) return;
    const partner = similar.take(key(item));
    if (partner === -1) return;
    partners[index] = partner;
    used.add(partner);
  });
  return { partners, exactly, leftover: before.map((_, index) => index).filter((index) => !used.has(index)) };
}

/**
 * The old items not to report as removed when the new side was cut short (`cutShort`): of the
 * unmatched old items (`unmatched`, indices into a list of `length`), those after the last old item
 * that is matched. Empty when the new side is complete.
 */
function cutTail(cutShort: boolean, length: number, unmatched: ReadonlySet<number>): Set<number> {
  if (!cutShort) return new Set();
  let lastMatched = length - 1;
  while (lastMatched >= 0 && unmatched.has(lastMatched)) lastMatched--;
  return new Set([...unmatched].filter((index) => index > lastMatched));
}

/** Adds `after`'s items that `before` lacks, then `before`'s that `after` lacks (sets of strings). */
function setChanges(out: Changes, region: DiffRegion, field: DiffField, before: readonly string[], after: readonly string[]): void {
  const old = new Set(before);
  const now = new Set(after);
  for (const item of after) if (!old.has(item)) out.add(region, field, 'added', null, item);
  for (const item of before) if (!now.has(item)) out.add(region, field, 'removed', item, null);
}

/**
 * Walks one run of edits in order: a removed item in place; a pair (`pairs` maps a removed index to
 * an added one, in increasing order) where its removed item is, after any added items before its
 * partner; the remaining added items at the end.
 */
function walkRun(run: Run, pairs: ReadonlyMap<number, number>, emit: (kind: ChangeKind, removed: number | null, added: number | null) => void): void {
  let next = 0;
  for (const removed of run.removed) {
    const partner = pairs.get(removed);
    if (partner === undefined) {
      emit('removed', removed, null);
      continue;
    }
    while (run.added[next] !== partner) emit('added', null, run.added[next++]!);
    next++;
    emit('changed', removed, partner);
  }
  while (next < run.added.length) emit('added', null, run.added[next++]!);
}

/** The removed items of `runs` that `pairs` leaves unpaired. */
function unpaired(runs: readonly Run[], pairs: ReadonlyMap<number, number>): Set<number> {
  return new Set(runs.flatMap((run) => run.removed.filter((index) => !pairs.has(index))));
}

/** The diff of two snapshots, with every bound applied; `probe` (tests) learns the work done. */
export function diffSnapshots(before: CaptureSnapshot | null, after: CaptureSnapshot, probe?: DiffProbe): SnapshotDiff {
  const first = before === null;
  const old = before ?? EMPTY_CAPTURE_SNAPSHOT;
  const work = new Work(DIFF_LIMITS.maxWorkCells, probe);
  const out = new Changes();
  /** A scalar of `after`: on a first version it is new whatever the empty snapshot says. */
  const scalar = (region: DiffRegion, field: DiffField, was: string | null, now: string | null, context: string | null = null) => out.value(region, field, first ? null : was, now, context);

  // Head.
  const head: [DiffField, keyof Omit<CaptureSnapshot['head'], 'hreflang'>][] = [
    ['title', 'title'],
    ['meta-description', 'metaDescription'],
    ['canonical', 'canonical'],
    ['robots-meta', 'robotsMeta'],
    ['lang', 'lang'],
    ['viewport', 'viewport'],
    ['og-title', 'ogTitle'],
    ['og-description', 'ogDescription'],
    ['og-image', 'ogImage'],
  ];
  for (const [field, key] of head) out.value('head', field, old.head[key], after.head[key]);
  {
    const was = old.head.hreflang;
    const { partners, exactly, leftover } = match(was, after.head.hreflang, (entry) => `${entry.hreflang}\u0000${entry.href}`, (entry) => entry.hreflang);
    after.head.hreflang.forEach((entry, index) => {
      if (exactly[index]) return;
      const partner = partners[index]!;
      if (partner === -1) out.add('head', 'hreflang', 'added', null, entry.href, entry.hreflang);
      else out.add('head', 'hreflang', 'changed', was[partner]!.href, entry.href, entry.hreflang);
    });
    for (const index of leftover) out.add('head', 'hreflang', 'removed', was[index]!.href, null, was[index]!.hreflang);
  }

  // HTTP.
  const text = (value: number | boolean | null) => (value === null ? null : String(value));
  scalar('http', 'status', text(old.http.status), text(after.http.status));
  out.value('http', 'x-robots-tag', old.http.xRobotsTag, after.http.xRobotsTag);
  scalar('http', 'indexable', text(old.http.indexable), text(after.http.indexable));

  // Structured data.
  setChanges(out, 'structured-data', 'structured-data-type', old.structuredData.types, after.structuredData.types);
  diffJsonLd(out, work, old.structuredData.blocks, after.structuredData.blocks);

  // Page regions, in change order, so the budget reaches the main content first.
  for (const region of PAGE_REGIONS) diffRegion(out, work, region, old, after, first);

  // Audit.
  scalar('audit', 'score', String(old.audit.score), String(after.audit.score));
  setChanges(out, 'audit', 'finding', old.audit.findings, after.audit.findings);
  const totals: [DiffField, TotalCounter, number, number][] = [
    ['images', 'total', old.images.total, after.images.total],
    ['images', 'missing-alt', old.images.missingAlt, after.images.missingAlt],
    ['links-total', 'total', old.links.total, after.links.total],
    ['links-total', 'internal', old.links.internal, after.links.internal],
    ['links-total', 'external', old.links.external, after.links.external],
    ['links-total', 'nofollow', old.links.nofollow, after.links.nofollow],
  ];
  for (const [field, counter, was, now] of totals) scalar('audit', field, String(was), String(now), counter);

  // Count everything, keep the first `maxChanges`, and only then spend work on their inline segments.
  const all = out.ordered();
  const kept = all.slice(0, DIFF_LIMITS.maxChanges).map(({ change, inline }) => {
    if (!inline) return change;
    const [a, b] = inline;
    if (a.length > DIFF_LIMITS.maxChangeTextChars || b.length > DIFF_LIMITS.maxChangeTextChars) return change;
    const segments = inlineSegments(a, b, work);
    return segments.length ? { ...change, segments } : change;
  });
  const partial = old.partial || after.partial || PAGE_REGIONS.some((region) => old.regions[region].truncated || after.regions[region].truncated);
  return {
    engine: DIFF_ENGINE_VERSION,
    changes: kept,
    summary: summarize(all.map((pending) => pending.change)),
    changeCount: all.length,
    truncated: all.length > kept.length,
    partial,
  };
}

/**
 * JSON-LD blocks: equal blocks match first; the rest, grouped by type set, pair each new block with
 * the most similar old one of its group (the earliest on a tie; in order once the budget is spent).
 */
function diffJsonLd(out: Changes, work: Work, before: readonly CaptureJsonLdBlock[], after: readonly CaptureJsonLdBlock[]): void {
  const types = (block: CaptureJsonLdBlock) => block.types.join('\u0000');
  const equal = new Queues();
  before.forEach((block, index) => equal.push(`${block.hash}\u0000${types(block)}\u0000${block.text}`, index));
  const exact = after.map((block) => equal.take(`${block.hash}\u0000${types(block)}\u0000${block.text}`));
  const taken = new Set(exact.filter((partner) => partner !== -1));
  const label = (block: CaptureJsonLdBlock) => block.types.join(', ');
  const wordsBefore = new Map<number, Set<string>>();
  let budget = true;
  after.forEach((block, index) => {
    if (exact[index] !== -1) return;
    let best = -1;
    let bestScore = -1;
    const words = wordSet(block.text);
    before.forEach((candidate, k) => {
      if (taken.has(k) || types(candidate) !== types(block)) return;
      if (budget) {
        if (!wordsBefore.has(k)) wordsBefore.set(k, wordSet(candidate.text));
        const { index: score, cost } = jaccard(words, wordsBefore.get(k)!);
        if (work.take(cost)) {
          if (score > bestScore) [best, bestScore] = [k, score];
          return;
        }
        work.fellBack('structured-data');
        budget = false;
      }
      if (best === -1) best = k;
    });
    if (best === -1) return out.add('structured-data', 'structured-data-block', 'added', null, block.text, label(block));
    taken.add(best);
    out.add('structured-data', 'structured-data-block', 'changed', before[best]!.text, block.text, label(block));
  });
  before.forEach((block, index) => {
    if (!taken.has(index)) out.add('structured-data', 'structured-data-block', 'removed', block.text, null, label(block));
  });
}

/**
 * Pairs one run's removed blocks with its added ones, greedily in order: each removed block takes
 * the first later unpaired added block whose word set's Jaccard index with its own is at least
 * `similarity`. Candidates come from an index of the run's added blocks by word, so a block sharing
 * no word costs only its own size. Each removed block costs its word count plus the postings it
 * visits, against the run's `maxLcsCells` and the diff's budget; once refused, the rest stays unpaired.
 */
function pairBlocks(run: Run, before: readonly string[], after: readonly string[], wordsOf: (block: string) => Set<string>, work: Work, region: PageRegion): Map<number, number> {
  const pairs = new Map<number, number>();
  if (!run.removed.length || !run.added.length) return pairs;
  const postings = new Map<string, number[]>();
  run.added.forEach((index, k) => {
    for (const word of wordsOf(after[index]!)) {
      const list = postings.get(word);
      if (list) list.push(k);
      else postings.set(word, [k]);
    }
  });
  /** The first position in `list` (ascending) at or after `from`. */
  const from = (list: readonly number[], start: number) => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle]! < start) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let next = 0;
  let spent = 0;
  const shared = new Map<number, number>();
  for (const removed of run.removed) {
    if (next >= run.added.length) break;
    const words = wordsOf(before[removed]!);
    let cost = words.size + 1;
    for (const word of words) {
      const list = postings.get(word);
      if (list) cost += list.length - from(list, next);
    }
    if (spent + cost > DIFF_LIMITS.maxLcsCells || !work.take(cost)) {
      work.fellBack(`pairing:${region}`);
      break;
    }
    spent += cost;
    shared.clear();
    for (const word of words) {
      const list = postings.get(word);
      if (!list) continue;
      for (let p = from(list, next); p < list.length; p++) shared.set(list[p]!, (shared.get(list[p]!) ?? 0) + 1);
    }
    let best = -1;
    for (const [k, count] of shared) {
      if (best !== -1 && k >= best) continue;
      if (count / (words.size + wordsOf(after[run.added[k]!]!).size - count) >= DIFF_LIMITS.similarity) best = k;
    }
    if (best === -1) continue;
    pairs.set(removed, run.added[best]!);
    next = best + 1;
  }
  return pairs;
}

/** One page region's headings, links, text blocks, word count and text hash. */
function diffRegion(out: Changes, work: Work, region: PageRegion, old: CaptureSnapshot, now: CaptureSnapshot, first: boolean): void {
  // Headings: an LCS on (level, text); a removed and an added heading at the same place in a run, of one level, are one changed heading.
  const headingsBefore = old.headings.filter((heading) => heading.region === region);
  const headingsAfter = now.headings.filter((heading) => heading.region === region);
  const headingKey = (heading: { level: number; text: string }) => `${heading.level}\u0000${heading.text}`;
  const headingRuns = alignRuns(headingsBefore.map(headingKey), headingsAfter.map(headingKey), work, `heading:${region}`);
  const headingPairs = new Map<number, number>();
  for (const run of headingRuns) {
    for (let k = 0; k < Math.min(run.removed.length, run.added.length); k++) {
      if (headingsBefore[run.removed[k]!]!.level === headingsAfter[run.added[k]!]!.level) headingPairs.set(run.removed[k]!, run.added[k]!);
    }
  }
  const headingsCut = cutTail(now.partial || now.headings.length >= CAPTURE_LIMITS.maxHeadings, headingsBefore.length, unpaired(headingRuns, headingPairs));
  for (const run of headingRuns) {
    walkRun(run, headingPairs, (kind, removed, added) => {
      if (kind === 'removed' && headingsCut.has(removed!)) return;
      const was = removed === null ? null : headingsBefore[removed]!;
      const is = added === null ? null : headingsAfter[added]!;
      out.add(region, 'heading', kind, was?.text ?? null, is?.text ?? null, `h${(is ?? was)!.level}`);
    });
  }

  // Links: a multiset; equal links first, then by href.
  const linksBefore = old.links.list.filter((link) => link.region === region);
  const linksAfter = now.links.list.filter((link) => link.region === region);
  const describe = (link: { text: string; rel: string }) => (link.rel ? `${link.text} (rel=${link.rel})` : link.text);
  const { partners, exactly, leftover } = match(linksBefore, linksAfter, (link) => `${link.href}\u0000${link.text}\u0000${link.rel}`, (link) => link.href);
  linksAfter.forEach((link, index) => {
    if (exactly[index]) return;
    const was = linksBefore[partners[index]!];
    if (!was) out.add(region, 'link', 'added', null, describe(link), link.href);
    else out.add(region, 'link', 'changed', describe(was), describe(link), link.href);
  });
  const linksCut = cutTail(now.partial || now.links.list.length >= CAPTURE_LIMITS.maxLinks, linksBefore.length, new Set(leftover));
  for (const index of leftover) if (!linksCut.has(index)) out.add(region, 'link', 'removed', describe(linksBefore[index]!), null, linksBefore[index]!.href);

  // Text blocks: an LCS on exact strings, similar blocks in a run paired as edits.
  const blocksBefore = old.regions[region].blocks;
  const blocksAfter = now.regions[region].blocks;
  const wordSets = new Map<string, Set<string>>();
  const wordsOf = (block: string) => {
    let set = wordSets.get(block);
    if (!set) wordSets.set(block, (set = wordSet(block)));
    return set;
  };
  const textRuns = alignRuns(blocksBefore, blocksAfter, work, `text:${region}`);
  const textPairs = new Map<number, number>();
  for (const run of textRuns) for (const [removed, added] of pairBlocks(run, blocksBefore, blocksAfter, wordsOf, work, region)) textPairs.set(removed, added);
  const textCut = cutTail(now.partial || now.regions[region].truncated, blocksBefore.length, unpaired(textRuns, textPairs));
  for (const run of textRuns) {
    const context = run.anchor === null ? null : cut(blocksBefore[run.anchor]!, DIFF_LIMITS.contextChars);
    walkRun(run, textPairs, (kind, removed, added) => {
      if (kind === 'removed' && textCut.has(removed!)) return;
      const was = removed === null ? null : blocksBefore[removed]!;
      const is = added === null ? null : blocksAfter[added]!;
      out.add(region, 'text', kind, was, is, context, kind === 'changed' ? [was!, is!] : undefined);
    });
  }

  const words = [old.regions[region].words, now.regions[region].words] as const;
  if (words[0] !== words[1]) out.add(region, 'words', first ? 'added' : 'changed', first ? null : String(words[0]), String(words[1]));
  // A text hash that moved while no kept block did (or only blocks the cut side cannot vouch for).
  const hashes = [old.regions[region].textHash, now.regions[region].textHash] as const;
  if (hashes[0] !== hashes[1] && !out.has(region, 'text')) out.add(region, 'hidden-text', first ? 'added' : 'changed', first ? null : hashes[0].slice(0, 12), hashes[1].slice(0, 12));
}

/** Counts of each kind of change per diff region (every region present). */
export function summarize(changes: readonly Change[]): Record<DiffRegion, ChangeCounts> {
  const summary = Object.fromEntries(DIFF_REGIONS.map((region) => [region, { added: 0, removed: 0, changed: 0 }])) as Record<DiffRegion, ChangeCounts>;
  for (const change of changes) summary[change.region][change.kind] += 1;
  return summary;
}
