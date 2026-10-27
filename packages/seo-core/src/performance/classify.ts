import { RESOURCE_DOCUMENT_INITIATORS, RESOURCE_EXTENSIONS, RESOURCE_FETCH_INITIATORS, RESOURCE_MIME_TYPES, TEXT_MIME_TYPES, UNCOMPRESSED_MIN_BYTES, type ResourceType } from '@app/specs/seo-speed.spec';
import type { ResourceRecord } from './model';

// Classifying requests (spec `seo-speed.spec.ts`, `RESOURCE_TYPES`; acceptance `seo-speed.feature.md`,
// Summary). Pure: URLs are parsed with the WHATWG `URL`, never fetched.

const IMAGE_INITIATORS: readonly string[] = ['img', 'image', 'input', 'icon'];
const MEDIA_INITIATORS: readonly string[] = ['video', 'audio', 'track'];

/** A MIME type without parameters, lowercased (`text/html; charset=utf-8` → `text/html`). */
export function mimeOf(contentType: string | null): string {
  if (!contentType) return '';
  const semi = contentType.indexOf(';');
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

/** The URL's file extension (lowercased, without the dot), or `''`. */
export function extensionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** What a request is (`RESOURCE_TYPES`), by the order the spec gives: initiator, MIME type, initiator again, extension. */
export function resourceType(record: Pick<ResourceRecord, 'initiator' | 'contentType' | 'url'>): ResourceType {
  const initiator = record.initiator.toLowerCase();
  if ((RESOURCE_DOCUMENT_INITIATORS as readonly string[]).includes(initiator)) return 'document';
  if ((RESOURCE_FETCH_INITIATORS as readonly string[]).includes(initiator)) return 'fetch';
  const mime = mimeOf(record.contentType);
  if (mime !== '') {
    const byMime = RESOURCE_MIME_TYPES.find((entry) => entry.match.test(mime));
    if (byMime) return byMime.type;
  }
  if (initiator === 'script') return 'script';
  if (IMAGE_INITIATORS.includes(initiator)) return 'image';
  if (MEDIA_INITIATORS.includes(initiator)) return 'other';
  return Object.hasOwn(RESOURCE_EXTENSIONS, extensionOf(record.url)) ? RESOURCE_EXTENSIONS[extensionOf(record.url)]! : 'other';
}

/** A host's site: lowercased, one leading `www.` dropped. */
export function siteOf(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/** The URL's host (with its port), lowercased, or `''` when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Whether a request to `host` is third-party for a page on `pageHost` (`THIRD_PARTY_RULE`): not the
 * same host, and neither is a subdomain of the other's site. Ports count as part of the host.
 */
export function isThirdParty(host: string, pageHost: string): boolean {
  if (host === '' || pageHost === '') return host !== pageHost;
  const a = host.toLowerCase();
  const b = pageHost.toLowerCase();
  if (a === b) return false;
  const siteA = siteOf(a);
  const siteB = siteOf(b);
  return !(siteA === siteB || a.endsWith(`.${siteB}`) || b.endsWith(`.${siteA}`));
}

/** A request reported no size (cross-origin without `Timing-Allow-Origin`, or nothing received). */
export function sizeUnavailable(record: Pick<ResourceRecord, 'transfer' | 'encoded' | 'decoded'>): boolean {
  return record.transfer === 0 && record.encoded === 0 && record.decoded === 0;
}

/** Answered from the cache: nothing transferred, but an encoded body. */
export function fromCache(record: Pick<ResourceRecord, 'transfer' | 'encoded'>): boolean {
  return record.transfer === 0 && record.encoded > 0;
}

/** A request's weight: its transfer size, or its encoded size when it came from the cache. */
export function weightOf(record: Pick<ResourceRecord, 'transfer' | 'encoded'>): number {
  return record.transfer > 0 ? record.transfer : record.encoded;
}

/**
 * Whether a response was text sent without compression (`TEXT_MIME_TYPES`, `UNCOMPRESSED_MIN_BYTES`):
 * a text MIME type (or, without one, a script, stylesheet or document), at least the minimum
 * decoded, a known size, and either an empty `contentEncoding` (where the browser reports it) or an
 * encoded size not below the decoded size.
 */
export function isUncompressedText(record: Pick<ResourceRecord, 'contentType' | 'contentEncoding' | 'encoded' | 'decoded' | 'initiator' | 'url'>, type: ResourceType = resourceType(record)): boolean {
  if (record.decoded < UNCOMPRESSED_MIN_BYTES || record.encoded === 0) return false;
  const mime = mimeOf(record.contentType);
  const text = mime !== '' ? TEXT_MIME_TYPES.test(mime) : type === 'script' || type === 'stylesheet' || type === 'document';
  if (!text) return false;
  if (record.contentEncoding !== null) {
    const encoding = record.contentEncoding.trim().toLowerCase();
    return encoding === '' || encoding === 'identity';
  }
  return record.encoded >= record.decoded;
}
