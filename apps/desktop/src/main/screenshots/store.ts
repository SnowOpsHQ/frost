import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CAPTURES_DIR_NAME, SHA256_HEX_PATTERN } from '@app/specs/capture-db.spec';
import { SCREENSHOT_LIMITS, SCREENSHOTS_DIR_NAME } from '@app/specs/screenshot.spec';

// The screenshot file store (Phase 6 Task 5; spec `screenshot.spec.ts`, `capture-db.spec.ts`;
// acceptance `screenshot.feature.md`, Files). Main only: PNG files live in
// `<userData>/frost-captures/screenshots/`, each named by the SHA-256 this store computed of its
// own bytes. Nothing here takes a path: `write` takes the bytes, everything else a hash, and
// `fileFor` accepts only a lowercase hex SHA-256 and checks the file lands directly in the
// directory. Both directories are created `0700` and `lstat`ed before every write and read (a
// symlink is never followed, and never `chmod`ed through); files are written `0600` under a
// temporary name in the same directory and renamed into place; reads never follow a symlink and
// check the hash.
//
// For Task 7 (retention): `unlink(sha)` removes a file no row references any more; the orphan sweep
// lists the directory itself and must only touch names matching `<sha>.png` (and this store's
// `<sha>.png.tmp-<hex>` leftovers from a crash).

export interface ScreenshotFiles {
  /** `<userData>/frost-captures/screenshots` (absolute). */
  readonly dir: string;
  /** The file for a hash: throws unless `sha256` is a lowercase hex SHA-256. */
  fileFor(sha256: string): string;
  /** Stores the PNG under its own hash (reusing a file that already matches); rejects on a refused directory or a write error. */
  write(png: Buffer): Promise<{ readonly sha256: string; readonly bytes: number }>;
  /** The file's bytes if they hash to `sha256`; `null` when missing, a symlink, over the cap or changed. */
  read(sha256: string): Promise<Buffer | null>;
  /** Whether the file is there as a regular file (no hash check). */
  has(sha256: string): Promise<boolean>;
  /** Removes the file; whether one was removed. */
  unlink(sha256: string): Promise<boolean>;
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const posix = process.platform !== 'win32';
/** Open flags that refuse a symlink at the last component (where the platform has them). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export function createScreenshotFiles(userData: string, options: { readonly maxBytes?: number } = {}): ScreenshotFiles {
  const captures = path.join(path.resolve(userData), CAPTURES_DIR_NAME);
  const dir = path.join(captures, SCREENSHOTS_DIR_NAME);
  const maxBytes = options.maxBytes ?? SCREENSHOT_LIMITS.maxPngBytes;

  /** Throws unless `at` is a real directory: a symlink (to anything) or a file is refused. */
  const realDirectory = async (at: string): Promise<void> => {
    const stat = await lstat(at);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path.basename(at)} is not a directory`);
  };
  /** Both directories, checked (never created). */
  const checkDirs = async (): Promise<void> => {
    await realDirectory(captures);
    await realDirectory(dir);
  };
  /** Both directories, created `0700` if missing, then checked, then set `0700` (through a handle that refuses a symlink). */
  const ensureDirs = async (): Promise<void> => {
    for (const at of [captures, dir]) {
      await mkdir(at, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      });
      await realDirectory(at);
      if (!posix) continue;
      const handle = await open(at, constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW);
      try {
        if (!(await handle.stat()).isDirectory()) throw new Error(`${path.basename(at)} is not a directory`);
        await handle.chmod(0o700);
      } finally {
        await handle.close();
      }
    }
  };

  const fileFor = (sha256: string): string => {
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) throw new Error('not a screenshot hash');
    const file = path.join(dir, `${sha256}.png`);
    if (path.dirname(file) !== dir || path.relative(dir, file) !== `${sha256}.png`) throw new Error('not a screenshot file');
    return file;
  };
  const fileOrNull = (sha256: string): string | null => {
    try {
      return fileFor(sha256);
    } catch {
      return null;
    }
  };

  /** The file's bytes if it is a regular file within the cap whose bytes hash to `sha256`. */
  const readChecked = async (file: string, sha256: string): Promise<Buffer | null> => {
    try {
      const link = await lstat(file);
      if (link.isSymbolicLink() || !link.isFile() || link.size > maxBytes) return null;
      const handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) return null;
        const bytes = await handle.readFile();
        return bytes.length <= maxBytes && sha256Of(bytes) === sha256 ? bytes : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };

  return {
    dir,
    fileFor,
    async write(png) {
      if (!Buffer.isBuffer(png) || png.length === 0 || png.length > maxBytes) throw new Error('not a screenshot within the cap');
      const sha256 = sha256Of(png);
      const file = fileFor(sha256);
      await ensureDirs();
      if ((await readChecked(file, sha256)) !== null) return { sha256, bytes: png.length };
      // A new name in the same directory, written once (`wx`), then renamed over whatever is there
      // (a changed file, or a symlink: the link itself is replaced, never its target).
      const temporary = path.join(dir, `${sha256}.png.tmp-${randomBytes(8).toString('hex')}`);
      try {
        await writeFile(temporary, png, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      return { sha256, bytes: png.length };
    },
    async read(sha256) {
      const file = fileOrNull(sha256);
      if (file === null) return null;
      try {
        await checkDirs();
      } catch {
        return null;
      }
      return readChecked(file, sha256);
    },
    async has(sha256) {
      const file = fileOrNull(sha256);
      if (file === null) return false;
      try {
        await checkDirs();
        const stat = await lstat(file);
        return stat.isFile() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
    async unlink(sha256) {
      const file = fileOrNull(sha256);
      if (file === null) return false;
      try {
        await checkDirs();
        await unlink(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
