import {
  GSC_DOMAIN_PREFIX,
  GSC_LIMITS,
  GSC_PERMISSION_LEVELS,
  GSC_UNVERIFIED_PERMISSION,
  GscPropertySchema,
  type GscPermissionLevel,
  type GscProperty,
} from '@app/specs/gsc.schema';
import { parseWebUrl } from '@app/specs/web-url.spec';

// Which Search Console property covers a URL (spec `gsc.spec.ts`, properties; acceptance
// `gsc.feature.md`, Properties). Pure: no I/O.
//
// - A URL-prefix property (`https://www.example.com/blog/`) covers the URLs that begin with it:
//   the same scheme and host (with port), and its path a literal prefix of the URL's path and query.
//   The longest such property wins.
// - Otherwise a domain property (`sc-domain:example.com`) covers its domain and every subdomain over
//   both schemes and any port. The most specific (longest) domain wins.
// - `siteUnverifiedUser` properties read no data: they are never listed nor matched.

const PERMISSIONS: ReadonlySet<string> = new Set(GSC_PERMISSION_LEVELS);

/** `url` without its fragment (the form a `page equals` filter compares), or `null` when it is not `http(s)`. */
export function pageUrlOf(url: string): string | null {
  const parsed = parseWebUrl(url);
  if (!parsed) return null;
  parsed.hash = '';
  return parsed.href;
}

/** A host name as `URL` normalizes it (lowercase, punycode), or `null`. */
function hostOf(name: string): string | null {
  if (name === '' || /[/?#@:\s]/.test(name)) return null;
  try {
    const host = new URL(`http://${name}/`).hostname;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** One of Google's site entries as a `GscProperty`, or `null` (unverified, unknown permission, malformed). */
export function propertyOfSite(entry: { readonly siteUrl: string; readonly permissionLevel: string }): GscProperty | null {
  if (!PERMISSIONS.has(entry.permissionLevel) || entry.permissionLevel === GSC_UNVERIFIED_PERMISSION) return null;
  const domain = entry.siteUrl.startsWith(GSC_DOMAIN_PREFIX);
  if (domain && hostOf(entry.siteUrl.slice(GSC_DOMAIN_PREFIX.length)) === null) return null;
  const candidate = { siteUrl: entry.siteUrl, kind: domain ? 'domain' : 'url-prefix', permissionLevel: entry.permissionLevel as GscPermissionLevel };
  const parsed = GscPropertySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Google's site entries as properties: verified ones only, once each, sorted by `siteUrl`, capped. */
export function propertiesFromSites(entries: readonly { readonly siteUrl: string; readonly permissionLevel: string }[]): GscProperty[] {
  const bySite = new Map<string, GscProperty>();
  for (const entry of entries) {
    const property = propertyOfSite(entry);
    if (property && !bySite.has(property.siteUrl)) bySite.set(property.siteUrl, property);
  }
  return [...bySite.values()].sort((a, b) => (a.siteUrl < b.siteUrl ? -1 : a.siteUrl > b.siteUrl ? 1 : 0)).slice(0, GSC_LIMITS.maxProperties);
}

/** The property that covers `url` (see above), or `null`. */
export function propertyFor(url: string, properties: readonly GscProperty[]): GscProperty | null {
  const page = parseWebUrl(url);
  if (!page) return null;
  const pagePath = `${page.pathname}${page.search}`;
  let best: { property: GscProperty; length: number } | null = null;
  for (const property of properties) {
    if (property.kind !== 'url-prefix' || property.permissionLevel === GSC_UNVERIFIED_PERMISSION) continue;
    const prefix = parseWebUrl(property.siteUrl);
    if (!prefix || prefix.protocol !== page.protocol || prefix.host !== page.host) continue;
    const prefixPath = `${prefix.pathname}${prefix.search}`;
    if (!pagePath.startsWith(prefixPath)) continue;
    if (!best || prefixPath.length > best.length) best = { property, length: prefixPath.length };
  }
  if (best) return best.property;
  const host = page.hostname;
  for (const property of properties) {
    if (property.kind !== 'domain' || property.permissionLevel === GSC_UNVERIFIED_PERMISSION) continue;
    const domain = hostOf(property.siteUrl.slice(GSC_DOMAIN_PREFIX.length));
    if (domain === null || (host !== domain && !host.endsWith(`.${domain}`))) continue;
    if (!best || domain.length > best.length) best = { property, length: domain.length };
  }
  return best?.property ?? null;
}
