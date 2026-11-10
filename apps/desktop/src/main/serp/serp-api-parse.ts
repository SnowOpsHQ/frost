import {
  DATAFORSEO_TASK_OK,
  SERP_API_LIMITS,
  SERP_API_METADATA_KEYS,
  SERP_API_TYPE_MAP,
  SERPAPI_EMPTY_STATE,
  SERPAPI_STATUS_OK,
  type SerpApiProvider,
} from '@app/specs/serp-api.spec';
import {
  DataForSeoElementSchema,
  DataForSeoResponseSchema,
  SerpApiJobSchema,
  SerpApiResponseSchema,
  SerperResponseSchema,
  type DataForSeoElement,
  type SerpApiJobResult,
} from '@app/specs/serp-api.schema';
import type { SerpResultType } from '@app/specs/serp-selector-pack.spec';
import type { SerpRead, SerpReadBlock, SerpReadItem } from '@app/specs/serp-snapshot.schema';
import { SERP_READ_LIMITS } from '@app/specs/serp.spec';
import { analyseSerp } from './serp-analyse';

// A data API's answer → `SerpRead` → `SerpSnapshot` (Phase 12 Task 3; spec `serp-api.spec.ts`,
// `serp-api.schema.ts`; plan Decision 7, Global constraints "Untrusted text", Threat model "Hostile
// vendor JSON"). Pure, and run only in the SERP worker (`serp-worker.ts`, job kind `api`), never on
// Electron's main thread. Never throws.
// 1. The job is validated (`SerpApiJobSchema`); the answer's size (`maxResponseBytes`, UTF-8) and
//    nesting (`maxDepth`, counted on the text, strings skipped) are checked **before** `JSON.parse`.
// 2. The JSON is validated with the vendor's schema: picked fields strictly typed and capped; each
//    vendor result type goes through `SERP_API_TYPE_MAP` (an unmapped one is skipped and counted).
// 3. The blocks, in the vendor's page order (DataForSEO's `rank_absolute`; SerpApi's and Serper's
//    sections in the map's key order, SerpApi's bottom ads last), form a `SerpRead`: titles collapsed
//    and cut as the reader cuts them, links kept only as absolute `http(s)` URLs within the reader's
//    cap, past `maxResults` results or `maxBlocks` blocks cut from the bottom (`truncated`).
// 4. K-A1: the organic results' own vendor ranks, in page order, must be 1 … n, so the positions
//    `analyseSerp` derives equal them; otherwise the answer is refused. An answer without the
//    vendor's organic container (`SERP_API_ORGANIC_CONTAINER`) is refused too, so an error or empty
//    body never becomes a false "not ranking" point; the vendor's own error answers are
//    `vendorError`. An ad without a web link is dropped and counted as skipped.
// 5. `analyseSerp` derives ranks, positions, composition and ownership exactly as for a tab.
// Any problem is `invalid-answer` (DataForSEO's task failing is `vendorError` as well).

const L = SERP_API_LIMITS;
const R = SERP_READ_LIMITS;

type Item = SerpReadItem;

/** One mapped section: its frost type, its items, and (organic only) the vendor's rank of each. */
interface Section {
  readonly type: SerpResultType;
  readonly items: readonly Item[];
  readonly ranks?: readonly number[];
  /** Joined with a directly preceding section of the same type (DataForSEO: one element per local pack place). */
  readonly join?: boolean;
}

/** What a vendor mapper answers: sections in page order and the types skipped; `invalid` or `vendor-error` otherwise. */
type Mapped =
  | { readonly ok: true; readonly sections: readonly Section[]; readonly skipped: number; /** The vendor's organic container is present (or says the page was empty). */ readonly container: boolean }
  | { readonly ok: false; readonly vendorError: boolean };

const VENDOR_ERROR: Mapped = { ok: false, vendorError: true };

const INVALID: Mapped = { ok: false, vendorError: false };

/** Whether no array or object in the JSON text nests deeper than `max` (strings skipped). */
export function withinDepth(text: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i += 1;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      depth += 1;
      if (depth > max) return false;
    } else if (c === 0x7d || c === 0x5d) depth -= 1;
  }
  return true;
}

/** `s` cut to at most `max` UTF-16 code units, never splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = max - (/[\ud800-\udbff]/.test(s.charAt(max - 1)) ? 1 : 0);
  return s.slice(0, end);
}

/** A title as the reader keeps it: whitespace collapsed, trimmed, cut to `maxTitleChars`. */
const title = (value: string | null | undefined): string => (typeof value === 'string' ? cut(value.replace(/\s+/g, ' ').trim(), R.maxTitleChars) : '');

const URL_SHAPE = /^https?:\/\/[^\u0000- \u007f]+$/;

/** An absolute `http:` / `https:` URL in its serialised form within the reader's cap, or `null`. */
function link(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.href.length > R.maxUrlChars || !URL_SHAPE.test(url.href)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** An item with a title or a link, or `null` (nothing to show). */
function item(text: string | null | undefined, url: string | null | undefined): Item | null {
  const out = { title: title(text), url: link(url) };
  return out.title === '' && out.url === null ? null : out;
}

const items = (list: readonly (Item | null)[]): Item[] => list.filter((entry): entry is Item => entry !== null);

/** `list` by its vendor rank when every entry has one (stable), else in the array's order. */
function byRank<T>(list: readonly T[], rank: (entry: T) => number | null | undefined): T[] {
  if (!list.every((entry) => typeof rank(entry) === 'number')) return [...list];
  return list
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry)! - rank(b.entry)! || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Top-level keys that are neither mapped nor metadata: the result types skipped. */
function skippedKeys(json: Record<string, unknown>, provider: 'serpapi' | 'serper'): number {
  const map = SERP_API_TYPE_MAP[provider];
  const metadata: readonly string[] = SERP_API_METADATA_KEYS[provider];
  return Object.keys(json).filter((key) => !Object.prototype.hasOwnProperty.call(map, key) && !metadata.includes(key)).length;
}

/** The organic section of `entries` (each with a vendor rank and a link): `null` when a link is not a web URL. */
function organic<T extends { readonly position: number; readonly title?: string | null | undefined; readonly link: string }>(entries: readonly T[]): Section | null {
  const sorted = byRank(entries, (entry) => entry.position);
  const out: Item[] = [];
  for (const entry of sorted) {
    const url = link(entry.link);
    if (url === null) return null;
    out.push({ title: title(entry.title), url });
  }
  return { type: 'organic', items: out, ranks: sorted.map((entry) => entry.position) };
}

function mapSerpApi(json: unknown): Mapped {
  const parsed = SerpApiResponseSchema.safeParse(json);
  if (!parsed.success) return INVALID;
  const data = parsed.data;
  // SerpApi's own error answers.
  if (data.error !== undefined || (data.search_metadata !== undefined && data.search_metadata.status !== SERPAPI_STATUS_OK)) return VENDOR_ERROR;
  const sections: Section[] = [];
  const add = (type: SerpResultType, list: readonly (Item | null)[]) => sections.push({ type, items: items(list) });
  // Ads without a web link are dropped and counted.
  const allAds = byRank(data.ads ?? [], (ad) => ad.position);
  const ads = allAds.filter((ad) => link(ad.link) !== null);
  let skipped = allAds.length - ads.length;
  for (const key of Object.keys(SERP_API_TYPE_MAP.serpapi)) {
    switch (key) {
      case 'ads':
        add('ad', ads.filter((ad) => ad.block_position !== 'bottom').map((ad) => item(ad.title, ad.link)));
        break;
      case 'ai_overview':
        add('ai-overview', (data.ai_overview?.references ?? []).map((ref) => item(ref.title, ref.link)));
        break;
      case 'answer_box':
        if (data.answer_box) add('featured-snippet', [item(data.answer_box.title, data.answer_box.link)]);
        break;
      case 'knowledge_graph':
        if (data.knowledge_graph) add('knowledge-panel', [item(data.knowledge_graph.title, data.knowledge_graph.website)]);
        break;
      case 'local_results': {
        const local = data.local_results;
        const places = local === undefined ? [] : Array.isArray(local) ? local : (local.places ?? []);
        add('local-pack', byRank(places, (place) => place.position).map((place) => item(place.title, place.links?.website)));
        break;
      }
      case 'top_stories': {
        const stories = data.top_stories;
        const list = stories === undefined ? [] : Array.isArray(stories) ? stories : Object.values(stories).flat();
        add('top-stories', list.slice(0, L.maxItems).map((story) => item(story.title, story.link)));
        break;
      }
      case 'organic_results': {
        const section = organic(data.organic_results ?? []);
        if (section === null) return INVALID;
        sections.push(section);
        break;
      }
      case 'related_questions':
        add('people-also-ask', (data.related_questions ?? []).map((question) => item(question.question, question.link)));
        break;
      case 'inline_videos':
        add('video', byRank(data.inline_videos ?? [], (video) => video.position).map((video) => item(video.title, video.link)));
        break;
      case 'related_searches':
        add('related-searches', (data.related_searches ?? []).map((search) => item(search.query, search.link)));
        break;
      default:
        return INVALID;
    }
  }
  // Ads shown below the results come last.
  add('ad', ads.filter((ad) => ad.block_position === 'bottom').map((ad) => item(ad.title, ad.link)));
  skipped += skippedKeys(json as Record<string, unknown>, 'serpapi');
  const container = data.organic_results !== undefined || SERPAPI_EMPTY_STATE.test(data.search_information?.organic_results_state ?? '');
  return { ok: true, sections, skipped, container };
}

function mapSerper(json: unknown): Mapped {
  const parsed = SerperResponseSchema.safeParse(json);
  if (!parsed.success) return INVALID;
  const data = parsed.data;
  // An error answer: a `message` and no organic results.
  if (data.organic === undefined && data.message !== undefined) return VENDOR_ERROR;
  const sections: Section[] = [];
  const add = (type: SerpResultType, list: readonly (Item | null)[]) => sections.push({ type, items: items(list) });
  for (const key of Object.keys(SERP_API_TYPE_MAP.serper)) {
    switch (key) {
      case 'knowledgeGraph':
        if (data.knowledgeGraph) add('knowledge-panel', [item(data.knowledgeGraph.title, null)]);
        break;
      case 'organic': {
        const section = organic(data.organic ?? []);
        if (section === null) return INVALID;
        sections.push(section);
        break;
      }
      case 'peopleAlsoAsk':
        add('people-also-ask', (data.peopleAlsoAsk ?? []).map((question) => item(question.question ?? question.title, question.link)));
        break;
      case 'relatedSearches':
        add('related-searches', (data.relatedSearches ?? []).map((search) => item(search.query, null)));
        break;
      default:
        return INVALID;
    }
  }
  return { ok: true, sections, skipped: skippedKeys(json as Record<string, unknown>, 'serper'), container: data.organic !== undefined };
}

/** A DataForSEO element's items: AI overviews their references; others their nested items, or themselves. */
function dataForSeoItems(element: DataForSeoElement): (Item | null)[] {
  if (element.type === 'ai_overview') return (element.references ?? []).map((ref) => item(ref.title, ref.url));
  const children = element.items ?? [];
  if (children.length > 0) return children.map((child) => (typeof child === 'string' ? item(child, null) : item(child.title ?? child.alt, child.url)));
  return [item(element.title, element.url)];
}

function mapDataForSeo(json: unknown): Mapped {
  const parsed = DataForSeoResponseSchema.safeParse(json);
  if (!parsed.success) return INVALID;
  const task = parsed.data.tasks[0]!;
  if (parsed.data.status_code !== DATAFORSEO_TASK_OK || task.status_code !== DATAFORSEO_TASK_OK) return VENDOR_ERROR;
  const list = task.result?.[0]?.items;
  const map = SERP_API_TYPE_MAP.dataforseo;
  let skipped = 0;
  const elements: { readonly type: SerpResultType; readonly element: DataForSeoElement }[] = [];
  for (const raw of list ?? []) {
    if (!Object.prototype.hasOwnProperty.call(map, raw.type)) {
      skipped += 1;
      continue;
    }
    const element = DataForSeoElementSchema.safeParse(raw);
    if (!element.success) return INVALID;
    elements.push({ type: map[raw.type]!, element: element.data });
  }
  const sections: Section[] = [];
  for (const { type, element } of byRank(elements, (entry) => entry.element.rank_absolute)) {
    if (type === 'organic') {
      const url = link(element.url);
      if (url === null) return INVALID;
      sections.push({ type, items: [{ title: title(element.title), url }], ranks: [element.rank_group] });
    } else if (type === 'ad') {
      // An ad without a web link is dropped and counted.
      const url = link(element.url);
      if (url === null) skipped += 1;
      else sections.push({ type, items: [{ title: title(element.title), url }] });
    } else sections.push({ type, items: items(dataForSeoItems(element)), join: true });
  }
  return { ok: true, sections, skipped, container: Array.isArray(list) };
}

const MAPPERS: Readonly<Record<SerpApiProvider, (json: unknown) => Mapped>> = { serpapi: mapSerpApi, dataforseo: mapDataForSeo, serper: mapSerper };

/**
 * Sections → the reader's blocks: empty ones dropped, consecutive organic results and ads joined (and
 * consecutive DataForSEO elements of one feature type, `join`), cut at the reader's caps.
 */
function blocksOf(sections: readonly Section[]): { blocks: SerpReadBlock[]; truncated: boolean; organicCut: boolean } {
  const joined: { type: SerpResultType; items: Item[] }[] = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    const last = joined.at(-1);
    if (last && last.type === section.type && (section.type === 'organic' || section.type === 'ad' || section.join === true)) last.items.push(...section.items);
    else joined.push({ type: section.type, items: [...section.items] });
  }
  const blocks: SerpReadBlock[] = [];
  let total = 0;
  let truncated = false;
  let organicCut = false;
  for (const block of joined) {
    const room = blocks.length < R.maxBlocks ? R.maxResults - total : 0;
    const kept = block.items.slice(0, Math.max(0, room));
    if (kept.length < block.items.length) {
      truncated = true;
      if (block.type === 'organic') organicCut = true;
    }
    if (kept.length === 0) continue;
    blocks.push({ type: block.type, items: kept });
    total += kept.length;
  }
  return { blocks, truncated, organicCut };
}

/**
 * The vendor's answer text as a reader's answer (`SerpRead`) and the result types skipped; `ok: false`
 * for anything that does not fit (`vendorError` when DataForSEO said its task failed). Never throws.
 */
export function serpApiRead(provider: SerpApiProvider, body: string): { readonly ok: true; readonly read: SerpRead; readonly skipped: number } | { readonly ok: false; readonly vendorError: boolean } {
  try {
    if (typeof body !== 'string' || !Object.prototype.hasOwnProperty.call(MAPPERS, provider)) return INVALID as { ok: false; vendorError: boolean };
    // The caps first: nothing too large or too deep reaches the parser.
    if (body.length > L.maxResponseBytes || Buffer.byteLength(body, 'utf8') > L.maxResponseBytes || !withinDepth(body, L.maxDepth)) return { ok: false, vendorError: false };
    const json: unknown = JSON.parse(body);
    if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, vendorError: false };
    const mapped = MAPPERS[provider](json);
    if (!mapped.ok) return { ok: false, vendorError: mapped.vendorError };
    // No organic container: never a snapshot (an empty `ready` or `no-results` would read as "not ranking").
    if (!mapped.container) return { ok: false, vendorError: false };
    // K-A1: the organic results' vendor ranks, in page order, are 1 … n.
    const ranks = mapped.sections.flatMap((section) => section.ranks ?? []);
    if (!ranks.every((rank, index) => rank === index + 1)) return { ok: false, vendorError: false };
    const { blocks, truncated, organicCut } = blocksOf(mapped.sections);
    return { ok: true, read: { ok: true, blocks, stats: { nodes: 0, elapsedMs: 0, truncated, organicCut } }, skipped: mapped.skipped };
  } catch {
    return { ok: false, vendorError: false };
  }
}

/** The worker's answer to an `api` job: the snapshot, the types skipped, and whether the vendor said it failed. */
export type SerpApiJobAnswer = SerpApiJobResult & { readonly vendorError: boolean };

/** Validates and runs one `api` job (`SerpApiJobSchema`) in the SERP worker. Never throws. */
export function runSerpApiJob(raw: unknown): SerpApiJobAnswer {
  const record = typeof raw === 'object' && raw !== null ? (raw as { params?: unknown; packVersion?: unknown }) : {};
  // `analyseSerp` with no answer: `unreadable` (`invalid-answer`), with the parameters when they are valid.
  const invalid = (vendorError: boolean): SerpApiJobAnswer => ({ snapshot: analyseSerp(undefined, { params: record.params, packVersion: record.packVersion }), skipped: 0, vendorError });
  try {
    const job = SerpApiJobSchema.safeParse(raw);
    if (!job.success) return invalid(false);
    const read = serpApiRead(job.data.provider, job.data.body);
    if (!read.ok) return invalid(read.vendorError);
    return { snapshot: analyseSerp(read.read, { params: job.data.params, packVersion: job.data.packVersion, redirects: [] }), skipped: read.skipped, vendorError: false };
  } catch {
    return { snapshot: { status: 'unreadable', reason: 'invalid-answer', params: null, packVersion: null }, skipped: 0, vendorError: false };
  }
}
