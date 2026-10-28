import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BoundedFetcher } from '@app/specs/fetcher.spec';
import {
  SELECTOR_PACK_LIMITS,
  SERP_PACK_FETCH_LIMITS,
  SERP_PACK_FILE,
  SERP_PACK_SIGNATURE_FILE,
  packSignatureUrl,
  type PackSource,
  type PackUpdateOutcome,
} from '@app/specs/serp-selector-pack.spec';
import type { SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { verifyPack } from './pack-verify';

// The selector pack in use (spec `serp-selector-pack.spec.ts`, trust model; acceptance
// `serp-selector-pack.feature.md`, Store; review focus `pack-rejects-forged-and-stale`): the
// bundled pack, verified when the store is created; a stored remote pack, verified again by
// `load()` at every start and used only if newer; and a remote pack fetched only by
// `checkForUpdate()` (a user action), verified, and used only if newer than the one in use. Every
// pack goes through `verifyPack` (size, signature, then parse); a refusal changes nothing. The disk
// and the network are injected (`PackStorage`, `PackFetch`); `fileStorage` and `boundedPackFetch`
// are the real ones main wires (Task 4).

/** A pack file's exact bytes and its `.sig` text. */
export interface PackFiles {
  readonly bytes: Uint8Array;
  readonly signature: string;
}

/** Where an installed remote pack is kept (`userData/serp-selectors/`, `fileStorage`). */
export interface PackStorage {
  /** The stored pack and signature; `null` when there is none (or only half of one). Rejects on a read error. */
  read(): Promise<PackFiles | null>;
  /** Replaces the stored pack and signature (atomically per file). */
  write(bytes: Uint8Array, signature: string): Promise<void>;
}

/** How fetching one file ended: its bytes, or why not (`too-large`: longer than `maxBytes`). */
export type PackFetchResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: 'unreachable' | 'too-large' };

/** Fetches `url`, reading at most `maxBytes` of it. */
export type PackFetch = (url: string, maxBytes: number) => Promise<PackFetchResult>;

/**
 * The pack in use: `ready` with the pack, where it came from and its version, or `pack-invalid`
 * when the bundled pack failed verification (SERP reading is disabled; Task 3's `pack-invalid`).
 */
export type ActivePack =
  | { readonly status: 'ready'; readonly pack: SelectorPack; readonly source: PackSource; readonly version: number }
  | { readonly status: 'pack-invalid' };

export interface PackStoreOptions {
  /** The pack bundled with the app (`bundled.ts`: the raw text main's build imports). */
  readonly bundled: PackFiles;
  /** Trusted keys (`SERP_PACK_PUBLIC_KEYS`, plus the e2e seam's in unpackaged builds). */
  readonly publicKeys: readonly string[];
  readonly storage: PackStorage;
  /** The network (`boundedPackFetch` over the `checks` lane); `null`: updates are `disabled`. */
  readonly fetchPack: PackFetch | null;
  /** The remote pack's URL (`SERP_PACK_REMOTE_URL`, or the e2e seam's); its signature is beside it. */
  readonly url: string;
  /** Allow an `http:` URL (only the e2e URL seam, in unpackaged builds). */
  readonly allowHttp?: boolean;
  /** One line per refusal or storage failure (main's log). */
  readonly log?: (message: string) => void;
}

export interface PackStore {
  /** The pack in use now. */
  current(): ActivePack;
  /** At start: verifies the stored pack and uses it if it is newer than the one in use. Never fetches. */
  load(): Promise<ActivePack>;
  /** The user's "Check for selector updates": fetch, verify, and install a newer pack. Concurrent calls share one run. */
  checkForUpdate(): Promise<PackUpdateOutcome>;
  /** Called with the new pack whenever the pack in use changes; returns the unsubscribe. */
  onChanged(listener: (active: ActivePack) => void): () => void;
}

/** Whether a pack may be fetched from (or redirected through) `url`: `https:` only, or `http:` too when `allowHttp`. */
export function isAllowedPackUrl(url: string, allowHttp = false): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return (SERP_PACK_FETCH_LIMITS.schemes as readonly string[]).includes(protocol) || (allowHttp && protocol === 'http:');
}

/** A `.sig` body as text (`null` when it is not UTF-8, so not a signature). */
function signatureText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createPackStore(options: PackStoreOptions): PackStore {
  const { storage, fetchPack, url, publicKeys } = options;
  const allowHttp = options.allowHttp ?? false;
  const log = options.log ?? (() => {});
  const listeners = new Set<(active: ActivePack) => void>();

  const bundled = verifyPack(options.bundled.bytes, options.bundled.signature, publicKeys);
  if (!bundled.ok) log(`serp: the bundled selector pack was refused (${bundled.reason}); SERP reading is disabled`);
  let active: ActivePack = bundled.ok ? { status: 'ready', pack: bundled.pack, source: 'bundled', version: bundled.pack.version } : { status: 'pack-invalid' };

  /** Newer than the pack in use (never when SERP reading is disabled). */
  const isNewer = (pack: SelectorPack): boolean => active.status === 'ready' && pack.version > active.version;

  const adopt = (pack: SelectorPack): void => {
    active = { status: 'ready', pack, source: 'remote', version: pack.version };
    for (const listener of listeners) {
      try {
        listener(active);
      } catch (error) {
        log(`serp: a selector pack listener failed: ${message(error)}`);
      }
    }
  };

  async function load(): Promise<ActivePack> {
    if (active.status !== 'ready') return active;
    let stored: PackFiles | null;
    try {
      stored = await storage.read();
    } catch (error) {
      log(`serp: the stored selector pack could not be read: ${message(error)}`);
      return active;
    }
    if (stored === null) return active;
    const result = verifyPack(stored.bytes, stored.signature, publicKeys);
    if (!result.ok) {
      log(`serp: the stored selector pack was refused (${result.reason}); using the bundled one`);
      return active;
    }
    if (isNewer(result.pack)) adopt(result.pack);
    return active;
  }

  /** Fetches one file; a fetch that throws (it should not) is `unreachable`. */
  async function fetchFile(fileUrl: string, maxBytes: number): Promise<PackFetchResult> {
    try {
      return await fetchPack!(fileUrl, maxBytes);
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }

  async function update(): Promise<PackUpdateOutcome> {
    if (fetchPack === null || active.status !== 'ready') return 'disabled';
    if (!isAllowedPackUrl(url, allowHttp)) return 'unreachable';
    const packFile = await fetchFile(url, SERP_PACK_FETCH_LIMITS.maxBytes);
    if (!packFile.ok) return packFile.reason;
    if (packFile.bytes.byteLength > SELECTOR_PACK_LIMITS.maxPackBytes) return 'too-large';
    const signatureFile = await fetchFile(packSignatureUrl(url), SERP_PACK_FETCH_LIMITS.maxSignatureBytes);
    if (!signatureFile.ok) return signatureFile.reason === 'too-large' ? 'bad-signature' : 'unreachable';
    const signature = signatureText(signatureFile.bytes);
    if (signature === null) return 'bad-signature';
    const result = verifyPack(packFile.bytes, signature, publicKeys);
    if (!result.ok) return result.reason;
    if (!isNewer(result.pack)) return 'not-newer';
    // Used at once; stored for the next start (a failed write only loses that).
    adopt(result.pack);
    try {
      await storage.write(packFile.bytes, `${signature.trim()}\n`);
    } catch (error) {
      log(`serp: the selector pack update is in use but could not be stored: ${message(error)}`);
    }
    return 'installed';
  }

  let running: Promise<PackUpdateOutcome> | null = null;

  return {
    current: () => active,
    load,
    checkForUpdate() {
      running ??= update().finally(() => {
        running = null;
      });
      return running;
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

// ---- The real disk and network ----------------------------------------------------------------

/** Reads at most `maxBytes` of `file`; `null` when it does not exist. */
async function readUpTo(file: string, maxBytes: number): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await open(file, 'r');
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
    return buffer.slice(0, length);
  } finally {
    await handle.close();
  }
}

/** Writes `bytes` to a temporary file beside `file`, flushed, then renames it over `file`. */
async function writeAtomically(file: string, bytes: Uint8Array | string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o600, flush: true });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * The stored pack in `dir` (main: `userData/SERP_PACK_DIR`): `SERP_PACK_FILE` and
 * `SERP_PACK_SIGNATURE_FILE`. Reads stop one byte past each cap (so an oversize file is refused as
 * `too-large`, never read whole). Each file is written atomically, the pack first; a crash between
 * the two renames leaves a pair that does not verify, which `load()` ignores.
 */
export function fileStorage(dir: string): PackStorage {
  const packPath = path.join(dir, SERP_PACK_FILE);
  const signaturePath = path.join(dir, SERP_PACK_SIGNATURE_FILE);
  return {
    async read() {
      const bytes = await readUpTo(packPath, SELECTOR_PACK_LIMITS.maxPackBytes + 1);
      if (bytes === null) return null;
      const signature = await readUpTo(signaturePath, SELECTOR_PACK_LIMITS.maxSignatureChars + 1);
      if (signature === null) return null;
      return { bytes, signature: Buffer.from(signature).toString('utf8') };
    },
    async write(bytes, signature) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeAtomically(packPath, bytes);
      await writeAtomically(signaturePath, signature);
    },
  };
}

/**
 * The store's fetch over a bounded fetcher (main: the `checks` lane, `fetcher.spec.ts`): a GET with
 * frost's own user agent, the file's URL as the request's page (so a private host is requested only
 * when the pack URL itself is on one), `maxBytes` the cap the store asks for, and
 * `SERP_PACK_FETCH_LIMITS`' deadline and redirect cap. `https:` only, the URL, every redirect and
 * the final URL (`http:` too when `allowHttp`, the e2e URL seam); a 200 is the file, a body past the
 * cap `too-large`, anything else `unreachable`.
 */
export function boundedPackFetch(fetcher: BoundedFetcher, options: { readonly allowHttp?: boolean } = {}): PackFetch {
  const allowHttp = options.allowHttp ?? false;
  return async (url, maxBytes) => {
    if (!isAllowedPackUrl(url, allowHttp)) return { ok: false, reason: 'unreachable' };
    const result = await fetcher.fetch({
      url,
      page: url,
      method: 'GET',
      userAgent: null,
      maxBytes,
      timeoutMs: SERP_PACK_FETCH_LIMITS.timeoutMs,
      maxRedirects: SERP_PACK_FETCH_LIMITS.maxRedirects,
    });
    if (result.outcome !== 'response' || result.status !== 200) return { ok: false, reason: 'unreachable' };
    const hops = [...result.chain.map((hop) => hop.location), result.finalUrl ?? ''];
    if (!hops.every((hop) => isAllowedPackUrl(hop, allowHttp))) return { ok: false, reason: 'unreachable' };
    if (result.truncated) return { ok: false, reason: 'too-large' };
    return { ok: true, bytes: result.body };
  };
}
