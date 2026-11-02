import type { GscIpcService } from '@app/ipc-contract';
import {
  GSC_INSPECTION_RATE,
  GscInspectInputSchema,
  GscInspectionAnswerSchema,
  isGscInspectionLink,
  type GscInspectionAnswer,
  type GscInspectionOk,
  type GscOpenLinkResult,
} from '@app/specs/gsc-inspection.schema';
import {
  GSC_CACHE_TTL_MS,
  GSC_COUNTRY_PATTERN,
  GSC_DATE_PATTERN,
  GSC_LIMITS,
  GSC_RATE_LIMIT,
  GscCountriesAnswerSchema,
  GscPerformanceAnswerSchema,
  GscPerformanceQuerySchema,
  GscQueriesAnswerSchema,
  GscUrlInputSchema,
  GSC_PROFILE_OWNER,
  gscCustomRange,
  gscDateRange,
  gscRangeDays,
  type GoogleSearchAnalyticsResponse,
  type GscCountriesAnswer,
  type GscCountryRow,
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
import { inspectionAnswerOf } from './inspection';
import { createGscAuth, type TokenFailure } from './oauth';
import { pageUrlOf, propertiesFromSites, propertyFor } from './properties';
import { createRedactingLog } from './redact';

// Search Console's read API in main (spec `gsc.schema.ts`; acceptance `gsc.feature.md`, Service; plan
// "Interfaces for other phases": `GscService` is stable, Phase 5's agent tool calls it in main). No
// Electron import: main injects `net.fetch`, the secret store, the entitlement check, the loopback,
// the browser opener and the gesture check.
//
// - Not gated in main (2026-10-29; `UNGATED_FEATURES`): main passes `GSC_UNGATED_ACCESS`. The
//   `entitled()` seam stays (tested): when false, every read answers `not-entitled`, and `connect`
//   too, before anything is sent. `disconnect` always works.
// - Never throws: every answer is `ok` or `unavailable` with a reason, in the order the spec gives.
// - A preset range ends `GSC_DATA_LAG_DAYS` before today's UTC date (`gscDateRange`); a custom range is
//   checked and clamped by `gscCustomRange` (refused: `invalid`, nothing sent). The range and the
//   `country` / `device` filters are part of each read's cache and merge key.
// - The connection belongs to its owner (`userId()`; in main, this frost profile: `GSC_PROFILE_OWNER`):
//   another owner's is never read with, and is disconnected (revoked, deleted) when a different owner
//   is current.
// - The property list and each `ok` answer are kept `GSC_CACHE_TTL_MS` per key; a new connection or a
//   disconnect clears them, and a read whose connection changed while it waited answers
//   `not-connected` (never the old connection's data) and keeps nothing.
// - Identical reads in flight are merged; API calls pass a token bucket: Search Analytics and `sites`
//   draw from `GSC_RATE_LIMIT`, URL Inspection from its own `GSC_INSPECTION_RATE`, so neither drains
//   the other (`gsc-inspection.feature.md`).
// - `inspect` runs only when called (a mutation: it spends Google's per-site quota); its `ok` answer is
//   cached under `['inspect', siteUrl, url]` (`fresh` skips the cache). `openInspectionLink` spends the
//   asking window's live gesture and opens only the link of main's own cached answer for that page,
//   checked again against `GSC_INSPECTION_LINK_HOST`; it never calls Google and never opens what the
//   renderer named.
// - `watch` long-polls the status (the chrome's Settings and panel).

export interface GscServiceDeps {
  /** `null`: unconfigured; nothing is sent to Google. */
  readonly config: GscConfig | null;
  readonly fetch: FetchLike;
  readonly store: Pick<SecretStore, 'persistent' | 'read' | 'write' | 'delete'>;
  /** Whether reads and connect may run (main: always, `GSC_UNGATED_ACCESS`; never the account's entitlements). */
  readonly entitled: () => boolean;
  /** Subscribes to entitlement changes (so watchers learn `entitled` changed); answers the unsubscribe. */
  readonly onEntitlementsChange?: (listener: () => void) => () => void;
  /** Who the connection belongs to now, or `null` (main: this frost profile, `GSC_PROFILE_OWNER`). */
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

/**
 * What main passes (2026-10-29: Search Console is free and needs no frost account; `gsc.feature.md`):
 * never gated, and the connection is this frost profile's whoever is signed in to frost (or nobody).
 * Main must not wire `entitled` to the account's entitlements, nor `userId` to the frost account.
 */
export const GSC_UNGATED_ACCESS: Pick<GscServiceDeps, 'entitled' | 'userId'> = Object.freeze({
  entitled: () => true,
  userId: () => GSC_PROFILE_OWNER,
});

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

/** A token bucket (`GSC_RATE_LIMIT` or `GSC_INSPECTION_RATE`). */
interface Bucket {
  /** Takes one token: `false` (and nothing is sent) when none is left. */
  take(): boolean;
  /** The fixed line logged when a call was not sent. */
  readonly refusal: string;
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

/** Google's order (most clicks first), each country once, capped; a row without a lowercase alpha-3 code is dropped. */
function countryRowsOf(rows: GoogleSearchAnalyticsResponse['rows']): GscCountryRow[] {
  const out: GscCountryRow[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const country = row.keys?.[0];
    if (typeof country !== 'string' || !GSC_COUNTRY_PATTERN.test(country) || seen.has(country)) continue;
    seen.add(country);
    const { clicks, impressions } = metrics(row);
    out.push({ country, clicks, impressions });
    if (out.length >= GSC_LIMITS.maxCountries) break;
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

/** Search Console's service, after the stored connection (if any) is read. */
export async function createGscService(deps: GscServiceDeps): Promise<GscMainService> {
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
      : await createGscAuth({
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
  const api = config === null ? null : createGscApi({ apiBase: config.endpoints.apiBase, inspectionBase: config.endpoints.inspectionBase, fetch: deps.fetch });

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
   * The owner changed: another owner's connection (or connect) is dropped, revoked and deleted; with no
   * owner, it is kept (unused) for when the same owner is back. Main's owner never changes (the profile).
   */
  const followAccount = (): void => {
    if (!auth) return;
    const user = currentUser();
    if (user === null) return;
    if (auth.connecting() && auth.pendingOwner() !== user) void auth.cancelConnect();
    if (auth.held() && auth.owner() !== user) {
      log('gsc: the connection belongs to another owner; it is revoked');
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

  /** A token bucket on the injected clock: at most `burst` at once, refilled at `perSecond`. */
  const bucketOf = (rate: { readonly perSecond: number; readonly burst: number }, refusal: string): Bucket => {
    let tokens: number = rate.burst;
    let filledAt = now();
    return {
      refusal,
      take() {
        const at = now();
        if (at > filledAt) tokens = Math.min(rate.burst, tokens + ((at - filledAt) / 1000) * rate.perSecond);
        filledAt = at;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
      },
    };
  };
  /** Search Analytics and `sites` (`GSC_RATE_LIMIT`). */
  const readBucket = bucketOf(GSC_RATE_LIMIT, 'gsc: the API rate limit was reached; a call was not sent');
  /** URL Inspection's own (`GSC_INSPECTION_RATE`): reads never drain it, nor it them. */
  const inspectionBucket = bucketOf(GSC_INSPECTION_RATE, 'gsc: the inspection rate limit was reached; a call was not sent');

  // ---- Reads ------------------------------------------------------------------------------------

  /** The first reason nothing can be read (before any input is looked at), or `null`. */
  const gate = (): GscUnavailableReason | null => {
    if (!auth || !api) return 'unconfigured';
    if (!isEntitled()) return 'not-entitled';
    if (!auth.connected()) return 'not-connected';
    return null;
  };

  /**
   * Calls Google with a live access token, each attempt taking a token from `bucket` (else `quota`,
   * nothing sent); a 401 forgets the access token, refreshes and retries once. If the connection
   * changed (`generation`) or is no longer the signed-in account's while it waited, the answer is
   * `not-connected`: it read for another connection.
   */
  const withToken = async <T>(generation: number, bucket: Bucket, run: (token: string) => Promise<GscApiResult<T>>): Promise<Read<T>> => {
    if (!auth) return { ok: false, reason: 'unconfigured' };
    const stale = (): boolean => auth.generation() !== generation || !auth.connected();
    for (let attempt = 0; ; attempt++) {
      const token = await auth.accessToken();
      if (!token.ok) return { ok: false, reason: TOKEN_REASONS[token.failure] };
      if (stale()) return { ok: false, reason: 'not-connected' };
      if (!bucket.take()) {
        log(bucket.refusal);
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
      const sites = await withToken(generation, readBucket, (token) => api!.sites(token));
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
    // A preset, or a custom range checked against the clock (refused before anything is sent).
    const range = 'days' in parsed.value ? gscDateRange(parsed.value.days, now()) : gscCustomRange(parsed.value.range.start, parsed.value.range.end, now());
    if (range === null) return { ok: false, reason: 'invalid' };
    const pageUrl = pageUrlOf(parsed.value.url);
    if (pageUrl === null) return { ok: false, reason: 'not-a-web-page' };
    const properties = await loadProperties();
    if (!properties.ok) return properties;
    const property = propertyFor(pageUrl, properties.value);
    if (!property) return { ok: false, reason: 'no-property' };
    return { ok: true, value: { query: parsed.value, property, pageUrl, range } };
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

  const runQuery = async <T extends GscPerformanceAnswer | GscQueriesAnswer | GscCountriesAnswer>(
    kind: 'performance' | 'queries' | 'countries',
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
    // A country read ignores a `country` filter: the picker's list would be only that country.
    const country = kind === 'countries' ? null : (query.country ?? null);
    const device = query.device ?? null;
    const key = JSON.stringify([kind, property.siteUrl, query.scope, filter, range.start, range.end, country, device]);
    const known = cached<T>(key);
    if (known) return known;
    const generation = auth?.generation() ?? 0;
    return merged(`${key}|${generation}`, async (): Promise<T | GscUnavailable> => {
      const body =
        kind === 'performance'
          ? searchAnalyticsBody({ range, dimension: 'date', pageUrl: filter, country, device, rowLimit: gscRangeDays(range) })
          : kind === 'queries'
            ? searchAnalyticsBody({ range, dimension: 'query', pageUrl: filter, country, device, rowLimit: GSC_LIMITS.maxTopQueries })
            : searchAnalyticsBody({ range, dimension: 'country', pageUrl: filter, device, rowLimit: GSC_LIMITS.maxCountries });
      const result = await withToken(generation, readBucket, (token) => api!.query(token, property.siteUrl, body));
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

  /** The cache key of `url`'s (without its fragment) inspection in `siteUrl`. */
  const inspectKey = (siteUrl: string, url: string): string => JSON.stringify(['inspect', siteUrl, url]);

  const runInspect = async (input: unknown): Promise<GscInspectionAnswer> => {
    const closed = gate();
    if (closed) return unavailable(closed);
    const parsed = GscInspectInputSchema.safeParse(input);
    if (!parsed.success) {
      const url = typeof input === 'object' && input !== null ? (input as { url?: unknown }).url : undefined;
      return unavailable(typeof url === 'string' && !isWebUrl(url) ? 'not-a-web-page' : 'invalid');
    }
    const pageUrl = pageUrlOf(parsed.data.url);
    if (pageUrl === null) return unavailable('not-a-web-page');
    const properties = await loadProperties();
    if (!properties.ok) return unavailable(properties.reason);
    const property = propertyFor(pageUrl, properties.value);
    if (!property) return unavailable('no-property');
    const key = inspectKey(property.siteUrl, pageUrl);
    if (parsed.data.fresh !== true) {
      const known = cached<GscInspectionOk>(key);
      if (known) return known;
    }
    const generation = auth?.generation() ?? 0;
    // A fresh inspection joins one already in flight for the page: that one is fresh too.
    return merged(`${key}|${generation}`, async (): Promise<GscInspectionAnswer> => {
      const result = await withToken(generation, inspectionBucket, (token) => api!.inspect(token, { inspectionUrl: pageUrl, siteUrl: property.siteUrl }));
      if (!result.ok) {
        if (result.reason === 'no-property') dropProperties();
        return unavailable(result.reason);
      }
      const checked = GscInspectionAnswerSchema.safeParse(inspectionAnswerOf(result.value, { property, url: pageUrl, inspectedAt: new Date(now()).toISOString() }));
      if (!checked.success || checked.data.status !== 'ok') {
        log('gsc: an inspection answer did not match its schema');
        return unavailable('invalid');
      }
      keep(key, checked.data, generation);
      return checked.data;
    });
  };

  /**
   * The link of the newest cached `ok` inspection of `pageUrl` (any property; the cache's TTL and
   * connection rules apply), if it is still a Search Console link; else `null`. Never calls Google.
   */
  const cachedInspectionLink = (pageUrl: string): string | null => {
    syncCache();
    let newest: { at: number; link: string | null } | null = null;
    for (const [key, entry] of [...cache.entries()]) {
      let parts: unknown;
      try {
        parts = JSON.parse(key);
      } catch {
        continue;
      }
      if (!Array.isArray(parts) || parts[0] !== 'inspect' || parts[2] !== pageUrl) continue;
      const answer = cached<GscInspectionOk>(key);
      if (!answer || answer.status !== 'ok') continue;
      if (newest === null || entry.at >= newest.at) newest = { at: entry.at, link: answer.link };
    }
    return newest !== null && isGscInspectionLink(newest.link) ? newest.link : null;
  };

  const openLink = (windowId: number, url: unknown): GscOpenLinkResult => {
    // The gesture first: one gesture backs at most one attempt, whatever it finds.
    let gesture = false;
    try {
      gesture = deps.consumeGesture(windowId) === true;
    } catch {
      gesture = false;
    }
    if (!gesture) return 'needs-gesture';
    // Not configured, entitled or connected (for this owner): nothing cached is used.
    if (gate() !== null) return 'no-link';
    if (typeof url !== 'string' || !GscUrlInputSchema.safeParse({ url }).success) return 'no-link';
    const pageUrl = pageUrlOf(url);
    if (pageUrl === null) return 'no-link';
    const link = cachedInspectionLink(pageUrl);
    if (link === null) return 'no-link';
    try {
      return deps.openInBrowser(link, true) === true ? 'opened' : 'no-link';
    } catch {
      log('gsc: an inspection link could not be opened');
      return 'no-link';
    }
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
        // No owner: nothing to connect for (never in main, whose owner is the profile).
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

    countries: (query) =>
      guard(() =>
        runQuery<GscCountriesAnswer>(
          'countries',
          query,
          ({ property, range, rows }) => ({ status: 'ok', property, range, countries: countryRowsOf(rows) }),
          GscCountriesAnswerSchema,
        ),
      ),

    inspect: (input) => guard(() => runInspect(input)),

    async openInspectionLink(windowId, url) {
      if (disposed) return 'no-link';
      try {
        return openLink(windowId, url);
      } catch {
        log('gsc: opening an inspection link failed unexpectedly');
        return 'no-link';
      }
    },

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
