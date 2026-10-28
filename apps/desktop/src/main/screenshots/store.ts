import { createHash, randomBytes } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
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
// What is guaranteed: the directories are private to the user (`0700`), but another process of the
// same user could still swap one for a symlink between two checks. A write therefore works through
// the screenshot directory's own no-follow handle (on Linux, by its `/proc/self/fd/<fd>` name, so
// the temporary file and the rename land in that directory whatever its path now names), and after
// the rename it checks again: both directories are still real directories, the screenshot
// directory's device and inode are the handle's, and the file's are the ones written. On a mismatch
// it removes what it wrote (where it can) and fails: frost detects the race and refuses.
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

export interface ScreenshotFilesOptions {
  readonly maxBytes?: number;
  /** Write through `/proc/self/fd/<fd>` (default: where the platform has it, i.e. Linux). */
  readonly procFd?: boolean;
  /** Called between the rename and the checks after it (tests use it to swap a directory). */
  readonly afterRename?: () => Promise<void>;
}

/** Whether two stats name the same file. */
const sameFile = (a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }): boolean => a.dev === b.dev && a.ino === b.ino;

export function createScreenshotFiles(userData: string, options: ScreenshotFilesOptions = {}): ScreenshotFiles {
  const captures = path.join(path.resolve(userData), CAPTURES_DIR_NAME);
  const dir = path.join(captures, SCREENSHOTS_DIR_NAME);
  const maxBytes = options.maxBytes ?? SCREENSHOT_LIMITS.maxPngBytes;
  const procFd = options.procFd ?? (process.platform === 'linux' && existsSync('/proc/self/fd'));

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
  /**
   * Both directories, created `0700` if missing, checked, then set `0700` through a handle that
   * refuses a symlink. Answers the screenshot directory's handle, open (POSIX; `null` elsewhere).
   */
  const ensureDirs = async (): Promise<FileHandle | null> => {
    let handle: FileHandle | null = null;
    for (const at of [captures, dir]) {
      await handle?.close();
      handle = null;
      await mkdir(at, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      });
      await realDirectory(at);
      if (!posix) continue;
      handle = await open(at, constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW);
      try {
        if (!(await handle.stat()).isDirectory()) throw new Error(`${path.basename(at)} is not a directory`);
        await handle.chmod(0o700);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return handle;
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

  /**
   * The file's bytes if it is a regular file within the cap whose bytes hash to `sha256`; with
   * `private`, it is also set `0600` through the same no-follow handle (a reused file keeps no wider
   * mode), and answers its device and inode.
   */
  const readChecked = async (file: string, sha256: string, own = false): Promise<{ bytes: Buffer; dev: number; ino: number } | null> => {
    try {
      const link = await lstat(file);
      if (link.isSymbolicLink() || !link.isFile() || link.size > maxBytes) return null;
      const handle = await open(file, constants.O_RDONLY | NO_FOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes) return null;
        const bytes = await handle.readFile();
        if (bytes.length > maxBytes || sha256Of(bytes) !== sha256) return null;
        if (own && posix) await handle.chmod(0o600);
        return { bytes, dev: stat.dev, ino: stat.ino };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };

  /**
   * After a write: both directories are still real directories, the screenshot directory is the one
   * `handle` holds, and `file` is the file written (`written`). Else what was written is removed
   * (through the handle's name, where there is one) and it throws.
   */
  const verify = async (handle: FileHandle | null, base: string, name: string, written: { dev: number; ino: number }): Promise<void> => {
    const file = path.join(dir, name);
    let intact = false;
    try {
      await realDirectory(captures);
      await realDirectory(dir);
      const [held, now, landed] = await Promise.all([handle?.stat() ?? null, lstat(dir), lstat(file)]);
      intact = (held === null || sameFile(held, now)) && landed.isFile() && !landed.isSymbolicLink() && sameFile(landed, written);
    } catch {
      intact = false;
    }
    if (intact) return;
    // Only ever the file this write made: by the handle's own directory, else by path if it is that file.
    if (base !== dir) await unlink(path.join(base, name)).catch(() => undefined);
    else {
      const there = await lstat(file).catch(() => null);
      if (there && sameFile(there, written)) await unlink(file).catch(() => undefined);
    }
    throw new Error('the screenshot directory changed while it was written');
  };

  return {
    dir,
    fileFor,
    async write(png) {
      if (!Buffer.isBuffer(png) || png.length === 0 || png.length > maxBytes) throw new Error('not a screenshot within the cap');
      const sha256 = sha256Of(png);
      const name = path.basename(fileFor(sha256));
      const handle = await ensureDirs();
      try {
        // The directory as its handle names it (Linux), else by its path.
        const base = handle && procFd ? `/proc/self/fd/${handle.fd}` : dir;
        const reused = await readChecked(path.join(base, name), sha256, true);
        if (reused !== null) {
          await verify(handle, base, name, reused);
          return { sha256, bytes: png.length };
        }
        // A new name in the same directory, written once (`wx`, `0600`), then renamed over whatever is
        // there (a changed file, or a symlink: the link itself is replaced, never its target).
        const temporary = path.join(base, `${name}.tmp-${randomBytes(8).toString('hex')}`);
        let written: { dev: number; ino: number };
        try {
          const out = await open(temporary, 'wx', 0o600);
          try {
            await out.writeFile(png);
            const stat = await out.stat();
            written = { dev: stat.dev, ino: stat.ino };
          } finally {
            await out.close();
          }
          await rename(temporary, path.join(base, name));
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
        await options.afterRename?.();
        await verify(handle, base, name, written);
        return { sha256, bytes: png.length };
      } finally {
        await handle?.close();
      }
    },
    async read(sha256) {
      const file = fileOrNull(sha256);
      if (file === null) return null;
      try {
        await checkDirs();
      } catch {
        return null;
      }
      return (await readChecked(file, sha256))?.bytes ?? null;
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
