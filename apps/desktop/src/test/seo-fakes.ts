import type { PageSnapshot } from '@app/specs/seo-snapshot.spec';

// A valid page snapshot as the extractor would answer it, for the auditor and schema tests.

export function rawSnapshot(url: string, changes: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url,
    extractedAt: 1_760_000_000_000,
    durationMs: 9,
    lang: 'en',
    titles: [{ text: 'A well titled page about something useful', length: 42 }],
    titleTotal: 1,
    metaDescriptions: [{ text: 'A description that is long enough to be a useful summary of what this page is about.', length: 86 }],
    metaDescriptionTotal: 1,
    metaRobots: ['index, follow'],
    canonicals: [{ href: url, resolved: url }],
    canonicalTotal: 1,
    ogUrl: url,
    viewport: 'width=device-width, initial-scale=1',
    headings: [
      { level: 1, text: 'Main heading' },
      { level: 2, text: 'Section' },
    ],
    headingTotal: 2,
    wordCount: 640,
    textTruncated: false,
    links: [{ href: 'https://example.com/other', scheme: 'https:', rel: '', text: 'Other page', kind: 'internal' }],
    linkTotal: 1,
    images: [{ src: 'https://example.com/a.png', alt: { text: 'An image', length: 8 }, width: '10', height: '10', loading: null }],
    imageTotal: 1,
    ...changes,
  };
}
