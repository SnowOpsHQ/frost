import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import { INTENT_DOWNLOAD_LIMITS, INTENT_MODEL, INTENT_MODEL_DIR, type IntentEnableOutcome, type IntentModelFile } from '@app/specs/intent-classifier.spec';

// The intent model on disk (spec `intent-classifier.spec.ts`, The model; acceptance
// `intent-classifier.feature.md`, Model download). The model and its vocabulary are downloaded only
// by `download()` (the user's "Enable on-device intent"), each through the bounded fetcher's `checks`
// lane, capped at its pinned size plus slack; a file is written (atomically, to
// `userData/models/<model id>/`) only once its length and sha256 are the pinned ones, so a mismatch
// is never kept. `load()` reads both again, no further than one byte past their pins, and hashes them
// every time: a file that no longer matches is removed and the model is `model-missing`. Main hands
// the checked bytes to the utility process (`host.ts`); the process never opens them itself. The
// disk and the network are injected (`ModelStorage`, `ModelFetch`); `fileModelStorage` and
// `boundedModelFetch` are the real ones (`setup.ts`).

/** One pinned file: its name in the model directory, its URL, sha256 (hex) and exact size. */
export interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}
export type PinnedFiles = Readonly<Record<IntentModelFile, PinnedFile>>;

/** The spec's pins (`INTENT_MODEL.files`). */
export const DEFAULT_PINNED_FILES: PinnedFiles = INTENT_MODEL.files;

/** The model's directory under `userData`. */
export const intentModelDir = (userData: string): string => path.join(userData, INTENT_MODEL_DIR, INTENT_MODEL.id);

/** The model directory: files by name (a plain file name, never a path). */
export interface ModelStorage {
  /** The file's size, or `null` when there is none. */
  size(name: string): Promise<number | null>;
  /** At most `maxBytes` of the file, or `null` when there is none. */
  read(name: string, maxBytes: number): Promise<Uint8Array | null>;
  /** Replaces the file atomically. */
  write(name: string, bytes: Uint8Array): Promise<void>;
  /** Removes the file (nothing when there is none). */
  remove(name: string): Promise<void>;
}

/** How fetching one file ended: its bytes, or why not (`too-large`: longer than `maxBytes`). */
export type ModelFetchResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: 'unreachable' | 'too-large' };

/** Fetches `url`, reading at most `maxBytes` of it. */
export type ModelFetch = (url: string, maxBytes: number) => Promise<ModelFetchResult>;

/** The checked model and vocabulary, or `model-missing`. */
export type ModelLoadResult = { readonly ok: true; readonly model: Uint8Array; readonly vocab: string } | { readonly ok: false; readonly reason: 'model-missing' };

export interface ModelStoreOptions {
  readonly storage: ModelStorage;
  /** The network (`boundedModelFetch` over the `checks` lane); `null`: downloads are `disabled`. */
  readonly fetchFile: ModelFetch | null;
  /** The pins (the spec's; tests pin small files of their own). */
  readonly files?: PinnedFiles;
  readonly log?: (message: string) => void;
}

export interface ModelStore {
  /** Whether both files are there at their pinned sizes (a quick check; `load()` hashes them). Never fetches. */
  present(): Promise<boolean>;
  /** The user's "Enable on-device intent": fetches what is missing or wrong, checks it, stores it. Concurrent calls share one run. */
  download(): Promise<IntentEnableOutcome>;
  /** Reads and checks both files (every time); a mismatch is removed and `model-missing`. Never fetches. */
  load(): Promise<ModelLoadResult>;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Whether `bytes` is exactly the pinned file. */
const matches = (bytes: Uint8Array, file: PinnedFile): boolean => bytes.byteLength === file.bytes && sha256Hex(bytes) === file.sha256;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The vocabulary first: it is small, so a host that is down fails before 23 MB are asked for. */
const ORDER: readonly IntentModelFile[] = ['vocab', 'model'];

export function createModelStore(options: ModelStoreOptions): ModelStore {
  const { storage, fetchFile } = options;
  const files = options.files ?? DEFAULT_PINNED_FILES;
  const log = options.log ?? (() => {});

  /** The stored file if it is exactly the pinned one; `null` otherwise (missing, wrong, unreadable). */
  async function stored(file: PinnedFile): Promise<Uint8Array | null> {
    try {
      const bytes = await storage.read(file.name, file.bytes + 1);
      return bytes !== null && matches(bytes, file) ? bytes : null;
    } catch (error) {
      log(`intent: ${file.name} could not be read: ${message(error)}`);
      return null;
    }
  }

  async function fetchOne(file: PinnedFile): Promise<IntentEnableOutcome> {
    if ((await stored(file)) !== null) return 'ready';
    let fetched: ModelFetchResult;
    try {
      fetched = await fetchFile!(file.url, file.bytes + INTENT_DOWNLOAD_LIMITS.slackBytes);
    } catch {
      fetched = { ok: false, reason: 'unreachable' };
    }
    if (!fetched.ok) return fetched.reason;
    if (fetched.bytes.byteLength > file.bytes) return 'too-large';
    if (!matches(fetched.bytes, file)) {
      log(`intent: ${file.name} does not match its pinned sha256; not kept`);
      return 'integrity';
    }
    try {
      await storage.write(file.name, fetched.bytes);
    } catch (error) {
      log(`intent: ${file.name} could not be stored: ${message(error)}`);
      return 'storage';
    }
    return 'ready';
  }

  async function download(): Promise<IntentEnableOutcome> {
    if (fetchFile === null) return 'disabled';
    for (const key of ORDER) {
      const outcome = await fetchOne(files[key]);
      if (outcome !== 'ready') return outcome;
    }
    return 'ready';
  }

  let running: Promise<IntentEnableOutcome> | null = null;

  return {
    async present() {
      for (const key of ORDER) {
        try {
          if ((await storage.size(files[key].name)) !== files[key].bytes) return false;
        } catch {
          return false;
        }
      }
      return true;
    },
    download() {
      running ??= download().finally(() => {
        running = null;
      });
      return running;
    },
    async load() {
      const model = await stored(files.model);
      const vocabBytes = await stored(files.vocab);
      let vocab: string | null = null;
      try {
        if (vocabBytes !== null) vocab = new TextDecoder('utf-8', { fatal: true }).decode(vocabBytes);
      } catch {
        vocab = null;
      }
      if (model !== null && vocab !== null) return { ok: true, model, vocab };
      // Whatever no longer matches goes, so enabling again downloads it.
      for (const [file, ok] of [
        [files.model, model !== null],
        [files.vocab, vocab !== null],
      ] as const) {
        if (ok) continue;
        try {
          if ((await storage.size(file.name)) !== null) {
            log(`intent: ${file.name} no longer matches its pinned sha256; removed`);
            await storage.remove(file.name);
          }
        } catch (error) {
          log(`intent: ${file.name} could not be removed: ${message(error)}`);
        }
      }
      return { ok: false, reason: 'model-missing' };
    },
  };
}

// ---- The real disk and network ----------------------------------------------------------------

/** A plain file name (no separators, not `.` or `..`). */
function fileIn(dir: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || name !== path.basename(name) || name.includes('/') || name.includes('\\')) throw new Error(`not a model file name: ${name}`);
  return path.join(dir, name);
}

/**
 * The model directory `dir` (main: `intentModelDir(userData)`). Reads stop at `maxBytes` (the store
 * asks for one byte past a pin, so a longer file is refused, never read whole). Writes go to a
 * temporary file beside the target, flushed, then renamed over it; private to the user.
 */
export function fileModelStorage(dir: string): ModelStorage {
  return {
    async size(name) {
      try {
        const info = await stat(fileIn(dir, name));
        return info.isFile() ? info.size : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async read(name, maxBytes) {
      let handle;
      try {
        handle = await open(fileIn(dir, name), 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const buffer = new Uint8Array(maxBytes);
        let length = 0;
        while (length < maxBytes) {
          const { bytesRead } = await handle.read(buffer, length, maxBytes - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        return length === maxBytes ? buffer : buffer.subarray(0, length);
      } finally {
        await handle.close();
      }
    },
    async write(name, bytes) {
      const file = fileIn(dir, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temp, bytes, { mode: 0o600, flush: true });
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    async remove(name) {
      await rm(fileIn(dir, name), { force: true });
    },
  };
}

/** Whether a model file may be fetched from (or redirected through) `url`: `https:` only. */
function isAllowedModelUrl(url: string): boolean {
  try {
    return (INTENT_DOWNLOAD_LIMITS.schemes as readonly string[]).includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The store's fetch over a bounded fetcher (main: the `checks` lane, `fetcher.spec.ts`): a GET with
 * frost's own user agent, no cookies, the file's URL as the request's page (so a private host is
 * never requested: the URLs are public), `maxBytes` the cap the store asks for, and
 * `INTENT_DOWNLOAD_LIMITS`' deadline and redirect cap. `https:` only, the URL, every redirect (the
 * repository host sends files to its CDN host) and the final URL; a 200 is the file, a body past the
 * cap `too-large`, anything else `unreachable`.
 */
export function boundedModelFetch(fetcher: BoundedFetcher): ModelFetch {
  return async (url, maxBytes) => {
    if (!isAllowedModelUrl(url)) return { ok: false, reason: 'unreachable' };
    const result = await fetcher.fetch({
      url,
      page: url,
      method: 'GET',
      userAgent: null,
      maxBytes,
      timeoutMs: INTENT_DOWNLOAD_LIMITS.timeoutMs,
      maxRedirects: INTENT_DOWNLOAD_LIMITS.maxRedirects,
    });
    if (result.outcome !== 'response' || result.status !== 200) return { ok: false, reason: 'unreachable' };
    const hops = [...result.chain.map((hop) => hop.location), result.finalUrl ?? ''];
    if (!hops.every(isAllowedModelUrl)) return { ok: false, reason: 'unreachable' };
    if (result.truncated) return { ok: false, reason: 'too-large' };
    return { ok: true, bytes: result.body };
  };
}
