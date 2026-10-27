import type { PageFacts } from './types';
import { parseUrl } from './util';

// The Social panel's previews, drawn by frost from the page's text (spec `seo-sidebar.spec.ts`,
// `SOCIAL_REMOTE_IMAGES`; acceptance `seo-panels.feature.md`, Social). Each card has its own fallback
// chain, as the apps that draw it read the tags: the large-image card Open Graph, then the page;
// the summary card the Twitter card tags, then Open Graph, then the page. Each value says where it
// came from.

export type SocialSource = 'og' | 'twitter' | 'page' | 'none';

export interface SocialValue {
  readonly value: string;
  readonly source: SocialSource;
}

/** The image a card shows: as written, and resolved against the page (`null` when it does not parse). Never loaded. */
export interface SocialImage {
  readonly raw: string;
  readonly resolved: string | null;
  readonly source: SocialSource;
}

/** One card's title, description and image, each with where it came from. */
export interface SocialCard {
  readonly title: SocialValue;
  readonly description: SocialValue;
  readonly image: SocialImage | null;
}

export interface SocialPreview {
  /** The large-image card: Open Graph, then the page (`seo-sidebar.spec.ts`, `SOCIAL_REMOTE_IMAGES`). */
  readonly large: SocialCard;
  /** The summary card: the Twitter card tags, then Open Graph, then the page. */
  readonly summary: SocialCard;
  /** `og:image:width` × `og:image:height` as declared (`null` unless both are). */
  readonly imageSize: string | null;
  /** The host the cards name: `og:url`'s, else the page's (no `www.`). */
  readonly domain: string;
  readonly siteName: string | null;
  /** `twitter:card` as written (`null` when absent). */
  readonly card: string | null;
}

const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== '';

/** The first present value of `chain`, with its source; `none` when there is none. */
function first(chain: readonly [SocialSource, string | null | undefined][]): SocialValue {
  for (const [source, value] of chain) if (present(value)) return { value, source };
  return { value: '', source: 'none' };
}

function image(chain: readonly [SocialSource, string | null][], base: string): SocialImage | null {
  for (const [source, value] of chain) {
    if (!present(value)) continue;
    const raw = value.trim();
    return { raw, resolved: parseUrl(raw, base)?.href ?? null, source };
  }
  return null;
}

export function socialPreview(page: PageFacts): SocialPreview {
  const s = page.social;
  const width = s['og:image:width'];
  const height = s['og:image:height'];
  const host = (parseUrl(page.ogUrl, page.url) ?? parseUrl(page.url))?.hostname.toLowerCase() ?? '';
  const title = page.title?.text;
  const description = page.description?.text;
  return {
    large: {
      title: first([
        ['og', s['og:title']],
        ['page', title],
      ]),
      description: first([
        ['og', s['og:description']],
        ['page', description],
      ]),
      image: image([['og', s['og:image']]], page.url),
    },
    summary: {
      title: first([
        ['twitter', s['twitter:title']],
        ['og', s['og:title']],
        ['page', title],
      ]),
      description: first([
        ['twitter', s['twitter:description']],
        ['og', s['og:description']],
        ['page', description],
      ]),
      image: image(
        [
          ['twitter', s['twitter:image']],
          ['og', s['og:image']],
        ],
        page.url,
      ),
    },
    imageSize: present(width) && present(height) ? `${width.trim()} × ${height.trim()}` : null,
    domain: host.startsWith('www.') ? host.slice(4) : host,
    siteName: present(s['og:site_name']) ? s['og:site_name'] : null,
    card: present(s['twitter:card']) ? s['twitter:card'] : null,
  };
}

/**
 * Every URL the audit lists, each as its parsed `URL.href` (the page's own, its canonical and og:url,
 * each link's `href`, each image's `src`, both cards' images): what "Copy URL" may put on the
 * clipboard for this page (`seo.copyUrl`). Values that do not parse, and raw tag strings, are left out.
 */
export function pageUrls(page: PageFacts): Set<string> {
  const urls = new Set<string>();
  const add = (value: string | null | undefined) => {
    const href = value ? parseUrl(value.trim(), page.url)?.href : undefined;
    if (href) urls.add(href);
  };
  add(page.url);
  add(page.canonical);
  add(page.ogUrl);
  for (const link of page.linkList) add(link.href);
  for (const item of page.imageList) add(item.src);
  const preview = socialPreview(page);
  add(preview.large.image?.resolved);
  add(preview.summary.image?.resolved);
  return urls;
}
