// Spec: specs/intent-classifier.spec.ts (The model; INTENT_MODEL, INTENT_MODEL_DIR,
// INTENT_DOWNLOAD_LIMITS, INTENT_ENABLE_OUTCOMES); specs/fetcher.spec.ts (Lanes: checks)
// Acceptance: specs/intent-classifier.feature.md (Model download)
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { BoundedFetcher, BoundedFetchRequest, BoundedFetchResult } from '@app/specs/fetcher.spec';
import { INTENT_DOWNLOAD_LIMITS, INTENT_ENABLE_OUTCOMES, INTENT_MODEL, INTENT_MODEL_DIR } from '@app/specs/intent-classifier.spec';
import { boundedModelFetch, createModelStore, DEFAULT_PINNED_FILES, fileModelStorage, intentModelDir, type ModelFetch, type ModelStorage, type PinnedFiles } from '../model-store';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();

const MODEL_BYTES = encoder.encode('a tiny model standing in for the onnx file');
const VOCAB_BYTES = encoder.encode('[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello\n');
const PINS: PinnedFiles = {
  model: { name: 'model.onnx', url: 'https://models.example.com/rev/model.onnx', sha256: sha256(MODEL_BYTES), bytes: MODEL_BYTES.byteLength },
  vocab: { name: 'vocab.txt', url: 'https://models.example.com/rev/vocab.txt', sha256: sha256(VOCAB_BYTES), bytes: VOCAB_BYTES.byteLength },
};

/** An in-memory model directory, recording writes and removals. */
function memoryStorage(initial: Record<string, Uint8Array> = {}, options: { writeFails?: boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const removed: string[] = [];
  const reads: { name: string; maxBytes: number }[] = [];
  const storage: ModelStorage = {
    size: async (name) => files.get(name)?.byteLength ?? null,
    read: async (name, maxBytes) => {
      reads.push({ name, maxBytes });
      const bytes = files.get(name);
      return bytes === undefined ? null : bytes.slice(0, maxBytes);
    },
    write: async (name, bytes) => {
      if (options.writeFails) throw new Error('ENOSPC');
      writes.push(name);
      files.set(name, bytes);
    },
    remove: async (name) => {
      removed.push(name);
      files.delete(name);
    },
  };
  return { storage, files, writes, removed, reads };
}

/** A fetch answering `answers` (URL → bytes or failure), recording each URL and cap asked for. */
function fakeFetch(answers: Record<string, Uint8Array | 'unreachable' | 'too-large'>) {
  const asked: { url: string; maxBytes: number }[] = [];
  const fetchFile: ModelFetch = async (url, maxBytes) => {
    asked.push({ url, maxBytes });
    const answer = answers[url];
    if (answer === undefined || answer === 'unreachable') return { ok: false, reason: 'unreachable' };
    if (answer === 'too-large') return { ok: false, reason: 'too-large' };
    if (answer.byteLength > maxBytes) return { ok: false, reason: 'too-large' };
    return { ok: true, bytes: answer };
  };
  return { fetchFile, asked };
}

const GOOD = { [PINS.model.url]: MODEL_BYTES, [PINS.vocab.url]: VOCAB_BYTES };

describe('intent model store', () => {
  test('intent-model-pinned-by-sha256 (the pins are the spec’s)', () => {
    expect(DEFAULT_PINNED_FILES).toBe(INTENT_MODEL.files);
    for (const file of Object.values(INTENT_MODEL.files)) {
      expect(file.url.startsWith(`https://${INTENT_MODEL.host}/`)).toBe(true);
      expect(file.url).toContain(`/resolve/${INTENT_MODEL.revision}/`);
      expect(file.url.endsWith(`/${file.name}`)).toBe(true);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(file.bytes) && file.bytes > 0).toBe(true);
    }
    expect(intentModelDir('/profile')).toBe(path.join('/profile', INTENT_MODEL_DIR, INTENT_MODEL.id));
  });

  test('intent-model-pinned-by-sha256 (a mismatch is refused and never written)', async () => {
    const { storage, writes, files } = memoryStorage();
    const tampered = MODEL_BYTES.slice();
    tampered[0] = tampered[0]! ^ 1;
    const { fetchFile } = fakeFetch({ ...GOOD, [PINS.model.url]: tampered });
    const store = createModelStore({ storage, fetchFile, files: PINS });
    expect(await store.download()).toBe('integrity');
    expect(writes).not.toContain(PINS.model.name);
    expect(files.has(PINS.model.name)).toBe(false);
    expect(await store.present()).toBe(false);

    // A file of the wrong length (shorter) is refused the same way.
    const short = fakeFetch({ ...GOOD, [PINS.vocab.url]: VOCAB_BYTES.slice(1) });
    const shortStore = memoryStorage();
    expect(await createModelStore({ storage: shortStore.storage, fetchFile: short.fetchFile, files: PINS }).download()).toBe('integrity');
    expect(shortStore.writes).toEqual([]);
  });

  test('intent-model-download-verifies-then-writes', async () => {
    const { storage, writes, files } = memoryStorage();
    const { fetchFile, asked } = fakeFetch(GOOD);
    const store = createModelStore({ storage, fetchFile, files: PINS });
    expect(await store.present()).toBe(false);
    expect(await store.download()).toBe('ready');
    // The vocabulary first (small), then the model; each capped at its pinned size plus slack.
    expect(asked).toEqual([
      { url: PINS.vocab.url, maxBytes: PINS.vocab.bytes + INTENT_DOWNLOAD_LIMITS.slackBytes },
      { url: PINS.model.url, maxBytes: PINS.model.bytes + INTENT_DOWNLOAD_LIMITS.slackBytes },
    ]);
    expect(writes).toEqual([PINS.vocab.name, PINS.model.name]);
    expect([...files.get(PINS.model.name)!]).toEqual([...MODEL_BYTES]);
    expect(await store.present()).toBe(true);
    // Already there and still matching: nothing is fetched again.
    expect(await store.download()).toBe('ready');
    expect(asked).toHaveLength(2);
  });

  test('intent-model-oversize-refused', async () => {
    const { storage, writes } = memoryStorage();
    const { fetchFile } = fakeFetch({ ...GOOD, [PINS.model.url]: 'too-large' });
    expect(await createModelStore({ storage, fetchFile, files: PINS }).download()).toBe('too-large');
    // A body longer than the pin but within the slack is still not the pinned file.
    const longer = new Uint8Array(MODEL_BYTES.byteLength + 10);
    const { fetchFile: longerFetch } = fakeFetch({ ...GOOD, [PINS.model.url]: longer });
    expect(await createModelStore({ storage, fetchFile: longerFetch, files: PINS }).download()).toBe('too-large');
    expect(writes).not.toContain(PINS.model.name);
  });

  test('intent-model-download-outcomes', async () => {
    const unreachable = fakeFetch({ [PINS.vocab.url]: VOCAB_BYTES });
    expect(await createModelStore({ storage: memoryStorage().storage, fetchFile: unreachable.fetchFile, files: PINS }).download()).toBe('unreachable');
    expect(await createModelStore({ storage: memoryStorage().storage, fetchFile: null, files: PINS }).download()).toBe('disabled');
    const failing = memoryStorage({}, { writeFails: true });
    expect(await createModelStore({ storage: failing.storage, fetchFile: fakeFetch(GOOD).fetchFile, files: PINS }).download()).toBe('storage');
    const thrown: ModelFetch = async () => {
      throw new Error('boom');
    };
    expect(await createModelStore({ storage: memoryStorage().storage, fetchFile: thrown, files: PINS }).download()).toBe('unreachable');
    for (const outcome of ['ready', 'unreachable', 'too-large', 'integrity', 'storage', 'disabled']) expect(INTENT_ENABLE_OUTCOMES).toContain(outcome);
  });

  test('intent-model-download-is-user-action-only', async () => {
    const { storage } = memoryStorage();
    const { fetchFile, asked } = fakeFetch(GOOD);
    const store = createModelStore({ storage, fetchFile, files: PINS });
    await store.present();
    expect(await store.load()).toEqual({ ok: false, reason: 'model-missing' });
    expect(asked).toEqual([]);
    // Concurrent enables share one download.
    const [first, second] = await Promise.all([store.download(), store.download()]);
    expect([first, second]).toEqual(['ready', 'ready']);
    expect(asked).toHaveLength(2);
  });

  test('intent-model-rehashed-on-load', async () => {
    const good = memoryStorage({ [PINS.model.name]: MODEL_BYTES, [PINS.vocab.name]: VOCAB_BYTES });
    const loaded = await createModelStore({ storage: good.storage, fetchFile: null, files: PINS }).load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('not loaded');
    expect([...loaded.model]).toEqual([...MODEL_BYTES]);
    expect(loaded.vocab).toBe(new TextDecoder().decode(VOCAB_BYTES));
    // Read no further than one byte past the pin.
    expect(good.reads).toEqual(expect.arrayContaining([{ name: PINS.model.name, maxBytes: PINS.model.bytes + 1 }]));

    // A file changed on disk since it was checked is model-missing, and removed (so enabling again downloads it).
    const corrupt = MODEL_BYTES.slice();
    corrupt[3] = corrupt[3]! ^ 0xff;
    const bad = memoryStorage({ [PINS.model.name]: corrupt, [PINS.vocab.name]: VOCAB_BYTES });
    const store = createModelStore({ storage: bad.storage, fetchFile: null, files: PINS });
    expect(await store.present()).toBe(true);
    expect(await store.load()).toEqual({ ok: false, reason: 'model-missing' });
    expect(bad.removed).toEqual([PINS.model.name]);
    expect(await store.present()).toBe(false);

    // A longer file is never read whole, and is model-missing too.
    const longer = memoryStorage({ [PINS.model.name]: new Uint8Array(PINS.model.bytes + 100), [PINS.vocab.name]: VOCAB_BYTES });
    expect(await createModelStore({ storage: longer.storage, fetchFile: null, files: PINS }).load()).toEqual({ ok: false, reason: 'model-missing' });
  });

  test('intent-model-file-storage-is-atomic', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frost-intent-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const modelDir = path.join(dir, 'models', 'm');
    const storage = fileModelStorage(modelDir);
    expect(await storage.size('model.onnx')).toBeNull();
    expect(await storage.read('model.onnx', 10)).toBeNull();
    await storage.write('model.onnx', MODEL_BYTES);
    expect(await storage.size('model.onnx')).toBe(MODEL_BYTES.byteLength);
    expect([...(await storage.read('model.onnx', 1_000))!]).toEqual([...MODEL_BYTES]);
    expect((await storage.read('model.onnx', 4))!.byteLength).toBe(4);
    expect(await readdir(modelDir)).toEqual(['model.onnx']);
    await storage.remove('model.onnx');
    await storage.remove('model.onnx');
    expect(await readdir(modelDir)).toEqual([]);
    // A name is a file name, never a path.
    await expect(storage.write('../escape', MODEL_BYTES)).rejects.toThrow(/name/);
    await writeFile(path.join(modelDir, 'x'), 'y');
    expect(await readFile(path.join(modelDir, 'x'), 'utf8')).toBe('y');
  });

  test('intent-model-download-uses-checks-lane', async () => {
    const requests: BoundedFetchRequest[] = [];
    const answer = (partial: Partial<BoundedFetchResult>): BoundedFetchResult => ({
      url: '',
      outcome: 'response',
      status: 200,
      finalUrl: 'https://cdn.models.example.com/x',
      redirects: 1,
      chain: [{ url: 'https://models.example.com/x', status: 302, location: 'https://cdn.models.example.com/x' }],
      headers: {},
      body: new Uint8Array([1, 2, 3]),
      truncated: false,
      durationMs: 1,
      ...partial,
    });
    let next = answer({});
    const fetcher: BoundedFetcher = {
      fetch: async (request) => {
        requests.push(request);
        return next;
      },
      load: () => ({ running: 0, queued: 0 }),
    };
    const fetchFile = boundedModelFetch(fetcher);
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
    expect(requests[0]).toEqual({
      url: 'https://models.example.com/x',
      page: 'https://models.example.com/x',
      method: 'GET',
      userAgent: null,
      maxBytes: 100,
      timeoutMs: INTENT_DOWNLOAD_LIMITS.timeoutMs,
      maxRedirects: INTENT_DOWNLOAD_LIMITS.maxRedirects,
    });
    next = answer({ truncated: true });
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: false, reason: 'too-large' });
    next = answer({ status: 404 });
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: false, reason: 'unreachable' });
    next = answer({ outcome: 'timeout', status: null });
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: false, reason: 'unreachable' });
    next = answer({ finalUrl: 'http://cdn.models.example.com/x' });
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: false, reason: 'unreachable' });
    next = answer({ chain: [{ url: 'https://models.example.com/x', status: 302, location: 'http://cdn.models.example.com/x' }] });
    expect(await fetchFile('https://models.example.com/x', 100)).toEqual({ ok: false, reason: 'unreachable' });
    const before = requests.length;
    expect(await fetchFile('http://models.example.com/x', 100)).toEqual({ ok: false, reason: 'unreachable' });
    expect(requests).toHaveLength(before);
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
