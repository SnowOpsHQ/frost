// Spec: specs/devtools.spec.ts (DEVTOOLS_STORAGE_WORLD_ID, WEB_STORAGE_AREAS, WEB_STORAGE_LIMITS, StorageAnswer),
// specs/devtools.schema.ts (WebStorageKeysAnswerSchema, WebStorageValueAnswerSchema), specs/agent-page-tools.spec.ts (NON_AGENT_WORLD_IDS)
// Acceptance: specs/devtools.feature.md (Web storage)
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NON_AGENT_WORLD_IDS } from '@app/specs/agent-page-tools.spec';
import { DEVTOOLS_STORAGE_WORLD_ID, WEB_STORAGE_LIMITS, type WebStorageView } from '@app/specs/devtools.spec';
import { INSPECTOR_WORLD_ID } from '@app/specs/inspector.spec';
import { SCREENSHOT_WORLD_ID } from '@app/specs/screenshot.spec';
import { createDevtoolsService, type DevtoolsContents } from '../service';
import { createWebStorageReader, type WebStorageTarget } from '../web-storage';

const ORIGIN = 'https://www.example.com';

/** A `Storage` over a Map, as the isolated world sees it (insertion order). */
function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  const writes: string[] = [];
  return {
    map,
    writes,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string) => writes.push(`set ${key}`),
    removeItem: (key: string) => writes.push(`remove ${key}`),
    clear: () => writes.push('clear'),
  };
}

interface FakeGlobal {
  origin: string;
  location: { origin: string };
  localStorage: ReturnType<typeof fakeStorage>;
  sessionStorage: ReturnType<typeof fakeStorage>;
  navigator: { storage?: { estimate?: () => Promise<{ usage?: number; quota?: number }> } };
}

/**
 * A tab whose isolated world runs the script for real: the code is evaluated with only `globalThis`
 * bound to a fake page global, so it must be self-contained.
 */
class FakeTab extends EventEmitter implements WebStorageTarget {
  url = `${ORIGIN}/page`;
  calls: { world: number; code: string }[] = [];
  /** Replaces the isolated world's answer (a hostile or broken page). */
  answer: ((code: string) => unknown) | null = null;
  page: FakeGlobal;
  constructor(
    readonly id: number,
    local: Record<string, string> = { token: 'local-secret-1', theme: 'dark' },
    session: Record<string, string> = { cart: '3 items' },
  ) {
    super();
    this.page = {
      origin: ORIGIN,
      location: { origin: ORIGIN },
      localStorage: fakeStorage(local),
      sessionStorage: fakeStorage(session),
      navigator: { storage: { estimate: async () => ({ usage: 1_234, quota: 5_678 }) } },
    };
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
  executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<unknown> {
    const code = scripts[0]!.code;
    this.calls.push({ world, code });
    if (this.answer) return Promise.resolve(this.answer(code));
    return Promise.resolve(new Function('globalThis', `return ${code}`)(this.page) as unknown);
  }
}

const ops = (tab: FakeTab) => tab.calls.map((c) => (c.code.includes('"op":"value"') ? 'value' : 'keys'));
const ready = (view: WebStorageView | null, area: 'local' | 'session') => {
  const a = view?.[area];
  if (a?.status !== 'ready') throw new Error(`${area} not ready: ${JSON.stringify(a)}`);
  return a;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('web storage reader', () => {
  test('reads-in-storage-world-only', async () => {
    expect(DEVTOOLS_STORAGE_WORLD_ID).toBe(1_700);
    for (const id of [DEVTOOLS_STORAGE_WORLD_ID, SCREENSHOT_WORLD_ID, INSPECTOR_WORLD_ID]) expect(NON_AGENT_WORLD_IDS).toContain(id);
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    await reader.answer(tab, false);
    expect(tab.calls.length).toBe(2);
    for (const call of tab.calls) {
      expect(call.world).toBe(DEVTOOLS_STORAGE_WORLD_ID);
      // Read-only: the script never writes the page's storage.
      expect(call.code).not.toMatch(/setItem|removeItem|\.clear\(/);
    }
    expect(tab.page.localStorage.writes).toEqual([]);
    expect(tab.page.sessionStorage.writes).toEqual([]);
  });

  test('refresh-returns-keys-and-sizes-only', async () => {
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    // Not read yet: nothing, and no script runs.
    await expect(reader.answer(tab, false)).resolves.toEqual({ webStorage: null, usage: null, quota: null });
    expect(tab.calls).toEqual([]);
    const first = await reader.answer(tab, true);
    expect(first.usage).toBe(1_234);
    expect(first.quota).toBe(5_678);
    expect(ready(first.webStorage, 'local')).toEqual({
      status: 'ready',
      total: 2,
      items: [
        { key: 'token', keyTruncated: false, size: 'local-secret-1'.length, value: null, valueTruncated: false },
        { key: 'theme', keyTruncated: false, size: 4, value: null, valueTruncated: false },
      ],
    });
    expect(ready(first.webStorage, 'session').items).toEqual([{ key: 'cart', keyTruncated: false, size: 7, value: null, valueTruncated: false }]);
    expect(JSON.stringify(first)).not.toContain('local-secret-1');
    // The script's own answer carries no value either.
    expect(tab.calls[0]!.code).toContain('"op":"keys"');
    // Without `read`, the last listing again, no script.
    tab.page.localStorage.map.set('later', 'x');
    const again = await reader.answer(tab, false);
    expect(again).toEqual(first);
    expect(tab.calls).toHaveLength(1);
    // Refresh reads again.
    expect(ready((await reader.answer(tab, true)).webStorage, 'local').total).toBe(3);

    // Through the service: `devtools.storage` with `readWebStorage`.
    const service = createDevtoolsService({
      activeTabId: () => 1,
      contentsOf: (tabId) => (tabId === 1 ? (tab as unknown as DevtoolsContents) : null),
      tabIdOf: () => 1,
      responses: { responseFor: () => null },
      robots: () => null,
      robotsVerdicts: async () => ({ ok: false, reason: 'invalid-job' }),
      cookies: async () => [],
      confirmClearSiteData: async () => true,
      clearOrigin: async () => undefined,
      liveWindow: () => true,
    });
    service.watchContents(tab as unknown as DevtoolsContents);
    const before = await service.storage(1);
    expect(before).toMatchObject({ status: 'ready', webStorage: null, usage: null, quota: null });
    const read = await service.storage(1, { readWebStorage: true });
    expect(read).toMatchObject({ status: 'ready', usage: 1_234, quota: 5_678 });
    expect(read.status === 'ready' && ready(read.webStorage, 'local').total).toBe(3);
    await expect(service.revealStorageItem(1, { area: 'local', key: 'token' })).resolves.toBe(true);
    await expect(service.revealStorageItem(2, { area: 'local', key: 'token' })).resolves.toBe(false);
  });

  test('reveal-reads-one-key-and-keeps-nothing', async () => {
    const changed = vi.fn();
    const reader = createWebStorageReader({ changed });
    const long = 'k'.repeat(WEB_STORAGE_LIMITS.maxKeyChars + 10);
    const tab = new FakeTab(5, { token: 'local-secret-1', big: 'v'.repeat(WEB_STORAGE_LIMITS.maxValueChars + 50), [long]: 'x' });
    // Nothing listed yet: nothing to reveal.
    expect(reader.reveal(tab, 'local', 'token')).toBe(false);
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'nope')).toBe(false);
    expect(reader.reveal(tab, 'session', 'token')).toBe(false);
    // A key cut to `maxKeyChars` cannot be revealed (it would name another key).
    expect(reader.reveal(tab, 'local', long.slice(0, WEB_STORAGE_LIMITS.maxKeyChars))).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    expect(changed).toHaveBeenCalledWith(5);
    tab.calls = [];
    const shown = await reader.answer(tab, false);
    // A second call, reading that key alone.
    expect(ops(tab)).toEqual(['value']);
    expect(tab.calls[0]!.code).toContain('"key":"token"');
    expect(tab.calls[0]!.code).not.toContain('theme');
    const items = ready(shown.webStorage, 'local').items;
    expect(items.find((i) => i.key === 'token')!.value).toBe('local-secret-1');
    expect(items.filter((i) => i.value !== null)).toHaveLength(1);
    // Each answer reads it again: main kept nothing of it.
    tab.page.localStorage.map.set('token', 'rotated-2');
    expect(ready((await reader.answer(tab, false)).webStorage, 'local').items.find((i) => i.key === 'token')!.value).toBe('rotated-2');
    tab.page.localStorage.map.delete('token');
    expect(ready((await reader.answer(tab, false)).webStorage, 'local').items.find((i) => i.key === 'token')!.value).toBeNull();
    // A long value is capped; one revealed key at a time.
    expect(reader.reveal(tab, 'local', 'big')).toBe(true);
    const big = ready((await reader.answer(tab, false)).webStorage, 'local').items;
    expect(big.find((i) => i.key === 'big')).toMatchObject({ value: 'v'.repeat(WEB_STORAGE_LIMITS.maxValueChars), valueTruncated: true });
    expect(big.filter((i) => i.value !== null).map((i) => i.key)).toEqual(['big']);
  });

  test('reveal-stale-after-navigation', async () => {
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    // A commit forgets the listing and the reveal.
    reader.committed(5);
    tab.calls = [];
    await expect(reader.answer(tab, false)).resolves.toEqual({ webStorage: null, usage: null, quota: null });
    expect(tab.calls).toEqual([]);
    expect(reader.reveal(tab, 'local', 'token')).toBe(false);

    // A value read overtaken by a commit is dropped (and the listing with it).
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    const run = tab.executeJavaScriptInIsolatedWorld.bind(tab);
    tab.executeJavaScriptInIsolatedWorld = (world, scripts) => {
      reader.committed(5);
      return run(world, scripts);
    };
    const overtaken = await reader.answer(tab, false);
    expect(JSON.stringify(overtaken)).not.toContain('local-secret-1');
    tab.executeJavaScriptInIsolatedWorld = run;

    // An answer for another origin (the page moved on) is dropped.
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    tab.page.origin = 'https://evil.example';
    tab.page.location.origin = 'https://evil.example';
    expect(JSON.stringify(await reader.answer(tab, false))).not.toContain('local-secret-1');
    const moved = await reader.answer(tab, true);
    expect(moved.webStorage).toBeNull();
  });

  test('answer-validated-and-capped', async () => {
    const reader = createWebStorageReader();
    const many = Object.fromEntries(Array.from({ length: WEB_STORAGE_LIMITS.maxKeys + 100 }, (_, i) => [`k${i}`, 'v']));
    const tab = new FakeTab(5, many);
    const capped = ready((await reader.answer(tab, true)).webStorage, 'local');
    expect(capped.items).toHaveLength(WEB_STORAGE_LIMITS.maxKeys);
    expect(capped.total).toBe(WEB_STORAGE_LIMITS.maxKeys + 100);
    // A page answering anything: never shown.
    const hostile = [
      null,
      'keys',
      { op: 'keys', origin: ORIGIN, local: { status: 'ready', items: [{ key: 'x'.repeat(WEB_STORAGE_LIMITS.maxKeyChars + 1), keyTruncated: false, size: 1 }], total: 1 }, session: { status: 'unavailable', reason: 'denied' }, usage: null, quota: null },
      { op: 'keys', origin: ORIGIN, local: { status: 'ready', items: [{ key: 'a', keyTruncated: false, size: 1, value: 'smuggled' }], total: 1 }, session: { status: 'unavailable', reason: 'denied' }, usage: null, quota: null },
      { op: 'keys', origin: ORIGIN, local: { status: 'ready', items: Array.from({ length: WEB_STORAGE_LIMITS.maxKeys + 1 }, (_, i) => ({ key: `k${i}`, keyTruncated: false, size: 1 })), total: 1e6 }, session: { status: 'unavailable', reason: 'denied' }, usage: null, quota: null },
      { op: 'keys', origin: ORIGIN, local: { status: 'ready', items: [{ key: 'a', keyTruncated: false, size: -1 }], total: 1 }, session: { status: 'unavailable', reason: 'denied' }, usage: Number.NaN, quota: null },
      { op: 'keys', origin: ORIGIN, local: { status: 'ready', items: [{ key: 'a', keyTruncated: false, size: 1 }, { key: 'b', keyTruncated: false, size: 1 }], total: 1 }, session: { status: 'unavailable', reason: 'denied' }, usage: null, quota: null },
    ];
    for (const answer of hostile) {
      const bad = new FakeTab(6);
      bad.answer = () => answer;
      const view = (await reader.answer(bad, true)).webStorage;
      expect(view, JSON.stringify(answer)?.slice(0, 80)).toEqual({ local: { status: 'unavailable', reason: 'invalid' }, session: { status: 'unavailable', reason: 'invalid' } });
      expect(JSON.stringify(view)).not.toContain('smuggled');
    }
    // A malformed or over-long value answer shows no value.
    const tab2 = new FakeTab(7);
    await reader.answer(tab2, true);
    expect(reader.reveal(tab2, 'local', 'token')).toBe(true);
    for (const answer of [{ op: 'value', status: 'ready', origin: ORIGIN, area: 'local', key: 'token', value: 'x'.repeat(WEB_STORAGE_LIMITS.maxValueChars + 1), truncated: false }, { op: 'value', status: 'ready', origin: ORIGIN, area: 'local', key: 'theme', value: 'other-key', truncated: false }, 42]) {
      tab2.answer = () => answer;
      const items = ready((await reader.answer(tab2, false)).webStorage, 'local').items;
      expect(items.every((i) => i.value === null)).toBe(true);
    }
  });

  test('opaque-origin-unavailable', async () => {
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    tab.page.origin = 'null';
    const view = (await reader.answer(tab, true)).webStorage;
    // The opaque answer's origin is not the tab's: main answers unavailable, never the page's keys.
    expect(view).toEqual({ local: { status: 'unavailable', reason: 'opaque-origin' }, session: { status: 'unavailable', reason: 'opaque-origin' } });
    // A storage the browser refuses (a SecurityError on access) is `denied`, the other area still read.
    const denied = new FakeTab(6);
    Object.defineProperty(denied.page, 'localStorage', {
      get() {
        throw new Error('SecurityError');
      },
    });
    const answer = await reader.answer(denied, true);
    expect(answer.webStorage?.local).toEqual({ status: 'unavailable', reason: 'denied' });
    expect(ready(answer.webStorage, 'session').total).toBe(1);
    // No estimate offered (an insecure context): usage and quota stay null.
    const insecure = new FakeTab(8);
    insecure.page.navigator = {};
    expect(await reader.answer(insecure, true)).toMatchObject({ usage: null, quota: null });
  });

  test('script-timeout-unavailable', async () => {
    vi.useFakeTimers();
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    tab.answer = () => new Promise(() => undefined);
    const pending = reader.answer(tab, true);
    await vi.advanceTimersByTimeAsync(WEB_STORAGE_LIMITS.scriptTimeoutMs + 1);
    const { webStorage } = await pending;
    expect(webStorage).toEqual({ local: { status: 'unavailable', reason: 'timeout' }, session: { status: 'unavailable', reason: 'timeout' } });
    // A script that throws (the page went away) is `failed`.
    vi.useRealTimers();
    const gone = new FakeTab(6);
    gone.executeJavaScriptInIsolatedWorld = () => Promise.reject(new Error('Script failed to execute'));
    expect((await reader.answer(gone, true)).webStorage).toEqual({ local: { status: 'unavailable', reason: 'failed' }, session: { status: 'unavailable', reason: 'failed' } });
  });

  test('reads-coalesced-per-tab', async () => {
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    // Requests while a read is in flight share it: one keys script, whatever asked (StrictMode's double fetch, a watch wake-up).
    const [a, b, c] = await Promise.all([reader.answer(tab, true), reader.answer(tab, true), reader.answer(tab, false)]);
    expect(ops(tab)).toEqual(['keys']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(ready(a.webStorage, 'local').total).toBe(2);
    // The revealed value: one read for the answers asking at once, and never two scripts at a time on the tab.
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    tab.calls = [];
    let running = 0;
    let most = 0;
    const run = tab.executeJavaScriptInIsolatedWorld.bind(tab);
    tab.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return run(world, scripts);
    };
    const answers = await Promise.all([reader.answer(tab, false), reader.answer(tab, false), reader.answer(tab, true)]);
    expect(most).toBe(1);
    expect(ops(tab).filter((op) => op === 'value').length).toBeLessThanOrEqual(2);
    for (const answer of answers) expect(ready(answer.webStorage, 'local').items.find((i) => i.key === 'token')!.value).toBe('local-secret-1');
  });

  test('clear-during-read-saves-nothing', async () => {
    const reader = createWebStorageReader();
    const tab = new FakeTab(5);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run = tab.executeJavaScriptInIsolatedWorld.bind(tab);
    tab.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      await gate;
      return run(world, scripts);
    };
    const pending = reader.answer(tab, true);
    // Clear Browsing Data (or Clear this site's data) lands while the page answers.
    reader.clear();
    release();
    await expect(pending).resolves.toEqual({ webStorage: null, usage: null, quota: null });
    tab.executeJavaScriptInIsolatedWorld = run;
    await expect(reader.answer(tab, false)).resolves.toEqual({ webStorage: null, usage: null, quota: null });
    // A revealed value read across a clear is not shown either.
    await reader.answer(tab, true);
    expect(reader.reveal(tab, 'local', 'token')).toBe(true);
    tab.executeJavaScriptInIsolatedWorld = (world, scripts) => {
      reader.clear();
      return run(world, scripts);
    };
    expect(JSON.stringify(await reader.answer(tab, false))).not.toContain('local-secret-1');
  });

  test('reader-runs-with-javascript-off', async () => {
    // With the page's scripting off (a render profile's JavaScript off), the page's main world runs
    // nothing; the reader does not depend on it: it runs only in its own isolated world, as the
    // extractor does, and reads the same storage.
    const reader = createWebStorageReader();
    const tab = new FakeTab(5) as FakeTab & { executeJavaScript?: () => Promise<unknown> };
    tab.executeJavaScript = () => Promise.reject(new Error('JavaScript is disabled'));
    const answer = await reader.answer(tab, true);
    expect(ready(answer.webStorage, 'local').total).toBe(2);
    expect(tab.calls.every((c) => c.world === DEVTOOLS_STORAGE_WORLD_ID)).toBe(true);
  });
});
