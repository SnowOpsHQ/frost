import type { PageFacts } from './types';
import { parseUrl } from './util';

// The Social panel's preview, drawn by frost from the page's text (spec `seo-sidebar.spec.ts`,
// `SOCIAL_REMOTE_IMAGES`; acceptance `seo-panels.feature.md`, Social). Apps that build link cards
// fall back from Open Graph to Twitter card tags to the page's own title and description; the
// preview does the same, and says where each value came from.

export type SocialSource = 'og' | 'twitter' | 'page' | 'none';

export interface SocialValue {
  readonly value: string;
  readonly source: SocialSource;
}

export interface SocialPreview {
  readonly title: SocialValue;
  readonly description: SocialValue;
  /** The image URL as written, and resolved against the page (`null` when it does not parse). Never loaded. */
  readonly image: { readonly raw: string; readonly resolved: string | null; readonly source: SocialSource } | null;
  /** `og:image:width` × `og:image:height` as declared (`null` unless both are). */
  readonly imageSize: string | null;
  /** The host the card names: `og:url`'s, else the page's (no `www.`). */
  readonly domain: string;
  readonly siteName: string | null;
  /** `twitter:card` as written (`null` when absent). */
  readonly card: string | null;
}

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== '';

function pick(og: string | null, twitter: string | null, page: string | null | undefined): SocialValue {
  if (present(og)) return { value: og, source: 'og' };
  if (present(twitter)) return { value: twitter, source: 'twitter' };
  if (present(page)) return { value: page, source: 'page' };
  return { value: '', source: 'none' };
}

export function socialPreview(page: PageFacts): SocialPreview {
  const s = page.social;
  const rawImage = present(s['og:image']) ? { raw: s['og:image'].trim(), source: 'og' as const } : present(s['twitter:image']) ? { raw: s['twitter:image'].trim(), source: 'twitter' as const } : null;
  const width = s['og:image:width'];
  const height = s['og:image:height'];
  const host = (parseUrl(page.ogUrl, page.url) ?? parseUrl(page.url))?.hostname.toLowerCase() ?? '';
  return {
    title: pick(s['og:title'], s['twitter:title'], page.title?.text),
    description: pick(s['og:description'], s['twitter:description'], page.description?.text),
    image: rawImage && { ...rawImage, resolved: parseUrl(rawImage.raw, page.url)?.href ?? null },
    imageSize: present(width) && present(height) ? `${width.trim()} × ${height.trim()}` : null,
    domain: host.startsWith('www.') ? host.slice(4) : host,
    siteName: present(s['og:site_name']) ? s['og:site_name'] : null,
    card: present(s['twitter:card']) ? s['twitter:card'] : null,
  };
}

/**
 * Every URL the audit lists (the page's own, its canonical and og:url, each link's `href`, each
 * image's `src`, the social image as written and resolved): what "Copy URL" may put on the
 * clipboard for this page (`seo.copyUrl`). Empty values are left out.
 */
export function pageUrls(page: PageFacts): Set<string> {
  const urls = new Set<string>([page.url]);
  const add = (value: string | null | undefined) => {
    if (value) urls.add(value);
  };
  add(page.canonical);
  add(page.ogUrl);
  for (const link of page.linkList) add(link.href);
  for (const image of page.imageList) add(image.src);
  const image = socialPreview(page).image;
  add(image?.raw);
  add(image?.resolved);
  return urls;
}
