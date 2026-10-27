import type { SnippetCut } from '@app/seo-core';
import { MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';

// Pure helpers behind the Content panel (spec `seo-content.spec.ts`; acceptance
// `seo-content.feature.md`, Panel). No styles are computed here: bar and meter lengths are SVG
// attribute values, never `style`.

/** An n-gram row's bar length (0–100, one decimal) relative to the most frequent row: SVG `width`. */
export function ngramBar(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.max(2, Math.round((Math.min(count, max) / max) * 1000) / 10);
}

export type MeterState = 'empty' | 'fits' | 'over';

/** A width meter against its budget: its state, the fill (0–100 of a track 1.25 × the budget wide) and the budget mark. */
export interface WidthMeter {
  readonly state: MeterState;
  readonly fill: number;
  readonly mark: number;
  readonly label: string;
}

const METER_SCALE = 1.25;

/** The meter of `cut` (`null`: nothing to measure). */
export function widthMeter(cut: SnippetCut | null): WidthMeter {
  const mark = Math.round((1 / METER_SCALE) * 1000) / 10;
  if (cut === null || cut.width === 0) return { state: 'empty', fill: 0, mark, label: 'Nothing to measure' };
  const fill = Math.max(2, Math.round((Math.min(cut.width, cut.budget * METER_SCALE) / (cut.budget * METER_SCALE)) * 1000) / 10);
  const px = (n: number) => `${Math.round(n).toLocaleString('en-US')} px`;
  return cut.truncated
    ? { state: 'over', fill, mark, label: `${px(cut.width)} of about ${px(cut.budget)}: cut` }
    : { state: 'fits', fill, mark, label: `${px(cut.width)} of about ${px(cut.budget)}: fits` };
}

/** The first slot no draft uses, or `null` when every `MAX_SNIPPET_VARIANTS` slot is taken. */
export function firstFreeSlot(used: readonly number[]): number | null {
  for (let slot = 0; slot < MAX_SNIPPET_VARIANTS; slot++) if (!used.includes(slot)) return slot;
  return null;
}

/** `value` cut to `max` UTF-16 code units, never splitting a surrogate pair. */
export function capInput(value: string, max: number): string {
  if (value.length <= max) return value;
  const code = value.charCodeAt(max - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export const capQuery = (value: string): string => capInput(value, TARGET_QUERY_MAX_CHARS);
export const capTitle = (value: string): string => capInput(value, SNIPPET_VARIANT_TITLE_MAX_CHARS);
export const capDescription = (value: string): string => capInput(value, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS);

/**
 * How a result shows a page's address: its host, then its path segments (decoded where they decode),
 * joined with ` › `. Text only; the address is never a link here.
 */
export function breadcrumb(url: string): { readonly host: string; readonly path: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: url, path: '' };
  }
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  return { host: parsed.host, path: segments.length > 0 ? ` › ${segments.join(' › ')}` : '' };
}

/** `n` words / sentences etc. with a unit, singular for one. */
export function countLabel(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * On-Page's length verdict since the width rules (`seo-content.spec.ts`): `missing`, `short` below
 * the character minimum, `long` when a result cuts it by width (`truncated`), else `ok`.
 */
export function snippetIndicator(length: number | null | undefined, min: number, truncated: boolean): 'missing' | 'short' | 'ok' | 'long' {
  if (length === null || length === undefined || length === 0) return 'missing';
  if (truncated) return 'long';
  return length < min ? 'short' : 'ok';
}

/** A ratio with one decimal (`0` for nothing to divide by). */
export function ratio(a: number, b: number): string {
  return b > 0 ? (Math.round((a / b) * 10) / 10).toLocaleString('en-US') : '0';
}
