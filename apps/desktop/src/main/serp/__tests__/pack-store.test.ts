// Spec: specs/serp-selector-pack.spec.ts (trust model, SERP_PACK_PUBLIC_KEYS, PACK_UPDATE_OUTCOMES,
// SERP_PACK_FETCH_LIMITS, SERP_PACK_DIR, the e2e switches); specs/fetcher.spec.ts (Lanes);
// specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/serp-selector-pack.feature.md (Store); review focus pack-rejects-forged-and-stale
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BoundedFetcher, BoundedFetchRequest, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import {
  PACK_UPDATE_MESSAGES,
  PACK_UPDATE_OUTCOMES,
  SELECTOR_PACK_LIMITS,
  SERP_E2E_PACK_KEY_SWITCH,
  SERP_E2E_PACK_URL_SWITCH,
  SERP_PACK_FETCH_LIMITS,
  SERP_PACK_FILE,
  SERP_PACK_PUBLIC_KEYS,
  SERP_PACK_REMOTE_URL,
  SERP_PACK_SIGNATURE_FILE,
  SERP_RESULT_TYPES,
} from '@app/specs/serp-selector-pack.spec';
import { BUNDLED_PACK } from '../bundled';
import { boundedPackFetch, createPackStore, fileStorage, type PackFetch, type PackFiles, type PackStorage, type PackStoreOptions } from '../pack-store';
import { verifyPack } from '../pack-verify';
import { encode, signBytes, signedPack, testKey } from './pack-keys';

const KEY = testKey();
const OTHER = testKey();
const URL_ = 'https://packs.example.com/serp-selectors.json';
const BUNDLED = signedPack(KEY, { version: 3 });

/** An in-memory storage, recording writes. */
function memoryStorage(initial: PackFiles | null = null, options: { readFails?: boolean; writeFails?: boolean } = {}) {
  let stored = initial;
  const writes: PackFiles[] = [];
  const storage: PackStorage = {
    read: async () => {
      if (options.readFails) throw new Error('EIO');
      return stored;
    },
    write: async (bytes, signature) => {
      if (options.writeFails) throw new Error('ENOSPC');
      writes.push({ bytes, signature });
      stored = { bytes, signature };
    },
  };
  return { storage, writes };
}

/** A fetch answering `files` (URL → bytes or failure), recording each URL and cap asked for. */
function fakeFetch(files: Record<string, Uint8Array | 'unreachable' | 'too-large'>) {
  const asked: { url: string; maxBytes: number }[] = [];
  const fetchPack: PackFetch = async (url, maxBytes) => {
    asked.push({ url, maxBytes });
    const file = files[url];
    if (file === undefined || file === 'unreachable') return { ok: false, reason: 'unreachable' };
    if (file === 'too-large') return { ok: false, reason: 'too-large' };
    return { ok: true, bytes: file };
  };
  return { fetchPack, asked };
}

/** The remote files for a signed pack at `URL_`. */
const remote = (pack: { bytes: Uint8Array; signature: string }) => ({ [URL_]: pack.bytes, [`${URL_}.sig`]: encode(`${pack.signature}\n`) });

function store(overrides: Partial<PackStoreOptions> = {}) {
  return createPackStore({ bundled: BUNDLED, publicKeys: [KEY.spki], storage: memoryStorage().storage, fetchPack: null, url: URL_, ...overrides });
}

describe('pack store', () => {
  test('bundled-pack-is-signed', async () => {
    // What main imports (`?raw`) is the file's exact bytes: the signature covers what is verified.
    const file = fileURLToPath(new URL('../packs/serp-selectors.json', import.meta.url));
    const onDisk = new Uint8Array(await readFile(file));
    expect(Buffer.from(BUNDLED_PACK.bytes).equals(Buffer.from(onDisk))).toBe(true);
    expect(BUNDLED_PACK.signature.trim()).toBe((await readFile(`${file}.sig`, 'utf8')).trim());
    const result = verifyPack(BUNDLED_PACK.bytes, BUNDLED_PACK.signature, SERP_PACK_PUBLIC_KEYS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.version).toBe(1);
    expect(result.pack.engines.map((engine) => engine.id)).toEqual(['google', 'bing', 'duckduckgo']);
    const hosts = result.pack.engines.flatMap((engine) => engine.hosts);
    expect(hosts).toEqual(expect.arrayContaining(['www.google.com', 'www.google.co.uk', 'www.bing.com', 'duckduckgo.com', 'html.duckduckgo.com']));
    for (const engine of result.pack.engines) {
      expect(engine.layout.blocks.some((block) => block.type === 'organic' && block.required === true)).toBe(true);
      expect(engine.layout.blocks.every((block) => (SERP_RESULT_TYPES as readonly string[]).includes(block.type))).toBe(true);
    }
    // The real store, given the bundled pack and the embedded keys, uses it.
    expect(createPackStore({ bundled: BUNDLED_PACK, publicKeys: SERP_PACK_PUBLIC_KEYS, storage: memoryStorage().storage, fetchPack: null, url: SERP_PACK_REMOTE_URL }).current()).toMatchObject({ status: 'ready', source: 'bundled', version: 1 });
  });

  test('bundled-pack-invalid-disables', async () => {
    const tampered = { bytes: BUNDLED.bytes.slice(), signature: BUNDLED.signature };
    tampered.bytes[5] = tampered.bytes[5]! ^ 0x01;
    const { fetchPack, asked } = fakeFetch(remote(signedPack(KEY, { version: 9 })));
    const packs = store({ bundled: tampered, storage: memoryStorage(signedPack(KEY, { version: 8 })).storage, fetchPack });
    expect(packs.current()).toEqual({ status: 'pack-invalid' });
    expect(await packs.load()).toEqual({ status: 'pack-invalid' });
    expect(await packs.checkForUpdate()).toBe('disabled');
    expect(asked).toEqual([]);
    expect(packs.current()).toEqual({ status: 'pack-invalid' });
  });

  test('stored-pack-reverified-at-start', async () => {
    // Newer and verified: used.
    const newer = signedPack(KEY, { version: 4 });
    const used = store({ storage: memoryStorage(newer).storage });
    expect(used.current()).toMatchObject({ status: 'ready', source: 'bundled', version: 3 });
    expect(await used.load()).toMatchObject({ status: 'ready', source: 'remote', version: 4 });
    expect(used.current()).toMatchObject({ status: 'ready', source: 'remote', version: 4, pack: { version: 4 } });
    // Anything else: the bundled pack.
    const tampered = { bytes: newer.bytes.slice(), signature: newer.signature };
    tampered.bytes[20] = tampered.bytes[20]! ^ 0x01;
    const oversize = new Uint8Array(SELECTOR_PACK_LIMITS.maxPackBytes + 1).fill(0x20);
    oversize.set(newer.bytes);
    const garbage = encode('{"format":1,');
    const others: (PackFiles | null)[] = [
      null,
      tampered,
      { bytes: newer.bytes, signature: signBytes(newer.bytes, OTHER) },
      { bytes: garbage, signature: signBytes(garbage, KEY) },
      { bytes: oversize, signature: signBytes(oversize, KEY) },
      { bytes: newer.bytes, signature: 'not base64!' },
      signedPack(KEY, { version: 3 }),
      signedPack(KEY, { version: 2 }),
    ];
    for (const stored of others) {
      expect(await store({ storage: memoryStorage(stored).storage }).load()).toMatchObject({ status: 'ready', source: 'bundled', version: 3 });
    }
    expect(await store({ storage: memoryStorage(newer, { readFails: true }).storage }).load()).toMatchObject({ status: 'ready', source: 'bundled', version: 3 });
  });

  test('pack-rejects-forged-and-stale', async () => {
    const changed = signedPack(KEY, { version: 5 });
    const flipped = changed.bytes.slice();
    flipped[30] = flipped[30]! ^ 0x01;
    const invalid = encode({ format: 1, version: 5 });
    const cases: [Record<string, Uint8Array>, string][] = [
      [remote({ bytes: changed.bytes, signature: signBytes(changed.bytes, OTHER) }), 'bad-signature'],
      [remote({ bytes: flipped, signature: changed.signature }), 'bad-signature'],
      [{ [URL_]: changed.bytes, [`${URL_}.sig`]: encode('%%%') }, 'bad-signature'],
      [{ [URL_]: changed.bytes, [`${URL_}.sig`]: Uint8Array.of(0xff, 0xfe) }, 'bad-signature'],
      [remote({ bytes: invalid, signature: signBytes(invalid, KEY) }), 'invalid-pack'],
      [remote(signedPack(KEY, { version: 3 })), 'not-newer'],
      [remote(signedPack(KEY, { version: 1 })), 'not-newer'],
    ];
    for (const [files, outcome] of cases) {
      const { storage, writes } = memoryStorage();
      const packs = store({ storage, fetchPack: fakeFetch(files).fetchPack });
      const changedListener = vi.fn();
      packs.onChanged(changedListener);
      await packs.load();
      expect(await packs.checkForUpdate()).toBe(outcome);
      expect(packs.current()).toMatchObject({ status: 'ready', source: 'bundled', version: 3 });
      expect(writes).toEqual([]);
      expect(changedListener).not.toHaveBeenCalled();
    }
  });

  test('pack-update-installs-newer', async () => {
    const newer = signedPack(KEY, { version: 7 });
    const { storage, writes } = memoryStorage();
    const { fetchPack, asked } = fakeFetch(remote(newer));
    const packs = store({ storage, fetchPack });
    const listener = vi.fn();
    const unsubscribe = packs.onChanged(listener);
    await packs.load();
    expect(await packs.checkForUpdate()).toBe('installed');
    expect(asked).toEqual([
      { url: URL_, maxBytes: SERP_PACK_FETCH_LIMITS.maxBytes },
      { url: `${URL_}.sig`, maxBytes: SERP_PACK_FETCH_LIMITS.maxSignatureBytes },
    ]);
    expect(writes).toHaveLength(1);
    expect(Buffer.from(writes[0]!.bytes).equals(Buffer.from(newer.bytes))).toBe(true);
    expect(writes[0]!.signature.trim()).toBe(newer.signature);
    expect(packs.current()).toMatchObject({ status: 'ready', source: 'remote', version: 7 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', source: 'remote', version: 7 }));
    // Newer than the pack in use, not just the bundled one.
    expect(await packs.checkForUpdate()).toBe('not-newer');
    expect(writes).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);
    // It survives a restart: the stored pack is verified again and used.
    expect(await store({ storage }).load()).toMatchObject({ status: 'ready', source: 'remote', version: 7 });
    unsubscribe();
  });

  test('pack-update-outcomes', async () => {
    const newer = signedPack(KEY, { version: 7 });
    const files = remote(newer);
    const check = (fetched: Record<string, Uint8Array | 'unreachable' | 'too-large'>, overrides: Partial<PackStoreOptions> = {}) => store({ fetchPack: fakeFetch(fetched).fetchPack, ...overrides }).checkForUpdate();
    expect(await check({ [URL_]: 'unreachable' })).toBe('unreachable');
    expect(await check({ [URL_]: newer.bytes, [`${URL_}.sig`]: 'unreachable' })).toBe('unreachable');
    expect(await check({ [URL_]: 'too-large' })).toBe('too-large');
    // An oversize signature is not a signature.
    expect(await check({ [URL_]: newer.bytes, [`${URL_}.sig`]: 'too-large' })).toBe('bad-signature');
    // A fetch that hands back more than the cap anyway is still refused unread.
    const oversize = new Uint8Array(SELECTOR_PACK_LIMITS.maxPackBytes + 1).fill(0x20);
    oversize.set(newer.bytes);
    expect(await check(remote({ bytes: oversize, signature: signBytes(oversize, KEY) }))).toBe('too-large');
    expect(await store({ fetchPack: null }).checkForUpdate()).toBe('disabled');
    // Not https: nothing is requested (the e2e URL seam alone may be http).
    for (const url of ['http://packs.example.com/serp-selectors.json', 'file:///etc/passwd', 'not a url']) {
      const { fetchPack, asked } = fakeFetch({});
      expect(await store({ fetchPack, url }).checkForUpdate()).toBe('unreachable');
      expect(asked).toEqual([]);
    }
    const httpUrl = 'http://packs.example.com/serp-selectors.json';
    expect(await store({ fetchPack: fakeFetch({ [httpUrl]: newer.bytes, [`${httpUrl}.sig`]: encode(newer.signature) }).fetchPack, url: httpUrl, allowHttp: true }).checkForUpdate()).toBe('installed');
    // A write that fails still uses the verified pack for this run.
    const failing = memoryStorage(null, { writeFails: true });
    const packs = store({ storage: failing.storage, fetchPack: fakeFetch(files).fetchPack, log: () => {} });
    expect(await packs.checkForUpdate()).toBe('installed');
    expect(packs.current()).toMatchObject({ source: 'remote', version: 7 });
    // Every outcome has a message.
    for (const outcome of PACK_UPDATE_OUTCOMES) expect(PACK_UPDATE_MESSAGES[outcome].length).toBeGreaterThan(0);
  });

  test('pack-update-is-user-action-only', async () => {
    const { fetchPack, asked } = fakeFetch(remote(signedPack(KEY, { version: 7 })));
    const packs = store({ fetchPack, storage: memoryStorage(signedPack(KEY, { version: 4 })).storage });
    await packs.load();
    packs.current();
    expect(asked).toEqual([]);
    // Two checks at once share one run.
    const [first, second] = await Promise.all([packs.checkForUpdate(), packs.checkForUpdate()]);
    expect([first, second]).toEqual(['installed', 'installed']);
    expect(asked).toHaveLength(2);
    expect(await packs.checkForUpdate()).toBe('not-newer');
    expect(asked).toHaveLength(4);
  });
});

describe('pack fetch over the bounded fetcher', () => {
  const answer = (request: BoundedFetchRequest, patch: Partial<BoundedFetchResult> = {}): BoundedFetchResult => ({
    url: request.url,
    outcome: 'response',
    status: 200,
    finalUrl: request.url,
    redirects: 0,
    chain: [],
    headers: {},
    body: new Uint8Array(new TextEncoder().encode('{}')),
    truncated: false,
    durationMs: 1,
    ...patch,
  });
  function fakeFetcher(respond: (request: BoundedFetchRequest) => BoundedFetchResult) {
    const requests: BoundedFetchRequest[] = [];
    const fetcher: BoundedFetcher = {
      fetch: async (request) => {
        requests.push(request);
        return respond(request);
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    return { fetcher, requests };
  }

  test('pack-fetch-uses-checks-lane', async () => {
    const ok = fakeFetcher((request) => answer(request));
    expect(await boundedPackFetch(ok.fetcher)(URL_, 1_000)).toEqual({ ok: true, bytes: encode('{}') });
    expect(ok.requests).toEqual([expect.objectContaining({ url: URL_, page: URL_, method: 'GET', maxBytes: 1_000, timeoutMs: SERP_PACK_FETCH_LIMITS.timeoutMs, maxRedirects: SERP_PACK_FETCH_LIMITS.maxRedirects, userAgent: null })]);
    // A redirect to the download host over https is followed.
    const redirected = fakeFetcher((request) => answer(request, { finalUrl: 'https://downloads.example.net/x', redirects: 1, chain: [{ url: request.url, status: 302, location: 'https://downloads.example.net/x' }] }));
    expect(await boundedPackFetch(redirected.fetcher)(URL_, 1_000)).toMatchObject({ ok: true });
    const cases: [Partial<BoundedFetchResult>, string][] = [
      [{ truncated: true }, 'too-large'],
      [{ status: 404 }, 'unreachable'],
      [{ status: 206 }, 'unreachable'],
      [{ outcome: 'timeout', status: null }, 'unreachable'],
      [{ outcome: 'busy', status: null }, 'unreachable'],
      [{ outcome: 'private-address', status: null }, 'unreachable'],
      [{ finalUrl: 'http://downloads.example.net/x', redirects: 1, chain: [{ url: URL_, status: 302, location: 'http://downloads.example.net/x' }] }, 'unreachable'],
    ];
    for (const [patch, reason] of cases) {
      expect(await boundedPackFetch(fakeFetcher((request) => answer(request, patch)).fetcher)(URL_, 1_000)).toEqual({ ok: false, reason });
    }
    // An http URL is never requested, unless allowed (the e2e URL seam).
    const http = fakeFetcher((request) => answer(request));
    expect(await boundedPackFetch(http.fetcher)('http://packs.example.com/p.json', 1_000)).toEqual({ ok: false, reason: 'unreachable' });
    expect(http.requests).toEqual([]);
    expect(await boundedPackFetch(http.fetcher, { allowHttp: true })('http://packs.example.com/p.json', 1_000)).toMatchObject({ ok: true });
  });
});

describe('file storage', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  test('pack-file-storage-is-atomic', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'frost-pack-'));
    const packDir = path.join(dir, 'serp-selectors');
    const storage = fileStorage(packDir);
    expect(await storage.read()).toBeNull();
    const pack = signedPack(KEY);
    await storage.write(pack.bytes, pack.signature);
    expect((await readdir(packDir)).sort()).toEqual([SERP_PACK_FILE, SERP_PACK_SIGNATURE_FILE].sort());
    const read = await storage.read();
    expect(read && Buffer.from(read.bytes).equals(Buffer.from(pack.bytes))).toBe(true);
    expect(read?.signature.trim()).toBe(pack.signature);
    // Overwrites in place, leaving no temporary files.
    const next = signedPack(KEY, { version: 9 });
    await storage.write(next.bytes, next.signature);
    expect((await readdir(packDir)).sort()).toEqual([SERP_PACK_FILE, SERP_PACK_SIGNATURE_FILE].sort());
    expect(verifyPack((await storage.read())!.bytes, (await storage.read())!.signature, [KEY.spki])).toMatchObject({ ok: true, pack: { version: 9 } });
    // An oversize file is read no further than one byte past the cap (so verifyPack refuses it as too large).
    await writeFile(path.join(packDir, SERP_PACK_FILE), new Uint8Array(SELECTOR_PACK_LIMITS.maxPackBytes + 10_000));
    const big = await storage.read();
    expect(big?.bytes.byteLength).toBe(SELECTOR_PACK_LIMITS.maxPackBytes + 1);
    // A pack without its signature is no pack.
    await rm(path.join(packDir, SERP_PACK_SIGNATURE_FILE));
    expect(await storage.read()).toBeNull();
  });

  test('pack-e2e-switches-refused-when-packaged', () => {
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(SERP_E2E_PACK_KEY_SWITCH);
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(SERP_E2E_PACK_URL_SWITCH);
  });
});
