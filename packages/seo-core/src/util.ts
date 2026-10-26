import { FINDING_SAMPLE_LIMIT } from '@app/specs/seo-rules.spec';
import type { FindingDetails, FindingFact } from './types';

// Small pure helpers the rules share.

/** `url` parsed, or `null` (never throws). */
export function parseUrl(url: string | null | undefined, base?: string): URL | null {
  if (!url) return null;
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** A host as a site: lowercased, without one leading `www.` (so `www.example.com` is `example.com`). */
export function siteHost(url: URL): string {
  const host = url.hostname.toLowerCase();
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** `url` serialised without its `#fragment`. */
export function withoutFragment(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

/** `n characters` (singular for one). */
export function characters(n: number): string {
  return `${n.toLocaleString('en-US')} character${n === 1 ? '' : 's'}`;
}

/** `n` with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The first `FINDING_SAMPLE_LIMIT` values. */
export function samples(values: readonly string[]): string[] {
  return values.slice(0, FINDING_SAMPLE_LIMIT);
}

export function fact(label: string, value: string): FindingFact {
  return { label, value };
}

export function details(facts: readonly FindingFact[], sampleValues: readonly string[] = [], count?: number): FindingDetails {
  return count === undefined ? { facts, samples: samples(sampleValues) } : { facts, samples: samples(sampleValues), count };
}

/** The whitespace-separated, lowercased tokens of an attribute value (`rel`, robots `content` split on commas too). */
export function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((token) => token !== '');
}
