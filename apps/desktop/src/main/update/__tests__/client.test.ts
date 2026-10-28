// Spec: specs/update-client.spec.ts · Acceptance: specs/update-client.feature.md (Client)
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_PENDING_UPDATE_WATCHES,
  UPDATE_DOWNLOADS_DIR,
  UPDATE_PREFS_FILE,
  UPDATE_SCHEDULE,
  jittered,
  type UpdatePrefs,
  type UpdateState,
  type UpdateStatusKind,
} from '@app/specs/update-client.spec';
import { MAX_ENVELOPE_BYTES, artifactFileName } from '@app/specs/update-manifest.spec';
import { createUpdateClient, type UpdateClient, type UpdateClientDeps, type UpdateTimers } from '../client';
import { createPrefsStore } from '../prefs';
import { artifactBytes, manifestFor, nodeTransport, sha256Hex, signEnvelope, startFakeFeed, tableResolver, testSigningKey, type FakeFeed } from './fake-feed';

const HOST = 'downloads.frost-feed.com';
const KEY = testSigningKey();
const OTHER_KEY = testSigningKey();
const START = Date.parse('2026-10-29T00:00:00Z');
const BYTES = artifactBytes(200_000, 7);
const ARTIFACT = { url: `https://${HOST}/frost-1.3.0.AppImage`, sha256: sha256Hex(BYTES), size: BYTES.length };

let feed: FakeFeed;
let userData: string;
let clock: number;
const clients: UpdateClient[] = [];

beforeEach(async () => {
  feed = await startFakeFeed();
  userData = await mkdtemp(path.join(os.tmpdir(), 'frost-update-client-'));
  clock = START;
  feed.route('/frost-1.3.0.AppImage', { body: BYTES });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  await feed.close();
  await rm(userData, { recursive: true, force: true });
});

/** Injected timers: nothing runs until the test fires it. */
function fakeTimers(): UpdateTimers & { pending(): number[]; fire(): void } {
  let next = 1;
  const queue = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      queue.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      queue.delete(id as number);
    },
    pending: () => [...queue.values()].map((entry) => entry.ms),
    fire() {
      const first = queue.entries().next().value;
      if (!first) throw new Error('no timer pending');
      queue.delete(first[0]);
      first[1].fn();
    },
  };
}

/** Serves `manifest`, signed by `key`, as the feed. */
const serve = (manifest: unknown, key = KEY) => feed.route('/feed.json', { body: signEnvelope(manifest, key) });
const manifest = (version = '1.3.0', extra: Record<string, unknown> = {}, artifacts: Record<string, typeof ARTIFACT> = { 'linux-x64': ARTIFACT }) => manifestFor(version, clock, artifacts, extra);

async function makeClient(overrides: Partial<UpdateClientDeps> = {}) {
  const timers = fakeTimers();
  const hop = nodeTransport({ https: { [HOST]: feed.port } });
  const client = await createUpdateClient({
    feed: { url: `${feed.origin}/feed.json` },
    currentVersion: '1.2.0',
    platformKey: 'linux-x64',
    userData,
    prefs: createPrefsStore(userData),
    hop,
    resolve: tableResolver({ [HOST]: ['93.184.215.14'] }),
    isPackaged: false,
    keys: KEY.keys,
    now: () => clock,
    random: () => 0.5,
    timers,
    ...overrides,
  });
  clients.push(client);
  return { client, timers, hop };
}

/** Lets a fired timer's check (and what it schedules after) finish. */
async function settle(client: UpdateClient) {
  await new Promise((resolve) => setImmediate(resolve));
  while (['checking', 'downloading'].includes(client.state().status.kind)) await client.watch(client.state().version);
  await new Promise((resolve) => setImmediate(resolve));
}

/** A manual check past the rate limit. */
async function checkAgain(client: UpdateClient) {
  clock += UPDATE_SCHEDULE.manualMinIntervalMs + 1;
  return client.checkNow();
}

const prefsOnDisk = async () => JSON.parse(await readFile(path.join(userData, UPDATE_PREFS_FILE), 'utf8')) as UpdatePrefs;
const feedRequests = () => feed.requests.filter((request) => request.path === '/feed.json');
const artifactRequests = () => feed.requests.filter((request) => request.path !== '/feed.json');

/** Records every status kind the client passes through. */
function record(client: UpdateClient) {
  const kinds: UpdateStatusKind[] = [client.state().status.kind];
  const states: UpdateState[] = [client.state()];
  const controller = new AbortController();
  void (async () => {
    let version = client.state().version;
    while (!controller.signal.aborted) {
      const state = await client.watch(version, controller.signal);
      if (state.version === version) break;
      version = state.version;
      kinds.push(state.status.kind);
      states.push(state);
    }
  })();
  return { kinds, states, stop: () => controller.abort() };
}

describe('update client', () => {
  test('no-feed-no-requests', async () => {
    const { client, timers, hop } = await makeClient({ feed: null });
    expect(client.state()).toMatchObject({ status: { kind: 'disabled' }, checks: 'on', currentVersion: '1.2.0', lastCheckedAt: null });
    expect(timers.pending()).toEqual([]);
    expect((await client.checkNow()).status.kind).toBe('disabled');
    expect((await client.download()).status.kind).toBe('disabled');
    expect((await client.setChecks('off')).status.kind).toBe('disabled');
    expect((await client.setChecks('on')).status.kind).toBe('disabled');
    expect(timers.pending()).toEqual([]);
    expect(hop.urls).toEqual([]);
    expect(feed.requests).toEqual([]);
  });

  test('checks-off-no-requests', async () => {
    const store = createPrefsStore(userData);
    await store.write({ ...(await store.read()), checks: 'off' });
    serve(manifest());
    const { client, timers, hop } = await makeClient();
    expect(client.state()).toMatchObject({ status: { kind: 'off' }, checks: 'off' });
    // No automatic check is even scheduled.
    expect(timers.pending()).toEqual([]);
    expect(hop.urls).toEqual([]);
    // "Check now" is a user action: one check.
    expect((await client.checkNow()).status).toMatchObject({ kind: 'available', version: '1.3.0' });
    expect(feedRequests()).toHaveLength(1);
    expect(timers.pending()).toEqual([]);
    expect(client.state().checks).toBe('off');
  });

  test('check-schedule', async () => {
    serve(manifest());
    const randoms = [0, 0.999_999, 0.25];
    const { client, timers } = await makeClient({ random: () => randoms.shift() ?? 0.5 });
    expect(client.state().status.kind).toBe('idle');
    // The first check: 30 s, jittered (random 0: -10 %).
    expect(timers.pending()).toEqual([jittered(UPDATE_SCHEDULE.firstCheckMs, 0)]);
    expect(jittered(UPDATE_SCHEDULE.firstCheckMs, 0)).toBe(27_000);
    expect(feed.requests).toEqual([]);
    timers.fire();
    expect(client.state().status.kind).toBe('checking');
    await settle(client);
    expect(client.state().status.kind).toBe('available');
    expect(feedRequests()).toHaveLength(1);
    // Then every 6 h, jittered (random ~1: +10 %).
    const [interval] = timers.pending();
    expect(timers.pending()).toHaveLength(1);
    expect(interval).toBe(jittered(UPDATE_SCHEDULE.intervalMs, 0.999_999));
    expect(interval).toBeGreaterThan(UPDATE_SCHEDULE.intervalMs * 1.0999);
    expect(interval).toBeLessThanOrEqual(UPDATE_SCHEDULE.intervalMs * 1.1);
    // "Check now" right after a check: no request, the current state.
    const before = client.state();
    expect(await client.checkNow()).toEqual(before);
    clock += UPDATE_SCHEDULE.manualMinIntervalMs - 1;
    expect(await client.checkNow()).toEqual(before);
    expect(feedRequests()).toHaveLength(1);
    clock += 2;
    await client.checkNow();
    expect(feedRequests()).toHaveLength(2);
    // The next scheduled check runs and schedules the one after.
    timers.fire();
    await settle(client);
    expect(feedRequests()).toHaveLength(3);
    expect(timers.pending()).toEqual([jittered(UPDATE_SCHEDULE.intervalMs, 0.25)]);
    // Jitter stays within ± 10 %.
    for (const random of [0, 0.1, 0.5, 0.9, 0.999_999]) {
      const delay = jittered(UPDATE_SCHEDULE.intervalMs, random);
      expect(delay).toBeGreaterThanOrEqual(UPDATE_SCHEDULE.intervalMs * 0.9);
      expect(delay).toBeLessThanOrEqual(UPDATE_SCHEDULE.intervalMs * 1.1);
    }
  });

  test('available-after-verified-check', async () => {
    const offered = manifest('1.3.0', { notes: 'frost 1.3.0\n\n- New things.' });
    serve(offered);
    const { client } = await makeClient();
    const seen = record(client);
    const state = await client.checkNow();
    seen.stop();
    expect(seen.kinds.slice(0, 3)).toEqual(['idle', 'checking', 'available']);
    expect(state.status).toEqual({ kind: 'available', version: '1.3.0', notes: 'frost 1.3.0\n\n- New things.', releasedAt: offered.releasedAt, required: false, size: BYTES.length });
    expect(state.lastCheckedAt).toBe(new Date(clock).toISOString());
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'available', version: '1.3.0' });
    expect((await prefsOnDisk()).highWaterMark).toEqual({ version: '1.3.0', releasedAt: offered.releasedAt });
    // One request, to the feed; nothing about the install in it.
    expect(feed.requests).toHaveLength(1);
    const installId = (await prefsOnDisk()).installId;
    expect(JSON.stringify(feed.requests[0])).not.toContain(installId);
    expect(Object.keys(feed.requests[0]!.headers).sort()).toEqual(['connection', 'host', 'user-agent']);
    // The state the chrome sees holds no path and no URL.
    expect(JSON.stringify(state)).not.toContain(userData);
    expect(JSON.stringify(state)).not.toContain(HOST);
  });

  test('check-errors', async () => {
    const { client } = await makeClient();
    const reasonOf = async () => {
      const state = await checkAgain(client);
      return state.status.kind === 'error' ? state.status.reason : state.status.kind;
    };
    // No route yet: 404.
    expect(await reasonOf()).toBe('feed-unreachable');
    expect(client.lastCheck()).toEqual({ kind: 'failed', reason: 'feed-unreachable', detail: 'http-status' });
    feed.route('/feed.json', { body: Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x20) });
    expect(await reasonOf()).toBe('feed-too-large');
    serve(manifest(), OTHER_KEY);
    expect(await reasonOf()).toBe('bad-envelope');
    expect(client.lastCheck()).toEqual({ kind: 'failed', reason: 'bad-envelope', detail: 'bad-signature' });
    serve(manifest(), testSigningKey('another-key'));
    expect(await reasonOf()).toBe('bad-envelope');
    expect(client.lastCheck()).toEqual({ kind: 'failed', reason: 'bad-envelope', detail: 'unknown-key' });
    feed.route('/feed.json', { body: 'not json' });
    expect(await reasonOf()).toBe('bad-envelope');
    serve(manifestFor('1.3.0', clock - 40 * 24 * 60 * 60 * 1000, { 'linux-x64': ARTIFACT }));
    expect(await reasonOf()).toBe('stale');
    expect(client.lastCheck()).toEqual({ kind: 'failed', reason: 'stale', detail: 'expired' });
    // A feed on a closed port.
    const closed = await startFakeFeed();
    await closed.close();
    const { client: offline } = await makeClient({ feed: { url: `${closed.origin}/feed.json` } });
    expect((await offline.checkNow()).status).toEqual({ kind: 'error', reason: 'feed-unreachable' });
    // An error clears after a good check.
    serve(manifest());
    expect(await reasonOf()).toBe('available');
  });

  test('older-than-seen', async () => {
    const { client } = await makeClient();
    const newest = manifest('1.3.0');
    serve(newest);
    expect((await client.checkNow()).status.kind).toBe('available');
    const mark = { version: '1.3.0', releasedAt: newest.releasedAt };
    expect((await prefsOnDisk()).highWaterMark).toEqual(mark);
    // A correctly signed, fresh, older manifest (still newer than the running 1.2.0): a replay.
    serve(manifest('1.2.5'));
    expect((await checkAgain(client)).status).toEqual({ kind: 'error', reason: 'older-than-seen' });
    // The same version released earlier.
    serve(manifest('1.3.0', { releasedAt: new Date(Date.parse(newest.releasedAt) - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    expect((await checkAgain(client)).status).toEqual({ kind: 'error', reason: 'older-than-seen' });
    expect((await prefsOnDisk()).highWaterMark).toEqual(mark);
    // The mark survives a restart.
    const { client: restarted } = await makeClient();
    serve(manifest('1.2.5'));
    expect((await restarted.checkNow()).status).toEqual({ kind: 'error', reason: 'older-than-seen' });
    // The same manifest again is fine; re-signed later, the mark moves.
    serve(newest);
    expect((await checkAgain(client)).status.kind).toBe('available');
    const later = manifest('1.3.0', { releasedAt: new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    serve(later);
    expect((await checkAgain(client)).status.kind).toBe('available');
    expect((await prefsOnDisk()).highWaterMark).toEqual({ version: '1.3.0', releasedAt: later.releasedAt });
  });

  test('prerelease-does-not-raise-mark', async () => {
    const { client } = await makeClient();
    // A release build sees a verified pre-release: ignored, and the mark stays where it was.
    serve(manifest('2.0.0-beta.1'));
    expect((await client.checkNow()).status).toEqual({ kind: 'up-to-date' });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'prerelease-ignored', version: '2.0.0-beta.1' });
    expect((await prefsOnDisk()).highWaterMark).toBeUndefined();
    // So a later release hotfix below that pre-release is still offered, not refused as a replay.
    serve(manifest('1.5.0'));
    expect((await checkAgain(client)).status).toMatchObject({ kind: 'available', version: '1.5.0' });
    expect((await prefsOnDisk()).highWaterMark?.version).toBe('1.5.0');
    serve(manifest('2.0.0-beta.2'));
    await checkAgain(client);
    expect((await prefsOnDisk()).highWaterMark?.version).toBe('1.5.0');
    // An install running a pre-release is offered pre-releases, so they do raise its mark.
    const { client: beta } = await makeClient({ currentVersion: '1.6.0-beta.1' });
    serve(manifest('2.0.0-beta.2'));
    expect((await beta.checkNow()).status).toMatchObject({ kind: 'available', version: '2.0.0-beta.2' });
    expect((await prefsOnDisk()).highWaterMark?.version).toBe('2.0.0-beta.2');
  });

  test('staged-out-stays-quiet', async () => {
    const { client } = await makeClient();
    serve(manifest('1.3.0', { rolloutPercent: 0 }));
    expect((await client.checkNow()).status).toEqual({ kind: 'up-to-date' });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'staged-out', version: '1.3.0' });
    // The mark moves even for a version this install is not offered.
    expect((await prefsOnDisk()).highWaterMark?.version).toBe('1.3.0');
    serve(manifest('1.4.0-beta.1'));
    expect((await checkAgain(client)).status).toEqual({ kind: 'up-to-date' });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'prerelease-ignored', version: '1.4.0-beta.1' });
    serve(manifest('1.4.0', {}, { 'darwin-arm64': ARTIFACT }));
    expect((await checkAgain(client)).status).toEqual({ kind: 'up-to-date' });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'no-artifact', version: '1.4.0' });
    serve(manifest('1.4.0'));
    expect((await checkAgain(client)).status.kind).toBe('available');
    // A platform frost publishes nothing for.
    const { client: other } = await makeClient({ platformKey: null });
    expect((await other.checkNow()).status).toEqual({ kind: 'up-to-date' });
    expect(other.lastCheck()).toEqual({ kind: 'decided', decision: 'no-artifact', version: '1.4.0' });
    // Nothing was downloaded by any of it.
    expect(artifactRequests()).toEqual([]);
  });

  test('skip-version', async () => {
    const { client } = await makeClient();
    serve(manifest('1.3.0'));
    await client.checkNow();
    expect((await client.skip()).status).toEqual({ kind: 'up-to-date' });
    expect((await prefsOnDisk()).skippedVersion).toBe('1.3.0');
    expect((await checkAgain(client)).status).toEqual({ kind: 'up-to-date' });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'skipped', version: '1.3.0' });
    // skip() outside `available` changes nothing.
    const before = client.state();
    expect(await client.skip()).toEqual(before);
    // A later version is offered again.
    serve(manifest('1.3.1'));
    expect((await checkAgain(client)).status).toMatchObject({ kind: 'available', version: '1.3.1' });
  });

  test('required-cannot-be-skipped', async () => {
    const store = createPrefsStore(userData);
    await store.write({ ...(await store.read()), skippedVersion: '1.3.0' });
    const { client } = await makeClient();
    serve(manifest('1.3.0', { minimumVersion: '1.2.5', rolloutPercent: 0 }));
    const state = await client.checkNow();
    expect(state.status).toMatchObject({ kind: 'available', version: '1.3.0', required: true });
    expect(client.lastCheck()).toEqual({ kind: 'decided', decision: 'required', version: '1.3.0' });
    expect(await client.skip()).toEqual(state);
    expect(client.state().status).toMatchObject({ kind: 'available', required: true });
    expect((await prefsOnDisk()).skippedVersion).toBe('1.3.0');
  });

  test('download-needs-consent', async () => {
    const { client } = await makeClient();
    // Not available yet: download() does nothing.
    expect((await client.download()).status.kind).toBe('idle');
    serve(manifest('1.3.0'));
    await client.checkNow();
    expect(artifactRequests()).toEqual([]);
    expect(client.readyFile()).toBeNull();
    const seen = record(client);
    const state = await client.download();
    seen.stop();
    const fileName = artifactFileName('1.3.0', 'linux-x64');
    expect(state.status).toEqual({ kind: 'ready', version: '1.3.0', install: 'manual', fileName });
    expect(seen.kinds).toContain('downloading');
    const downloading = seen.states.filter((s) => s.status.kind === 'downloading').map((s) => s.status as { bytes: number; total: number });
    expect(downloading[0]).toEqual({ kind: 'downloading', version: '1.3.0', bytes: 0, total: BYTES.length });
    expect(downloading.every((s) => s.total === BYTES.length && s.bytes <= BYTES.length)).toBe(true);
    expect(seen.kinds.at(-1)).toBe('ready');
    const file = path.join(userData, UPDATE_DOWNLOADS_DIR, '1.3.0', fileName);
    expect(client.readyFile()).toBe(file);
    expect(await readFile(file)).toEqual(BYTES);
    expect(JSON.stringify(state)).not.toContain(userData);
    expect(artifactRequests()).toHaveLength(1);
    expect(Object.keys(artifactRequests()[0]!.headers).sort()).toEqual(['connection', 'host', 'user-agent']);
    // Ready: a second download() and further checks do nothing.
    expect(await client.download()).toEqual(client.state());
    expect(await checkAgain(client)).toEqual(client.state());
    expect(artifactRequests()).toHaveLength(1);
    expect(feedRequests()).toHaveLength(1);
  });

  test('download-errors-shown', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[0] = tampered[0]! ^ 1;
    feed.route('/frost-1.3.0.AppImage', { body: tampered });
    const { client } = await makeClient();
    serve(manifest('1.3.0'));
    await client.checkNow();
    expect((await client.download()).status).toEqual({ kind: 'error', reason: 'hash-mismatch', version: '1.3.0' });
    expect(client.readyFile()).toBeNull();
    expect(await readdir(path.join(userData, UPDATE_DOWNLOADS_DIR, '1.3.0'))).toEqual([]);
    // No retry from the error: download() needs a fresh offer.
    expect((await client.download()).status.kind).toBe('error');
    expect(artifactRequests()).toHaveLength(1);
    // An offer whose manifest expired since the check: stale, and nothing requested.
    feed.route('/frost-1.3.0.AppImage', { body: BYTES });
    serve(manifest('1.3.0'));
    expect((await checkAgain(client)).status.kind).toBe('available');
    clock += 31 * 24 * 60 * 60 * 1000;
    expect((await client.download()).status).toEqual({ kind: 'error', reason: 'stale', version: '1.3.0' });
    expect(artifactRequests()).toHaveLength(1);
  });

  test('set-checks', async () => {
    const { client, timers } = await makeClient();
    expect(client.state().status.kind).toBe('idle');
    expect(timers.pending()).toHaveLength(1);
    let state = await client.setChecks('off');
    expect(state).toMatchObject({ checks: 'off', status: { kind: 'off' } });
    expect(timers.pending()).toEqual([]);
    expect((await prefsOnDisk()).checks).toBe('off');
    state = await client.setChecks('on');
    expect(state).toMatchObject({ checks: 'on', status: { kind: 'idle' } });
    expect(timers.pending()).toEqual([jittered(UPDATE_SCHEDULE.firstCheckMs, 0.5)]);
    expect((await prefsOnDisk()).checks).toBe('on');
    // An offer stays on screen when checks are turned off.
    serve(manifest('1.3.0'));
    await client.checkNow();
    state = await client.setChecks('off');
    expect(state).toMatchObject({ checks: 'off', status: { kind: 'available', version: '1.3.0' } });
    expect(timers.pending()).toEqual([]);
    // Turning them on twice schedules one check, not two.
    await client.setChecks('on');
    await client.setChecks('on');
    expect(timers.pending()).toHaveLength(1);
    // dispose() stops the schedule.
    client.dispose();
    expect(timers.pending()).toEqual([]);
  });

  test('watch-long-poll', async () => {
    const { client } = await makeClient();
    const v = client.state().version;
    // Older than the state: at once.
    expect((await client.watch(v - 1)).version).toBe(v);
    // Current: on the next change.
    let answered: UpdateState | undefined;
    const pending = client.watch(v).then((state) => (answered = state));
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBeUndefined();
    await client.setChecks('off');
    await pending;
    expect(answered!.version).toBeGreaterThan(v);
    expect(answered!.status.kind).toBe('off');
    // A version from the future waits for the next change only.
    const future = client.watch(client.state().version + 100);
    await client.setChecks('on');
    expect((await future).status.kind).toBe('idle');
    // Aborting answers with the current state.
    const controller = new AbortController();
    const aborted = client.watch(client.state().version, controller.signal);
    controller.abort();
    expect((await aborted).version).toBe(client.state().version);
    // At the cap, one more answers the oldest at once.
    const order: number[] = [];
    const watches = Array.from({ length: MAX_PENDING_UPDATE_WATCHES + 1 }, (_, i) => client.watch(client.state().version).then(() => order.push(i)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([0]);
    await client.setChecks('off');
    await Promise.all(watches);
    expect(order).toHaveLength(MAX_PENDING_UPDATE_WATCHES + 1);
    // dispose() answers whoever waits.
    const last = client.watch(client.state().version);
    client.dispose();
    expect((await last).version).toBe(client.state().version);
  });

  test('errors-are-caught', async () => {
    serve(manifest('1.3.0'));
    const { client } = await makeClient({ currentVersion: 'not-a-version' });
    expect((await client.checkNow()).status).toEqual({ kind: 'error', reason: 'internal' });
    // A prefs write that fails: `disk`, never a rejection.
    const store = createPrefsStore(userData);
    const failing = { read: () => store.read(), write: async () => Promise.reject(new Error('EROFS')) };
    const { client: readOnly } = await makeClient({ prefs: failing });
    expect((await readOnly.checkNow()).status).toEqual({ kind: 'error', reason: 'disk' });
    expect((await readOnly.setChecks('off')).status.kind).toBe('error');
    // A hop that throws synchronously.
    const { client: broken } = await makeClient({
      hop: () => {
        throw new Error('boom');
      },
    });
    expect((await broken.checkNow()).status).toEqual({ kind: 'error', reason: 'feed-unreachable' });
  });
});
