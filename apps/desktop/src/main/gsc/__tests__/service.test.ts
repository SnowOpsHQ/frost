// Spec: specs/gsc.spec.ts (gscDateRange, GSC_CACHE_TTL_MS, GSC_LIMITS, GSC_UNAVAILABLE_REASONS), specs/gsc.schema.ts
// (GscStatusSchema, GscPerformanceAnswerSchema, GscQueriesAnswerSchema, GscPropertiesAnswerSchema, GscPropertyForAnswerSchema)
// Acceptance: specs/gsc.feature.md (Service) · plan decision "Search Console is a `pro` feature" and
// "Interfaces for other phases" (the read API never throws)
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  GSC_CACHE_TTL_MS,
  GSC_LIMITS,
  GSC_SCOPE,
  GscPerformanceAnswerSchema,
  GscQueriesAnswerSchema,
  GscStatusSchema,
  gscDateRange,
  type GscPerformanceQuery,
} from '@app/specs/gsc.schema';
import { fakeDateRows } from '../../../../e2e/fake-google';
import { searchAnalyticsBody } from '../api';
import { GSC_SECRET } from '../oauth';
import { createGscService, type GscMainService, type GscServiceDeps } from '../service';
import { createHarness, memoryStore, WINDOW_ID, type Harness } from './harness';

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

function serviceWith(overrides: Partial<GscServiceDeps> = {}): GscMainService {
  const service = createGscService({
    config: h.config,
    fetch: h.fetch,
    store: h.store,
    entitled: () => entitled,
    onEntitlementsChange: (listener) => {
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
  const service = serviceWith(overrides);
  h.grant();
  expect(await service.connect(WINDOW_ID)).toBe('started');
  await h.follow();
  await service.whenIdle();
  expect(service.status().connected).toBe(true);
  return service;
}

const range28 = () => gscDateRange(28, h.clock.now);

describe('Search Console service', () => {
  test('not-entitled-refused-before-network', async () => {
    h.store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: 'stored-refresh-token-1', scope: GSC_SCOPE }));
    entitled = false;
    const service = serviceWith();
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

  test('unconfigured-and-not-connected', async () => {
    const bare = serviceWith({ config: null });
    expect(GscStatusSchema.parse(bare.status())).toMatchObject({ configured: false, connected: false, connecting: false });
    for (const answer of [await bare.properties(), await bare.propertyFor(PAGE), await bare.performance(QUERY), await bare.topQueries(QUERY)]) {
      expect(answer).toEqual({ status: 'unavailable', reason: 'unconfigured' });
    }
    h.grant();
    expect(await bare.connect(WINDOW_ID)).toBe('unconfigured');
    expect(await bare.cancelConnect()).toBe(false);
    expect(await bare.disconnect()).toBe(false);
    const service = serviceWith();
    expect(service.status()).toMatchObject({ configured: true, entitled: true, connected: false, connecting: false, keychain: 'persistent', error: null });
    for (const answer of [await service.properties(), await service.propertyFor(PAGE), await service.performance(QUERY), await service.topQueries(QUERY)]) {
      expect(answer).toEqual({ status: 'unavailable', reason: 'not-connected' });
    }
    expect(h.fetched).toEqual([]);
    expect(serviceWith({ store: memoryStore(false) }).status().keychain).toBe('memory-only');
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
    expect(h.store.read(GSC_SECRET)).toBeNull();
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
    const throwing = serviceWith({
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
    store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: 'stored-refresh-token-1', scope: GSC_SCOPE }));
    const service = serviceWith({
      store,
      fetch: () => {
        throw new Error('boom');
      },
    });
    expect(await service.performance(QUERY)).toEqual({ status: 'unavailable', reason: 'network' });
    expect(await service.properties()).toEqual({ status: 'unavailable', reason: 'network' });
    const broken = serviceWith({
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
    const angry = serviceWith({
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
    const service = serviceWith();
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
    const idle = serviceWith({ store: memoryStore() });
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
    const pending = serviceWith({ store: memoryStore() });
    h.grant();
    expect(await pending.connect(WINDOW_ID)).toBe('started');
    expect(pending.dispose()).toBeNull();
    await h.loopbacks.at(-1)!.closed;
    expect(pending.status().connecting).toBe(false);
    h.grant();
    expect(await pending.connect(WINDOW_ID)).toBe('unconfigured');
  });
});
