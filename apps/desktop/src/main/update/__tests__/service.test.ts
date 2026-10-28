// Spec: specs/update-client.spec.ts (UPDATE_TEST_CERT_SWITCH, Install), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES)
// Acceptance: specs/update-client.feature.md (Main)
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import {
  UPDATE_FEED_SWITCH,
  UPDATE_PARTITION,
  UPDATE_PUBLIC_KEY_SWITCH,
  UPDATE_TEST_CERT_SWITCH,
  updateUserAgent,
  type UpdateState,
  type UpdateStatus,
} from '@app/specs/update-client.spec';
import { selfSignedCertificate } from '../../../../e2e/tls';
import { createUpdateClient, type UpdateClient } from '../client';
import { createPrefsStore } from '../prefs';
import { certificateSha256, createUpdateService, pinnedCertificateVerifier, startUpdateService, type StartUpdateDeps } from '../service';
import { artifactBytes, manifestFor, nodeTransport, sha256Hex, signEnvelope, startFakeFeed, tableResolver, testSigningKey, type FakeFeed } from './fake-feed';

const POSIX = process.platform !== 'win32';

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(path.join(os.tmpdir(), 'frost-update-service-'));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

/** A shell whose every opener is a spy: the service may only ever reveal. */
function fakeShell() {
  return { showItemInFolder: vi.fn((_path: string) => undefined), openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') };
}

/** A client stand-in answering `status` with `file` as its verified file. */
function fakeClient(status: UpdateStatus, file: string | null): UpdateClient {
  const state = (): UpdateState => ({ version: 1, currentVersion: '1.2.0', checks: 'on', lastCheckedAt: null, status });
  return {
    state,
    watch: async () => state(),
    checkNow: async () => state(),
    download: () => new Promise<UpdateState>(() => undefined),
    skip: async () => state(),
    setChecks: async () => state(),
    readyFile: () => file,
    lastCheck: () => null,
    dispose: () => undefined,
  };
}

const READY: UpdateStatus = { kind: 'ready', version: '1.3.0', install: 'manual', fileName: 'frost-1.3.0-linux-x64.AppImage' };

describe('update service', () => {
  test('install-shows-file', async () => {
    // End to end over a real client and the local fake feed: check, download, verify, then Show file.
    const feed: FakeFeed = await startFakeFeed();
    const key = testSigningKey();
    const bytes = artifactBytes(50_000, 3);
    const host = 'downloads.frost-feed.com';
    try {
      feed.route('/frost.AppImage', { body: bytes });
      feed.route('/feed.json', { body: signEnvelope(manifestFor('1.3.0', Date.now(), { 'linux-x64': { url: `https://${host}/frost.AppImage`, sha256: sha256Hex(bytes), size: bytes.length } }), key) });
      const client = await createUpdateClient({
        feed: { url: `${feed.origin}/feed.json` },
        currentVersion: '1.2.0',
        platformKey: 'linux-x64',
        userData,
        prefs: createPrefsStore(userData),
        hop: nodeTransport({ https: { [host]: feed.port } }),
        resolve: tableResolver({ [host]: ['93.184.215.14'] }),
        isPackaged: false,
        keys: key.keys,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      });
      try {
        const shell = fakeShell();
        const service = createUpdateService(client, { shell });
        expect((await service.check()).status.kind).toBe('available');
        // Nothing to show yet.
        expect(await service.install()).toBe(false);
        // `download()` answers once started; the state follows through `watch`.
        expect((await service.download()).status.kind).toBe('downloading');
        let state = service.state();
        while (state.status.kind === 'downloading') state = await service.watch(state.version);
        expect(state.status).toMatchObject({ kind: 'ready', install: 'manual' });
        expect(await service.install()).toBe(true);
        const file = client.readyFile();
        expect(shell.showItemInFolder.mock.calls).toEqual([[file]]);
        expect(createHash('sha256').update(await readFile(file!)).digest('hex')).toBe(sha256Hex(bytes));
        // Revealed, never opened or run.
        expect(shell.openExternal).not.toHaveBeenCalled();
        expect(shell.openPath).not.toHaveBeenCalled();
      } finally {
        client.dispose();
      }
    } finally {
      await feed.close();
    }
  });

  test('install-refused-unless-ready', async () => {
    const file = path.join(userData, 'frost-1.3.0-linux-x64.AppImage');
    await writeFile(file, 'verified');
    const others: UpdateStatus[] = [
      { kind: 'disabled' },
      { kind: 'off' },
      { kind: 'idle' },
      { kind: 'checking' },
      { kind: 'up-to-date' },
      { kind: 'available', version: '1.3.0', notes: '', releasedAt: '2026-10-28T00:00:00Z', required: false, size: 8 },
      { kind: 'downloading', version: '1.3.0', bytes: 1, total: 8 },
      { kind: 'error', reason: 'hash-mismatch', version: '1.3.0' },
      // Unreachable today, and refused until `autoUpdater` holds the update (no fake restart).
      { ...READY, install: 'restart' },
    ];
    for (const status of others) {
      const shell = fakeShell();
      expect([status.kind, await createUpdateService(fakeClient(status, file), { shell }).install()]).toEqual([status.kind, false]);
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    }
    // Ready, but no file, a file gone, a directory, or (POSIX) a symbolic link in its place.
    const candidates: (string | null)[] = [null, path.join(userData, 'gone'), userData];
    if (POSIX) {
      const link = path.join(userData, 'link.AppImage');
      await symlink(file, link);
      candidates.push(link);
    }
    for (const candidate of candidates) {
      const shell = fakeShell();
      expect([candidate, await createUpdateService(fakeClient(READY, candidate), { shell }).install()]).toEqual([candidate, false]);
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
    }
    // The real thing, for contrast.
    const shell = fakeShell();
    expect(await createUpdateService(fakeClient(READY, file), { shell }).install()).toBe(true);
    expect(shell.showItemInFolder.mock.calls).toEqual([[file]]);
  });

  test('download-starts-not-awaits', async () => {
    const client = fakeClient({ kind: 'downloading', version: '1.3.0', bytes: 0, total: 8 }, null);
    const download = vi.spyOn(client, 'download');
    // The client's download never finishes here; the procedure still answers.
    await expect(createUpdateService(client, { shell: fakeShell() }).download()).resolves.toMatchObject({ status: { kind: 'downloading' } });
    expect(download).toHaveBeenCalledTimes(1);
  });
});

/** Electron's objects, faked: what `startUpdateService` touches. */
function fakeElectron(options: { isPackaged: boolean; switches?: Record<string, string> }) {
  const switches = options.switches ?? {};
  const session = {
    setUserAgent: vi.fn((_ua: string) => undefined),
    webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
    resolveHost: vi.fn(async () => ({ endpoints: [{ address: '93.184.215.14' }] })),
    setCertificateVerifyProc: vi.fn(),
  };
  const fromPartition = vi.fn((_partition: string, _options: { cache: boolean }) => session);
  const net = { request: vi.fn(() => { throw new Error('no request expected'); }) };
  const deps: StartUpdateDeps = {
    app: {
      isPackaged: options.isPackaged,
      getVersion: () => '1.2.0',
      getPath: () => userData,
      commandLine: { getSwitchValue: (name: string) => switches[name] ?? '' },
    },
    net,
    session: { fromPartition },
    shell: fakeShell(),
    env: {},
    log: () => undefined,
  };
  return { deps, session, fromPartition, net };
}

describe('startUpdateService', () => {
  const KEY = testSigningKey('e2e-key');
  const PEM = selfSignedCertificate().cert;
  const PIN = certificateSha256(PEM)!;
  const SWITCHES = {
    [UPDATE_FEED_SWITCH]: 'https://updates.frost-e2e.net:4443/feed.json',
    [UPDATE_PUBLIC_KEY_SWITCH]: `${KEY.keyId}:${KEY.spki}`,
    [UPDATE_TEST_CERT_SWITCH]: PIN,
    [E2E_PUBLIC_HOSTS_SWITCH]: 'updates.frost-e2e.net',
  };

  test('switches-unpackaged-only', async () => {
    // Every e2e switch is one a packaged build refuses to start with (verify:mac/linux/win probe them).
    for (const name of [UPDATE_FEED_SWITCH, UPDATE_PUBLIC_KEY_SWITCH, UPDATE_TEST_CERT_SWITCH, E2E_PUBLIC_HOSTS_SWITCH]) expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(name);

    // Packaged: the switches are ignored: no feed (disabled), no pin; the session is still the hardened in-memory one.
    const packaged = fakeElectron({ isPackaged: true, switches: SWITCHES });
    const quiet = await startUpdateService(packaged.deps);
    try {
      expect(quiet.service.state().status.kind).toBe('disabled');
      expect(packaged.fromPartition).toHaveBeenCalledWith(UPDATE_PARTITION, { cache: false });
      expect(packaged.session.setUserAgent).toHaveBeenCalledWith(updateUserAgent('1.2.0'));
      expect(packaged.session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
      expect(packaged.session.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1);
      expect(packaged.session.setCertificateVerifyProc).not.toHaveBeenCalled();
      // A user action with no feed makes no request.
      await quiet.service.check();
      expect(packaged.net.request).not.toHaveBeenCalled();
    } finally {
      quiet.dispose();
    }
    // Packaged with `FROST_UPDATE_FEED_URL`: that feed (any build may be pointed at one).
    const configured = fakeElectron({ isPackaged: true });
    const fed = await startUpdateService({ ...configured.deps, env: { FROST_UPDATE_FEED_URL: 'https://updates.frost.example.com/feed.json' } });
    try {
      expect(fed.service.state().status.kind).toBe('idle');
    } finally {
      fed.dispose();
    }

    // Unpackaged: the feed switch is the feed; the pin is installed. Nothing is requested at start.
    const dev = fakeElectron({ isPackaged: false, switches: SWITCHES });
    const started = await startUpdateService(dev.deps);
    try {
      expect(started.service.state().status.kind).toBe('idle');
      expect(dev.session.setCertificateVerifyProc).toHaveBeenCalledTimes(1);
      expect(dev.net.request).not.toHaveBeenCalled();
    } finally {
      started.dispose();
    }
  });

  test('test-cert-pins-one-certificate', async () => {
    const verify = pinnedCertificateVerifier(PIN);
    const answer = (pem: string) => {
      let result: number | undefined;
      verify({ certificate: { data: pem } }, (code) => (result = code));
      return result;
    };
    // Exactly the pinned certificate is accepted; any other, or garbage, is Chromium's own verdict.
    expect(answer(PEM)).toBe(0);
    expect(answer(selfSignedCertificate().cert)).toBe(-3);
    expect(answer('not a certificate')).toBe(-3);
    expect(answer('')).toBe(-3);
    expect(PIN).toMatch(/^[0-9a-f]{64}$/);

    // A malformed pin installs nothing extra.
    for (const bad of ['', 'zz', PIN.slice(1), `${PIN}00`, `sha256/${PIN}`]) {
      const dev = fakeElectron({ isPackaged: false, switches: { ...SWITCHES, [UPDATE_TEST_CERT_SWITCH]: bad } });
      const started = await startUpdateService(dev.deps);
      started.dispose();
      expect([bad, dev.session.setCertificateVerifyProc.mock.calls.length]).toEqual([bad, 0]);
    }
    // The installed proc is the pin, on the update session only (the fake holds the one session asked for).
    const dev = fakeElectron({ isPackaged: false, switches: SWITCHES });
    const started = await startUpdateService(dev.deps);
    started.dispose();
    expect(dev.fromPartition.mock.calls.map(([partition]) => partition)).toEqual([UPDATE_PARTITION]);
    const proc = dev.session.setCertificateVerifyProc.mock.calls[0]![0] as typeof verify;
    let accepted: number | undefined;
    proc({ certificate: { data: PEM } }, (code) => (accepted = code));
    expect(accepted).toBe(0);
  });
});
