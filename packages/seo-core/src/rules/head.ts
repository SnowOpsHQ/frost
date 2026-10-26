import { DESCRIPTION_MAX_CHARS, DESCRIPTION_MIN_CHARS, TITLE_MAX_CHARS, TITLE_MIN_CHARS } from '@app/specs/seo-rules.spec';
import type { CappedText, FindingDetails, PageSnapshot } from '../types';
import { characters, details, fact, formatCount, parseUrl, siteHost, tokens, withoutFragment } from '../util';

// Checks on the document's head: title, meta description, canonical, meta robots, lang and
// viewport (catalog: `specs/seo-rules.spec.ts`). Each answers `null` when the page passes.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

/** The first title, if it has text. */
function titled(s: PageSnapshot): CappedText | null {
  const first = s.titles[0];
  return first && first.text !== '' ? first : null;
}

/** The first meta description with text (an empty tag before it changes nothing). */
export function described(s: PageSnapshot): CappedText | null {
  return s.metaDescriptions.find((d) => d.text !== '') ?? null;
}

/** Facts for a measured text: the value and its length against the recommended range. */
function lengthFacts(label: string, value: CappedText, min: number, max: number) {
  return [fact(label, value.text), fact('Length', characters(value.length)), fact('Recommended', `${min}–${max} characters`)];
}

/** The robots metas (generic or crawler-specific) carrying any of `directives`. */
export function robotsWith(s: PageSnapshot, directives: readonly string[]): PageSnapshot['metaRobots'] {
  return s.metaRobots.filter((meta) => tokens(meta.content).some((token) => directives.includes(token)));
}

/** A fact per robots meta, named after its crawler (`Meta robots (googlebot)`); the generic tag is plain `Meta robots`. */
function robotsFacts(metas: PageSnapshot['metaRobots']) {
  return metas.map((meta) => fact(meta.name === 'robots' ? 'Meta robots' : `Meta robots (${meta.name})`, meta.content));
}

/** The first canonical's resolved URL, if it parses. */
function canonicalUrl(s: PageSnapshot): URL | null {
  return parseUrl(s.canonicals[0]?.resolved ?? null);
}

export const HEAD_CHECKS = {
  'title-missing': (s) => (s.titleTotal === 0 ? details([fact('Title', 'None')]) : null),
  'title-empty': (s) => (s.titleTotal > 0 && s.titles[0]?.text === '' ? details([fact('Title', 'Empty')]) : null),
  'title-multiple': (s) => (s.titleTotal > 1 ? details([fact('Titles', formatCount(s.titleTotal))], s.titles.map((t) => t.text || '(empty)'), s.titleTotal) : null),
  'title-too-short': (s) => {
    const title = titled(s);
    return title && title.length < TITLE_MIN_CHARS ? details(lengthFacts('Title', title, TITLE_MIN_CHARS, TITLE_MAX_CHARS)) : null;
  },
  'title-too-long': (s) => {
    const title = titled(s);
    return title && title.length > TITLE_MAX_CHARS ? details(lengthFacts('Title', title, TITLE_MIN_CHARS, TITLE_MAX_CHARS)) : null;
  },

  'meta-description-missing': (s) => (described(s) ? null : details([fact('Meta description', s.metaDescriptionTotal === 0 ? 'None' : 'Empty')])),
  'meta-description-too-short': (s) => {
    const description = described(s);
    return description && description.length < DESCRIPTION_MIN_CHARS ? details(lengthFacts('Description', description, DESCRIPTION_MIN_CHARS, DESCRIPTION_MAX_CHARS)) : null;
  },
  'meta-description-too-long': (s) => {
    const description = described(s);
    return description && description.length > DESCRIPTION_MAX_CHARS ? details(lengthFacts('Description', description, DESCRIPTION_MIN_CHARS, DESCRIPTION_MAX_CHARS)) : null;
  },
  'meta-description-multiple': (s) =>
    s.metaDescriptionTotal > 1 ? details([fact('Meta descriptions', formatCount(s.metaDescriptionTotal))], s.metaDescriptions.map((d) => d.text || '(empty)'), s.metaDescriptionTotal) : null,

  'canonical-missing': (s) => (s.canonicalTotal === 0 ? details([fact('Canonical', 'None')]) : null),
  'canonical-multiple': (s) =>
    s.canonicalTotal > 1 ? details([fact('Canonical links', formatCount(s.canonicalTotal))], s.canonicals.map((c) => c.href || '(empty)'), s.canonicalTotal) : null,
  'canonical-relative': (s) => {
    const first = s.canonicals[0];
    // A scheme is letters, digits, `+`, `-`, `.` after a letter, then `:` (so `//host/` is relative).
    return first && !/^[a-z][a-z0-9+.-]*:/i.test(first.href.trim()) ? details([fact('Canonical href', first.href || '(empty)')]) : null;
  },
  'canonical-off-host': (s) => {
    const canonical = canonicalUrl(s);
    const page = parseUrl(s.url);
    if (!canonical || !page || siteHost(canonical) === siteHost(page)) return null;
    return details([fact('Canonical', canonical.href), fact('Canonical host', canonical.hostname), fact('Page host', page.hostname)]);
  },
  'canonical-og-url-mismatch': (s) => {
    const canonical = canonicalUrl(s);
    const og = parseUrl(s.ogUrl, s.url);
    if (!canonical || !og || withoutFragment(canonical) === withoutFragment(og)) return null;
    return details([fact('Canonical', canonical.href), fact('og:url', s.ogUrl ?? '')]);
  },
  'canonical-has-query': (s) => {
    const canonical = canonicalUrl(s);
    return canonical && canonical.search !== '' ? details([fact('Canonical', canonical.href), fact('Query', canonical.search)]) : null;
  },

  'robots-noindex': (s) => {
    const metas = robotsWith(s, ['noindex', 'none']);
    return metas.length > 0 ? details(robotsFacts(metas)) : null;
  },
  'robots-nofollow': (s) => {
    const metas = robotsWith(s, ['nofollow', 'none']);
    return metas.length > 0 ? details(robotsFacts(metas)) : null;
  },

  'lang-missing': (s) => (s.lang === null || s.lang.trim() === '' ? details([fact('lang', 'None')]) : null),
  'viewport-missing': (s) => (s.viewport === null || s.viewport.trim() === '' ? details([fact('Viewport', s.viewport === null ? 'None' : 'Empty')]) : null),
} as const satisfies Record<string, Check>;
