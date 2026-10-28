// The region-tagged diff of two capture snapshots (spec `specs/capture.spec.ts`; acceptance
// `specs/changes-diff.feature.md`, How each part is compared, Change order, Bounds and the fallback).
import {
  CAPTURE_LIMITS,
  CAPTURE_SNAPSHOT_VERSION,
  DIFF_ENGINE_VERSION,
  DIFF_FIELDS,
  DIFF_LIMITS,
  DIFF_REGIONS,
  PAGE_REGIONS,
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
import { alignRuns, inlineSegments, Work, type DiffProbe, type Run } from './lcs';

/** SHA-256 of the empty string: the text hash of a region with no text. */
const EMPTY_TEXT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

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

/** `value`, frozen all the way down (the empty snapshot is shared; nobody may change it). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

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

  ordered(): Pending[] {
    return DIFF_REGIONS.flatMap((region) => DIFF_FIELDS.flatMap((field) => this.buckets.get(`${region}\u0000${field}`) ?? []));
  }
}

/**
 * Pairs each item of `after` with the first unpaired item of `before` with the same key (so items
 * that share a key are matched in order). Answers the partner of each `after` item (or `-1`) and the
 * `before` items left over, in order.
 */
function matchBy<T>(before: readonly T[], after: readonly T[], key: (item: T) => string): { partners: number[]; leftover: number[] } {
  const waiting = new Map<string, number[]>();
  before.forEach((item, index) => {
    const k = key(item);
    const list = waiting.get(k);
    if (list) list.push(index);
    else waiting.set(k, [index]);
  });
  const partners = after.map((item) => waiting.get(key(item))?.shift() ?? -1);
  const taken = new Set(partners);
  return { partners, leftover: before.map((_, index) => index).filter((index) => !taken.has(index)) };
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

const WORD = /[\p{L}\p{N}]+/gu;

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
    const { partners, leftover } = matchBy(old.head.hreflang, after.head.hreflang, (entry) => entry.hreflang);
    after.head.hreflang.forEach((entry, index) => {
      const was = old.head.hreflang[partners[index]!];
      if (!was) out.add('head', 'hreflang', 'added', null, entry.href, entry.hreflang);
      else if (was.href !== entry.href) out.add('head', 'hreflang', 'changed', was.href, entry.href, entry.hreflang);
    });
    for (const index of leftover) out.add('head', 'hreflang', 'removed', old.head.hreflang[index]!.href, null, old.head.hreflang[index]!.hreflang);
  }

  // HTTP.
  const text = (value: number | boolean | null) => (value === null ? null : String(value));
  scalar('http', 'status', text(old.http.status), text(after.http.status));
  out.value('http', 'x-robots-tag', old.http.xRobotsTag, after.http.xRobotsTag);
  scalar('http', 'indexable', text(old.http.indexable), text(after.http.indexable));

  // Structured data.
  setChanges(out, 'structured-data', 'structured-data-type', old.structuredData.types, after.structuredData.types);
  {
    const blocksBefore = old.structuredData.blocks;
    const blocksAfter = after.structuredData.blocks;
    const byHash = matchBy(blocksBefore, blocksAfter, (block) => block.hash);
    const looseBefore = byHash.leftover;
    const looseAfter = blocksAfter.map((_, index) => index).filter((index) => byHash.partners[index] === -1);
    // The blocks no hash matched, matched again by their type set: a pair is one edited block.
    const typed = matchBy(
      looseBefore.map((index) => blocksBefore[index]!),
      looseAfter.map((index) => blocksAfter[index]!),
      (block) => block.types.join('\u0000'),
    );
    const label = (types: readonly string[]) => types.join(', ');
    looseAfter.forEach((index, k) => {
      const block = blocksAfter[index]!;
      const partner = typed.partners[k]!;
      if (partner === -1) out.add('structured-data', 'structured-data-block', 'added', null, block.text, label(block.types));
      else out.add('structured-data', 'structured-data-block', 'changed', blocksBefore[looseBefore[partner]!]!.text, block.text, label(block.types));
    });
    for (const k of typed.leftover) {
      const block = blocksBefore[looseBefore[k]!]!;
      out.add('structured-data', 'structured-data-block', 'removed', block.text, null, label(block.types));
    }
  }

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
  return { engine: DIFF_ENGINE_VERSION, changes: kept, summary: summarize(all.map((pending) => pending.change)), changeCount: all.length, truncated: all.length > kept.length };
}

/** One page region's headings, links, text blocks and word count. */
function diffRegion(out: Changes, work: Work, region: PageRegion, old: CaptureSnapshot, now: CaptureSnapshot, first: boolean): void {
  // Headings: an LCS on (level, text); a removed and an added heading at the same place in a run, of one level, are one changed heading.
  const headingsBefore = old.headings.filter((heading) => heading.region === region);
  const headingsAfter = now.headings.filter((heading) => heading.region === region);
  const headingKey = (heading: { level: number; text: string }) => `${heading.level}\u0000${heading.text}`;
  for (const run of alignRuns(headingsBefore.map(headingKey), headingsAfter.map(headingKey), work, `heading:${region}`)) {
    const pairs = new Map<number, number>();
    for (let k = 0; k < Math.min(run.removed.length, run.added.length); k++) {
      if (headingsBefore[run.removed[k]!]!.level === headingsAfter[run.added[k]!]!.level) pairs.set(run.removed[k]!, run.added[k]!);
    }
    walkRun(run, pairs, (kind, removed, added) => {
      const was = removed === null ? null : headingsBefore[removed]!;
      const is = added === null ? null : headingsAfter[added]!;
      out.add(region, 'heading', kind, was?.text ?? null, is?.text ?? null, `h${(is ?? was)!.level}`);
    });
  }

  // Links: a multiset by href.
  const linksBefore = old.links.list.filter((link) => link.region === region);
  const linksAfter = now.links.list.filter((link) => link.region === region);
  const describe = (link: { text: string; rel: string }) => (link.rel ? `${link.text} (rel=${link.rel})` : link.text);
  const { partners, leftover } = matchBy(linksBefore, linksAfter, (link) => link.href);
  linksAfter.forEach((link, index) => {
    const was = linksBefore[partners[index]!];
    if (!was) out.add(region, 'link', 'added', null, describe(link), link.href);
    else if (was.text !== link.text || was.rel !== link.rel) out.add(region, 'link', 'changed', describe(was), describe(link), link.href);
  });
  for (const index of leftover) out.add(region, 'link', 'removed', describe(linksBefore[index]!), null, linksBefore[index]!.href);

  // Text blocks: an LCS on exact strings, similar blocks in a run paired as edits.
  const blocksBefore = old.regions[region].blocks;
  const blocksAfter = now.regions[region].blocks;
  const wordSets = new Map<string, Set<string>>();
  const wordsOf = (block: string) => {
    let set = wordSets.get(block);
    if (!set) wordSets.set(block, (set = new Set(block.toLowerCase().match(WORD) ?? [])));
    return set;
  };
  for (const run of alignRuns(blocksBefore, blocksAfter, work, `text:${region}`)) {
    // Greedy, in order: each removed block takes the first later unpaired added block similar enough.
    // The words compared count against the run's LCS cap and the diff's budget; once refused, the
    // rest of the run stays removed and added.
    const pairs = new Map<number, number>();
    let runWork = 0;
    let next = 0;
    let stopped = false;
    for (const removed of run.removed) {
      if (stopped) break;
      const a = wordsOf(blocksBefore[removed]!);
      for (let k = next; k < run.added.length; k++) {
        const b = wordsOf(blocksAfter[run.added[k]!]!);
        const cost = a.size + b.size + 1; // never free, so blocks without words still use up the cap
        if (runWork + cost > DIFF_LIMITS.maxLcsCells || !work.take(cost)) {
          work.fellBack(`pairing:${region}`);
          stopped = true;
          break;
        }
        runWork += cost;
        if (jaccard(a, b) >= DIFF_LIMITS.similarity) {
          pairs.set(removed, run.added[k]!);
          next = k + 1;
          break;
        }
      }
    }
    const context = run.anchor === null ? null : cut(blocksBefore[run.anchor]!, DIFF_LIMITS.contextChars);
    walkRun(run, pairs, (kind, removed, added) => {
      const was = removed === null ? null : blocksBefore[removed]!;
      const is = added === null ? null : blocksAfter[added]!;
      out.add(region, 'text', kind, was, is, context, kind === 'changed' ? [was!, is!] : undefined);
    });
  }

  const words = [old.regions[region].words, now.regions[region].words] as const;
  if (words[0] !== words[1]) out.add(region, 'words', first ? 'added' : 'changed', first ? null : String(words[0]), String(words[1]));
}

/** The Jaccard index of two word sets (0 when both are empty). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Counts of each kind of change per diff region (every region present). */
export function summarize(changes: readonly Change[]): Record<DiffRegion, ChangeCounts> {
  const summary = Object.fromEntries(DIFF_REGIONS.map((region) => [region, { added: 0, removed: 0, changed: 0 }])) as Record<DiffRegion, ChangeCounts>;
  for (const change of changes) summary[change.region][change.kind] += 1;
  return summary;
}
