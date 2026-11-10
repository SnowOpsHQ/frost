// Spec: specs/location-profiles.spec.ts (LOCATION_PARTITION_PREFIX, isLocationPartition, LOCATION_LIMITS, normalizeLocationHost,
// normalizeLocationLabel, normalizeLocationUsername, normalizeLocationPassword, proxyRulesFor, proxyAuthKey, locationCredentialSlots,
// LOCATION_README_FACTS), specs/serp-search-params.schema.ts (SEARCH_LOCATION_MAX_CHARS, SearchLocationLabelSchema),
// specs/location-profiles.schema.ts (TabLocationSchema)
// Acceptance: specs/location-profiles.feature.md (Behaviour; README "Locations") · plan docs/plans/phase-12-big-bets.md, Decision 11, Task 10b
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  isLocationCredentialSlot,
  isLocationPartition,
  LOCATION_LIMITS,
  LOCATION_README_FACTS,
  locationCredentialSlots,
  locationPartition,
  normalizeLocationHost,
  normalizeLocationLabel,
  normalizeLocationPassword,
  normalizeLocationUsername,
  proxyAuthKey,
  proxyRulesFor,
} from '@app/specs/location-profiles.spec';
import { TabLocationSchema } from '@app/specs/location-profiles.schema';
import { SEARCH_LOCATION_MAX_CHARS, SearchLocationLabelSchema } from '@app/specs/serp-search-params.schema';

const ID = '01920000-0000-7000-8000-0000000000c1';

describe('location profiles spec', () => {
  test('location-spec-values', () => {
    expect(LOCATION_LIMITS.maxLabelChars).toBeLessThanOrEqual(SEARCH_LOCATION_MAX_CHARS);
    // Every label a profile may have is a valid `SearchLocation` label.
    for (const label of ['Berlin', 'São Paulo', 'x'.repeat(LOCATION_LIMITS.maxLabelChars)]) expect(SearchLocationLabelSchema.safeParse(normalizeLocationLabel(label)).success, label).toBe(true);
    for (const label of ['', '   ', 'a\nb', 'x'.repeat(LOCATION_LIMITS.maxLabelChars + 1), 'evil‮']) expect(normalizeLocationLabel(label), JSON.stringify(label)).toBeNull();
    expect(isLocationPartition(locationPartition(ID))).toBe(true);
    for (const partition of ['persist:frost-browser', 'frost-location-', `persist:frost-location-${ID}`, `frost-location-${ID}x`, 'frost-data-api']) expect(isLocationPartition(partition), partition).toBe(false);
    expect(TabLocationSchema.safeParse({ profileId: ID, label: 'Berlin' }).success).toBe(true);
    expect(TabLocationSchema.safeParse({ profileId: ID, label: 'Berlin', partition: 'persist:x' }).success).toBe(false);
  });

  test('location-proxy-host-and-rules', () => {
    for (const [given, stored] of [
      ['Proxy.Example.NET', 'proxy.example.net'],
      ['127.0.0.1', '127.0.0.1'],
      ['[::1]', '[::1]'],
      ['localhost', 'localhost'],
    ] as const) {
      expect(normalizeLocationHost(given)).toBe(stored);
    }
    for (const host of ['http://proxy.example', 'proxy.example:80', 'me@proxy.example', '*.example', 'proxy.example/', '1.2.3', '999.1.1.1', '[not:an:ip', 'a..b', '-a.example', 'x'.repeat(254), '']) expect(normalizeLocationHost(host), host).toBeNull();
    expect(proxyRulesFor({ scheme: 'http', host: 'proxy.example.net', port: 3128 })).toBe('http://proxy.example.net:3128');
    expect(proxyRulesFor({ scheme: 'socks5', host: '[::1]', port: 1080 })).toBe('socks5://[::1]:1080');
    expect(() => proxyRulesFor({ scheme: 'http', host: 'a;direct://', port: 1 })).toThrow();
    expect(() => proxyRulesFor({ scheme: 'http', host: 'proxy.example', port: 0 })).toThrow();
    expect(proxyAuthKey('[::1]', 1080)).toBe(proxyAuthKey('::1', 1080));
    expect(proxyAuthKey('Proxy.Example', 80)).toBe('proxy.example:80');
  });

  test('location-credential-rules', () => {
    expect(locationCredentialSlots(ID)).toEqual({ username: `location-username.${ID}`, password: `location-password.${ID}` });
    expect(isLocationCredentialSlot(`location-password.${ID}`)).toBe(true);
    expect(isLocationCredentialSlot('anthropic')).toBe(false);
    expect(isLocationCredentialSlot('location-password.x')).toBe(false);
    expect(normalizeLocationUsername('me')).toBe('me');
    expect(normalizeLocationUsername('a:b')).toBeNull();
    expect(normalizeLocationUsername('')).toBeNull();
    expect(normalizeLocationPassword(' spaced pass ')).toBe(' spaced pass ');
    expect(normalizeLocationPassword('a\nb')).toBeNull();
    expect(normalizeLocationPassword('x'.repeat(LOCATION_LIMITS.maxCredentialChars + 1))).toBeNull();
  });

  test('location-readme-says-what-is-not-proxied', () => {
    const root = path.resolve(__dirname, '../../../../../..');
    for (const file of ['README.md', 'apps/desktop/README.md']) {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(text, file).toMatch(/^#{2,3} Locations/m);
      // Line wrapping aside.
      const flat = text.replace(/\s+/g, ' ');
      for (const fact of LOCATION_README_FACTS) expect(flat, `${file}: ${fact}`).toContain(fact);
    }
  });
});
