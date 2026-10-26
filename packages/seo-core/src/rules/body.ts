import { IMAGE_ALT_MAX_CHARS, THIN_CONTENT_WORDS, URL_MAX_CHARS } from '@app/specs/seo-rules.spec';
import type { FindingDetails, PageSnapshot } from '../types';
import { characters, details, fact, formatCount, parseUrl, tokens, withoutFragment } from '../util';

// Checks on the document's body (headings, text, images, links) and on the page URL (catalog:
// `specs/seo-rules.spec.ts`). Lists are the snapshot's capped lists; counts say "of the analysed".

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

/** `n of the m analysed` (`of m` only when the list was capped below the page's total). */
function ofAnalysed(n: number, analysed: number, total: number): string {
  return analysed < total ? `${formatCount(n)} of the first ${formatCount(analysed)} (page has ${formatCount(total)})` : `${formatCount(n)} of ${formatCount(total)}`;
}

/** A sample's label for an element without a usable URL. */
const orNone = (value: string) => value || '(none)';

function pagePath(s: PageSnapshot): string {
  return parseUrl(s.url)?.pathname ?? '';
}

export const BODY_CHECKS = {
  'h1-missing': (s) => (s.headings.some((h) => h.level === 1) ? null : details([fact('H1 headings', 'None')])),
  'h1-multiple': (s) => {
    const h1s = s.headings.filter((h) => h.level === 1);
    return h1s.length > 1 ? details([fact('H1 headings', formatCount(h1s.length))], h1s.map((h) => h.text || '(empty)'), h1s.length) : null;
  },
  'h1-empty': (s) => {
    const empty = s.headings.filter((h) => h.level === 1 && h.text === '');
    return empty.length > 0 ? details([fact('Empty H1 headings', formatCount(empty.length))], [], empty.length) : null;
  },
  'heading-level-skipped': (s) => {
    const skips: string[] = [];
    for (let i = 1; i < s.headings.length; i++) {
      const before = s.headings[i - 1]!;
      const heading = s.headings[i]!;
      if (heading.level > before.level + 1) skips.push(`H${before.level} → H${heading.level}: ${heading.text || '(empty)'}`);
    }
    return skips.length > 0 ? details([fact('Skips', formatCount(skips.length))], skips, skips.length) : null;
  },

  'content-thin': (s) =>
    !s.textTruncated && s.wordCount < THIN_CONTENT_WORDS ? details([fact('Words', formatCount(s.wordCount)), fact('Recommended', `at least ${formatCount(THIN_CONTENT_WORDS)}`)]) : null,

  'images-missing-alt': (s) => {
    const missing = s.images.filter((image) => image.alt === null);
    return missing.length > 0 ? details([fact('Images without alt', ofAnalysed(missing.length, s.images.length, s.imageTotal))], missing.map((image) => orNone(image.src)), missing.length) : null;
  },
  'image-alt-too-long': (s) => {
    const long = s.images.filter((image) => image.alt !== null && image.alt.length > IMAGE_ALT_MAX_CHARS);
    if (long.length === 0) return null;
    const longest = Math.max(...long.map((image) => image.alt!.length));
    return details(
      [fact('Images', formatCount(long.length)), fact('Longest alt', characters(longest)), fact('Recommended', `at most ${IMAGE_ALT_MAX_CHARS} characters`)],
      long.map((image) => image.alt!.text),
      long.length,
    );
  },

  'links-empty-anchor': (s) => {
    const empty = s.links.filter((link) => link.text === '');
    return empty.length > 0 ? details([fact('Links without text', ofAnalysed(empty.length, s.links.length, s.linkTotal))], empty.map((link) => orNone(link.href)), empty.length) : null;
  },
  'links-javascript-href': (s) => {
    const scripted = s.links.filter((link) => link.scheme === 'javascript:');
    return scripted.length > 0 ? details([fact('javascript: links', ofAnalysed(scripted.length, s.links.length, s.linkTotal))], scripted.map((link) => link.text || orNone(link.href)), scripted.length) : null;
  },
  'links-nofollow': (s) => {
    const nofollow = s.links.filter((link) => tokens(link.rel).includes('nofollow'));
    return nofollow.length > 0 ? details([fact('nofollow links', ofAnalysed(nofollow.length, s.links.length, s.linkTotal))], nofollow.map((link) => orNone(link.href)), nofollow.length) : null;
  },

  'url-too-long': (s) => {
    const url = parseUrl(s.url);
    const length = url ? [...withoutFragment(url)].length : 0;
    return length > URL_MAX_CHARS ? details([fact('URL', url!.href), fact('Length', characters(length)), fact('Recommended', `at most ${URL_MAX_CHARS} characters`)]) : null;
  },
  'url-uppercase': (s) => (/[A-Z]/.test(pagePath(s)) ? details([fact('Path', pagePath(s))]) : null),
  'url-underscores': (s) => (pagePath(s).includes('_') ? details([fact('Path', pagePath(s))]) : null),
} as const satisfies Record<string, Check>;
