import { SCHEMA_PARSE_LIMITS } from '@app/specs/schema-types.spec';
import {
  SERP_PREVIEW_BUDGETS_PX,
  SERP_PREVIEW_LIMITS as L,
  SNIPPET_ELLIPSIS,
  SUGGESTED_JSONLD_SHAPE,
  type SerpBreadcrumbSource,
  type SerpDateSource,
  type SerpPreviewVariant,
  type SerpSiteNameSource,
} from '@app/specs/seo-content.spec';
import { isA, isAbsoluteWebUrl, isIsoDate, isIsoDuration } from '../schema/check';
import { formatJson } from '../schema/json';
import type { SchemaEntity, SchemaReport, SchemaValue } from '../schema/model';
import type { PageFacts } from '../types';
import { parseUrl } from '../util';
import { snippetText, truncateToWidth, type SnippetCut } from './widths';

// The result preview's facts (Phase 11 Task 3, Decision 4; spec `seo-content.spec.ts`, Result
// preview facts): a pure function of the audit's page facts and structured data. The chrome draws
// them; main builds "Copy JSON-LD" from the same function. Nothing here is fetched or parsed from
// markup: every value is page text, cut to `SERP_PREVIEW_LIMITS`, and an invalid one is ignored.

/** What the preview reads from an audit. */
export type SerpPreviewInput = {
  readonly url: string;
  readonly page: PageFacts;
  readonly schema: SchemaReport;
  /** The audit's canonical (`IndexabilityReport.canonical.effective`): a suggested JSON-LD names it as the page. */
  readonly indexability?: { readonly canonical: { readonly effective: string | null } };
};

export interface SerpSiteName {
  /** The site name as its source holds it (white space collapsed; the source's own cap): what a suggested JSON-LD names. */
  readonly name: string;
  /** The site name as drawn: `name` cut to `maxSiteNameChars`. */
  readonly text: string;
  /** `text` cut by width (`SERP_PREVIEW_BUDGETS_PX.siteName`). */
  readonly shown: SnippetCut;
  readonly source: SerpSiteNameSource;
  /** The placeholder's mark: the name's first letter or digit, uppercased (`•` without one). Never a favicon. */
  readonly monogram: string;
}

export interface SerpCrumb {
  /** The step's name (cut to `maxFactChars`). */
  readonly name: string;
  /** The name as drawn (cut to `maxCrumbChars`). */
  readonly shown: string;
  /** The step's absolute `http(s)` URL, or `null`. */
  readonly url: string | null;
}

export interface SerpBreadcrumb {
  /** The page's host (with its port), as a result names it. */
  readonly host: string;
  /** The steps drawn: the first `maxCrumbs` of `steps`. */
  readonly crumbs: readonly SerpCrumb[];
  /** Every step of the trail (not capped for drawing): what a suggested BreadcrumbList lists. */
  readonly steps: readonly SerpCrumb[];
  /** The trail had more steps than `crumbs` holds. */
  readonly more: boolean;
  readonly source: SerpBreadcrumbSource;
  /** `host › step › step`, cut by width (`SERP_PREVIEW_BUDGETS_PX.breadcrumb`). */
  readonly line: SnippetCut;
}

/** A date as written (an ISO 8601 date) and as drawn (`Jan 5, 2025`). */
export interface SerpDate {
  readonly iso: string;
  readonly shown: string;
}

export interface SerpRating {
  readonly value: number;
  readonly best: number;
  readonly worst: number;
  /** `ratingCount`, else `reviewCount` (a whole number), else `null`. */
  readonly count: number | null;
  readonly countOf: 'ratings' | 'reviews' | null;
  /** Whole stars of five (`value / best × 5`, rounded). */
  readonly stars: number;
  /** The value with at most one decimal. */
  readonly shown: string;
}

export interface SerpVideo {
  readonly name: string | null;
  /** `m:ss` or `h:mm:ss`. */
  readonly duration: string | null;
  readonly uploadDate: SerpDate | null;
  /** It names an absolute thumbnail URL (never loaded). */
  readonly thumbnail: boolean;
}

export interface SerpRecipe {
  readonly name: string | null;
  /** `1 hr 15 min`. */
  readonly totalTime: string | null;
  readonly yield: string | null;
  readonly rating: SerpRating | null;
}

export interface SerpPreviewFacts {
  readonly siteName: SerpSiteName;
  readonly breadcrumb: SerpBreadcrumb;
  readonly date: (SerpDate & { readonly source: SerpDateSource }) | null;
  readonly rating: SerpRating | null;
  /** The first Article-family node (Top stories). */
  readonly article: { readonly headline: string | null } | null;
  readonly video: SerpVideo | null;
  readonly recipe: SerpRecipe | null;
  /** Which variants the page has the facts for (`standard` always). */
  readonly variants: Readonly<Record<SerpPreviewVariant, boolean>>;
  /** The JSON-LD blocks (indexes, ascending) of the nodes the facts came from. */
  readonly blocks: readonly number[];
}

export interface SerpPreviewOptions {
  /** The session-only site-name override (blank: none). */
  readonly siteName?: string | undefined;
}

// ---- The structured data, as one index ------------------------------------------------------

interface SchemaIndex {
  /** Every entity, top-level ones in order, each followed by its nested ones. */
  readonly all: readonly SchemaEntity[];
  readonly byKey: ReadonlyMap<number, SchemaEntity>;
  /** Untyped nodes extending a typed one (`SchemaEntity.extends`), by the typed node's key. */
  readonly extensions: ReadonlyMap<number, readonly SchemaEntity[]>;
}

const indexes = new WeakMap<SchemaReport, SchemaIndex>();

function indexOf(report: SchemaReport): SchemaIndex {
  const cached = indexes.get(report);
  if (cached) return cached;
  const all: SchemaEntity[] = [];
  const stack = [...report.entities].reverse();
  while (stack.length > 0 && all.length < SCHEMA_PARSE_LIMITS.maxEntities) {
    const entity = stack.pop()!;
    all.push(entity);
    const nested: SchemaEntity[] = [];
    for (const property of entity.properties) for (const value of property.values) if (value.kind === 'entity') nested.push(value.entity);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]!);
  }
  const byKey = new Map(all.map((entity) => [entity.key, entity]));
  const extensions = new Map<number, SchemaEntity[]>();
  for (const entity of all) {
    if (entity.extends === null) continue;
    const list = extensions.get(entity.extends) ?? [];
    list.push(entity);
    extensions.set(entity.extends, list);
  }
  const index = { all, byKey, extensions };
  indexes.set(report, index);
  return index;
}

/** The values of `name` on `entity` and on the nodes extending it. */
function valuesOf(ix: SchemaIndex, entity: SchemaEntity, name: string): SchemaValue[] {
  const out: SchemaValue[] = [];
  for (const node of [entity, ...(ix.extensions.get(entity.key) ?? [])]) for (const property of node.properties) if (property.name === name) out.push(...property.values);
  return out;
}

/** A text value that says something (not `null`, not blank), white space collapsed. */
const said = (value: SchemaValue): string | null => (value.kind === 'text' && value.json !== 'null' && value.text.trim() !== '' ? snippetText(value.text) : null);

function textsOf(ix: SchemaIndex, entity: SchemaEntity, name: string): string[] {
  return valuesOf(ix, entity, name).flatMap((value) => said(value) ?? []);
}

const firstText = (ix: SchemaIndex, entity: SchemaEntity, name: string): string | null => textsOf(ix, entity, name)[0] ?? null;

/** A nested node, or the node a reference points at. */
function nodeOf(ix: SchemaIndex, value: SchemaValue): SchemaEntity | null {
  if (value.kind === 'entity') return value.entity;
  if (value.kind === 'ref' && value.target !== null) return ix.byKey.get(value.target) ?? null;
  return null;
}

const nodesOf = (ix: SchemaIndex, entity: SchemaEntity, name: string): SchemaEntity[] => valuesOf(ix, entity, name).flatMap((value) => nodeOf(ix, value) ?? []);

// ---- Values ----------------------------------------------------------------------------------

/** `text` cut to `max` code points, a cut ending in `SNIPPET_ELLIPSIS`. */
function cutChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}${SNIPPET_ELLIPSIS}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** An ISO 8601 date as written and drawn (`Jan 5, 2025`, `Jan 2025`, `2025`); `null` when it is not one. */
function dateOf(value: string | null | undefined): SerpDate | null {
  const iso = value?.trim() ?? '';
  if (iso === '' || !isIsoDate(iso)) return null;
  const [, year, month, day] = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(iso)!;
  const name = month === undefined ? null : MONTHS[Number(month) - 1]!;
  const shown = name === null ? year! : day === undefined ? `${name} ${year}` : `${name} ${Number(day)}, ${year}`;
  return { iso, shown };
}

const NUMBER = /^\d+(?:[.,]\d+)?$/;

/** A non-negative number: a JSON number, or digits with one `.` / `,` decimal part. */
function numberOf(value: SchemaValue): number | null {
  if (value.kind !== 'text') return null;
  const text = value.text.trim();
  const n = value.json === 'number' ? Number(text) : NUMBER.test(text) ? Number(text.replace(',', '.')) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** The first value of `name`, as a number: `fallback` without one, `null` when it is not a number. */
function numberProp(ix: SchemaIndex, entity: SchemaEntity, name: string, fallback: number | null): number | null {
  const value = valuesOf(ix, entity, name).find((v) => said(v) !== null);
  return value === undefined ? fallback : numberOf(value);
}

function wholeNumber(ix: SchemaIndex, entity: SchemaEntity, name: string): number | null {
  const value = valuesOf(ix, entity, name).find((v) => said(v) !== null);
  if (value === undefined || value.kind !== 'text') return null;
  const n = numberOf(value);
  return n !== null && Number.isInteger(n) && /^\d+$/.test(value.text.trim()) ? n : null;
}

/** An AggregateRating's facts, or `null` when it is not a valid rating. */
function ratingOf(ix: SchemaIndex, entity: SchemaEntity): SerpRating | null {
  const value = numberProp(ix, entity, 'ratingValue', null);
  const best = numberProp(ix, entity, 'bestRating', 5);
  const worst = numberProp(ix, entity, 'worstRating', 1);
  if (value === null || best === null || worst === null || !(worst < best) || value < worst || value > best || best <= 0) return null;
  const ratings = wholeNumber(ix, entity, 'ratingCount');
  const reviews = ratings === null ? wholeNumber(ix, entity, 'reviewCount') : null;
  return {
    value,
    best,
    worst,
    count: ratings ?? reviews,
    countOf: ratings !== null ? 'ratings' : reviews !== null ? 'reviews' : null,
    stars: Math.min(5, Math.max(0, Math.round((value / best) * 5))),
    shown: String(Math.round(value * 10) / 10),
  };
}

const DURATION_PARTS = /^P(?:([\d.,]+)Y)?(?:([\d.,]+)M)?(?:([\d.,]+)W)?(?:([\d.,]+)D)?(?:T(?:([\d.,]+)H)?(?:([\d.,]+)M)?(?:([\d.,]+)S)?)?$/;

/** An ISO 8601 duration in whole seconds; `null` when it is not one, names years or months, or is zero. */
function secondsOf(value: string | null): number | null {
  const text = value?.trim() ?? '';
  if (text === '' || !isIsoDuration(text)) return null;
  const m = DURATION_PARTS.exec(text);
  if (!m || m[1] !== undefined || m[2] !== undefined) return null;
  const n = (s: string | undefined) => (s === undefined ? 0 : Number(s.replace(',', '.')));
  const seconds = Math.floor(n(m[3]) * 604_800 + n(m[4]) * 86_400 + n(m[5]) * 3_600 + n(m[6]) * 60 + n(m[7]));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

const two = (n: number) => String(n).padStart(2, '0');

/** A video length: `m:ss`, or `h:mm:ss` from an hour. */
function clock(seconds: number): string {
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** A cooking time: `1 hr 15 min`, `2 hr`, `45 min`. */
function cookingTime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h > 0 ? `${h} hr` : '', m > 0 ? `${m} min` : ''].filter((part) => part !== '').join(' ');
}

/** The first absolute `http(s)` URL among `candidates`, as its parsed href. */
function webUrl(candidates: readonly (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (!candidate || !isAbsoluteWebUrl(candidate)) continue;
    const parsed = parseUrl(candidate.trim());
    if (parsed) return parsed.href;
  }
  return null;
}

function monogramOf(name: string): string {
  const letter = /[\p{L}\p{N}]/u.exec(name)?.[0];
  return letter === undefined ? '•' : letter.toLocaleUpperCase();
}

const hostName = (host: string): string => (host.startsWith('www.') ? host.slice(4) : host);

// ---- Facts -----------------------------------------------------------------------------------

function siteNameOf(ix: SchemaIndex, input: SerpPreviewInput, override: string | undefined, use: (entity: SchemaEntity) => void): SerpSiteName {
  const pick = (): { text: string; source: SerpSiteNameSource } => {
    const typed = override === undefined ? '' : snippetText(override);
    if (typed !== '') return { text: typed, source: 'override' };
    for (const entity of ix.all) {
      if (!isA(entity, 'WebSite')) continue;
      const name = firstText(ix, entity, 'name');
      if (name === null) continue;
      use(entity);
      return { text: name, source: 'website-schema' };
    }
    const og = snippetText(input.page.social['og:site_name'] ?? '');
    if (og !== '') return { text: og, source: 'og-site-name' };
    const host = parseUrl(input.url)?.hostname.toLowerCase() ?? '';
    return { text: host === '' ? snippetText(input.url) : hostName(host), source: 'host' };
  };
  const { text: whole, source } = pick();
  const text = cutChars(whole, L.maxSiteNameChars);
  return { name: whole, text, shown: truncateToWidth(text, SERP_PREVIEW_BUDGETS_PX.siteName, 'description'), source, monogram: monogramOf(text) };
}

function crumb(name: string, url: string | null): SerpCrumb {
  return { name: cutChars(name, L.maxFactChars), shown: cutChars(name, L.maxCrumbChars), url };
}

/** The first BreadcrumbList with a named step, as steps. */
function schemaCrumbs(ix: SchemaIndex, use: (entity: SchemaEntity) => void): SerpCrumb[] | null {
  for (const list of ix.all) {
    if (!isA(list, 'BreadcrumbList')) continue;
    const items = nodesOf(ix, list, 'itemListElement').map((item, order) => ({ item, order, position: wholeNumber(ix, item, 'position') }));
    if (items.every((row) => row.position !== null)) items.sort((a, b) => a.position! - b.position! || a.order - b.order);
    const crumbs: SerpCrumb[] = [];
    for (const { item } of items) {
      const target = valuesOf(ix, item, 'item');
      const node = target.map((value) => nodeOf(ix, value)).find((n) => n !== null) ?? null;
      const name = firstText(ix, item, 'name') ?? (node ? firstText(ix, node, 'name') : null);
      if (name === null) continue;
      const url = webUrl([...target.map((value) => said(value)), node?.id, ...(node ? textsOf(ix, node, 'url') : []), ...textsOf(ix, item, 'url')]);
      crumbs.push(crumb(name, url));
      use(item);
      if (node) use(node);
    }
    if (crumbs.length > 0) {
      use(list);
      return crumbs;
    }
  }
  return null;
}

/** The URL's path segments as steps (decoded where they decode), each with the URL up to it. */
function urlCrumbs(url: URL | null): SerpCrumb[] {
  if (url === null) return [];
  const raw = url.pathname.split('/').filter((segment) => segment !== '');
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  return raw.map((segment, i) => {
    let name = segment;
    try {
      name = decodeURIComponent(segment);
    } catch {
      // As written.
    }
    return crumb(name, web ? `${url.origin}/${raw.slice(0, i + 1).join('/')}` : null);
  });
}

function breadcrumbOf(ix: SchemaIndex, input: SerpPreviewInput, use: (entity: SchemaEntity) => void): SerpBreadcrumb {
  const url = parseUrl(input.url);
  const host = url?.host || input.url;
  const fromSchema = schemaCrumbs(ix, use);
  const all = fromSchema ?? urlCrumbs(url);
  const crumbs = all.slice(0, L.maxCrumbs);
  const line = [host, ...crumbs.map((c) => c.shown)].join(' › ');
  return { host, crumbs, steps: all, more: all.length > crumbs.length, source: fromSchema ? 'breadcrumb-schema' : 'url', line: truncateToWidth(line, SERP_PREVIEW_BUDGETS_PX.breadcrumb, 'description') };
}

function dateFact(ix: SchemaIndex, articles: readonly SchemaEntity[], input: SerpPreviewInput, use: (entity: SchemaEntity) => void): SerpPreviewFacts['date'] {
  const fromSchema: readonly [SerpDateSource, string][] = [
    ['article-date-published', 'datePublished'],
    ['article-date-modified', 'dateModified'],
  ];
  for (const [source, name] of fromSchema) {
    for (const article of articles) {
      for (const value of textsOf(ix, article, name)) {
        const date = dateOf(value);
        if (date === null) continue;
        use(article);
        return { ...date, source };
      }
    }
  }
  const fromTags: readonly [SerpDateSource, 'article:published_time' | 'article:modified_time'][] = [
    ['article-published-time', 'article:published_time'],
    ['article-modified-time', 'article:modified_time'],
  ];
  for (const [source, tag] of fromTags) {
    const date = dateOf(input.page.social[tag]);
    if (date !== null) return { ...date, source };
  }
  return null;
}

function videoOf(ix: SchemaIndex, entity: SchemaEntity): SerpVideo {
  const name = firstText(ix, entity, 'name');
  const seconds = textsOf(ix, entity, 'duration').map(secondsOf).find((s) => s !== null) ?? null;
  return {
    name: name === null ? null : cutChars(name, L.maxFactChars),
    duration: seconds === null ? null : clock(seconds),
    uploadDate: textsOf(ix, entity, 'uploadDate').map(dateOf).find((d) => d !== null) ?? null,
    thumbnail: webUrl(textsOf(ix, entity, 'thumbnailUrl')) !== null,
  };
}

function recipeOf(ix: SchemaIndex, entity: SchemaEntity, use: (entity: SchemaEntity) => void): SerpRecipe {
  const name = firstText(ix, entity, 'name');
  const first = (prop: string) => textsOf(ix, entity, prop).map(secondsOf).find((s) => s !== null) ?? null;
  const total = first('totalTime');
  const prep = first('prepTime');
  const cook = first('cookTime');
  const seconds = total ?? (prep === null && cook === null ? null : (prep ?? 0) + (cook ?? 0));
  const recipeYield = firstText(ix, entity, 'recipeYield');
  let rating: SerpRating | null = null;
  for (const node of nodesOf(ix, entity, 'aggregateRating')) {
    rating = ratingOf(ix, node);
    if (rating !== null) {
      use(node);
      break;
    }
  }
  return { name: name === null ? null : cutChars(name, L.maxFactChars), totalTime: seconds === null ? null : cookingTime(seconds), yield: recipeYield === null ? null : cutChars(recipeYield, L.maxFactChars), rating };
}

/** The result preview's facts (spec `seo-content.spec.ts`, Result preview facts). Pure. */
export function serpPreview(input: SerpPreviewInput, options: SerpPreviewOptions = {}): SerpPreviewFacts {
  const ix = indexOf(input.schema);
  const used = new Set<SchemaEntity>();
  const use = (entity: SchemaEntity) => void used.add(entity);
  const siteName = siteNameOf(ix, input, options.siteName, use);
  const breadcrumb = breadcrumbOf(ix, input, use);
  const articles = ix.all.filter((entity) => isA(entity, 'Article'));
  const date = dateFact(ix, articles, input, use);
  let rating: SerpRating | null = null;
  for (const entity of ix.all) {
    if (!isA(entity, 'AggregateRating')) continue;
    rating = ratingOf(ix, entity);
    if (rating !== null) {
      use(entity);
      break;
    }
  }
  const articleNode = articles[0] ?? null;
  if (articleNode) use(articleNode);
  const headline = articleNode ? firstText(ix, articleNode, 'headline') : null;
  const videoNode = ix.all.find((entity) => isA(entity, 'VideoObject')) ?? null;
  if (videoNode) use(videoNode);
  const recipeNode = ix.all.find((entity) => isA(entity, 'Recipe')) ?? null;
  if (recipeNode) use(recipeNode);
  const video = videoNode ? videoOf(ix, videoNode) : null;
  const recipe = recipeNode ? recipeOf(ix, recipeNode, use) : null;
  const blocks = new Set<number>();
  for (const entity of used) for (const node of [entity, ...(ix.extensions.get(entity.key) ?? [])]) if (node.block !== null) blocks.add(node.block);
  return {
    siteName,
    breadcrumb,
    date,
    rating,
    article: articleNode ? { headline: headline === null ? null : cutChars(headline, L.maxFactChars) } : null,
    video,
    recipe,
    variants: { standard: true, 'top-stories': articleNode !== null, video: video !== null, recipe: recipe !== null },
    blocks: [...blocks].sort((a, b) => a - b),
  };
}

// ---- Copy JSON-LD ----------------------------------------------------------------------------

/**
 * "Copy JSON-LD" of the page (`SNIPPET_JSONLD_SOURCES` `page`): the JSON-LD blocks that fed the
 * preview, in order, each formatted when it parsed (else as written), a blank line between them;
 * `null` when none did.
 */
export function previewJsonLdBlocks(input: SerpPreviewInput, options: SerpPreviewOptions = {}): string | null {
  const fed = new Set(serpPreview(input, options).blocks);
  const texts = input.schema.blocks.filter((block) => fed.has(block.index) && block.text !== '').map((block) => {
    if (block.status !== 'valid') return block.text;
    // A formatting cut short would be invalid JSON: the block as written instead.
    const pretty = formatJson(block.text);
    return pretty.cut ? block.text : pretty.text;
  });
  return texts.length === 0 ? null : texts.join('\n\n');
}

/** What a suggested JSON-LD takes from the editor (`SuggestedJsonLdFieldsSchema`, validated by main). */
export interface SuggestedJsonLdFields {
  readonly siteName?: string | undefined;
  /** Include the breadcrumb trail (default on). */
  readonly breadcrumb?: boolean | undefined;
  /** Include the previewed date (`datePublished`, or `dateModified` when it came from a modified date; default on). */
  readonly date?: boolean | undefined;
}

/** Date sources that are a modified date: a suggested JSON-LD writes them as `dateModified`. */
const MODIFIED_DATES: ReadonlySet<SerpDateSource> = new Set(['article-date-modified', 'article-modified-time']);

/**
 * The suggested minimal JSON-LD (`SUGGESTED_JSONLD_SHAPE`): WebSite, BreadcrumbList and WebPage built
 * from the previewed facts only, two-space indented, every `<` written `\u003c`. `null` for a page
 * URL that is not `http(s)`.
 */
export function suggestedJsonLd(input: SerpPreviewInput, fields: SuggestedJsonLdFields = {}): string | null {
  const page = parseUrl(input.url);
  if (page === null || (page.protocol !== 'http:' && page.protocol !== 'https:')) return null;
  page.hash = '';
  // The canonical search engines read names the page, when it is an absolute http(s) URL.
  const canonical = input.indexability?.canonical.effective ?? null;
  const canonicalUrl = canonical !== null && isAbsoluteWebUrl(canonical) ? parseUrl(canonical.trim()) : null;
  if (canonicalUrl) canonicalUrl.hash = '';
  const pageUrl = canonicalUrl?.href ?? page.href;
  const websiteId = `${page.origin}${SUGGESTED_JSONLD_SHAPE.websiteIdSuffix}`;
  const breadcrumbId = `${pageUrl}${SUGGESTED_JSONLD_SHAPE.breadcrumbIdSuffix}`;
  const facts = serpPreview(input, { siteName: fields.siteName });
  const graph: Record<string, unknown>[] = [{ '@type': 'WebSite', '@id': websiteId, name: facts.siteName.name, url: `${page.origin}/` }];
  const trail = fields.breadcrumb !== false && facts.breadcrumb.crumbs.length > 0;
  if (trail) {
    graph.push({
      '@type': 'BreadcrumbList',
      '@id': breadcrumbId,
      itemListElement: facts.breadcrumb.steps.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, ...(c.url === null ? {} : { item: c.url }) })),
    });
  }
  const title = snippetText(input.page.title?.text ?? '');
  graph.push({
    '@type': 'WebPage',
    '@id': pageUrl,
    url: pageUrl,
    ...(title === '' ? {} : { name: cutChars(title, L.maxFactChars) }),
    isPartOf: { '@id': websiteId },
    ...(trail ? { breadcrumb: { '@id': breadcrumbId } } : {}),
    ...(fields.date !== false && facts.date !== null ? { [MODIFIED_DATES.has(facts.date.source) ? 'dateModified' : 'datePublished']: facts.date.iso } : {}),
  });
  return JSON.stringify({ '@context': SUGGESTED_JSONLD_SHAPE.context, '@graph': graph }, null, 2).replace(/</g, '\\u003c');
}
