import { CSV_FORMULA_PREFIXES, LINK_REL_FLAGS, LINKS_CSV_COLUMNS, type LinkRelFilter, type LinkRelFlag, type LinkTypeFilter } from '@app/specs/seo-sidebar.spec';
import type { PageLink } from './types';
import { tokens } from './util';

// The Links panel's rows: rel flags, filtering, counts and the CSV that "Copy as CSV" writes (spec
// `seo-sidebar.spec.ts`, Links; acceptance `seo-panels.feature.md`, Links). Pure: the chrome
// filters with it, and main formats the same rows for the clipboard.

/** The panel's filter (`LinkFilterSchema` in `seo-snapshot.spec.ts` validates it in main). */
export interface LinkFilter {
  readonly type: LinkTypeFilter;
  readonly rel: LinkRelFilter;
  readonly query: string;
}

export const NO_LINK_FILTER: LinkFilter = { type: 'all', rel: 'all', query: '' };

/** Which of `LINK_REL_FLAGS` the link's `rel` has. */
export function relFlags(link: Pick<PageLink, 'rel'>): Readonly<Record<LinkRelFlag, boolean>> {
  const rel = tokens(link.rel);
  return { nofollow: rel.includes('nofollow'), sponsored: rel.includes('sponsored'), ugc: rel.includes('ugc') };
}

function matchesRel(link: PageLink, rel: LinkRelFilter): boolean {
  if (rel === 'all') return true;
  const flags = relFlags(link);
  if (rel === 'followed') return !LINK_REL_FLAGS.some((flag) => flags[flag]);
  return flags[rel];
}

/** The links `filter` selects, in document order: its type, its rel, and the query in the href or anchor text (case-insensitive). */
export function filterLinks<T extends PageLink>(links: readonly T[], filter: LinkFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  return links.filter(
    (link) =>
      (filter.type === 'all' || link.kind === filter.type) &&
      matchesRel(link, filter.rel) &&
      (query === '' || link.href.toLowerCase().includes(query) || link.text.toLowerCase().includes(query)),
  );
}

export interface LinkCounts {
  readonly all: number;
  readonly internal: number;
  readonly external: number;
  readonly other: number;
  readonly nofollow: number;
  readonly sponsored: number;
  readonly ugc: number;
  readonly followed: number;
}

/** How many links each type and rel filter selects. */
export function linkCounts(links: readonly PageLink[]): LinkCounts {
  const counts = { all: links.length, internal: 0, external: 0, other: 0, nofollow: 0, sponsored: 0, ugc: 0, followed: 0 };
  for (const link of links) {
    counts[link.kind] += 1;
    const flags = relFlags(link);
    for (const flag of LINK_REL_FLAGS) if (flags[flag]) counts[flag] += 1;
    if (!LINK_REL_FLAGS.some((flag) => flags[flag])) counts.followed += 1;
  }
  return counts;
}

/**
 * One CSV cell: a value starting with a `CSV_FORMULA_PREFIXES` character gets a leading `'` (a
 * spreadsheet never evaluates page text), then a value holding `"`, `,`, CR or LF is quoted with
 * its `"` doubled (RFC 4180).
 */
export function csvCell(value: string): string {
  const guarded = (CSV_FORMULA_PREFIXES as readonly string[]).some((prefix) => value.startsWith(prefix)) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** `rows` as CSV: the `LINKS_CSV_COLUMNS` header, then one line per link, CRLF line ends. */
export function linksCsv(rows: readonly PageLink[]): string {
  const yes = (on: boolean) => (on ? 'yes' : 'no');
  const lines = [LINKS_CSV_COLUMNS.map(csvCell).join(',')];
  for (const link of rows) {
    const flags = relFlags(link);
    lines.push([link.href, link.text, link.kind, link.rel, yes(flags.nofollow), yes(flags.sponsored), yes(flags.ugc), link.target ?? ''].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
