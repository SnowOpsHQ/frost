// Spec: specs/command-palette.spec.ts (OPEN_IN_CONSENT_STORAGE_KEY, OPEN_IN_CONSENT_MAX)
// Acceptance: specs/command-palette.feature.md (Open in: consent-remembers-hosts)
import { describe, expect, test } from 'vitest';
import { OPEN_IN_CONSENT_MAX, OPEN_IN_CONSENT_STORAGE_KEY } from '@app/specs/command-palette.spec';
import { createConsentStore, parseConsents } from '../consent';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('open in consent', () => {
  test('consent-remembers-hosts', () => {
    for (const raw of [null, '', 'nope', '{}', '"search.google.com"', '42']) expect(parseConsents(raw), String(raw)).toEqual([]);
    expect(parseConsents(JSON.stringify(['search.google.com', 'SEARCH.GOOGLE.COM', 7, 'bad host!', '', 'x'.repeat(300), 'pagespeed.web.dev', 'search.google.com']))).toEqual(['search.google.com', 'pagespeed.web.dev']);
    const many = Array.from({ length: OPEN_IN_CONSENT_MAX + 4 }, (_, i) => `h${i}.example.com`);
    expect(parseConsents(JSON.stringify(many))).toHaveLength(OPEN_IN_CONSENT_MAX);

    const storage = memoryStorage({ [OPEN_IN_CONSENT_STORAGE_KEY]: JSON.stringify(['search.google.com']) });
    const store = createConsentStore(storage);
    expect(store.has('search.google.com')).toBe(true);
    expect(store.has('pagespeed.web.dev')).toBe(false);
    store.grant('pagespeed.web.dev');
    store.grant('pagespeed.web.dev');
    expect(store.has('pagespeed.web.dev')).toBe(true);
    expect(JSON.parse(storage.data.get(OPEN_IN_CONSENT_STORAGE_KEY)!)).toEqual(['search.google.com', 'pagespeed.web.dev']);
    // Another store on the same storage (a new palette, a relaunch) remembers it.
    expect(createConsentStore(storage).has('pagespeed.web.dev')).toBe(true);
    // A malformed host is never granted.
    store.grant('bad host!');
    expect(store.has('bad host!')).toBe(false);

    // Storage that throws (or none): the session still remembers, nothing throws.
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const fallback = createConsentStore(broken);
    expect(fallback.has('search.google.com')).toBe(false);
    fallback.grant('search.google.com');
    expect(fallback.has('search.google.com')).toBe(true);
    const none = createConsentStore(null);
    none.grant('search.google.com');
    expect(none.has('search.google.com')).toBe(true);
  });
});
