// Spec: specs/gsc.spec.ts (gscDateRange, gscRetentionStart, gscCustomRange, GSC_MAX_RANGE_DAYS, GSC_CACHE_TTL_MS, GSC_LIMITS,
// GSC_UNAVAILABLE_REASONS), specs/gsc.schema.ts (GscStatusSchema, GscPerformanceAnswerSchema, GscQueriesAnswerSchema,
// GscCountriesAnswerSchema, GscPropertiesAnswerSchema, GscPropertyForAnswerSchema)
// specs/entitlements-snapshot.spec.ts (UNGATED_FEATURES: Search Console is not gated, 2026-10-29)
// Acceptance: specs/gsc.feature.md (Service; Ranges and filters) · plan "Interfaces for other phases" (the read API never throws)
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  GSC_CACHE_TTL_MS,
  GSC_LIMITS,
  GSC_MAX_RANGE_DAYS,
  GSC_RATE_LIMIT,
  GscCountriesAnswerSchema,
  GscPerformanceAnswerSchema,
  GscQueriesAnswerSchema,
  GSC_PROFILE_OWNER,
  GscStatusSchema,
  gscCustomRange,
  gscDateRange,
  gscRangeDays,
  gscRetentionStart,
  type GscPerformanceQuery,
} from '@app/specs/gsc.schema';
import { gscAdapter, type GscServiceLike } from '../../agent/ports/gsc-adapter';
import { fakeDateRows, type FakeRow } from '../../../../e2e/fake-google';
import { searchAnalyticsBody } from '../api';
import { GSC_SECRET } from '../oauth';
import { UNGATED_FEATURES } from '@app/specs/entitlements-snapshot.spec';
import { createGscService, GSC_UNGATED_ACCESS, type GscMainService, type GscServiceDeps } from '../service';
import { createHarness, memoryStore, OWNER, storedBlob, WINDOW_ID, type Harness } from './harness';

const SITE = 'https://www.example.com/';
const PAGE = 'https://www.example.com/blog/post?x=1';
const QUERY: GscPerformanceQuery = { url: `${PAGE}#comments`, scope: 'page', days: 28 };

let h: Harness;
let entitled: boolean;
let listeners: Set<() => void>;
const services: GscMainService[] = [];

beforeEach(async () => {
  h = await createHarness();
  h.google.sites = [
    { siteUrl: SITE, permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://unverified.example.net/', permissionLevel: 'siteUnverifiedUser' },
  ];
  entitled = true;
  listeners = new Set();
});
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  await h.close();
});

async function serviceWith(overrides: Partial<GscServiceDeps> = {}): Promise<GscMainService> {
  const service = await createGscService({
    config: h.config,
    fetch: h.fetch,
    store: h.store,
    entitled: () => entitled,
    onEntitlementsChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    userId: h.currentUser,
    onAccountChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startLoopback: h.startLoopback,
    openInBrowser: h.openInBrowser,
    consumeGesture: h.consumeGesture,
    log: h.log,
    now: h.now,
    ...overrides,
  });
  services.push(service);
  return service;
}

async function connected(overrides: Partial<GscServiceDeps> = {}): Promise<GscMainService> {
  const service = await serviceWith(overrides);
  h.grant();
  expect(await service.connect(WINDOW_ID)).toBe('started');
  await h.follow();
  await service.whenIdle();
  expect(service.status().connected).toBe(true);
  return service;
}

const range28 = () => gscDateRange(28, h.clock.now);
const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** One fake row per day of the range (Google's answer for a range with data every day). */
const everyDay = (start: string, end: string): FakeRow[] => {
  const rows: FakeRow[] = [];
  for (let at = Date.parse(`${start}T00:00:00Z`); at <= Date.parse(`${end}T00:00:00Z`); at += DAY_MS) rows.push({ keys: [isoDay(at)], clicks: 1, impressions: 10, ctr: 0.1, position: 5 });
  return rows;
};

describe('Search Console service', () => {
  test('not-entitled-refused-before-network', async () => {
    h.store.write(GSC_SECRET, storedBlob());
    entitled = false;
    const service = await serviceWith();
    expect(service.status()).toMatchObject({ configured: true, entitled: false, connected: true });
    const unavailable = { status: 'unavailable', reason: 'not-entitled' };
    expect(await service.properties()).toEqual(unavailable);
    expect(await service.propertyFor(PAGE)).toEqual(unavailable);
    expect(await service.performance(QUERY)).toEqual(unavailable);
    expect(await service.topQueries(QUERY)).toEqual(unavailable);
    h.grant();
    expect(await service.connect(WINDOW_ID)).toBe('not-entitled');
    expect(h.fetched).toEqual([]);
    expect(h.google.requests).toEqual([]);
    expect(h.opened).toEqual([]);
    // Disconnect always works (and revokes).
    expect(await service.disconnect()).toBe(true);
    expect(h.google.revoked).toEqual(['stored-refresh-token-1']);
  });

  test('search-console-ungated-without-account', async () => {
    expect(UNGATED_FEATURES).toContain('search-console');
    // Main's wiring: no frost account at all (nobody signed in, no entitlements anywhere).
    h.account.userId = null;
    entitled = false;
    const service = await connected({ ...GSC_UNGATED_ACCESS, onEntitlementsChange: undefined, onAccountChange: undefined });
    expect(service.status()).toMatchObject({ configured: true, entitled: true, connected: true });
    expect(JSON.parse((await h.store.read(GSC_SECRET))!).owner).toBe(GSC_PROFILE_OWNER);
    expect(await service.performance(QUERY)).toMatchObject({ status: 'ok' });
    expect(await service.topQueries(QUERY)).toMatchObject({ status: 'ok' });
    // A connection an older build stored under a frost account is another owner's: revoked and deleted at start.
    const store = memoryStore();
    store.write(GSC_SECRET, storedBlob('stored-refresh-token-old', OWNER));
    const later = await serviceWith({ ...GSC_UNGATED_ACCESS, store, onEntitlementsChange: undefined, onAccountChange: undefined });
    expect(later.status()).toMatchObject({ entitled: true, connected: false });
    await expect.poll(() => h.google.revoked.includes('stored-refresh-token-old')).toBe(true);
    expect(await store.read(GSC_SECRET)).toBeNull();
    // Connected under the profile, it stays connected for a later run, whoever is signed in to frost.
    const kept = memoryStore();
    kept.write(GSC_SECRET, storedBlob('stored-refresh-token-profile', GSC_PROFILE_OWNER));
    expect((await serviceWith({ ...GSC_UNGATED_ACCESS, store: kept, onEntitlementsChange: undefined, onAccountChange: undefined })).status().connected).toBe(true);
  });

  test('unconfigured-and-not-connected', async () => {
    const bare = await serviceWith({ config: null });
    expect(GscStatusSchema.parse(bare.status())).toMatchObject({ configured: false, connected: false, connecting: false });
    for (const answer of [await bare.properties(), await bare.propertyFor(PAGE), await bare.performance(QUERY), await bare.topQueries(QUERY)]) {
      expect(answer).toEqual({ status: 'unavailable', reason: 'unconfigured' });
    }
    h.grant();
    expect(await bare.connect(WINDOW_ID)).toBe('unconfigured');
    expect(await bare.cancelConnect()).toBe(false);
    expect(await bare.disconnect()).toBe(false);
    const service = await serviceWith();
    expect(service.status()).toMatchObject({ configured: true, entitled: true, connected: false, connecting: false, keychain: 'persistent', error: null });
    for (const answer of [await service.properties(), await service.propertyFor(PAGE), await service.performance(QUERY), await service.topQueries(QUERY)]) {
      expect(answer).toEqual({ status: 'unavailable', reason: 'not-connected' });
    }
    expect(h.fetched).toEqual([]);
    expect(await (await serviceWith({ store: memoryStore(false) })).status().keychain).toBe('memory-only');
  });

  test('not-a-web-page-and-invalid', async () => {
    const service = await connected();
    const before = h.fetched.length;
    expect(await service.performance({ ...QUERY, url: 'about:blank' })).toEqual({ status: 'unavailable', reason: 'not-a-web-page' });
    expect(await service.topQueries({ ...QUERY, url: 'app://app/' })).toEqual({ status: 'unavailable', reason: 'not-a-web-page' });
    expect(await service.propertyFor('file:///etc/hosts')).toEqual({ status: 'unavailable', reason: 'not-a-web-page' });
    for (const bad of [{ ...QUERY, scope: 'site' }, { ...QUERY, days: 30 }, { ...QUERY, extra: 1 }, null, 'x', { url: 5 }]) {
      expect(await service.performance(bad as never), JSON.stringify(bad)).toEqual({ status: 'unavailable', reason: 'invalid' });
      expect(await service.topQueries(bad as never), JSON.stringify(bad)).toEqual({ status: 'unavailable', reason: 'invalid' });
    }
    expect(await service.propertyFor(42 as never)).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(h.fetched).toHaveLength(before);
  });

  test('performance-page-vs-property-bodies', async () => {
    const service = await connected();
    const page = await service.performance(QUERY);
    expect(page).toMatchObject({ status: 'ok', property: { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' }, scope: 'page', range: range28() });
    expect(h.google.queries).toEqual([{ siteUrl: SITE, body: searchAnalyticsBody({ range: range28(), dimension: 'date', pageUrl: PAGE, rowLimit: 28 }) }]);
    const site = await service.performance({ ...QUERY, scope: 'property', days: 90 });
    expect(site).toMatchObject({ status: 'ok', scope: 'property', range: gscDateRange(90, h.clock.now) });
    expect(h.google.queries[1]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: gscDateRange(90, h.clock.now), dimension: 'date', pageUrl: null, rowLimit: 90 }) });
    expect(h.google.queries[1]!.body).not.toHaveProperty('dimensionFilterGroups');
    // A domain property: the query goes to `sc-domain:…`.
    expect(await service.performance({ url: 'http://shop.example.org/', scope: 'page', days: 7 })).toMatchObject({ status: 'ok', property: { siteUrl: 'sc-domain:example.org', kind: 'domain' } });
    expect(h.google.queries[2]?.siteUrl).toBe('sc-domain:example.org');
    expect(await service.propertyFor(PAGE)).toEqual({ status: 'ok', property: { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' } });
    expect(await service.properties()).toEqual({
      status: 'ok',
      properties: [
        { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.org', kind: 'domain', permissionLevel: 'siteFullUser' },
      ],
    });
    // One `sites` call served all of them.
    expect(h.google.sitesCalls).toBe(1);
  });

  test('performance-rows-and-totals', async () => {
    const service = await connected();
    const { start, end } = range28();
    const answer = await service.performance(QUERY);
    expect(GscPerformanceAnswerSchema.parse(answer)).toEqual(answer);
    const expected = fakeDateRows(start).map((row) => ({ date: row.keys[0], clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position }));
    expect(answer).toMatchObject({ status: 'ok', rows: expected });
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.totals.clicks).toBe(60);
    expect(answer.totals.impressions).toBe(600);
    expect(answer.totals.ctr).toBeCloseTo(0.1);
    expect(answer.totals.position).toBeCloseTo((2 * 100 + 3 * 200 + 4 * 300) / 600);
    // Out-of-range, duplicate and unsorted rows: only the range's dates, once each, in order.
    h.google.dateRows = () => [
      { keys: [end], clicks: 1, impressions: 4, ctr: 0.25, position: 3 },
      { keys: ['1999-01-01'], clicks: 9, impressions: 9, ctr: 1, position: 1 },
      { keys: [start], clicks: 2, impressions: 8, ctr: 0.25, position: 5 },
      { keys: [start], clicks: 7, impressions: 7, ctr: 1, position: 1 },
      { keys: ['not a date'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
      { keys: [], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    ];
    const odd = await service.performance({ ...QUERY, scope: 'property' });
    expect(odd).toMatchObject({
      status: 'ok',
      rows: [
        { date: start, clicks: 2, impressions: 8, ctr: 0.25, position: 5 },
        { date: end, clicks: 1, impressions: 4, ctr: 0.25, position: 3 },
      ],
      totals: { clicks: 3, impressions: 12, ctr: 0.25 },
    });
    // No data: no rows, zero totals, no position.
    h.google.dateRows = () => [];
    expect(await service.performance({ ...QUERY, days: 7 })).toMatchObject({ status: 'ok', rows: [], totals: { clicks: 0, impressions: 0, ctr: 0, position: null } });
  });

  test('top-queries-capped', async () => {
    const service = await connected();
    const answer = await service.topQueries(QUERY);
    expect(GscQueriesAnswerSchema.parse(answer)).toEqual(answer);
    if (answer.status !== 'ok') throw new Error('not ok');
    expect(answer.rows).toHaveLength(GSC_LIMITS.maxTopQueries);
    expect(answer.rows[0]).toEqual({ query: 'fake query 1', clicks: 1000, impressions: 10_000, ctr: 0.1, position: 1 });
    expect(answer.rows.map((r) => r.clicks)).toEqual([...answer.rows.map((r) => r.clicks)].sort((a, b) => b - a));
    expect(h.google.queries[0]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: range28(), dimension: 'query', pageUrl: PAGE, rowLimit: GSC_LIMITS.maxTopQueries }) });
    h.google.queryRows = () => [{ keys: ['q'.repeat(GSC_LIMITS.maxQueryChars + 50)], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }];
    const long = await service.topQueries({ ...QUERY, scope: 'property' });
    expect(long).toMatchObject({ status: 'ok', rows: [{ query: 'q'.repeat(GSC_LIMITS.maxQueryChars) }] });
  });

  test('no-property', async () => {
    const service = await connected();
    for (const url of ['https://other.example.com/', 'http://www.example.com/blog/post', 'https://unverified.example.net/a']) {
      expect(await service.performance({ ...QUERY, url }), url).toEqual({ status: 'unavailable', reason: 'no-property' });
      expect(await service.propertyFor(url), url).toEqual({ status: 'unavailable', reason: 'no-property' });
    }
    expect(h.google.queries).toEqual([]);
    // Access to the property was withdrawn since the list was read: the query's 403 is `no-property`,
    // and the list is read again next time.
    h.google.sites = [];
    expect(await service.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'no-property' });
    expect(h.google.queries).toHaveLength(1);
    expect(h.google.sitesCalls).toBe(1);
    expect(await service.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'no-property' });
    expect(h.google.sitesCalls).toBe(2);
    expect(await service.properties()).toEqual({ status: 'ok', properties: [] });
  });

  test('refresh-once-on-401', async () => {
    const service = await connected();
    expect(await service.performance(QUERY)).toMatchObject({ status: 'ok' });
    expect(h.google.tokenRequests).toHaveLength(1);
    h.google.expireAccessTokens();
    expect(await service.performance({ ...QUERY, scope: 'property' })).toMatchObject({ status: 'ok' });
    expect(h.google.tokenRequests).toHaveLength(2);
    expect(h.google.tokenRequests[1]?.get('grant_type')).toBe('refresh_token');
    expect(h.google.apiTokens.slice(-2)).toEqual([h.google.accessTokens[0], h.google.accessTokens[1]]);
    // Still refused with a fresh token: `auth-expired` after one refresh, and the connection is kept.
    h.google.mode = 'unauthorized';
    expect(await service.performance({ ...QUERY, days: 7 })).toEqual({ status: 'unavailable', reason: 'auth-expired' });
    expect(h.google.tokenRequests).toHaveLength(3);
    expect(service.status().connected).toBe(true);
    // The refresh token itself refused: disconnected, `auth-expired`.
    h.google.mode = 'ok';
    h.google.revokeRefreshTokens();
    h.google.expireAccessTokens();
    expect(await service.performance({ ...QUERY, days: 90 })).toEqual({ status: 'unavailable', reason: 'auth-expired' });
    expect(service.status()).toMatchObject({ connected: false, error: 'auth-expired' });
    expect(await h.store.read(GSC_SECRET)).toBeNull();
    expect(await service.performance({ ...QUERY, days: 90 })).toEqual({ status: 'unavailable', reason: 'not-connected' });
  });

  test('quota-and-network-mapping', async () => {
    const service = await connected();
    const cases = [
      ['quota', 'quota'],
      ['quota-403', 'quota'],
      ['down', 'network'],
      ['garbage', 'invalid'],
    ] as const;
    for (const [mode, reason] of cases) {
      h.google.mode = mode;
      expect(await service.properties(), mode).toEqual({ status: 'unavailable', reason });
      expect(await service.performance(QUERY), mode).toEqual({ status: 'unavailable', reason });
    }
    h.google.mode = 'ok';
    expect(await service.performance(QUERY)).toMatchObject({ status: 'ok' });
    for (const [mode, reason] of cases) {
      h.google.mode = mode;
      expect(await service.topQueries({ ...QUERY, days: 7 }), mode).toEqual({ status: 'unavailable', reason });
    }
    h.google.mode = 'ok';
    await h.google.close();
    expect(await service.topQueries({ ...QUERY, days: 90 })).toEqual({ status: 'unavailable', reason: 'network' });
  });

  test('cache-15-minutes-cleared-on-disconnect', async () => {
    const service = await connected();
    const first = await service.performance(QUERY);
    expect(await service.performance(QUERY)).toEqual(first);
    // The fragment is not part of the key.
    expect(await service.performance({ ...QUERY, url: PAGE })).toEqual(first);
    expect(h.google.queries).toHaveLength(1);
    expect(h.google.sitesCalls).toBe(1);
    h.clock.now += GSC_CACHE_TTL_MS - 1;
    await service.performance(QUERY);
    await service.properties();
    expect(h.google.queries).toHaveLength(1);
    expect(h.google.sitesCalls).toBe(1);
    h.clock.now += 2;
    await service.performance(QUERY);
    expect(h.google.queries).toHaveLength(2);
    expect(h.google.sitesCalls).toBe(2);
    // Failures are not kept.
    h.google.mode = 'down';
    expect(await service.topQueries(QUERY)).toMatchObject({ reason: 'network' });
    h.google.mode = 'ok';
    expect(await service.topQueries(QUERY)).toMatchObject({ status: 'ok' });
    // A disconnect clears it; a read that was running then keeps nothing.
    const release = h.hold('api');
    const running = service.performance({ ...QUERY, days: 7 });
    expect(await service.disconnect()).toBe(true);
    release();
    await running;
    h.grant();
    expect(await service.connect(WINDOW_ID)).toBe('started');
    await h.follow();
    await service.whenIdle();
    const queries = h.google.queries.length;
    const sites = h.google.sitesCalls;
    await service.performance(QUERY);
    await service.performance({ ...QUERY, days: 7 });
    expect(h.google.sitesCalls).toBe(sites + 1);
    expect(h.google.queries).toHaveLength(queries + 2);
  });

  test('never-throws', async () => {
    // A fetch that throws synchronously is a network failure, in the exchange as in the reads.
    const throwing = await serviceWith({
      store: memoryStore(),
      fetch: () => {
        throw new Error('boom');
      },
    });
    h.grant();
    expect(await throwing.connect(WINDOW_ID)).toBe('started');
    await h.follow();
    await throwing.whenIdle();
    expect(throwing.status()).toMatchObject({ connected: false, connecting: false, error: 'network' });
    const store = memoryStore();
    store.write(GSC_SECRET, storedBlob());
    const service = await serviceWith({
      store,
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await service.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'network' });
    expect(await service.properties()).toEqual({ status: 'unavailable', reason: 'network' });
    const broken = await serviceWith({
      store: {
        persistent: true,
        read: () => {
          throw new Error('keychain');
        },
        write: () => {
          throw new Error('keychain');
        },
        delete: () => {
          throw new Error('keychain');
        },
      },
    });
    expect(broken.status().connected).toBe(false);
    expect(await broken.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'not-connected' });
    const angry = await serviceWith({
      entitled: () => {
        throw new Error('entitlements');
      },
    });
    expect(await angry.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'not-entitled' });
    expect(angry.status().entitled).toBe(false);
    for (const input of [undefined, null, 42, [], { url: PAGE, scope: 'page', days: 28, __proto__: { x: 1 } }]) {
      await expect(service.performance(input as never)).resolves.toMatchObject({ status: expect.any(String) });
      await expect(service.topQueries(input as never)).resolves.toMatchObject({ status: expect.any(String) });
      await expect(service.propertyFor(input as never)).resolves.toMatchObject({ status: 'unavailable' });
    }
  });

  test('status-watch-long-polls', async () => {
    const service = await serviceWith();
    const first = service.status();
    expect(await service.watch(-1)).toEqual(first);
    const next = service.watch(first.version);
    h.grant();
    expect(await service.connect(WINDOW_ID)).toBe('started');
    expect(await next).toMatchObject({ connecting: true, connected: false });
    const connectedNext = service.watch(service.status().version);
    await h.follow();
    await service.whenIdle();
    expect(await connectedNext).toMatchObject({ connecting: false, connected: true });
    // An entitlement change wakes the watchers.
    const lost = service.watch(service.status().version);
    entitled = false;
    for (const listener of listeners) listener();
    expect(await lost).toMatchObject({ entitled: false });
    // An aborted watch answers the current status.
    const controller = new AbortController();
    const aborted = service.watch(service.status().version, controller.signal);
    controller.abort();
    expect(await aborted).toEqual(service.status());
    // Disconnecting wakes them too.
    const gone = service.watch(service.status().version);
    await service.disconnect();
    expect(await gone).toMatchObject({ connected: false });
    for (const status of [first, service.status()]) expect(GscStatusSchema.safeParse(status).success).toBe(true);
    // At most `maxPendingWatches` wait; one more answers the oldest early.
    const waiting = Array.from({ length: GSC_LIMITS.maxPendingWatches + 1 }, () => service.watch(service.status().version));
    await expect(waiting[0]).resolves.toEqual(service.status());
  });

  test('dispose-awaits-revocation', async () => {
    const idle = await serviceWith({ store: memoryStore() });
    expect(idle.dispose()).toBeNull();
    const service = await connected();
    const release = h.hold('revoke');
    const disconnecting = service.disconnect();
    const held = service.dispose();
    expect(held).toBeInstanceOf(Promise);
    let done = false;
    void held!.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    release();
    await held;
    await disconnecting;
    expect(h.google.revoked).toHaveLength(1);
    // A pending connect is dropped (its listener closed).
    const pending = await serviceWith({ store: memoryStore() });
    h.grant();
    expect(await pending.connect(WINDOW_ID)).toBe('started');
    expect(pending.dispose()).toBeNull();
    await h.loopbacks.at(-1)!.closed;
    expect(pending.status().connecting).toBe(false);
    h.grant();
    expect(await pending.connect(WINDOW_ID)).toBe('unconfigured');
  });

  test('read-across-reconnect-not-answered', async () => {
    const service = await connected();
    expect(await service.performance(QUERY)).toMatchObject({ status: 'ok' });
    const release = h.hold('api');
    const running = service.performance({ ...QUERY, days: 7 });
    const listing = service.properties();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await service.disconnect()).toBe(true);
    h.grant();
    expect(await service.connect(WINDOW_ID)).toBe('started');
    await h.follow();
    await service.whenIdle();
    expect(service.status().connected).toBe(true);
    release();
    expect(await running).toEqual({ status: 'unavailable', reason: 'not-connected' });
    // Nothing of it was kept: the new connection reads afresh.
    const queries = h.google.queries.length;
    expect(await service.performance({ ...QUERY, days: 7 })).toMatchObject({ status: 'ok' });
    expect(h.google.queries).toHaveLength(queries + 1);
    await listing;
  });

  test('connection-belongs-to-frost-account', async () => {
    const service = await connected();
    expect(JSON.parse((await h.store.read(GSC_SECRET))!).owner).toBe(OWNER);
    const notify = () => {
      for (const listener of [...listeners]) listener();
    };
    // Signed out: not entitled, not connected, nothing sent.
    h.account.userId = null;
    entitled = false;
    notify();
    h.clock.now += h.google.accessTokenTtlSeconds * 1000;
    const sent = h.fetched.length;
    expect(service.status()).toMatchObject({ entitled: false, connected: false });
    expect(await service.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'not-entitled' });
    // Back as the same account: the connection is still there.
    h.account.userId = OWNER;
    entitled = true;
    notify();
    expect(service.status()).toMatchObject({ entitled: true, connected: true });
    expect(h.fetched).toHaveLength(sent);
    expect(await service.performance(QUERY)).toMatchObject({ status: 'ok' });
    // Another account: never read with, and disconnected (revoked and deleted).
    const refresh = h.google.refreshTokens.at(-1)!;
    h.account.userId = 'user-2';
    const apiCalls = h.google.apiTokens.length;
    expect(await service.performance({ ...QUERY, days: 90 })).toEqual({ status: 'unavailable', reason: 'not-connected' });
    expect(h.google.apiTokens).toHaveLength(apiCalls);
    notify();
    await expect.poll(() => h.google.revoked.includes(refresh)).toBe(true);
    expect(await h.store.read(GSC_SECRET)).toBeNull();
    expect(service.status()).toMatchObject({ connected: false });
    // A stored connection of another account is dropped at start.
    const store = memoryStore();
    store.write(GSC_SECRET, storedBlob('stored-refresh-token-2', 'user-9'));
    const other = await serviceWith({ store });
    expect(other.status().connected).toBe(false);
    await expect.poll(() => h.google.revoked.includes('stored-refresh-token-2')).toBe(true);
    expect(await store.read(GSC_SECRET)).toBeNull();
  });

  test('identical-reads-merged', async () => {
    const service = await connected();
    const [a, b, c] = await Promise.all([service.performance(QUERY), service.performance(QUERY), service.performance({ ...QUERY, url: PAGE })]);
    expect(a).toMatchObject({ status: 'ok' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(h.google.queries).toHaveLength(1);
    expect(h.google.sitesCalls).toBe(1);
    const [p, q] = await Promise.all([service.topQueries(QUERY), service.topQueries(QUERY)]);
    expect(q).toEqual(p);
    expect(h.google.queries).toHaveLength(2);
  });

  test('api-rate-limited', async () => {
    const service = await connected();
    // The property list takes one token.
    expect(await service.properties()).toMatchObject({ status: 'ok' });
    const reads = Array.from({ length: GSC_RATE_LIMIT.burst + 5 }, (_, i) => service.performance({ ...QUERY, url: `${SITE}page-${i}` }));
    const answers = await Promise.all(reads);
    const ok = answers.filter((a) => a.status === 'ok').length;
    expect(ok).toBe(GSC_RATE_LIMIT.burst - 1);
    expect(answers.filter((a) => a.status === 'unavailable' && a.reason === 'quota')).toHaveLength(6);
    expect(h.google.queries).toHaveLength(GSC_RATE_LIMIT.burst - 1);
    // A second later, `perSecond` more.
    h.clock.now += 1000;
    const more = await Promise.all(Array.from({ length: GSC_RATE_LIMIT.perSecond + 2 }, (_, i) => service.performance({ ...QUERY, url: `${SITE}more-${i}` })));
    expect(more.filter((a) => a.status === 'ok')).toHaveLength(GSC_RATE_LIMIT.perSecond);
    expect(h.google.queries).toHaveLength(GSC_RATE_LIMIT.burst - 1 + GSC_RATE_LIMIT.perSecond);
  });

  test('custom-range-validated', async () => {
    const service = await connected();
    // On 2026-10-28 (UTC): the lag day is 2026-10-26, and Search Console holds data from 2025-06-28.
    expect(gscRetentionStart(h.clock.now)).toBe('2025-06-28');
    await service.properties();
    const before = h.fetched.length;
    const refused = [
      { start: '2026-10-01', end: '2026-10-29' }, // the end is in the future
      { start: '2026-10-01', end: '2027-01-01' },
      { start: '2025-06-27', end: '2026-10-26' }, // before `gscRetentionStart`
      { start: '2024-01-01', end: '2025-06-30' },
      { start: '2025-01-01', end: '2026-10-26' }, // more than `GSC_MAX_RANGE_DAYS` days
      { start: '2026-10-20', end: '2026-10-10' }, // start after end
      { start: '2026-10-27', end: '2026-10-28' }, // start after the clamped end (the lag day)
      { start: '2026-02-30', end: '2026-03-02' }, // not a calendar date
      { start: '2026-10-01', end: '20261026' },
    ];
    for (const range of refused) {
      for (const read of [service.performance, service.topQueries, service.countries]) {
        expect(await read({ url: PAGE, scope: 'page', range }), JSON.stringify(range)).toEqual({ status: 'unavailable', reason: 'invalid' });
      }
    }
    expect(gscRangeDays({ start: '2025-01-01', end: '2026-10-26' })).toBeGreaterThan(GSC_MAX_RANGE_DAYS);
    // Exactly one of `days` and `range`.
    expect(await service.performance({ url: PAGE, scope: 'page', days: 28, range: range28() } as never)).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(await service.performance({ url: PAGE, scope: 'page' } as never)).toEqual({ status: 'unavailable', reason: 'invalid' });
    expect(h.fetched).toHaveLength(before);
    expect(h.google.queries).toEqual([]);
    // An end on today or yesterday (partial days) is clamped to the lag day; the answer says so.
    const clamped = await service.performance({ url: PAGE, scope: 'page', range: { start: '2026-10-01', end: '2026-10-28' } });
    expect(clamped).toMatchObject({ status: 'ok', range: { start: '2026-10-01', end: '2026-10-26' } });
    expect(h.google.queries[0]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: { start: '2026-10-01', end: '2026-10-26' }, dimension: 'date', pageUrl: PAGE, rowLimit: 26 }) });
    expect(gscCustomRange('2026-10-01', '2026-10-27', h.clock.now)).toEqual({ start: '2026-10-01', end: '2026-10-26' });
    // The boundaries themselves are accepted: one day, and the retention start.
    expect(await service.performance({ url: PAGE, scope: 'page', range: { start: '2026-10-26', end: '2026-10-26' } })).toMatchObject({ status: 'ok', range: { start: '2026-10-26', end: '2026-10-26' } });
    expect(await service.topQueries({ url: PAGE, scope: 'property', range: { start: '2025-06-28', end: '2026-10-26' } })).toMatchObject({ status: 'ok', range: { start: '2025-06-28', end: '2026-10-26' } });
  });

  test('range-16m-preset-valid', async () => {
    const service = await connected();
    h.google.dateRows = everyDay;
    let longest = 0;
    // Every day of 2027 and 2028 (2028 has a 29 February, inside many of the windows).
    for (let now = Date.UTC(2027, 0, 1, 15); now < Date.UTC(2029, 0, 1); now += DAY_MS) {
      h.clock.now = now;
      const lagDay = gscDateRange(1, now).end;
      const range = { start: gscRetentionStart(now), end: lagDay };
      expect(gscCustomRange(range.start, range.end, now), isoDay(now)).toEqual(range);
      const days = gscRangeDays(range);
      longest = Math.max(longest, days);
      expect(days, isoDay(now)).toBeLessThanOrEqual(GSC_LIMITS.maxDateRows);
      const answer = await service.performance({ url: PAGE, scope: 'page', range });
      if (answer.status !== 'ok') throw new Error(`${isoDay(now)}: ${answer.reason}`);
      expect(answer.range).toEqual(range);
      // Every day's row is kept, none cut by `maxDateRows`.
      expect(answer.rows, isoDay(now)).toHaveLength(days);
      expect(answer.rows[0]?.date).toBe(range.start);
      expect(answer.rows.at(-1)?.date).toBe(lagDay);
    }
    expect(longest).toBeGreaterThan(480);
    expect(longest).toBeLessThanOrEqual(GSC_MAX_RANGE_DAYS);
    expect(GSC_LIMITS.maxDateRows).toBe(GSC_MAX_RANGE_DAYS);
  });

  test('filters-in-cache-key', async () => {
    const service = await connected();
    const reads: GscPerformanceQuery[] = [
      QUERY,
      { ...QUERY, country: 'gbr' },
      { ...QUERY, country: 'usa' },
      { ...QUERY, device: 'MOBILE' },
      { ...QUERY, country: 'gbr', device: 'MOBILE' },
      { url: PAGE, scope: 'page', range: { start: '2026-08-01', end: '2026-08-31' } },
      { url: PAGE, scope: 'page', range: { start: '2026-08-01', end: '2026-08-31' }, device: 'TABLET' },
    ];
    for (const [i, read] of reads.entries()) {
      expect(await service.performance(read), JSON.stringify(read)).toMatchObject({ status: 'ok' });
      expect(h.google.queries, JSON.stringify(read)).toHaveLength(i + 1);
    }
    // Each filter went to Google in the body.
    expect(h.google.queries[4]!.body).toEqual(searchAnalyticsBody({ range: range28(), dimension: 'date', pageUrl: PAGE, country: 'gbr', device: 'MOBILE', rowLimit: 28 }));
    expect(h.google.queries[6]!.body).toEqual(searchAnalyticsBody({ range: { start: '2026-08-01', end: '2026-08-31' }, dimension: 'date', pageUrl: PAGE, device: 'TABLET', rowLimit: 31 }));
    // The same ones again: answered from the cache, nothing sent.
    for (const read of reads) await service.performance(read);
    expect(h.google.queries).toHaveLength(reads.length);
    // The same filters at once: one read.
    const [a, b] = await Promise.all([service.topQueries({ ...QUERY, device: 'DESKTOP' }), service.topQueries({ ...QUERY, device: 'DESKTOP' })]);
    expect(b).toEqual(a);
    expect(h.google.queries).toHaveLength(reads.length + 1);
    await service.topQueries({ ...QUERY, device: 'TABLET' });
    expect(h.google.queries).toHaveLength(reads.length + 2);
  });

  test('countries-read', async () => {
    const service = await connected();
    const answer = await service.countries(QUERY);
    expect(GscCountriesAnswerSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({
      status: 'ok',
      property: { siteUrl: SITE, kind: 'url-prefix', permissionLevel: 'siteOwner' },
      range: range28(),
      countries: [
        { country: 'usa', clicks: 400, impressions: 4000 },
        { country: 'gbr', clicks: 300, impressions: 3000 },
        { country: 'deu', clicks: 200, impressions: 2000 },
        { country: 'ind', clicks: 100, impressions: 1000 },
      ],
    });
    expect(h.google.queries[0]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: range28(), dimension: 'country', pageUrl: PAGE, rowLimit: GSC_LIMITS.maxCountries }) });
    // The device filter applies; a country filter does not (the list would be only itself).
    expect(await service.countries({ ...QUERY, scope: 'property', country: 'gbr', device: 'MOBILE' })).toMatchObject({ status: 'ok' });
    expect(h.google.queries[1]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: range28(), dimension: 'country', pageUrl: null, device: 'MOBILE', rowLimit: GSC_LIMITS.maxCountries }) });
    expect(await service.countries({ ...QUERY, scope: 'property', country: 'usa', device: 'MOBILE' })).toMatchObject({ status: 'ok' });
    expect(h.google.queries).toHaveLength(2);
    // Google's order, each country once, malformed codes dropped, capped at `maxCountries`.
    const codes = Array.from({ length: GSC_LIMITS.maxCountries + 40 }, (_, i) => String.fromCharCode(97 + Math.floor(i / 676), 97 + (Math.floor(i / 26) % 26), 97 + (i % 26)));
    h.google.countryRows = () => [
      { keys: ['USA'], clicks: 9_999, impressions: 9_999, ctr: 1, position: 1 },
      { keys: [], clicks: 9_998, impressions: 9_998, ctr: 1, position: 1 },
      ...codes.map((code, i) => ({ keys: [code], clicks: 5_000 - i, impressions: 50_000, ctr: 0.1, position: 2 })),
      { keys: ['aaa'], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    ];
    const capped = await service.countries({ ...QUERY, days: 90 });
    if (capped.status !== 'ok') throw new Error('not ok');
    expect(capped.countries).toHaveLength(GSC_LIMITS.maxCountries);
    expect(capped.countries.map((c) => c.country)).toEqual(codes.slice(0, GSC_LIMITS.maxCountries));
    expect(capped.countries[0]).toEqual({ country: 'aaa', clicks: 5_000, impressions: 50_000 });
    // A custom range, and the reasons as for the other reads.
    expect(await service.countries({ url: PAGE, scope: 'page', range: { start: '2026-01-01', end: '2026-06-30' } })).toMatchObject({ status: 'ok', range: { start: '2026-01-01', end: '2026-06-30' } });
    expect(await service.countries({ ...QUERY, url: 'https://other.example.com/' })).toEqual({ status: 'unavailable', reason: 'no-property' });
    h.google.mode = 'quota';
    expect(await service.countries({ ...QUERY, days: 7 })).toEqual({ status: 'unavailable', reason: 'quota' });
    expect(await (await serviceWith({ config: null })).countries(QUERY)).toEqual({ status: 'unavailable', reason: 'unconfigured' });
  });

  test('days-shape-still-works', async () => {
    const service = await connected();
    // Phase 5's agent adapter sends `{ url, scope, days }`, as before.
    expect(await service.performance({ url: PAGE, scope: 'page', days: 28 })).toMatchObject({ status: 'ok', range: range28() });
    expect(h.google.queries[0]).toEqual({ siteUrl: SITE, body: searchAnalyticsBody({ range: range28(), dimension: 'date', pageUrl: PAGE, rowLimit: 28 }) });
    expect(h.google.queries[0]!.body).not.toHaveProperty('dimensionFilterGroups.0.filters.1');
    // Type-level: main's service is still what the agent adapter takes (this file fails to compile otherwise).
    const like: GscServiceLike = service;
    const port = gscAdapter(like);
    expect(await port!.performance({ url: PAGE, days: 30 })).toMatchObject({ status: 'ok', data: { url: PAGE, days: 28, clicks: 60, impressions: 600 } });
  });

  test('keychain-reports-this-run-only', async () => {
    expect((await connected({ store: memoryStore(false) })).status().keychain).toBe('memory-only');
    const failing = { ...memoryStore(), write: () => { throw new Error('keychain'); } };
    const unsaved = await connected({ store: failing });
    expect(unsaved.status()).toMatchObject({ connected: true, keychain: 'memory-only' });
    expect(await (await serviceWith({ store: memoryStore() })).status().keychain).toBe('persistent');
    expect((await connected({ store: memoryStore() })).status().keychain).toBe('persistent');
  });
});
