// Spec: specs/update-client.spec.ts (Files, UPDATE_FETCH_LIMITS) · Acceptance: specs/update-client.feature.md (Download)
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { UPDATE_DOWNLOADS_DIR, UPDATE_FETCH_LIMITS, UPDATE_PARTIAL_SUFFIX, updateUserAgent } from '@app/specs/update-client.spec';
import { artifactFileName } from '@app/specs/update-manifest.spec';
import { downloadArtifact, pruneDownloads, type DownloadInput } from '../download';
import type { UpdateGetDeps } from '../fetch';
import { artifactBytes, nodeTransport, sha256Hex, startFakeFeed, tableResolver, type FakeFeed } from './fake-feed';

const POSIX = process.platform !== 'win32';
const HOST = 'downloads.frost-feed.com';
const VERSION = '1.3.0';
const NAME = artifactFileName(VERSION, 'linux-x64');
const BYTES = artifactBytes(300_000);

let feed: FakeFeed;
let userData: string;
beforeEach(async () => {
  feed = await startFakeFeed();
  userData = await mkdtemp(path.join(os.tmpdir(), 'frost-update-download-'));
});
afterEach(async () => {
  await feed.close();
  await rm(userData, { recursive: true, force: true });
});

const updatesDir = () => path.join(userData, UPDATE_DOWNLOADS_DIR);
const versionDir = (version = VERSION) => path.join(updatesDir(), version);
const getDeps = (overrides: Partial<UpdateGetDeps> = {}): UpdateGetDeps => ({
  hop: nodeTransport({ https: { [HOST]: feed.port } }),
  resolve: tableResolver({ [HOST]: ['93.184.215.14'], 'private.frost-feed.com': ['10.1.2.3'] }),
  isPackaged: false,
  userAgent: updateUserAgent('1.2.0'),
  ...overrides,
});
const input = (overrides: Partial<DownloadInput> = {}): DownloadInput => ({
  userData,
  version: VERSION,
  platformKey: 'linux-x64',
  artifact: { url: `https://${HOST}/frost.AppImage`, sha256: sha256Hex(BYTES), size: BYTES.length },
  get: getDeps(),
  ...overrides,
});
/** Everything under `updates/`, as relative paths. */
async function tree(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
    }
  };
  await walk(updatesDir(), '');
  return out.sort();
}

describe('downloadArtifact', () => {
  test('download-verified', async () => {
    feed.route('/frost.AppImage', { body: BYTES });
    // An older version's download, and a stale partial of this one, are cleaned up.
    await mkdir(versionDir('1.2.5'), { recursive: true });
    await writeFile(path.join(versionDir('1.2.5'), artifactFileName('1.2.5', 'linux-x64')), 'old');
    await mkdir(versionDir(), { recursive: true });
    await writeFile(path.join(versionDir(), `${NAME}${UPDATE_PARTIAL_SUFFIX}`), 'stale');
    const progress: number[] = [];
    const result = await downloadArtifact(input({ onProgress: (bytes) => progress.push(bytes) }));
    const file = path.join(versionDir(), NAME);
    expect(result).toEqual({ ok: true, file });
    expect(await readFile(file)).toEqual(BYTES);
    if (POSIX) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await tree()).toEqual([VERSION, `${VERSION}/${NAME}`]);
    expect(progress.at(-1)).toBe(BYTES.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    // The file name is fixed by version and platform, never taken from the URL.
    expect(NAME).toBe('frost-1.3.0-linux-x64.AppImage');
  });

  test('rejects-hash-mismatch', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[1234] = tampered[1234]! ^ 0x40;
    feed.route('/frost.AppImage', { body: tampered });
    // A ready older version stays: only a verified download replaces it.
    await mkdir(versionDir('1.2.5'), { recursive: true });
    await writeFile(path.join(versionDir('1.2.5'), artifactFileName('1.2.5', 'linux-x64')), 'old');
    const result = await downloadArtifact(input());
    expect(result).toEqual({ ok: false, reason: 'hash-mismatch' });
    expect(await tree()).toEqual(['1.2.5', `1.2.5/${artifactFileName('1.2.5', 'linux-x64')}`, VERSION]);
  });

  test('download-is-bounded', async () => {
    const reasonOf = async (overrides: Partial<DownloadInput>) => {
      const result = await downloadArtifact(input(overrides));
      // Whatever the failure, no file is left in the version directory.
      expect(await tree()).toEqual(result.ok ? expect.anything() : expect.not.arrayContaining([expect.stringContaining(NAME)]));
      return result.ok ? 'ok' : result.reason;
    };
    // One byte more than the signed size: reading stops.
    feed.route('/long', { body: Buffer.concat([BYTES, Buffer.from([0])]) });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/long` } })).toBe('too-large');
    // A Content-Length above the size: refused before the body.
    feed.route('/declared', (_request, response) => {
      response.writeHead(200, { 'Content-Length': String(BYTES.length + 1) });
      response.write(BYTES.subarray(0, 10));
    });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/declared` } })).toBe('too-large');
    // Shorter than the signed size.
    feed.route('/short', { body: BYTES.subarray(0, BYTES.length - 1) });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/short` } })).toBe('size-mismatch');
    // More than maxRedirects redirects (each one a new path on the same https host).
    for (let i = 0; i <= UPDATE_FETCH_LIMITS.maxRedirects + 1; i++) feed.route(`/r${i}`, { redirect: `https://${HOST}/r${i + 1}` });
    feed.requests.length = 0;
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/r0` } })).toBe('too-many-redirects');
    expect(feed.requests).toHaveLength(UPDATE_FETCH_LIMITS.maxRedirects + 1);
    // Exactly maxRedirects is fine.
    feed.route(`/r${UPDATE_FETCH_LIMITS.maxRedirects}`, { body: BYTES });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/r0` } })).toBe('ok');
    // https: redirected to http: (even loopback, even unpackaged): the http: target is never requested.
    feed.route('/to-http', { redirect: `${feed.origin}/frost.AppImage` });
    feed.route('/frost.AppImage', { body: BYTES });
    feed.requests.length = 0;
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/to-http` } })).toBe('insecure-redirect');
    expect(feed.requests.map((request) => request.path)).toEqual(['/to-http']);
    // A private address: a literal, a name resolving to one, a redirect to one. Never requested.
    feed.route('/to-private', { redirect: 'https://192.168.1.20/frost.AppImage' });
    feed.route('/to-private-name', { redirect: 'https://private.frost-feed.com/frost.AppImage' });
    feed.requests.length = 0;
    expect(await reasonOf({ artifact: { ...input().artifact, url: 'https://10.0.0.8/frost.AppImage' } })).toBe('private-address');
    expect(await reasonOf({ artifact: { ...input().artifact, url: 'https://private.frost-feed.com/frost.AppImage' } })).toBe('private-address');
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/to-private` } })).toBe('private-address');
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/to-private-name` } })).toBe('private-address');
    expect(feed.requests.map((request) => request.path)).toEqual(['/to-private', '/to-private-name']);
    // A status other than 200.
    feed.route('/missing', { status: 404 });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/missing` } })).toBe('http-status');
    // No byte for idleMs.
    feed.route('/stall', { stall: true });
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/stall` }, limits: { idleMs: 200 } })).toBe('timeout');
    // The signed size is the cap even if larger caps are asked for elsewhere.
    expect(await reasonOf({ artifact: { ...input().artifact, url: `https://${HOST}/long` } })).toBe('too-large');
  });

  test('download-stays-in-updates', async () => {
    feed.route('/frost.AppImage', { body: BYTES });
    // Not a version: nothing is written anywhere, nothing is requested.
    for (const version of ['../x', '..', '1.3', '1.3.0/../../x']) {
      expect([version, await downloadArtifact(input({ version }))]).toEqual([version, { ok: false, reason: 'disk' }]);
    }
    expect(feed.requests).toHaveLength(0);
    expect(await readdir(userData)).toEqual([]);
    if (!POSIX) return;
    // A symlinked updates directory, or version directory, is refused.
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'frost-update-elsewhere-'));
    try {
      await symlink(elsewhere, updatesDir());
      expect(await downloadArtifact(input())).toEqual({ ok: false, reason: 'disk' });
      expect(await readdir(elsewhere)).toEqual([]);
      await rm(updatesDir());
      await mkdir(updatesDir());
      await symlink(elsewhere, versionDir());
      expect(await downloadArtifact(input())).toEqual({ ok: false, reason: 'disk' });
      expect(await readdir(elsewhere)).toEqual([]);
      expect(feed.requests).toHaveLength(0);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test('prune-downloads', async () => {
    await mkdir(versionDir('1.2.5'), { recursive: true });
    await mkdir(versionDir('1.3.0'), { recursive: true });
    await writeFile(path.join(versionDir('1.3.0'), 'x'), 'x');
    await pruneDownloads(userData, '1.3.0');
    expect(await tree()).toEqual(['1.3.0', '1.3.0/x']);
    await pruneDownloads(userData, null);
    expect(await tree()).toEqual([]);
    // No downloads directory: nothing to do, no rejection.
    await rm(updatesDir(), { recursive: true, force: true });
    await pruneDownloads(userData, null);
  });
});
