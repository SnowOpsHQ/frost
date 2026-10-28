import { runAudit, type SeoAudit } from '@app/seo-core';
import { PAGE_REGIONS, type PageRegion } from '@app/specs/capture.spec';
import type { RegionAnswer, RegionTextAnswer } from '@app/specs/changes.spec';
import { NO_PAGE_CONTEXT, PageSnapshotSchema, type ExtractedSnapshot, type PageContext } from '@app/specs/seo-snapshot.spec';
import { rawSnapshot } from './seo-fakes';

// Change-intelligence fixtures: a real audit of a page, and a region answer as the extraction gives it.

/** The audit `runAudit` makes of `rawSnapshot(url, changes)` (with `context`, else none collected). */
export function auditOf(url: string, changes: Partial<ExtractedSnapshot> = {}, context: PageContext = NO_PAGE_CONTEXT): SeoAudit {
  return runAudit({ ...PageSnapshotSchema.parse(rawSnapshot(url, changes)), ...context });
}

/** One region's text, untruncated: `text` is its blocks joined, words counted by spaces. */
export function regionText(blocks: string[] = [], truncated = false): RegionTextAnswer {
  return { words: blocks.reduce((sum, block) => sum + block.split(' ').length, 0), blocks, truncated, text: blocks.join('\n') };
}

/** A valid region answer for `url`: an h1 and two paragraphs in `main`, one nav link, the rest empty. */
export function regionAnswer(url: string, regions: Partial<Record<PageRegion, RegionTextAnswer>> = {}, changes: Partial<RegionAnswer> = {}): RegionAnswer {
  return {
    url,
    partial: false,
    headings: [{ level: 1, text: 'Main heading', region: 'main' }],
    links: { total: 1, internal: 1, external: 0, nofollow: 0, list: [{ href: 'https://example.com/other', text: 'Other page', rel: '', region: 'nav' }] },
    regions: {
      ...(Object.fromEntries(PAGE_REGIONS.map((region) => [region, regionText()])) as Record<PageRegion, RegionTextAnswer>),
      main: regionText(['Main heading', 'A first paragraph about tea.', 'A second paragraph about biscuits.']),
      ...regions,
    },
    ...changes,
  };
}
