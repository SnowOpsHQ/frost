// Spec: specs/capture-db.spec.ts (CAPTURES_DIR_NAME, SHA256_HEX_PATTERN), specs/screenshot.spec.ts
// (SCREENSHOTS_DIR_NAME, SCREENSHOT_LIMITS.maxPngBytes)
// Acceptance: specs/screenshot.feature.md (Files; Scenarios screenshot-paths-are-main-only,
// store-writes-by-rename-and-reuses)
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CAPTURES_DIR_NAME, SHA256_HEX_PATTERN } from '@app/specs/capture-db.spec';
import { SCREENSHOTS_DIR_NAME } from '@app/specs/screenshot.spec';
import { createScreenshotFiles } from '../store';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function profile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-shots-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('\x89PNG\r\n\x1a\n not really a png, but bytes all the same');
const posix = process.platform !== 'win32';

describe('screenshot files', () => {
  test('screenshot-paths-are-main-only', async () => {
    const userData = profile();
    const files = createScreenshotFiles(userData);
    const dir = path.join(userData, CAPTURES_DIR_NAME, SCREENSHOTS_DIR_NAME);
    expect(files.dir).toBe(dir);

    // A name comes only from the bytes' own hash.
    const written = await files.write(PNG);
    expect(written).toEqual({ sha256: sha(PNG), bytes: PNG.length });
    expect(readdirSync(dir)).toEqual([`${sha(PNG)}.png`]);
    expect(files.fileFor(written.sha256)).toBe(path.join(dir, `${sha(PNG)}.png`));
    expect(readFileSync(files.fileFor(written.sha256))).toEqual(PNG);
    if (posix) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(userData, CAPTURES_DIR_NAME)).mode & 0o777).toBe(0o700);
      expect(statSync(files.fileFor(written.sha256)).mode & 0o777).toBe(0o600);
    }

    // `fileFor` takes a lowercase hex SHA-256 only: nothing that could name another file.
    const bad = ['', '../../etc/passwd', `${'a'.repeat(63)}/`, `../${'a'.repeat(61)}`, 'A'.repeat(64), `${'a'.repeat(64)}.png`, `${'a'.repeat(64)}\0`, 'g'.repeat(64), 'a'.repeat(65), `/${'a'.repeat(63)}`, `..${path.sep}${'a'.repeat(61)}`];
    for (const name of bad) {
      expect(SHA256_HEX_PATTERN.test(name)).toBe(false);
      expect(() => files.fileFor(name), JSON.stringify(name)).toThrow();
      await expect(files.read(name)).resolves.toBeNull();
      await expect(files.unlink(name)).resolves.toBe(false);
      await expect(files.has(name)).resolves.toBe(false);
    }
    // The API has no way in for a path: every entry point is the bytes or a hash.
    expect(Object.keys(files).sort()).toEqual(['dir', 'fileFor', 'has', 'read', 'unlink', 'write']);

    if (!posix) return;
    // A symlinked `screenshots` directory is refused: nothing is written through it.
    const elsewhere = profile();
    chmodSync(elsewhere, 0o755);
    const linkedShots = profile();
    mkdirSync(path.join(linkedShots, CAPTURES_DIR_NAME), { mode: 0o700 });
    symlinkSync(elsewhere, path.join(linkedShots, CAPTURES_DIR_NAME, SCREENSHOTS_DIR_NAME));
    const viaShots = createScreenshotFiles(linkedShots);
    await expect(viaShots.write(PNG)).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
    // Reads, checks and unlinks do not follow it either.
    writeFileSync(path.join(elsewhere, `${sha(PNG)}.png`), PNG);
    await expect(viaShots.read(sha(PNG))).resolves.toBeNull();
    await expect(viaShots.has(sha(PNG))).resolves.toBe(false);
    await expect(viaShots.unlink(sha(PNG))).resolves.toBe(false);
    expect(existsSync(path.join(elsewhere, `${sha(PNG)}.png`))).toBe(true);
    expect(statSync(elsewhere).mode & 0o777).toBe(0o755); // its mode was not changed through the link
    // A symlinked `frost-captures` directory is refused the same way.
    const elsewhere2 = profile();
    chmodSync(elsewhere2, 0o755);
    const linkedCaptures = profile();
    symlinkSync(elsewhere2, path.join(linkedCaptures, CAPTURES_DIR_NAME));
    await expect(createScreenshotFiles(linkedCaptures).write(PNG)).rejects.toThrow();
    expect(readdirSync(elsewhere2)).toEqual([]);
    expect(statSync(elsewhere2).mode & 0o777).toBe(0o755);
    // A regular file where a directory should be is refused.
    const fileInstead = profile();
    writeFileSync(path.join(fileInstead, CAPTURES_DIR_NAME), 'x');
    await expect(createScreenshotFiles(fileInstead).write(PNG)).rejects.toThrow();
    // A symlink where a screenshot file should be is never read through.
    const linkedFile = profile();
    const real = createScreenshotFiles(linkedFile);
    await real.write(Buffer.from('other'));
    const target = path.join(profile(), 'secret.png');
    writeFileSync(target, PNG);
    symlinkSync(target, real.fileFor(sha(PNG)));
    await expect(real.read(sha(PNG))).resolves.toBeNull();
    await expect(real.has(sha(PNG))).resolves.toBe(false);
  });

  test('store-writes-by-rename-and-reuses', async () => {
    const userData = profile();
    const files = createScreenshotFiles(userData);
    const first = await files.write(PNG);
    const file = files.fileFor(first.sha256);
    const inode = lstatSync(file).ino;
    // The same bytes again: the file is reused as it is.
    await expect(files.write(PNG)).resolves.toEqual(first);
    expect(lstatSync(file).ino).toBe(inode);
    expect(readdirSync(files.dir)).toEqual([path.basename(file)]);
    // A file under that name that does not hash to it is replaced (renamed over, never appended to).
    writeFileSync(file, 'tampered');
    await expect(files.read(first.sha256)).resolves.toBeNull();
    await expect(files.write(PNG)).resolves.toEqual(first);
    expect(readFileSync(file)).toEqual(PNG);
    await expect(files.read(first.sha256)).resolves.toEqual(PNG);
    // A symlink under that name is replaced by the file (the link itself, not its target).
    const target = path.join(profile(), 'victim');
    writeFileSync(target, 'keep me');
    rmSync(file);
    symlinkSync(target, file);
    await files.write(PNG);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    // No temporary file is left behind; a missing file reads null; unlink removes it.
    expect(readdirSync(files.dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    await expect(files.has(first.sha256)).resolves.toBe(true);
    await expect(files.unlink(first.sha256)).resolves.toBe(true);
    await expect(files.unlink(first.sha256)).resolves.toBe(false);
    await expect(files.read(first.sha256)).resolves.toBeNull();
    await expect(files.has(first.sha256)).resolves.toBe(false);
    // A file over the cap is neither written nor read.
    const shared = profile();
    const big = await createScreenshotFiles(shared).write(PNG);
    const small = createScreenshotFiles(shared, { maxBytes: 8 });
    await expect(small.read(big.sha256)).resolves.toBeNull();
    await expect(small.write(PNG)).rejects.toThrow();
  });
});
