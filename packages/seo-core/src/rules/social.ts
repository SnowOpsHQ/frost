import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact } from '../util';

// Checks on the page's social sharing tags (catalog: `specs/seo-rules.spec.ts`, Social): Open
// Graph and Twitter card fields as the snapshot read them (`SocialSchema`).

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

const blank = (value: string | null): boolean => value === null || value.trim() === '';

export const SOCIAL_CHECKS = {
  'og-title-missing': (s) => (blank(s.social['og:title']) ? details([fact('og:title', s.social['og:title'] === null ? 'None' : 'Empty')]) : null),
  'og-description-missing': (s) => (blank(s.social['og:description']) ? details([fact('og:description', s.social['og:description'] === null ? 'None' : 'Empty')]) : null),
  'og-image-missing': (s) => (blank(s.social['og:image']) ? details([fact('og:image', s.social['og:image'] === null ? 'None' : 'Empty')]) : null),
  'og-image-not-https': (s) => {
    const image = s.social['og:image'];
    if (image === null || image.trim() === '') return null;
    const value = image.trim();
    // A scheme is letters, digits, `+`, `-`, `.` after a letter, then `:` (so `//cdn/x.png` is relative).
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase() ?? null;
    if (scheme === 'https') return null;
    return details([fact('og:image', value), fact('Problem', scheme === null ? 'Relative URL' : `${scheme}: URL`)]);
  },
  'twitter-card-missing': (s) => (blank(s.social['twitter:card']) ? details([fact('twitter:card', s.social['twitter:card'] === null ? 'None' : 'Empty')]) : null),
} as const satisfies Record<string, Check>;
