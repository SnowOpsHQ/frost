// Spec: specs/update-client.spec.ts · Acceptance: specs/update-client.feature.md (Feed)
import { describe, expect, test } from 'vitest';
import { MAX_FEED_URL_CHARS, MAX_SWITCH_KEY_CHARS, UPDATE_FEED_ENV } from '@app/specs/update-client.spec';
import { UPDATE_PUBLIC_KEYS } from '@app/specs/update-manifest.spec';
import { resolveFeed, resolveTrustedKeys } from '../feed';
import { testSigningKey } from './fake-feed';

const HTTPS = 'https://updates.frost.example.com/feed.json';

describe('resolveFeed', () => {
  test('feed-rules', () => {
    const env = (value: string | undefined) => (value === undefined ? {} : { [UPDATE_FEED_ENV]: value });
    // [env, switch, isPackaged] → URL or null
    const table: [string | undefined, string | undefined, boolean, string | null][] = [
      // Nothing configured.
      [undefined, undefined, false, null],
      [undefined, undefined, true, null],
      ['', '', false, null],
      // The env, packaged or not.
      [HTTPS, undefined, false, HTTPS],
      [HTTPS, undefined, true, HTTPS],
      // The switch: unpackaged only, and it wins there.
      [undefined, HTTPS, false, HTTPS],
      [undefined, HTTPS, true, null],
      ['https://env.frost.example.com/f.json', HTTPS, false, HTTPS],
      ['https://env.frost.example.com/f.json', HTTPS, true, 'https://env.frost.example.com/f.json'],
      // http: only to a loopback literal, unpackaged.
      [undefined, 'http://127.0.0.1:8123/feed.json', false, 'http://127.0.0.1:8123/feed.json'],
      [undefined, 'http://[::1]:8123/feed.json', false, 'http://[::1]:8123/feed.json'],
      ['http://127.0.0.1:8123/feed.json', undefined, false, 'http://127.0.0.1:8123/feed.json'],
      ['http://127.0.0.1:8123/feed.json', undefined, true, null],
      [undefined, 'http://localhost:8123/feed.json', false, null],
      [undefined, 'http://127.0.0.2/feed.json', false, null],
      [undefined, 'http://updates.frost.example.com/feed.json', false, null],
      ['http://updates.frost.example.com/feed.json', undefined, true, null],
      // Other schemes, credentials, no host, odd characters, too long, unparsable.
      ['file:///etc/passwd', undefined, false, null],
      ['ftp://updates.frost.example.com/feed.json', undefined, false, null],
      ['data:application/json,{}', undefined, false, null],
      ['https://user@updates.frost.example.com/feed.json', undefined, false, null],
      ['https://user:pw@updates.frost.example.com/feed.json', undefined, false, null],
      ['https://:pw@updates.frost.example.com/feed.json', undefined, false, null],
      ['https://updates.frost.example.com/a feed.json', undefined, false, null],
      ['https://updätes.frost.example.com/feed.json', undefined, false, null],
      [` ${HTTPS}`, undefined, false, null],
      [`https://updates.frost.example.com/${'a'.repeat(MAX_FEED_URL_CHARS)}`, undefined, false, null],
      ['not a url', undefined, false, null],
      ['https://', undefined, false, null],
    ];
    for (const [envValue, switchValue, isPackaged, expected] of table) {
      const feed = resolveFeed({ env: env(envValue), switchValue, isPackaged });
      expect([envValue, switchValue, isPackaged, feed?.url ?? null]).toEqual([envValue, switchValue, isPackaged, expected]);
    }
    // Exactly MAX_FEED_URL_CHARS is fine.
    const long = `https://updates.frost.example.com/${'a'.repeat(MAX_FEED_URL_CHARS - 'https://updates.frost.example.com/'.length)}`;
    expect(long).toHaveLength(MAX_FEED_URL_CHARS);
    expect(resolveFeed({ env: env(long), switchValue: undefined, isPackaged: true })?.url).toBe(long);
  });

  test('trusted-keys-switch', () => {
    const key = testSigningKey('e2e-key');
    // Packaged, or no switch: the compiled-in keys.
    expect(resolveTrustedKeys({ switchValue: undefined, isPackaged: false })).toBe(UPDATE_PUBLIC_KEYS);
    expect(resolveTrustedKeys({ switchValue: '', isPackaged: false })).toBe(UPDATE_PUBLIC_KEYS);
    expect(resolveTrustedKeys({ switchValue: `e2e-key:${key.spki}`, isPackaged: true })).toBe(UPDATE_PUBLIC_KEYS);
    // Unpackaged: exactly that key replaces them.
    expect(resolveTrustedKeys({ switchValue: `e2e-key:${key.spki}`, isPackaged: false })).toEqual({ 'e2e-key': key.spki });
    // Malformed: no key at all (fail closed).
    for (const bad of ['e2e-key', `:${key.spki}`, `E2E:${key.spki}`, `e2e-key:${key.spki} `, `e2e-key:${key.spki.replace(/=$/, '')}`, `e2e-key:${'A'.repeat(MAX_SWITCH_KEY_CHARS + 4)}`, 'e2e-key:', `__proto__:${key.spki}`]) {
      expect([bad, resolveTrustedKeys({ switchValue: bad, isPackaged: false })]).toEqual([bad, {}]);
    }
  });
});
