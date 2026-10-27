// Spec: specs/devtools.spec.ts (COOKIE_LIMITS, CLEAR_SITE_DATA, STORAGE_USAGE_NOTE)
// Acceptance: specs/devtools.feature.md (Storage)
import { describe, expect, test, vi } from 'vitest';
import { COOKIE_LIMITS } from '@app/specs/devtools.spec';
import { createSiteStorage, type CookieLike } from '../storage';

const TAB = 5;
const PAGE = 'https://shop.example.com/cart?x=1';
const SESSION: CookieLike = { name: 'sid', value: 'super-secret-session', domain: 'shop.example.com', hostOnly: true, path: '/', secure: true, httpOnly: true, session: true, sameSite: 'lax' };
const THEME: CookieLike = { name: 'theme', value: 'dark', domain: '.example.com', hostOnly: false, path: '/', secure: false, httpOnly: false, session: false, expirationDate: 1_900_000_000.5, sameSite: 'no_restriction' };

function setup(cookies: CookieLike[] = [SESSION, THEME], answer = true) {
  const store = { cookies: vi.fn(async (_url: string) => cookies) };
  const confirmClear = vi.fn(async (_origin: string) => answer);
  const clearOrigin = vi.fn(async (_origin: string) => undefined);
  const changed = vi.fn();
  const storage = createSiteStorage({ cookies: store.cookies, confirmClear, clearOrigin, changed });
  return { storage, store, confirmClear, clearOrigin, changed };
}

describe('site storage', () => {
  test('cookies-masked-by-default', async () => {
    const { storage, store } = setup();
    const answer = await storage.storage(TAB, PAGE);
    expect(store.cookies).toHaveBeenCalledWith(PAGE);
    expect(answer).toEqual({
      status: 'ready',
      origin: 'https://shop.example.com',
      cookieTotal: 2,
      usage: null,
      cookies: [
        { name: 'sid', domain: 'shop.example.com', path: '/', hostOnly: true, expires: null, httpOnly: true, secure: true, sameSite: 'lax', value: null, valueTruncated: false },
        { name: 'theme', domain: '.example.com', path: '/', hostOnly: false, expires: 1_900_000_000_500, httpOnly: false, secure: false, sameSite: 'no_restriction', value: null, valueTruncated: false },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain('super-secret');
    // Capped list; non-web pages have no storage.
    const many = Array.from({ length: COOKIE_LIMITS.maxCookies + 5 }, (_, i) => ({ ...THEME, name: `c${i}` }));
    const capped = await setup(many).storage.storage(TAB, PAGE);
    expect(capped.status === 'ready' && [capped.cookies.length, capped.cookieTotal]).toEqual([COOKIE_LIMITS.maxCookies, COOKIE_LIMITS.maxCookies + 5]);
    expect(await storage.storage(TAB, 'about:blank')).toEqual({ status: 'no-page' });
    // A failing store answers no cookies, never an error.
    const broken = createSiteStorage({ cookies: async () => Promise.reject(new Error('gone')), confirmClear: async () => false, clearOrigin: async () => undefined, log: vi.fn() });
    expect(await broken.storage(TAB, PAGE)).toMatchObject({ status: 'ready', cookies: [] });
  });

  test('cookie-reveal-lifecycle', async () => {
    const { storage, changed } = setup([SESSION, THEME, { ...THEME, name: 'big', value: 'v'.repeat(COOKIE_LIMITS.maxValueChars + 3) }]);
    const shown = async () => {
      const answer = await storage.storage(TAB, PAGE);
      return answer.status === 'ready' ? Object.fromEntries(answer.cookies.map((c) => [c.name, c.value])) : null;
    };
    expect(await storage.reveal(TAB, PAGE, { name: 'sid', domain: 'shop.example.com', path: '/' })).toBe(true);
    expect(changed).toHaveBeenCalledWith(TAB);
    expect(await shown()).toEqual({ sid: 'super-secret-session', theme: null, big: null });
    // Unknown cookies, other tabs and non-web pages reveal nothing.
    expect(await storage.reveal(TAB, PAGE, { name: 'sid', domain: 'example.com', path: '/' })).toBe(false);
    expect(await storage.reveal(TAB, 'about:blank', { name: 'sid', domain: 'shop.example.com', path: '/' })).toBe(false);
    expect((await storage.storage(6, PAGE)).status === 'ready' && (await storage.storage(6, PAGE))).toMatchObject({ cookies: [{ value: null }, { value: null }, { value: null }] });
    // A revealed value is capped.
    expect(await storage.reveal(TAB, PAGE, { name: 'big', domain: '.example.com', path: '/' })).toBe(true);
    const big = await storage.storage(TAB, PAGE);
    expect(big.status === 'ready' && big.cookies[2]).toMatchObject({ valueTruncated: true });
    expect(big.status === 'ready' && big.cookies[2]!.value).toHaveLength(COOKIE_LIMITS.maxValueChars);
    // The next navigation masks everything again.
    storage.navigated(TAB);
    expect(await shown()).toEqual({ sid: null, theme: null, big: null });
    // So do Clear this site's data and closing the tab.
    await storage.reveal(TAB, PAGE, { name: 'theme', domain: '.example.com', path: '/' });
    await storage.clearSiteData(TAB, PAGE);
    expect(await shown()).toEqual({ sid: null, theme: null, big: null });
    await storage.reveal(TAB, PAGE, { name: 'theme', domain: '.example.com', path: '/' });
    storage.forget(TAB);
    expect(await shown()).toEqual({ sid: null, theme: null, big: null });
  });

  test('clear-site-data-confirms', async () => {
    const cancelled = setup(undefined, false);
    expect(await cancelled.storage.clearSiteData(TAB, PAGE)).toBe('cancelled');
    expect(cancelled.confirmClear).toHaveBeenCalledWith('https://shop.example.com');
    expect(cancelled.clearOrigin).not.toHaveBeenCalled();

    const confirmed = setup(undefined, true);
    await confirmed.storage.reveal(TAB, PAGE, { name: 'sid', domain: 'shop.example.com', path: '/' });
    // Asking twice while the dialog is up shows one dialog.
    const [first, second] = await Promise.all([confirmed.storage.clearSiteData(TAB, PAGE), confirmed.storage.clearSiteData(TAB, PAGE)]);
    expect([first, second]).toEqual(['cleared', 'cleared']);
    expect(confirmed.confirmClear).toHaveBeenCalledTimes(1);
    expect(confirmed.clearOrigin).toHaveBeenCalledExactlyOnceWith('https://shop.example.com');
    const after = await confirmed.storage.storage(TAB, PAGE);
    expect(after.status === 'ready' && after.cookies.every((c) => c.value === null)).toBe(true);

    // No web page: refused without asking.
    const refused = setup();
    expect(await refused.storage.clearSiteData(TAB, 'about:blank')).toBe('refused');
    expect(refused.confirmClear).not.toHaveBeenCalled();
    // A failing dialog is a Cancel.
    const failing = createSiteStorage({ cookies: async () => [], confirmClear: async () => Promise.reject(new Error('no dialog')), clearOrigin: vi.fn(), log: vi.fn() });
    expect(await failing.clearSiteData(TAB, PAGE)).toBe('cancelled');
  });
});
