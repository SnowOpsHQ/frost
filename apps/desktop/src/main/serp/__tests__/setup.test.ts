// Spec: specs/serp-selector-pack.spec.ts (SERP_E2E_PACK_URL_SWITCH, SERP_E2E_PACK_KEY_SWITCH, SERP_PACK_REMOTE_URL,
// SERP_PACK_PUBLIC_KEYS), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES), specs/serp-service.spec.ts,
// specs/visibility-probes.spec.ts (PROBE_AGENTS)
// Acceptance: specs/serp-overlay.feature.md (Setup), specs/visibility-probes.feature.md (Router and setup)
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';
import type { BoundedFetchRequest, BoundedFetchResult, BoundedFetcher } from '@app/specs/fetcher.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH, SERP_PACK_PUBLIC_KEYS, SERP_PACK_REMOTE_URL } from '@app/specs/serp-selector-pack.spec';
import { PROBE_AGENTS } from '@app/specs/visibility-probes.spec';
import { runProbeJob } from '../probe-parse';
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

/** Main's robots.txt fetcher: none to obey. */
const noRobots = vi.fn(async (url: string) => ({ url: new URL('/robots.txt', url).href, outcome: 'unavailable' as const, status: 404, finalUrl: new URL('/robots.txt', url).href, redirects: 0, body: new Uint8Array(), truncated: false }));

/** A probe worker answering each job as `serp-worker.ts` does. */
class ProbeWorker extends EventEmitter {
  terminated = false;
  postMessage(message: { id: number; job: unknown }): void {
    setImmediate(() => this.emit('message', { id: message.id, result: runProbeJob(message.job) }));
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(1);
  }
  unref(): void {}
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
    const unpackaged = setupSerp({ app, browser: browserOf(), isBrowseContents: () => true, fetchers: { checks }, robots: noRobots, userData: await userData(), switches: switches(extra), log: () => undefined, classifier: createFakeIntentClassifier(), spawnAnalysis: () => new EventEmitter() as never });
    expect(checks.fetch).not.toHaveBeenCalled();
    await expect(unpackaged.service.checkPackUpdate()).resolves.toBe('installed');
    expect(checks.fetch.mock.calls.map(([request]) => request.url)).toEqual([url, `${url}.sig`]);
    expect(unpackaged.service.packStatus()).toMatchObject({ version: 999, source: 'remote' });
    unpackaged.dispose();

    // Packaged: the same switches change nothing; the spec's URL is asked for.
    const packaged = fakeFetcher({});
    const other = setupSerp({ app: fakeApp(true).app, browser: browserOf(), isBrowseContents: () => true, fetchers: { checks: packaged }, robots: noRobots, userData: await userData(), switches: switches(extra), log: () => undefined, classifier: createFakeIntentClassifier(), spawnAnalysis: () => new EventEmitter() as never });
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
      robots: noRobots,
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

  test('serp-setup-wires-probes', async () => {
    const { app, emitter } = fakeApp(false);
    const PAGE = 'https://www.example.com/shoes';
    const page = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, getURL: () => PAGE, executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined) });
    const browser = {
      tabIdOf: (contents: unknown) => (contents === page ? 1 : null),
      getState: () => ({ version: 1, tabs: [{ id: 1, documentSeq: 1, loading: false, renderProfile: null }], activeTabId: 1 }) as unknown as BrowserState,
    };
    // A `checks` lane that answers HTML at once, or holds every request until it is aborted.
    let hold = false;
    const requests: BoundedFetchRequest[] = [];
    const checks = {
      fetch: vi.fn(
        (request: BoundedFetchRequest) =>
          new Promise<BoundedFetchResult>((resolve) => {
            requests.push(request);
            const answer = (outcome: BoundedFetchResult['outcome']) =>
              resolve({ url: request.url, outcome, status: outcome === 'response' ? 200 : null, finalUrl: request.url, redirects: 0, chain: [], headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<p>hello there</p>') as Uint8Array<ArrayBuffer>, truncated: false, durationMs: 1 });
            if (!hold) answer('response');
            else request.signal?.addEventListener('abort', () => answer('aborted'), { once: true });
          }),
      ),
      load: () => ({ running: 0, queued: 0 }),
    } satisfies BoundedFetcher;
    const robots = vi.fn(noRobots);
    const workers: ProbeWorker[] = [];
    const setup = setupSerp({
      app,
      browser,
      isBrowseContents: (contents) => contents === (page as never),
      fetchers: { checks },
      robots,
      userData: await userData(),
      switches: switches({}),
      log: () => undefined,
      classifier: createFakeIntentClassifier(),
      spawnAnalysis: () => new EventEmitter() as never,
      spawnProbes: () => {
        const worker = new ProbeWorker();
        workers.push(worker);
        return worker as never;
      },
    });
    emitter.emit('web-contents-created', {}, page);
    // Nothing is fetched until the user runs the probes.
    expect(setup.service.probes(1)).toMatchObject({ status: 'idle', url: PAGE });
    expect(setup.readApi.probes(1)).toMatchObject({ status: 'idle' });
    expect(checks.fetch).not.toHaveBeenCalled();
    expect(setup.service.runProbes(1)).toBe(true);
    await vi.waitFor(() => expect(setup.service.probes(1).status).toBe('done'));
    expect(checks.fetch).toHaveBeenCalledTimes(PROBE_AGENTS.length);
    expect(robots).toHaveBeenCalledWith(PAGE);
    expect(setup.readApi.probes(1).rows.map((row) => row.outcome)).toEqual(PROBE_AGENTS.map(() => 'ok'));
    expect(setup.readApi.probes(1).rows[0]).toMatchObject({ wordCount: 2, robots: { verdict: 'allowed' } });
    await expect(setup.service.watchProbes(1, -1)).resolves.toMatchObject({ status: 'done' });
    // A new document, an in-page move to another URL, a closed tab and Clear Browsing Data cancel a run.
    hold = true;
    const cancels: [string, () => void][] = [
      ['did-navigate', () => page.emit('did-navigate')],
      ['did-navigate-in-page', () => page.emit('did-navigate-in-page', {}, `${PAGE}?page=2`, true)],
      ['clear browsing data', () => setup.onClearBrowsingData()],
      ['destroyed', () => page.emit('destroyed')],
    ];
    for (const [name, cancel] of cancels) {
      requests.length = 0;
      expect(setup.readApi.runProbes(1), name).toBe(true);
      await vi.waitFor(() => expect(requests.length, name).toBe(2));
      // A subframe's in-page move changes nothing.
      page.emit('did-navigate-in-page', {}, `${PAGE}?frame=1`, false);
      expect(requests.every((request) => !request.signal?.aborted), name).toBe(true);
      cancel();
      expect(requests.every((request) => request.signal?.aborted), name).toBe(true);
      expect(setup.service.probes(1).status, name).not.toBe('running');
    }
    // `will-quit` disposes the probes and their worker.
    emitter.emit('will-quit');
    expect(setup.service.runProbes(1)).toBe(false);
    expect(workers.length).toBeGreaterThan(0);
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });
});
