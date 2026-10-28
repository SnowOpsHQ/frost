// Spec: specs/serp-selector-pack.spec.ts (SERP_E2E_PACK_URL_SWITCH, SERP_E2E_PACK_KEY_SWITCH, SERP_PACK_REMOTE_URL,
// SERP_PACK_PUBLIC_KEYS), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES), specs/serp-service.spec.ts
// Acceptance: specs/serp-overlay.feature.md (Setup)
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';
import type { BoundedFetchRequest, BoundedFetchResult, BoundedFetcher } from '@app/specs/fetcher.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH, SERP_PACK_PUBLIC_KEYS, SERP_PACK_REMOTE_URL } from '@app/specs/serp-selector-pack.spec';
import { createFakeIntentClassifier } from '../../intent/fake';
import { serpPackSeams, setupSerp, type SerpSetupApp } from '../setup';
import { encode, packObject, signBytes, signedPack, testKey } from './pack-keys';

vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] },
  utilityProcess: {
    fork: () => {
      throw new Error('Electron utilityProcess in a unit test');
    },
  },
}));

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const switches = (values: Record<string, string>) => ({ hasSwitch: (name: string) => name in values, getSwitchValue: (name: string) => values[name] ?? '' });

/** A `checks` lane answering `files` by URL (200 with the bytes; anything else 404). */
function fakeFetcher(files: Record<string, Uint8Array>) {
  const fetch = vi.fn(async (request: BoundedFetchRequest): Promise<BoundedFetchResult> => {
    const body = files[request.url];
    return { url: request.url, outcome: 'response', status: body ? 200 : 404, finalUrl: request.url, redirects: 0, chain: [], headers: {}, body: new Uint8Array(body ?? new Uint8Array()) as Uint8Array<ArrayBuffer>, truncated: false, durationMs: 1 };
  });
  return { fetch, load: () => ({ running: 0, queued: 0 }) } satisfies BoundedFetcher;
}

function fakeApp(isPackaged: boolean) {
  const emitter = new EventEmitter();
  const app: SerpSetupApp = { isPackaged, on: (event, listener) => emitter.on(event, listener), once: (event, listener) => emitter.once(event, listener) };
  return { app, emitter };
}

const browserOf = (state: Partial<BrowserState> = {}) => ({ tabIdOf: () => null, getState: () => ({ version: 1, tabs: [], activeTabId: null, ...state }) as unknown as BrowserState });

async function userData() {
  const dir = await mkdtemp(path.join(tmpdir(), 'frost-serp-setup-'));
  dirs.push(dir);
  return dir;
}

describe('SERP setup', () => {
  test('serp-setup-e2e-seams-unpackaged-only', async () => {
    const key = testKey();
    const extra = { [SERP_E2E_PACK_URL_SWITCH]: 'http://packs.test:8080/serp-selectors.json', [SERP_E2E_PACK_KEY_SWITCH]: key.spki };
    // The switches are refused at startup by packaged builds, and never read by them here.
    expect(PACKAGED_FORBIDDEN_SWITCHES).toEqual(expect.arrayContaining([SERP_E2E_PACK_URL_SWITCH, SERP_E2E_PACK_KEY_SWITCH]));
    expect(serpPackSeams({ app: fakeApp(true).app, switches: switches(extra) })).toEqual({ url: SERP_PACK_REMOTE_URL, allowHttp: false, publicKeys: SERP_PACK_PUBLIC_KEYS });
    expect(serpPackSeams({ app: fakeApp(false).app, switches: switches({}) })).toEqual({ url: SERP_PACK_REMOTE_URL, allowHttp: false, publicKeys: SERP_PACK_PUBLIC_KEYS });
    expect(serpPackSeams({ app: fakeApp(false).app, switches: switches(extra) })).toEqual({ url: extra[SERP_E2E_PACK_URL_SWITCH], allowHttp: true, publicKeys: [...SERP_PACK_PUBLIC_KEYS, key.spki] });

    // Unpackaged with the seams: an http pack signed by the extra key installs (through the `checks` lane).
    const pack = encode(packObject({ version: 999 }));
    const url = extra[SERP_E2E_PACK_URL_SWITCH];
    const checks = fakeFetcher({ [url]: pack, [`${url}.sig`]: encode(signBytes(pack, key)) });
    const { app } = fakeApp(false);
    const unpackaged = setupSerp({ app, browser: browserOf(), isBrowseContents: () => true, fetchers: { checks }, userData: await userData(), switches: switches(extra), log: () => undefined, classifier: createFakeIntentClassifier(), spawnAnalysis: () => new EventEmitter() as never });
    expect(checks.fetch).not.toHaveBeenCalled();
    await expect(unpackaged.service.checkPackUpdate()).resolves.toBe('installed');
    expect(checks.fetch.mock.calls.map(([request]) => request.url)).toEqual([url, `${url}.sig`]);
    expect(unpackaged.service.packStatus()).toMatchObject({ version: 999, source: 'remote' });
    unpackaged.dispose();

    // Packaged: the same switches change nothing; the spec's URL is asked for.
    const packaged = fakeFetcher({});
    const other = setupSerp({ app: fakeApp(true).app, browser: browserOf(), isBrowseContents: () => true, fetchers: { checks: packaged }, userData: await userData(), switches: switches(extra), log: () => undefined, classifier: createFakeIntentClassifier(), spawnAnalysis: () => new EventEmitter() as never });
    await expect(other.service.checkPackUpdate()).resolves.toBe('unreachable');
    expect(packaged.fetch.mock.calls.map(([request]) => request.url)).toEqual([SERP_PACK_REMOTE_URL]);
    other.dispose();
  });

  test('serp-setup-watches-browse-tabs-only', async () => {
    const { app, emitter } = fakeApp(false);
    const classifier = createFakeIntentClassifier();
    const dispose = vi.spyOn(classifier, 'dispose');
    const page = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, getURL: () => 'https://www.example.com/', executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined) });
    const chrome = Object.assign(new EventEmitter(), { id: 42, isDestroyed: () => false, getURL: () => 'app://frost/', executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined) });
    const setup = setupSerp({
      app,
      browser: browserOf(),
      isBrowseContents: (contents) => contents === (page as never),
      fetchers: { checks: fakeFetcher({}) },
      userData: await userData(),
      switches: switches({}),
      log: () => undefined,
      classifier,
      bundled: signedPack(testKey()),
      spawnAnalysis: () => new EventEmitter() as never,
    });
    emitter.emit('web-contents-created', {}, page);
    emitter.emit('web-contents-created', {}, page);
    emitter.emit('web-contents-created', {}, chrome);
    // A tab's page is watched once; the app's own window never.
    expect(page.listenerCount('did-finish-load')).toBe(1);
    expect(page.listenerCount('did-navigate')).toBe(1);
    expect(page.listenerCount('did-navigate-in-page')).toBe(1);
    expect(page.listenerCount('destroyed')).toBe(1);
    expect(chrome.eventNames()).toEqual([]);
    // A bundled pack that does not verify disables reading (never unsigned).
    expect(setup.service.packStatus().state).toBe('disabled');
    expect(setup.readApi.snapshot(1)).toEqual({ status: 'disabled', tabId: 1, reason: 'pack-invalid' });
    // Disposed on will-quit (the intent process with it).
    emitter.emit('will-quit');
    expect(dispose).toHaveBeenCalledTimes(1);
    setup.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
