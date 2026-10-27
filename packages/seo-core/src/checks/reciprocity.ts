import { HREFLANG_CHECK_LIMITS } from '@app/specs/seo-checks.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import type { HreflangReport } from '../indexability/model';
import { parseUrl, withoutFragment } from '../util';

// hreflang reciprocity (spec `seo-checks.spec.ts`, `RECIPROCITY_STATUSES`, `HREFLANG_CHECK_LIMITS`;
// acceptance `seo-checks.feature.md`, hreflang reciprocity). Which alternates to fetch, and whether
// what one lists links back to this page. Pure.

/** An annotation read from an alternate: its hreflang value and its target resolved against the alternate (`null`: does not parse). */
export interface ReturnLink {
  readonly hreflang: string;
  readonly resolved: string | null;
}

/** An alternate to fetch: its URL (fragment aside) and the hreflang values this page gives it (joined, cut). */
export interface AlternateTarget {
  readonly url: string;
  readonly lang: string;
}

/** `url` as a document key (parsed, no fragment), or `null`. */
const keyOf = (url: string | null): string | null => {
  const parsed = parseUrl(url);
  return parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? withoutFragment(parsed) : null;
};

/**
 * The alternates to check from the page's hreflang set: each distinct `http(s)` target other than
 * the page itself (an annotation marked `self`, or the page's URL or canonical), at most
 * `HREFLANG_CHECK_LIMITS.maxAlternates`; `over` is how many more there were. Also the hreflang values
 * the page gives itself (lowercased), which a return link should use.
 */
export function hreflangTargets(report: HreflangReport, pageUrl: string, canonical: string | null): { targets: AlternateTarget[]; over: number; selfLangs: string[]; pageKeys: string[] } {
  const pageKeys = [...new Set([keyOf(pageUrl), keyOf(canonical)].filter((key): key is string => key !== null))];
  const selfLangs = [...new Set(report.entries.filter((entry) => entry.self || pageKeys.includes(keyOf(entry.resolved) ?? '')).map((entry) => entry.value.toLowerCase()))];
  const langs = new Map<string, string[]>();
  for (const entry of report.entries) {
    const key = keyOf(entry.resolved);
    if (key === null || entry.self || pageKeys.includes(key)) continue;
    const list = langs.get(key) ?? [];
    if (!list.includes(entry.value)) list.push(entry.value);
    langs.set(key, list);
  }
  const all = [...langs.entries()].map(([url, values]) => ({ url, lang: values.join(', ').slice(0, SNAPSHOT_LIMITS.maxHreflangChars) }));
  return { targets: all.slice(0, HREFLANG_CHECK_LIMITS.maxAlternates), over: Math.max(0, all.length - HREFLANG_CHECK_LIMITS.maxAlternates), selfLangs, pageKeys };
}

/**
 * Whether an alternate's annotations (`links`) list this page (`pageKeys`) back: `reciprocal` with
 * one of the page's own values (`selfLangs`; any value when the page gives itself none),
 * `wrong-language` with others only, `missing-return` not at all. `returnLangs`: the values it uses.
 */
export function reciprocityOf(links: readonly ReturnLink[], pageKeys: readonly string[], selfLangs: readonly string[]): { status: 'reciprocal' | 'wrong-language' | 'missing-return'; returnLangs: string[] } {
  const returnLangs = [...new Set(links.filter((link) => pageKeys.includes(keyOf(link.resolved) ?? '')).map((link) => link.hreflang))];
  if (returnLangs.length === 0) return { status: 'missing-return', returnLangs };
  if (selfLangs.length === 0 || returnLangs.some((lang) => selfLangs.includes(lang.toLowerCase()))) return { status: 'reciprocal', returnLangs };
  return { status: 'wrong-language', returnLangs };
}
