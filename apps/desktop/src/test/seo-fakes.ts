import { SOCIAL_TAGS } from '@app/specs/seo-limits.spec';
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
    metaRobots: [{ name: 'robots', content: 'index, follow' }],
    canonicals: [{ href: url, resolved: url }],
    canonicalTotal: 1,
    ogUrl: url,
    social: { ...(Object.fromEntries(SOCIAL_TAGS.map((tag) => [tag, null])) as PageSnapshot['social']), 'og:title': 'A well titled page', 'og:description': 'What the page is about.', 'og:image': 'https://example.com/share.png', 'twitter:card': 'summary' },
    viewport: 'width=device-width, initial-scale=1',
    headings: [
      { level: 1, text: 'Main heading' },
      { level: 2, text: 'Section' },
    ],
    headingTotal: 2,
    wordCount: 640,
    textTruncated: false,
    partial: false,
    links: [{ href: 'https://example.com/other', scheme: 'https:', rel: '', text: 'Other page', kind: 'internal', target: null }],
    linkTotal: 1,
    images: [{ src: 'https://example.com/a.png', alt: { text: 'An image', length: 8 }, width: '10', height: '10', loading: null, rendered: { width: 10, height: 10 }, natural: { width: 10, height: 10 }, inFirstViewport: true, cssSized: false }],
    imageTotal: 1,
    ...changes,
  };
}
