// Spec: specs/gsc.spec.ts (GSC_PROPERTY_KINDS, GSC_DOMAIN_PREFIX, GSC_PERMISSION_LEVELS, GSC_UNVERIFIED_PERMISSION,
// GSC_LIMITS.maxProperties), specs/gsc.schema.ts (GscPropertySchema)
// Acceptance: specs/gsc.feature.md (Properties)
import { describe, expect, test } from 'vitest';
import { GSC_LIMITS, GscPropertySchema, type GscProperty } from '@app/specs/gsc.schema';
import { pageUrlOf, propertiesFromSites, propertyFor } from '../properties';

const prefix = (siteUrl: string, permissionLevel: GscProperty['permissionLevel'] = 'siteOwner'): GscProperty => ({ siteUrl, kind: 'url-prefix', permissionLevel });
const domain = (name: string, permissionLevel: GscProperty['permissionLevel'] = 'siteFullUser'): GscProperty => ({ siteUrl: `sc-domain:${name}`, kind: 'domain', permissionLevel });

const site = (url: string, properties: GscProperty[]): string | null => propertyFor(url, properties)?.siteUrl ?? null;

describe('Search Console properties', () => {
  test('property-url-prefix-longest-wins', () => {
    const properties = [prefix('https://www.example.com/'), prefix('https://www.example.com/blog/'), prefix('https://www.example.com/blog/2026/')];
    expect(site('https://www.example.com/blog/2026/10/post', properties)).toBe('https://www.example.com/blog/2026/');
    expect(site('https://www.example.com/blog/other', properties)).toBe('https://www.example.com/blog/');
    expect(site('https://www.example.com/shop', properties)).toBe('https://www.example.com/');
    expect(site('https://www.example.com/', properties)).toBe('https://www.example.com/');
    // The path prefix is literal (Search Console's own rule): `/blog/` does not cover `/blogger`.
    expect(site('https://www.example.com/blogger', properties)).toBe('https://www.example.com/');
    // A fragment never matters; the order of the list never does.
    expect(site('https://www.example.com/blog/x#top', [...properties].reverse())).toBe('https://www.example.com/blog/');
  });

  test('property-scheme-and-host-exact', () => {
    const properties = [prefix('https://www.example.com/'), prefix('http://127.0.0.1:4173/')];
    expect(site('http://www.example.com/page', properties)).toBeNull();
    expect(site('https://example.com/page', properties)).toBeNull();
    expect(site('https://shop.www.example.com/page', properties)).toBeNull();
    expect(site('https://www.example.com.evil.test/page', properties)).toBeNull();
    expect(site('https://www.example.com:8443/page', properties)).toBeNull();
    expect(site('https://WWW.EXAMPLE.COM/page', properties)).toBe('https://www.example.com/');
    expect(site('https://www.example.com:443/page', properties)).toBe('https://www.example.com/');
    expect(site('http://127.0.0.1:4173/page', properties)).toBe('http://127.0.0.1:4173/');
    expect(site('http://127.0.0.1:4174/page', properties)).toBeNull();
  });

  test('property-domain-covers-subdomains-and-schemes', () => {
    const properties = [domain('example.com'), domain('shop.example.com')];
    expect(site('https://example.com/', properties)).toBe('sc-domain:example.com');
    expect(site('http://www.example.com/a', properties)).toBe('sc-domain:example.com');
    expect(site('https://blog.example.com:8443/a', properties)).toBe('sc-domain:example.com');
    expect(site('https://cart.shop.example.com/a', properties)).toBe('sc-domain:shop.example.com');
    expect(site('https://shop.example.com/a', properties)).toBe('sc-domain:shop.example.com');
    expect(site('https://notexample.com/', properties)).toBeNull();
    expect(site('https://example.com.evil.test/', properties)).toBeNull();
    expect(site('https://EXAMPLE.com/', [domain('Example.COM')])).toBe('sc-domain:Example.COM');
  });

  test('property-url-prefix-before-domain', () => {
    const properties = [domain('example.com'), prefix('https://www.example.com/')];
    expect(site('https://www.example.com/a', properties)).toBe('https://www.example.com/');
    expect(site('http://www.example.com/a', properties)).toBe('sc-domain:example.com');
    expect(site('https://m.example.com/a', properties)).toBe('sc-domain:example.com');
  });

  test('property-unverified-ignored', () => {
    const properties = [prefix('https://www.example.com/blog/', 'siteUnverifiedUser'), prefix('https://www.example.com/'), domain('example.org', 'siteUnverifiedUser')];
    expect(site('https://www.example.com/blog/post', properties)).toBe('https://www.example.com/');
    expect(site('https://example.org/', properties)).toBeNull();
    expect(
      propertiesFromSites([
        { siteUrl: 'https://www.example.com/', permissionLevel: 'siteUnverifiedUser' },
        { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteRestrictedUser' },
      ]),
    ).toEqual([domain('example.org', 'siteRestrictedUser')]);
  });

  test('property-non-web-url-none', () => {
    const properties = [prefix('https://www.example.com/'), domain('example.com')];
    for (const url of ['about:blank', 'app://app/', 'file:///home/x', 'ftp://example.com/', 'javascript:alert(1)', '', 'not a url']) {
      expect(site(url, properties), url).toBeNull();
      expect(pageUrlOf(url), url).toBeNull();
    }
    expect(pageUrlOf('https://www.example.com/a?b=1#c')).toBe('https://www.example.com/a?b=1');
    expect(pageUrlOf('https://WWW.example.com:443/a')).toBe('https://www.example.com/a');
  });

  test('property-list-from-sites', () => {
    const properties = propertiesFromSites([
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
      { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
      { siteUrl: 'https://a.example.com/', permissionLevel: 'siteRestrictedUser' },
      { siteUrl: 'android-app://com.example/', permissionLevel: 'siteOwner' },
      { siteUrl: 'https://b.example.com/', permissionLevel: 'superUser' },
      { siteUrl: `https://c.example.com/${'a'.repeat(GSC_LIMITS.maxUrlChars)}`, permissionLevel: 'siteOwner' },
      { siteUrl: 'sc-domain:', permissionLevel: 'siteOwner' },
    ]);
    expect(properties).toEqual([prefix('https://a.example.com/', 'siteRestrictedUser'), prefix('https://www.example.com/', 'siteFullUser'), domain('example.com', 'siteOwner')]);
    for (const property of properties) expect(GscPropertySchema.safeParse(property).success).toBe(true);
    const many = Array.from({ length: GSC_LIMITS.maxProperties + 10 }, (_, i) => ({ siteUrl: `https://s${i}.example.com/`, permissionLevel: 'siteOwner' }));
    expect(propertiesFromSites(many)).toHaveLength(GSC_LIMITS.maxProperties);
  });
});
