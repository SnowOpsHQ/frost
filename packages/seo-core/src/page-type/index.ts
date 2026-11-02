import {
  PAGE_TYPE_OG_MAP,
  PAGE_TYPE_PATH_HINTS,
  PAGE_TYPE_SCHEMA_MAP,
  PAGE_TYPE_SIGNALS,
  PAGE_TYPE_STRUCTURE,
  type PageType,
  type PageTypeConfidence,
  type PageTypePathHint,
  type PageTypeSignal,
} from '@app/specs/page-type.spec';
import { analyseSchema } from '../schema';
import type { PageSnapshot } from '../types';

// The page type (spec `page-type.spec.ts`; acceptance `page-type.feature.md`, Decision 14): worked out
// in the analysis worker from the rendered page's existing snapshot, with the rest of the audit. Pure
// and deterministic: no request, no clock, nothing sent anywhere. A fact for the Overview's "Page"
// card, never a rule: the health score never reads it.

/** One signal and the page type it names; `evidence` is frost's own wording of what it saw. */
export interface PageTypeSignalHit {
  readonly signal: PageTypeSignal;
  readonly type: PageType;
  readonly evidence: string;
}

/** `audit.pageType`: the type, how sure frost is, and every signal it read (in `PAGE_TYPE_SIGNALS` order). */
export interface PageTypeReport {
  readonly type: PageType;
  readonly confidence: PageTypeConfidence;
  readonly signals: readonly PageTypeSignalHit[];
}

/** The type `map` gives `key`, own keys only (a page's `constructor` is not a type). */
const lookup = (map: Readonly<Record<string, PageType>>, key: string): PageType | null => (Object.hasOwn(map, key) ? map[key]! : null);

/** The first top-level JSON-LD entity with a mapped type (the Schema panel's reading, memoised per snapshot). */
function schemaSignal(s: PageSnapshot): PageTypeSignalHit | null {
  for (const entity of analyseSchema(s).entities) {
    if (entity.syntax !== 'json-ld') continue;
    for (const name of entity.types) {
      const type = lookup(PAGE_TYPE_SCHEMA_MAP, name);
      if (type) return { signal: 'schema-type', type, evidence: name };
    }
  }
  return null;
}

function ogSignal(s: PageSnapshot): PageTypeSignalHit | null {
  const value = s.social['og:type']?.trim().toLowerCase() ?? '';
  const type = value === '' ? null : lookup(PAGE_TYPE_OG_MAP, value);
  return type ? { signal: 'og-type', type, evidence: value } : null;
}

const EXTENSION = /\.(?:html?|php|aspx?)$/;

/** The URL's path segments (lowercased, a page extension dropped) and whether it has a query; `null`: not a URL. */
function pathOf(url: string): { segments: string[]; query: boolean } | null {
  try {
    const parsed = new URL(url);
    return { segments: parsed.pathname.split('/').filter((part) => part !== '').map((part) => part.toLowerCase().replace(EXTENSION, '')), query: parsed.search !== '' };
  } catch {
    return null;
  }
}

const hintEvidence = (hint: PageTypePathHint): string => (hint.match === 'root' ? '/' : hint.match === 'below' ? `/${hint.segment}/…` : `/${hint.segment}`);

/** The path hint of the deepest matching segment (the root path matches only `root`). */
function pathSignal(s: PageSnapshot): PageTypeSignalHit | null {
  const path = pathOf(s.url);
  if (!path) return null;
  const { segments } = path;
  if (segments.length === 0) {
    const root = PAGE_TYPE_PATH_HINTS.find((hint) => hint.match === 'root');
    return root && !path.query ? { signal: 'url-path', type: root.type, evidence: hintEvidence(root) } : null;
  }
  for (let at = segments.length - 1; at >= 0; at--) {
    const hint = PAGE_TYPE_PATH_HINTS.find((candidate) => candidate.segment === segments[at] && (candidate.match === 'segment' || (candidate.match === 'below' && at < segments.length - 1)));
    if (hint) return { signal: 'url-path', type: hint.type, evidence: hintEvidence(hint) };
  }
  return null;
}

/** `listing` from the snapshot's counts: many headings of one level below H1, many internal links, few words per heading. */
function structureSignal(s: PageSnapshot): PageTypeSignalHit | null {
  const { minSameLevelHeadings, minInternalLinks, maxWordsPerHeading } = PAGE_TYPE_STRUCTURE.listing;
  const perLevel = new Map<number, number>();
  for (const heading of s.headings) if (heading.level > 1) perLevel.set(heading.level, (perLevel.get(heading.level) ?? 0) + 1);
  let level = 0;
  let count = 0;
  for (const [candidate, n] of perLevel) if (n > count || (n === count && candidate < level)) [level, count] = [candidate, n];
  const internal = s.links.filter((link) => link.kind === 'internal').length;
  const wordsPerHeading = Math.round(s.wordCount / Math.max(1, s.headingTotal));
  if (count < minSameLevelHeadings || internal < minInternalLinks || wordsPerHeading > maxWordsPerHeading) return null;
  return { signal: 'structure', type: 'listing', evidence: `${count} H${level} headings, ${internal} internal links, ${wordsPerHeading} words per heading` };
}

/** The page's type from its snapshot. Pure. */
export function pageTypeOf(s: PageSnapshot): PageTypeReport {
  const read: Record<PageTypeSignal, PageTypeSignalHit | null> = {
    'schema-type': schemaSignal(s),
    'og-type': ogSignal(s),
    'url-path': pathSignal(s),
    structure: structureSignal(s),
  };
  const signals = PAGE_TYPE_SIGNALS.flatMap((signal) => (read[signal] ? [read[signal]] : []));
  // A site's root is its home page, whatever it lists.
  if (read['url-path']?.type === 'home') return { type: 'home', confidence: 'high', signals };
  const first = signals[0];
  if (!first) return { type: 'other', confidence: 'unsure', signals };
  const agree = signals.every((hit) => hit.type === first.type);
  return { type: first.type, confidence: !agree ? 'unsure' : signals.length >= 2 ? 'high' : 'low', signals };
}
