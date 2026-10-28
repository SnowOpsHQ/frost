import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { UPDATE_DOWNLOADS_DIR, UPDATE_FETCH_LIMITS, UPDATE_PARTIAL_SUFFIX } from '@app/specs/update-client.spec';
import { MAX_ARTIFACT_BYTES, SHA256_HEX_PATTERN, artifactFileName, type UpdateArtifact, type UpdatePlatform } from '@app/specs/update-manifest.spec';
import { updateGet, type UpdateGetDeps, type UpdateGetFailure, type UpdateGetLimits } from './fetch';
import { isVersion } from './manifest';

// The verified download (spec `update-client.spec.ts`, Files; `update-client.feature.md`,
// `download-verified`, `rejects-hash-mismatch`, `download-is-bounded`, `download-stays-in-updates`).
// The artifact is streamed to `userData/updates/<version>/<artifactFileName>.partial` (mode 0600,
// created exclusively) and hashed on the way; the read stops one byte past the signed `size`. Only
// when the byte count equals `size` and the SHA-256 equals the signed one (compared in constant
// time) is it renamed to its final name; on any failure the partial is deleted. Once one is ready,
// every other entry in `updates/` goes. Nothing is ever written outside `userData/updates`, and a
// symbolic link in place of either directory is refused.

/** Why a download failed: the getter's reasons, or `size-mismatch`, `hash-mismatch`, `disk`. */
export type DownloadFailure = UpdateGetFailure | 'size-mismatch' | 'hash-mismatch' | 'disk';

export type DownloadResult = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly reason: DownloadFailure };

export interface DownloadInput {
  readonly userData: string;
  readonly version: string;
  readonly platformKey: UpdatePlatform;
  /** From the verified manifest. */
  readonly artifact: UpdateArtifact;
  readonly get: UpdateGetDeps;
  /** Bytes received so far, after each chunk is written. */
  readonly onProgress?: (bytes: number) => void;
  readonly signal?: AbortSignal;
  /** Timeouts other than `UPDATE_FETCH_LIMITS.artifact` (tests). The size cap is always the signed `size`. */
  readonly limits?: Partial<Pick<UpdateGetLimits, 'responseMs' | 'idleMs' | 'totalMs'>>;
}

/** `userData/updates`. */
export const downloadsDir = (userData: string): string => path.join(userData, UPDATE_DOWNLOADS_DIR);

/** Whether `child` is strictly inside `parent` (by path). */
const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Makes `dir` (mode 0700) and checks it is a real directory, not a symbolic link. */
async function realDirectory(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes every entry in `userData/updates` but `keepVersion`'s directory (all of them for
 * `null`). Never rejects; a missing directory is fine.
 */
export async function pruneDownloads(userData: string, keepVersion: string | null): Promise<void> {
  const dir = downloadsDir(userData);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names.filter((name) => name !== keepVersion).map((name) => rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined)));
}

export async function downloadArtifact(input: DownloadInput): Promise<DownloadResult> {
  const { userData, version, platformKey, artifact } = input;
  if (!isVersion(version) || !SHA256_HEX_PATTERN.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'disk' };
  }
  let name: string;
  try {
    name = artifactFileName(version, platformKey);
  } catch {
    return { ok: false, reason: 'disk' };
  }
  const updates = downloadsDir(userData);
  const versionDir = path.join(updates, version);
  const file = path.join(versionDir, name);
  const partial = `${file}${UPDATE_PARTIAL_SUFFIX}`;
  if (!inside(updates, versionDir) || path.dirname(file) !== versionDir || path.dirname(partial) !== versionDir) return { ok: false, reason: 'disk' };
  if (!(await realDirectory(updates)) || !(await realDirectory(versionDir))) return { ok: false, reason: 'disk' };

  // A stale partial, or an earlier final file of this version, goes first: what is ready is only ever what was just verified.
  try {
    await rm(partial, { force: true });
    await rm(file, { force: true });
  } catch {
    return { ok: false, reason: 'disk' };
  }
  let handle;
  try {
    // `wx`: created here, never through something already at that path (a planted link included).
    handle = await open(partial, 'wx', 0o600);
  } catch {
    return { ok: false, reason: 'disk' };
  }

  const hash = createHash('sha256');
  let written = 0;
  let result: DownloadResult;
  try {
    const got = await updateGet(
      artifact.url,
      input.get,
      { ...UPDATE_FETCH_LIMITS.artifact, ...input.limits, maxBytes: Math.min(artifact.size, MAX_ARTIFACT_BYTES), maxRedirects: UPDATE_FETCH_LIMITS.maxRedirects },
      async (chunk) => {
        hash.update(chunk);
        await handle.write(chunk);
        written += chunk.byteLength;
        input.onProgress?.(written);
      },
      input.signal,
    );
    if (!got.ok) {
      result = { ok: false, reason: got.reason === 'sink' ? 'disk' : got.reason };
    } else if (got.bytes !== artifact.size || written !== artifact.size) {
      result = { ok: false, reason: 'size-mismatch' };
    } else {
      const expected = Buffer.from(artifact.sha256, 'hex');
      const actual = hash.digest();
      result = expected.length === actual.length && timingSafeEqual(actual, expected) ? { ok: true, file } : { ok: false, reason: 'hash-mismatch' };
    }
    if (result.ok) await handle.sync();
  } catch {
    result = { ok: false, reason: 'disk' };
  }
  try {
    await handle.close();
  } catch {
    result = { ok: false, reason: 'disk' };
  }

  if (result.ok) {
    try {
      await rename(partial, file);
    } catch {
      result = { ok: false, reason: 'disk' };
    }
  }
  if (!result.ok) {
    await unlink(partial).catch(() => undefined);
    return result;
  }
  await pruneDownloads(userData, version);
  return result;
}
