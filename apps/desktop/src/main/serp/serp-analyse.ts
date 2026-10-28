import { registrableDomain } from '@app/seo-core';
import { SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import { SERP_OWNER_SUFFIXES, SERP_READ_LIMITS, isSerpFeature, type SerpUnreadableReason } from '@app/specs/serp.spec';
import { SearchParamsSchema, type SearchParams } from '@app/specs/serp-search-params.schema';
import {
  SerpReadSchema,
  SerpRedirectRulesSchema,
  SerpSnapshotSchema,
  type SerpComposition,
  type SerpOwnership,
  type SerpReadBlock,
  type SerpRedirectRules,
  type SerpResult,
  type SerpSnapshot,
} from '@app/specs/serp-snapshot.schema';

// SERP analysis (spec `serp-snapshot.schema.ts`, the result model; `serp.spec.ts`; acceptance
// `serp-overlay.feature.md`, Analysis). Pure, and run only in the SERP worker (`serp-worker.ts`),
// never on Electron's main thread: the reader's raw answer and the search parameters in, a
// validated `SerpSnapshot` out. Never throws.
// - The answer is page data: it is validated with `SerpReadSchema` first, and the parameters and
//   pack version and the engine's click redirects (from main, over a structured clone) with theirs;
//   anything that fails is `invalid-answer`. A reader failure is `unreadable` with the reader's reason; a timeout's partial
//   blocks are never analysed.
// - Links through the engine's click redirect are unwrapped by the engine's `redirects` (data: host,
//   path, parameter, `plain` or `bing-a1`), one level, and the destination validated again as an
//   `http:` / `https:` URL within `maxUrlChars`; one that fails keeps the link as read with no
//   domain, so it never counts towards ownership.
// - A result's domain is its owner: a subdomain of a shared-hosting domain (`SERP_OWNER_SUFFIXES`)
//   is its own site; otherwise the registrable domain.
// - Ranks over every result in document order; organic positions 1 … n and ad positions 1 … k, each
//   their own count; each feature block a slot (1, 2, … in document order).
// - Composition: results per type (every type) and the feature blocks in order.
// - Ownership: the organic results with a domain, grouped by registrable domain, sorted by count
//   (most first), then best position, then name. Ads are not counted.
// - The snapshot is validated again (`SerpSnapshotSchema`) before it leaves.

export interface SerpAnalysisContext {
  /** The page's search parameters (`matchSerp`), validated here again. */
  readonly params: unknown;
  /** The version of the pack the page was read with. */
  readonly packVersion: unknown;
  /** The engine's click redirects, hosts resolved (`redirectRules`); absent: none. */
  readonly redirects?: unknown;
}

const URL_SHAPE = /^https?:\/\/[^\u0000-\u0020\u007f]+$/;

/** `value` as an `http:` / `https:` URL within the reader's cap (its serialised form), or `null`. */
function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.href.length > SERP_READ_LIMITS.maxUrlChars || !URL_SHAPE.test(url.href)) return null;
    return url;
  } catch {
    return null;
  }
}

/** A `bing-a1` value's destination: `a1`, then the URL's UTF-8 bytes in base64url (unpadded). */
function decodeBingA1(value: string): string | null {
  if (!value.startsWith('a1')) return null;
  const encoded = value.slice(2);
  if (encoded.length === 0 || encoded.length > SERP_READ_LIMITS.maxUrlChars * 2 || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url'));
  } catch {
    return null;
  }
}

/**
 * A link's destination: the link itself when no redirect rule matches it (`redirected: false`);
 * the decoded, revalidated destination when one does (`redirected: true`); the link as read with
 * no usable destination (`valid: false`) when a rule matches but nothing decodes to a web URL.
 */
function unwrap(url: string, rules: SerpRedirectRules): { url: string; redirected: boolean; valid: boolean } {
  const link = webUrl(url);
  if (link === null) return { url, redirected: false, valid: false };
  const host = link.hostname.toLowerCase().replace(/\.$/, '');
  let matched = false;
  for (const rule of rules) {
    if (!rule.hosts.includes(host) || link.pathname !== rule.path) continue;
    matched = true;
    const value = link.searchParams.get(rule.param);
    if (value === null) continue;
    const decoded = rule.decode === 'bing-a1' ? decodeBingA1(value) : value;
    const destination = decoded === null ? null : webUrl(decoded);
    if (destination !== null) return { url: destination.href, redirected: true, valid: true };
  }
  return { url, redirected: false, valid: !matched };
}

/** The owner of a host: a site under a shared-hosting domain is itself; otherwise its registrable domain. */
export function ownerDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  for (const suffix of SERP_OWNER_SUFFIXES) {
    if (h === suffix) return h;
    if (h.endsWith(`.${suffix}`)) {
      const labels = h.slice(0, -suffix.length - 1).split('.');
      const site = labels[labels.length - 1]!;
      return site === 'www' ? suffix : `${site}.${suffix}`;
    }
  }
  return registrableDomain(h);
}

/** The owner domain of `url`'s host, or `null`. */
function domainOf(url: URL | null): string | null {
  if (url === null) return null;
  const domain = ownerDomain(url.hostname);
  return domain.length > 0 && domain.length <= 253 ? domain : null;
}

function results(blocks: readonly SerpReadBlock[], rules: SerpRedirectRules): { results: SerpResult[]; composition: SerpComposition } {
  const out: SerpResult[] = [];
  const counts = Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, 0])) as Record<SerpResultType, number>;
  const features: SerpComposition['features'] = [];
  let organic = 0;
  let ads = 0;
  for (const block of blocks) {
    const slot = isSerpFeature(block.type) ? features.length + 1 : null;
    if (slot !== null && isSerpFeature(block.type)) features.push({ slot, type: block.type, results: block.items.length });
    for (const item of block.items) {
      counts[block.type] += 1;
      const position = block.type === 'organic' ? ++organic : block.type === 'ad' ? ++ads : null;
      const link = item.url === null ? null : unwrap(item.url, rules);
      const domain = link === null || !link.valid ? null : domainOf(webUrl(link.url));
      out.push({ rank: out.length + 1, type: block.type, position, featureSlot: slot, title: item.title, url: link?.url ?? null, redirected: link?.redirected ?? false, domain });
    }
  }
  return { results: out, composition: { counts, features } };
}

function ownership(all: readonly SerpResult[], page: number, complete: boolean): SerpOwnership {
  const organic = all.filter((result) => result.type === 'organic' && result.domain !== null && result.position !== null);
  const byDomain = new Map<string, number[]>();
  for (const result of organic) {
    const positions = byDomain.get(result.domain!) ?? [];
    positions.push(result.position!);
    byDomain.set(result.domain!, positions);
  }
  const domains = [...byDomain].map(([domain, positions]) => ({ domain, count: positions.length, share: positions.length / organic.length, positions, best: Math.min(...positions) }));
  domains.sort((a, b) => b.count - a.count || a.best - b.best || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { page, organic: organic.length, complete, domains };
}

/** Analyses the reader's raw answer for the page with `context`'s parameters. */
export function analyseSerp(raw: unknown, context: SerpAnalysisContext): SerpSnapshot {
  const parsedParams = SearchParamsSchema.safeParse(context?.params);
  const params: SearchParams | null = parsedParams.success ? parsedParams.data : null;
  const version = context?.packVersion;
  const packVersion = typeof version === 'number' && Number.isSafeInteger(version) && version >= 1 ? version : null;
  const unreadable = (reason: SerpUnreadableReason): SerpSnapshot => ({ status: 'unreadable', reason, params, packVersion });
  const rules = SerpRedirectRulesSchema.safeParse(context?.redirects ?? []);
  if (params === null || packVersion === null || !rules.success) return unreadable('invalid-answer');

  const read = SerpReadSchema.safeParse(raw);
  if (!read.success) return unreadable('invalid-answer');
  if (!read.data.ok) return unreadable(read.data.reason);
  if (read.data.blocks.length === 0) return unreadable('no-results');

  const { results: all, composition } = results(read.data.blocks, rules.data);
  const snapshot = SerpSnapshotSchema.safeParse({
    status: 'ready',
    params,
    packVersion,
    results: all,
    composition,
    ownership: ownership(all, params.page, !read.data.stats.organicCut),
    truncated: read.data.stats.truncated,
  });
  return snapshot.success ? snapshot.data : unreadable('invalid-answer');
}
