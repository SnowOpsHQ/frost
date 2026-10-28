import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import { INTENT_DOWNLOAD_LIMITS, INTENT_MODEL, INTENT_MODEL_DIR, type IntentEnableOutcome, type IntentModelFile } from '@app/specs/intent-classifier.spec';

// The intent model on disk (spec `intent-classifier.spec.ts`, The model; acceptance
// `intent-classifier.feature.md`, Model download). The model and its vocabulary are downloaded only
// by `download()` (the user's "Enable on-device intent"), each through the bounded fetcher's `checks`
// lane, capped at its pinned size plus slack; a file is written (atomically, to
// `userData/models/<model id>/`) only once its length and sha256 are the pinned ones, so a mismatch
// is never kept. `load()` reads both again, no further than one byte past their pins, and hashes them
// every time: a file that reads but no longer matches is removed and the model is `model-missing`; a
// file that cannot be read (permissions, I/O) is left alone and the model is `unreadable` for now.
// Downloads and loads run one at a time (one lock), so a load never judges (or removes) a file a
// download is replacing; each first sweeps temporary files a crash left behind. Main hands
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
  /** Removes temporary files an interrupted `write` left behind. */
  clean(): Promise<void>;
}

/** How fetching one file ended: its bytes, or why not (`too-large`: longer than `maxBytes`). */
export type ModelFetchResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: 'unreachable' | 'too-large' };

/** Fetches `url`, reading at most `maxBytes` of it. */
export type ModelFetch = (url: string, maxBytes: number) => Promise<ModelFetchResult>;

/**
 * The checked model and vocabulary; or `model-missing` (a file is missing or no longer matches its
 * pin); or `unreadable` (a file is there but could not be read: it is left as it is).
 */
export type ModelLoadResult = { readonly ok: true; readonly model: Uint8Array; readonly vocab: string } | { readonly ok: false; readonly reason: 'model-missing' | 'unreadable' };

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
  /** Reads and checks both files (every time); a mismatch is removed and `model-missing`, a read error `unreadable`. Never fetches. */
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

  /** The stored file: exactly the pinned one (`ok`), not there (`missing`), there but different (`mismatch`), or not readable (`error`). */
  async function stored(file: PinnedFile): Promise<{ readonly kind: 'ok'; readonly bytes: Uint8Array } | { readonly kind: 'missing' | 'mismatch' | 'error' }> {
    let bytes: Uint8Array | null;
    try {
      bytes = await storage.read(file.name, file.bytes + 1);
    } catch (error) {
      log(`intent: ${file.name} could not be read: ${message(error)}`);
      return { kind: 'error' };
    }
    if (bytes === null) return { kind: 'missing' };
    return matches(bytes, file) ? { kind: 'ok', bytes } : { kind: 'mismatch' };
  }

  /** Runs `task` after every download and load before it (one at a time). */
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = lock.then(async () => {
      try {
        await storage.clean();
      } catch (error) {
        log(`intent: leftover temporary files could not be removed: ${message(error)}`);
      }
      return task();
    });
    lock = run.catch(() => undefined);
    return run;
  }

  async function fetchOne(file: PinnedFile): Promise<IntentEnableOutcome> {
    if ((await stored(file)).kind === 'ok') return 'ready';
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

  async function load(): Promise<ModelLoadResult> {
    const model = await stored(files.model);
    const vocab = await stored(files.vocab);
    // Only a file that was read and does not match goes (so enabling again downloads it); one that
    // could not be read is left as it is.
    for (const [file, result] of [
      [files.model, model],
      [files.vocab, vocab],
    ] as const) {
      if (result.kind !== 'mismatch') continue;
      log(`intent: ${file.name} no longer matches its pinned sha256; removed`);
      try {
        await storage.remove(file.name);
      } catch (error) {
        log(`intent: ${file.name} could not be removed: ${message(error)}`);
      }
    }
    if (model.kind === 'error' || vocab.kind === 'error') return { ok: false, reason: 'unreadable' };
    if (model.kind !== 'ok' || vocab.kind !== 'ok') return { ok: false, reason: 'model-missing' };
    // The pinned vocabulary is UTF-8 (its sha256 matched), so this does not fail.
    return { ok: true, model: model.bytes, vocab: new TextDecoder('utf-8', { fatal: true }).decode(vocab.bytes) };
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
      running ??= exclusive(download).finally(() => {
        running = null;
      });
      return running;
    },
    load: () => exclusive(load),
  };
}

// ---- The real disk and network ----------------------------------------------------------------

/** A plain file name (no separators, not `.` or `..`). */
function fileIn(dir: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || name !== path.basename(name) || name.includes('/') || name.includes('\\')) throw new Error(`not a model file name: ${name}`);
  return path.join(dir, name);
}

/** A temporary file `write` makes beside its target (`<name>.<pid>.<12 hex>.tmp`). */
const TEMP_FILE = /^[^/\\]+\.\d+\.[0-9a-f]{12}\.tmp$/;

/**
 * The model directory `dir` (main: `intentModelDir(userData)`). Reads stop at `maxBytes` (the store
 * asks for one byte past a pin, so a longer file is refused, never read whole). Writes go to a
 * temporary file beside the target, flushed, then renamed over it; private to the user. `clean`
 * removes temporary files a crash mid-write left behind.
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
    async clean() {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) if (TEMP_FILE.test(entry)) await rm(path.join(dir, entry), { force: true });
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
 * cap `too-large`, anything else `unreachable`. The URL is checked before the request; the hops are
 * checked once the answer is in (the fetcher follows them itself, each checked for private
 * addresses). What makes the file trustworthy is its sha256 pin, checked by the store before it is
 * written, not the transport (spec, Known limits).
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
