import type { GscIpcService } from '@app/ipc-contract';
import {
  GSC_CACHE_TTL_MS,
  GSC_DATE_PATTERN,
  GSC_LIMITS,
  GSC_RATE_LIMIT,
  GscPerformanceAnswerSchema,
  GscPerformanceQuerySchema,
  GscQueriesAnswerSchema,
  GscUrlInputSchema,
  gscDateRange,
  type GoogleSearchAnalyticsResponse,
  type GscDateRange,
  type GscPerformanceAnswer,
  type GscPerformanceQuery,
  type GscPerformanceRow,
  type GscProperty,
  type GscPropertiesAnswer,
  type GscPropertyForAnswer,
  type GscQueriesAnswer,
  type GscQueryRow,
  type GscStatus,
  type GscTotals,
  type GscUnavailable,
  type GscUnavailableReason,
} from '@app/specs/gsc.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import type { Loopback, StartLoopbackOptions } from '../account/loopback';
import type { SecretStore } from '../account/secret-store';
import { createGscApi, searchAnalyticsBody, type GscApiFailure, type GscApiResult } from './api';
import type { GscConfig } from './config';
import type { FetchLike } from './http';
import { createGscAuth, type TokenFailure } from './oauth';
import { pageUrlOf, propertiesFromSites, propertyFor } from './properties';
import { createRedactingLog } from './redact';

// Search Console's read API in main (spec `gsc.schema.ts`; acceptance `gsc.feature.md`, Service; plan
// "Interfaces for other phases": `GscService` is stable, Phase 5's agent tool calls it in main). No
// Electron import: main injects `net.fetch`, the secret store, the entitlement check, the loopback,
// the browser opener and the gesture check.
//
// - Gated on `search-console` (`entitled()`): every read answers `not-entitled`, and `connect` too,
//   before anything is sent. `disconnect` always works.
// - Never throws: every answer is `ok` or `unavailable` with a reason, in the order the spec gives.
// - Ranges end `GSC_DATA_LAG_DAYS` before today's UTC date (`gscDateRange`).
// - The connection belongs to the frost account that made it (`userId()`): another account's is never
//   read with, and is disconnected (revoked, deleted) when a different account signs in.
// - The property list and each `ok` answer are kept `GSC_CACHE_TTL_MS` per key; a new connection or a
//   disconnect clears them, and a read whose connection changed while it waited answers
//   `not-connected` (never the old connection's data) and keeps nothing.
// - Identical reads in flight are merged; API calls pass a token bucket (`GSC_RATE_LIMIT`).
// - `watch` long-polls the status (the chrome's Settings and panel).

export interface GscServiceDeps {
  /** `null`: unconfigured; nothing is sent to Google. */
  readonly config: GscConfig | null;
  readonly fetch: FetchLike;
  readonly store: Pick<SecretStore, 'persistent' | 'read' | 'write' | 'delete'>;
  /** Whether the plan includes `search-console` now (main: `account.entitlements.has('search-console')`). */
  readonly entitled: () => boolean;
  /** Subscribes to entitlement changes (so watchers learn `entitled` changed); answers the unsubscribe. */
  readonly onEntitlementsChange?: (listener: () => void) => () => void;
  /** The signed-in frost account's user ID, or `null` (main: the account service's `userId()`). */
  readonly userId: () => string | null;
  /** Subscribes to account changes (sign-in, sign-out); answers the unsubscribe. */
  readonly onAccountChange?: (listener: () => void) => () => void;
  readonly startLoopback: (options: StartLoopbackOptions) => Promise<Loopback>;
  /** Opens `url` in the system browser: main passes `openExternalIfAllowed`. */
  readonly openInBrowser: (url: string, userGesture: boolean) => boolean;
  /** Spends window `windowId`'s live user gesture (the account's gesture tracker). */
  readonly consumeGesture: (windowId: number) => boolean;
  /** Receives redacted, fixed messages only. */
  readonly log: (message: string) => void;
  /** Epoch ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Main's Search Console service: the IPC `GscIpcService` plus what main and tests drive. */
export interface GscMainService extends GscIpcService {
  /** Resolves once no exchange, refresh or revocation started so far is still running. */
  whenIdle(): Promise<void>;
  /** Drops a pending connect and releases watchers; answers the revocations still running (to hold the quit for), or `null`. */
  dispose(): Promise<void> | null;
}

interface Waiter {
  readonly since: number;
  readonly resolve: (status: GscStatus) => void;
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: GscUnavailableReason };

const unavailable = (reason: GscUnavailableReason): GscUnavailable => ({ status: 'unavailable', reason });

const TOKEN_REASONS: Record<TokenFailure, GscUnavailableReason> = { 'not-connected': 'not-connected', 'auth-expired': 'auth-expired', network: 'network', invalid: 'invalid' };
const API_REASONS: Record<Exclude<GscApiFailure, 'auth'>, GscUnavailableReason> = { quota: 'quota', forbidden: 'no-property', network: 'network', invalid: 'invalid' };

const count = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
const metrics = (row: { clicks: number; impressions: number; ctr: number; position: number }) => ({
  clicks: count(row.clicks),
  impressions: count(row.impressions),
  ctr: Math.min(1, Math.max(0, row.ctr)),
  position: Math.min(1_000_000, Math.max(0, row.position)),
});

/** The range's days, once each (the first row for a date wins), in order; rows outside it dropped. */
function dateRowsOf(rows: GoogleSearchAnalyticsResponse['rows'], range: GscDateRange): GscPerformanceRow[] {
  const byDate = new Map<string, GscPerformanceRow>();
  for (const row of rows ?? []) {
    const date = row.keys?.[0];
    if (typeof date !== 'string' || !GSC_DATE_PATTERN.test(date) || date < range.start || date > range.end || byDate.has(date)) continue;
    byDate.set(date, { date, ...metrics(row) });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, GSC_LIMITS.maxDateRows);
}

/** `query` cut to `GSC_LIMITS.maxQueryChars` (never splitting a surrogate pair). */
function cutQuery(query: string): string {
  if (query.length <= GSC_LIMITS.maxQueryChars) return query;
  const cut = query.slice(0, GSC_LIMITS.maxQueryChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Google's order (most clicks first), capped; a row without a query is dropped. */
function queryRowsOf(rows: GoogleSearchAnalyticsResponse['rows']): GscQueryRow[] {
  const out: GscQueryRow[] = [];
  for (const row of rows ?? []) {
    const query = row.keys?.[0];
    if (typeof query !== 'string') continue;
    out.push({ query: cutQuery(query), ...metrics(row) });
    if (out.length >= GSC_LIMITS.maxTopQueries) break;
  }
  return out;
}

/** Sums, `ctr = clicks / impressions` (`0` without any), and the impression-weighted position (`null` without any). */
export function totalsOf(rows: readonly GscPerformanceRow[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const row of rows) {
    clicks += row.clicks;
    impressions += row.impressions;
    weighted += row.position * row.impressions;
  }
  return {
    clicks: count(clicks),
    impressions: count(impressions),
    ctr: impressions > 0 ? Math.min(1, clicks / impressions) : 0,
    position: impressions > 0 ? Math.min(1_000_000, weighted / impressions) : null,
  };
}

export function createGscService(deps: GscServiceDeps): GscMainService {
  const { config, store } = deps;
  const now = deps.now ?? (() => Date.now());
  const { log, remember, pin } = createRedactingLog(deps.log);
  if (config) pin(config.clientSecret);
  const currentUser = (): string | null => {
    try {
      const id = deps.userId();
      return typeof id === 'string' && id !== '' ? id : null;
    } catch {
      return null;
    }
  };

  let version = 0;
  let disposed = false;
  const waiters: Waiter[] = [];

  const isEntitled = (): boolean => {
    try {
      return deps.entitled() === true;
    } catch {
      return false;
    }
  };

  const auth =
    config === null
      ? null
      : createGscAuth({
          config,
          fetch: deps.fetch,
          store,
          startLoopback: deps.startLoopback,
          openInBrowser: deps.openInBrowser,
          consumeGesture: deps.consumeGesture,
          currentUser,
          log,
          remember,
          pin,
          onChange: () => bump(),
          now,
        });
  const api = config === null ? null : createGscApi({ apiBase: config.endpoints.apiBase, fetch: deps.fetch });

  const status = (): GscStatus => ({
    configured: auth !== null,
    entitled: isEntitled(),
    connected: auth?.connected() ?? false,
    connecting: auth?.connecting() ?? false,
    // Connected: where the refresh token really is; else where a connection would be kept.
    keychain: (auth?.connected() ? auth.persisted() : store.persistent) ? 'persistent' : 'memory-only',
    error: auth?.error() ?? null,
    version,
  });

  /** A change: the version goes up and watchers are answered (after the current call stack). */
  function bump(): void {
    version++;
    queueMicrotask(() => {
      const current = status();
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!;
        if (current.version > waiter.since) {
          waiters.splice(i, 1);
          waiter.resolve(current);
        }
      }
    });
  }

  /**
   * The signed-in frost account changed: another account's connection (or connect) is dropped, revoked
   * and deleted; signed out, it is kept (unused) for when the same account signs in again.
   */
  const followAccount = (): void => {
    if (!auth) return;
    const user = currentUser();
    if (user === null) return;
    if (auth.connecting() && auth.pendingOwner() !== user) void auth.cancelConnect();
    if (auth.held() && auth.owner() !== user) {
      log('gsc: another frost account signed in; the old connection is revoked');
      void auth.disconnect().catch(() => undefined);
    }
  };

  const seen = (): string => `${isEntitled()}|${auth?.connected() ?? false}`;
  let lastSeen = seen();
  const onExternalChange = (): void => {
    followAccount();
    const now = seen();
    if (now === lastSeen) return;
    lastSeen = now;
    bump();
  };
  const unsubscribes: (() => void)[] = [];
  for (const subscribe of [deps.onEntitlementsChange, deps.onAccountChange]) {
    try {
      const off = subscribe?.(onExternalChange);
      if (off) unsubscribes.push(off);
    } catch {
      log('gsc: account changes could not be followed');
    }
  }
  followAccount();

  // ---- The cache --------------------------------------------------------------------------------

  const cache = new Map<string, { readonly at: number; readonly value: unknown }>();
  let cacheGeneration = auth?.generation() ?? 0;
  /** A new connection or a disconnect since the cache was filled: it is dropped. */
  const syncCache = (): void => {
    const generation = auth?.generation() ?? 0;
    if (generation === cacheGeneration) return;
    cache.clear();
    cacheGeneration = generation;
  };
  const cached = <T>(key: string): T | undefined => {
    syncCache();
    const entry = cache.get(key);
    if (!entry) return undefined;
    const age = now() - entry.at;
    if (age < 0 || age >= GSC_CACHE_TTL_MS) {
      cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  };
  /** Keeps `value` unless the connection changed since the read began (`generation`). */
  const keep = (key: string, value: unknown, generation: number): void => {
    syncCache();
    if (generation !== cacheGeneration) return;
    cache.delete(key);
    cache.set(key, { at: now(), value });
    while (cache.size > GSC_LIMITS.maxCacheEntries) cache.delete(cache.keys().next().value as string);
  };

  // ---- Merging and rate ---------------------------------------------------------------------------

  /** Identical reads in flight (same key, same connection) share one call. */
  const running = new Map<string, Promise<unknown>>();
  const merged = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const known = running.get(key);
    if (known) return known as Promise<T>;
    const run = work().finally(() => running.delete(key));
    running.set(key, run);
    return run;
  };

  /** The API's token bucket (`GSC_RATE_LIMIT`), on the injected clock. */
  let bucket: number = GSC_RATE_LIMIT.burst;
  let filledAt = now();
  const takeToken = (): boolean => {
    const at = now();
    if (at > filledAt) bucket = Math.min(GSC_RATE_LIMIT.burst, bucket + ((at - filledAt) / 1000) * GSC_RATE_LIMIT.perSecond);
    filledAt = at;
    if (bucket < 1) return false;
    bucket -= 1;
    return true;
  };

  // ---- Reads ------------------------------------------------------------------------------------

  /** The first reason nothing can be read (before any input is looked at), or `null`. */
  const gate = (): GscUnavailableReason | null => {
    if (!auth || !api) return 'unconfigured';
    if (!isEntitled()) return 'not-entitled';
    if (!auth.connected()) return 'not-connected';
    return null;
  };

  /**
   * Calls Google with a live access token; a 401 forgets it, refreshes and retries once. If the
   * connection changed (`generation`) or is no longer the signed-in account's while it waited, the
   * answer is `not-connected`: it read for another connection.
   */
  const withToken = async <T>(generation: number, run: (token: string) => Promise<GscApiResult<T>>): Promise<Read<T>> => {
    if (!auth) return { ok: false, reason: 'unconfigured' };
    const stale = (): boolean => auth.generation() !== generation || !auth.connected();
    for (let attempt = 0; ; attempt++) {
      const token = await auth.accessToken();
      if (!token.ok) return { ok: false, reason: TOKEN_REASONS[token.failure] };
      if (stale()) return { ok: false, reason: 'not-connected' };
      if (!takeToken()) {
        log('gsc: the API rate limit was reached; a call was not sent');
        return { ok: false, reason: 'quota' };
      }
      const result = await run(token.token);
      if (stale()) return { ok: false, reason: 'not-connected' };
      if (result.ok) return result;
      if (result.failure !== 'auth') return { ok: false, reason: API_REASONS[result.failure] };
      auth.rejectAccessToken(token.token);
      if (attempt >= 1) {
        log('gsc: Google refused a fresh access token');
        return { ok: false, reason: 'auth-expired' };
      }
    }
  };

  const loadProperties = async (): Promise<Read<GscProperty[]>> => {
    const known = cached<GscProperty[]>('properties');
    if (known) return { ok: true, value: known };
    const generation = auth?.generation() ?? 0;
    return merged(`properties|${generation}`, async (): Promise<Read<GscProperty[]>> => {
      const sites = await withToken(generation, (token) => api!.sites(token));
      if (!sites.ok) return sites;
      const properties = propertiesFromSites(sites.value.siteEntry ?? []);
      keep('properties', properties, generation);
      return { ok: true, value: properties };
    });
  };

  const parseQuery = (query: unknown): Read<GscPerformanceQuery> => {
    const parsed = GscPerformanceQuerySchema.safeParse(query);
    if (parsed.success) return { ok: true, value: parsed.data };
    const url = typeof query === 'object' && query !== null ? (query as { url?: unknown }).url : undefined;
    return { ok: false, reason: typeof url === 'string' && !isWebUrl(url) ? 'not-a-web-page' : 'invalid' };
  };

  /** The property for the query's URL, and what to filter on. */
  const resolveQuery = async (query: unknown): Promise<Read<{ query: GscPerformanceQuery; property: GscProperty; pageUrl: string; range: GscDateRange }>> => {
    const parsed = parseQuery(query);
    if (!parsed.ok) return parsed;
    const pageUrl = pageUrlOf(parsed.value.url);
    if (pageUrl === null) return { ok: false, reason: 'not-a-web-page' };
    const properties = await loadProperties();
    if (!properties.ok) return properties;
    const property = propertyFor(pageUrl, properties.value);
    if (!property) return { ok: false, reason: 'no-property' };
    return { ok: true, value: { query: parsed.value, property, pageUrl, range: gscDateRange(parsed.value.days, now()) } };
  };

  /** Never throws: anything unexpected is `invalid`. */
  const guard = async <T>(read: () => Promise<T | GscUnavailable>): Promise<T | GscUnavailable> => {
    try {
      return await read();
    } catch {
      log('gsc: a read failed unexpectedly');
      return unavailable('invalid');
    }
  };

  /** A query's 403: no permission for that property any more; the list is read again next time. */
  const dropProperties = (): void => void cache.delete('properties');

  const runQuery = async <T extends GscPerformanceAnswer | GscQueriesAnswer>(
    kind: 'performance' | 'queries',
    input: unknown,
    build: (resolved: { query: GscPerformanceQuery; property: GscProperty; range: GscDateRange; rows: GoogleSearchAnalyticsResponse['rows'] }) => unknown,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T | GscUnavailable> => {
    const closed = gate();
    if (closed) return unavailable(closed);
    const resolved = await resolveQuery(input);
    if (!resolved.ok) return unavailable(resolved.reason);
    const { query, property, pageUrl, range } = resolved.value;
    const filter = query.scope === 'page' ? pageUrl : null;
    const key = JSON.stringify([kind, property.siteUrl, query.scope, filter, query.days, range.start, range.end]);
    const known = cached<T>(key);
    if (known) return known;
    const generation = auth?.generation() ?? 0;
    return merged(`${key}|${generation}`, async (): Promise<T | GscUnavailable> => {
      const body = searchAnalyticsBody({ range, dimension: kind === 'performance' ? 'date' : 'query', pageUrl: filter, rowLimit: kind === 'performance' ? query.days : GSC_LIMITS.maxTopQueries });
      const result = await withToken(generation, (token) => api!.query(token, property.siteUrl, body));
      if (!result.ok) {
        if (result.reason === 'no-property') dropProperties();
        return unavailable(result.reason);
      }
      const checked = schema.safeParse(build({ query, property, range, rows: result.value.rows }));
      if (!checked.success) {
        log('gsc: an answer did not match its schema');
        return unavailable('invalid');
      }
      keep(key, checked.data, generation);
      return checked.data;
    });
  };

  return {
    status,

    watch(sinceVersion, signal) {
      const current = status();
      if (current.version > sinceVersion || disposed) return Promise.resolve(current);
      return new Promise<GscStatus>((resolve) => {
        const waiter: Waiter = { since: sinceVersion, resolve };
        waiters.push(waiter);
        if (waiters.length > GSC_LIMITS.maxPendingWatches) waiters.shift()?.resolve(status());
        signal?.addEventListener(
          'abort',
          () => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            resolve(status());
          },
          { once: true },
        );
      });
    },

    async connect(windowId) {
      if (!auth || disposed) return 'unconfigured';
      if (!isEntitled()) return 'not-entitled';
      try {
        const result = await auth.connect(windowId);
        // No signed-in frost account: nothing to connect for (the plan is what the chrome can act on).
        return result === 'no-account' ? 'not-entitled' : result;
      } catch {
        log('gsc: connect failed unexpectedly');
        return 'browser-failed';
      }
    },

    async cancelConnect() {
      return auth?.cancelConnect() ?? false;
    },

    async disconnect() {
      if (!auth) return false;
      try {
        return await auth.disconnect();
      } catch {
        log('gsc: disconnect failed unexpectedly');
        return false;
      }
    },

    properties: () =>
      guard(async (): Promise<GscPropertiesAnswer> => {
        const closed = gate();
        if (closed) return unavailable(closed);
        const properties = await loadProperties();
        return properties.ok ? { status: 'ok', properties: properties.value } : unavailable(properties.reason);
      }),

    propertyFor: (url) =>
      guard(async (): Promise<GscPropertyForAnswer> => {
        const closed = gate();
        if (closed) return unavailable(closed);
        if (!GscUrlInputSchema.safeParse({ url }).success) return unavailable(typeof url === 'string' && !isWebUrl(url) ? 'not-a-web-page' : 'invalid');
        const properties = await loadProperties();
        if (!properties.ok) return unavailable(properties.reason);
        const property = propertyFor(pageUrlOf(url)!, properties.value);
        return property ? { status: 'ok', property } : unavailable('no-property');
      }),

    performance: (query) =>
      guard(() =>
        runQuery<GscPerformanceAnswer>(
          'performance',
          query,
          ({ query: q, property, range, rows }) => {
            const days = dateRowsOf(rows, range);
            return { status: 'ok', property, scope: q.scope, range, rows: days, totals: totalsOf(days) };
          },
          GscPerformanceAnswerSchema,
        ),
      ),

    topQueries: (query) =>
      guard(() =>
        runQuery<GscQueriesAnswer>(
          'queries',
          query,
          ({ query: q, property, range, rows }) => ({ status: 'ok', property, scope: q.scope, range, rows: queryRowsOf(rows) }),
          GscQueriesAnswerSchema,
        ),
      ),

    whenIdle: () => auth?.whenIdle() ?? Promise.resolve(),

    dispose() {
      disposed = true;
      for (const off of unsubscribes.splice(0)) off();
      const revoking = auth?.dispose() ?? null;
      for (const waiter of waiters.splice(0)) waiter.resolve(status());
      return revoking;
    },
  };
}
