import { IMAGE_OVERSIZE_FACTOR } from '@app/specs/seo-rules.spec';
import type { ImageFilter } from '@app/specs/seo-sidebar.spec';
import type { PageImage } from './types';

// What the Images panel and the image rules say about one image (spec `seo-rules.spec.ts`,
// `IMAGE_OVERSIZE_FACTOR`; `seo-sidebar.spec.ts`, `IMAGE_FILTERS`; acceptance
// `seo-panels.feature.md`, Images).

/** `missing`: no `alt` attribute; `decorative`: `alt=""`; `present`: alt text. */
export type AltState = 'missing' | 'decorative' | 'present';

export function altState(image: Pick<PageImage, 'alt'>): AltState {
  if (image.alt === null) return 'missing';
  return image.alt.text === '' && image.alt.length === 0 ? 'decorative' : 'present';
}

/**
 * Whether `src` is an SVG image (vectors scale for free). By URL only: a `.svg` / `.svgz` path or a
 * `data:image/svg+xml` URL; an SVG served from another URL is not recognised.
 */
export function isSvg(src: string): boolean {
  const lower = src.trim().toLowerCase();
  if (lower.startsWith('data:')) return lower.startsWith('data:image/svg+xml');
  const path = lower.split(/[?#]/, 1)[0] ?? '';
  return path.endsWith('.svg') || path.endsWith('.svgz');
}

/**
 * Rendered with a width or height attribute missing (absent or empty), and CSS does not fix its box
 * either (`cssSized`): no space is reserved before it loads.
 */
export function lacksDimensions(image: Pick<PageImage, 'rendered' | 'width' | 'height' | 'cssSized'>): boolean {
  return image.rendered !== null && !image.cssSized && (image.width === null || image.width.trim() === '' || image.height === null || image.height.trim() === '');
}

/**
 * Natural size more than `IMAGE_OVERSIZE_FACTOR` × the rendered size in either dimension (both
 * known and the rendered one non-zero); never for SVG images.
 */
export function isOversized(image: Pick<PageImage, 'src' | 'rendered' | 'natural'>): boolean {
  const { rendered, natural } = image;
  if (!rendered || !natural || isSvg(image.src)) return false;
  return (rendered.width > 0 && natural.width > IMAGE_OVERSIZE_FACTOR * rendered.width) || (rendered.height > 0 && natural.height > IMAGE_OVERSIZE_FACTOR * rendered.height);
}

/** `loading="lazy"` (any case) on an image whose box overlaps the first viewport. */
export function isLazyInFirstViewport(image: Pick<PageImage, 'loading' | 'inFirstViewport'>): boolean {
  return image.inFirstViewport && (image.loading ?? '').trim().toLowerCase() === 'lazy';
}

/** The images `filter` selects (`IMAGE_FILTERS`), in document order. */
export function filterImages<T extends PageImage>(images: readonly T[], filter: ImageFilter): T[] {
  switch (filter) {
    case 'missing-alt':
      return images.filter((image) => altState(image) === 'missing');
    case 'no-dimensions':
      return images.filter(lacksDimensions);
    case 'oversized':
      return images.filter(isOversized);
    case 'lazy-first-viewport':
      return images.filter(isLazyInFirstViewport);
    default:
      return [...images];
  }
}

/** How many images each filter selects. */
export function imageCounts(images: readonly PageImage[]): Readonly<Record<ImageFilter, number>> {
  return {
    all: images.length,
    'missing-alt': filterImages(images, 'missing-alt').length,
    'no-dimensions': filterImages(images, 'no-dimensions').length,
    oversized: filterImages(images, 'oversized').length,
    'lazy-first-viewport': filterImages(images, 'lazy-first-viewport').length,
  };
}
