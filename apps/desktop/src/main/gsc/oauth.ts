import { z } from 'zod';
import {
  GoogleTokenErrorSchema,
  GoogleTokenResponseSchema,
  GSC_ACCESS_TOKEN_SKEW_MS,
  GSC_AUTH_FIXED_PARAMS,
  GSC_CONNECT_TIMEOUT_MS,
  GSC_REFRESH_BACKOFF,
  GSC_SCOPE,
  type GoogleTokenResponse,
  type GscError,
} from '@app/specs/gsc.schema';
import type { SecretName } from '@app/specs/secret-store.spec';
import type { Loopback, LoopbackCallback, StartLoopbackOptions } from '../account/loopback';
import { challengeOf, createState, createVerifier } from '../account/pkce';
import type { SecretStore } from '../account/secret-store';
import type { GscConfig } from './config';
import { parseJson, send, type FetchLike } from './http';

// Search Console's Google connection (spec `gsc.spec.ts`, `GSC_SCOPE`, `GSC_AUTH_FIXED_PARAMS`;
// acceptance `gsc.feature.md`, Connection; review focus "Search Console asks for read-only access
// only"). OAuth 2.0 for installed apps (RFC 8252): the authorization code with PKCE S256 over the
// account's loopback listener (`../account/loopback.ts`, `../account/pkce.ts`). No Electron import:
// main injects the gesture check, the browser opener, `net.fetch`, the loopback and the store.
//
// 1. `connect(windowId)` spends a live gesture in that window, starts a listener bound to a fresh
//    `state` and opens the consent URL: exactly `GSC_AUTH_FIXED_PARAMS` (the read-only scope,
//    `access_type=offline`, `prompt=consent`) plus the client ID, redirect, `state` and challenge.
// 2. The callback's code is exchanged with the verifier. A grant of anything but `GSC_SCOPE` (or of no
//    scope, or without a refresh token) is refused and its tokens revoked; nothing is stored.
// 3. The refresh token goes to the secret store's `gsc` blob; the access token stays in memory with its
//    expiry, refreshed `GSC_ACCESS_TOKEN_SKEW_MS` early (one refresh at a time). `invalid_grant` on a
//    refresh ends the connection (`auth-expired`).
// 4. `disconnect()` deletes the blob at once and revokes the refresh token (best effort).
// 5. The connection belongs to the frost account signed in when it was made (`currentUser()`, stored
//    as the blob's `owner`): for any other account (or none) it is not `connected` and neither token
//    is sent. An exchange that lands after the account changed is revoked.
// 6. A failed refresh (`network`, `invalid`) is not retried for `GSC_REFRESH_BACKOFF` (doubling).
// 7. `dispose()` (quit) revokes a refresh token that was never written to the keychain, and answers
//    what is still running (an exchange in flight, revocations) for the quit to wait for.
//
// Logs: fixed messages only (the caller's log redacts as a second line of defence; `remember` feeds it
// every secret seen). Nothing here ever logs a URL, a body or a token.

/** The secret blob the Search Console connection lives in. */
export const GSC_SECRET: SecretName = 'gsc';

/** The stored connection (version 1): the refresh token of a read-only grant. Strict: anything else is discarded. */
const StoredGscSchema = z.strictObject({
  v: z.literal(1),
  refreshToken: z.string().min(1).max(4_096),
  scope: z.literal(GSC_SCOPE),
  /** The frost account (user ID) that made the connection. */
  owner: z.string().min(1).max(256),
});

/** An authorization code as it may arrive (printable ASCII; the listener caps its length). */
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;

/**
 * Why no access token: `not-connected` (no refresh token), `auth-expired` (Google refused the refresh
 * token, or granted more on refresh: disconnected), `network`, `invalid` (an unusable answer).
 */
export type TokenFailure = 'not-connected' | 'auth-expired' | 'network' | 'invalid';
export type TokenResult = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly failure: TokenFailure };

/** What the token endpoint answered: `auth` is `invalid_grant` (the code or refresh token is not accepted). */
type GrantResult = { readonly ok: true; readonly value: GoogleTokenResponse } | { readonly ok: false; readonly failure: 'auth' | 'network' | 'invalid' };

/** Whether a token answer's `scope` grants exactly the read-only scope (missing or empty: no). */
export function grantsOnlyReadOnly(scope: string | undefined): boolean {
  if (scope === undefined) return false;
  const granted = scope.split(/\s+/).filter((s) => s !== '');
  return granted.length > 0 && granted.every((s) => s === GSC_SCOPE);
}

/** The consent URL for one request: `GSC_AUTH_PARAMS` exactly. */
export function gscAuthorizeUrl(config: GscConfig, request: { readonly redirectUri: string; readonly state: string; readonly challenge: string }): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.challenge,
    ...GSC_AUTH_FIXED_PARAMS,
  });
  return `${config.endpoints.authUrl}?${query.toString()}`;
}

/** `no-account`: no frost account is signed in (the connection would belong to nobody). */
export type GscAuthConnectResult = 'started' | 'needs-gesture' | 'already-connected' | 'browser-failed' | 'no-account';

export interface GscAuthDeps {
  readonly config: GscConfig;
  readonly fetch: FetchLike;
  /** `persistent`: whether a write reaches the OS keychain (else the token lasts this run only). */
  readonly store: Pick<SecretStore, 'persistent' | 'read' | 'write' | 'delete'>;
  /** The signed-in frost account's user ID (`null`: none). The connection belongs to the one that made it. */
  readonly currentUser: () => string | null;
  readonly startLoopback: (options: StartLoopbackOptions) => Promise<Loopback>;
  /** Opens `url` in the system browser: main passes `openExternalIfAllowed` (scheme allowlist, given the gesture verdict). */
  readonly openInBrowser: (url: string, userGesture: boolean) => boolean;
  /** Spends window `windowId`'s live user gesture (the account's `createWindowGestures().consume`). */
  readonly consumeGesture: (windowId: number) => boolean;
  /** Receives fixed messages. */
  readonly log: (message: string) => void;
  /** Hands over every short-lived secret seen (codes, access tokens, nonces), to be scrubbed from logs. */
  readonly remember: (...values: string[]) => void;
  /** Hands over long-lived secrets (refresh tokens), scrubbed for the whole run; defaults to `remember`. */
  readonly pin?: (...values: string[]) => void;
  /** Called after each change of `connected`, `connecting` or `error`. */
  readonly onChange: () => void;
  /** Epoch ms. */
  readonly now: () => number;
  /** Each call to Google; defaults to `GSC_LIMITS.timeoutMs`. */
  readonly timeoutMs?: number;
  /** Defaults to `GSC_CONNECT_TIMEOUT_MS`. */
  readonly connectTimeoutMs?: number;
}

export interface GscAuth {
  /** A refresh token is held, for the signed-in frost account. */
  connected(): boolean;
  /** A refresh token is held (for whichever account). */
  held(): boolean;
  /** The frost account the held connection belongs to, or `null`. */
  owner(): string | null;
  /** The frost account a pending connect is for, or `null`. */
  pendingOwner(): string | null;
  /** Whether the held refresh token was written to the OS keychain (else: this run only). */
  persisted(): boolean;
  /** A connect is waiting for the browser (or its exchange). */
  connecting(): boolean;
  /** Why the last connect failed or the connection ended (cleared by the next connect). */
  error(): GscError | null;
  /** Raised by every new connection and every disconnect: what was read before it is not kept. */
  generation(): number;
  connect(windowId: number): Promise<GscAuthConnectResult>;
  /** Drops the pending connect (a code it is exchanging is revoked when it arrives): `true` if there was one. */
  cancelConnect(): boolean;
  /** Deletes the blob and revokes the refresh token: `true` if connected. */
  disconnect(): Promise<boolean>;
  /** A live access token (refreshed when expired). */
  accessToken(): Promise<TokenResult>;
  /** The API refused `token` (401): it is not used again. */
  rejectAccessToken(token: string): void;
  /** Resolves once no exchange, refresh or revocation started so far is still running. */
  whenIdle(): Promise<void>;
  /**
   * Drops a pending connect and revokes a refresh token never written to the keychain; answers what is
   * still running (exchanges, refreshes, revocations) for the quit to wait for, or `null`.
   */
  dispose(): Promise<void> | null;
}

interface Pending {
  readonly owner: string;
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  phase: 'awaiting' | 'exchanging';
  loopback: Loopback | null;
}

const FORM_HEADERS = (): Headers => new Headers({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' });

export function createGscAuth(deps: GscAuthDeps): GscAuth {
  const { config, store, log, remember } = deps;
  const pin = deps.pin ?? remember;
  const timeouts = deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs };
  const changed = (): void => {
    try {
      deps.onChange();
    } catch {
      // A listener's failure is not the connection's.
    }
  };

  let refreshToken: string | null = null;
  let owner: string | null = null;
  let persisted = false;
  /** Consecutive failed refreshes, and when the next may be sent. */
  let refreshFailures = 0;
  let retryAt = 0;
  let lastFailure: 'network' | 'invalid' = 'network';
  let access: { readonly token: string; readonly expiresAt: number } | null = null;
  let pending: Pending | null = null;
  let error: GscError | null = null;
  let generation = 0;
  let disposed = false;
  let refreshing: { readonly refreshToken: string; readonly run: Promise<TokenResult> } | null = null;
  const inflight = new Set<Promise<unknown>>();
  const revoking = new Set<Promise<void>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => undefined);
    return work;
  };

  // ---- The store (never throws: a failing keychain keeps the connection for this run) ------------

  /** Whether the token reached the keychain (a memory-only store, or a failed write: this run only). */
  const save = (token: string, by: string): boolean => {
    try {
      store.write(GSC_SECRET, JSON.stringify({ v: 1, refreshToken: token, scope: GSC_SCOPE, owner: by }));
      return store.persistent;
    } catch {
      log('gsc: the connection could not be stored; kept for this run only');
      return false;
    }
  };
  const forget = (): void => {
    try {
      store.delete(GSC_SECRET);
    } catch {
      log('gsc: the stored connection could not be deleted');
    }
  };

  // ---- Google's token and revoke endpoints ------------------------------------------------------

  const grant = async (form: Record<string, string>): Promise<GrantResult> => {
    const body = new URLSearchParams({ ...form, client_id: config.clientId, client_secret: config.clientSecret }).toString();
    const outcome = await send(deps.fetch, config.endpoints.tokenUrl, { method: 'POST', headers: FORM_HEADERS(), body }, timeouts);
    if (outcome.kind === 'network') return { ok: false, failure: 'network' };
    const { status, text } = outcome;
    if (status >= 200 && status <= 299) {
      const parsed = GoogleTokenResponseSchema.safeParse(parseJson(text));
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: 'invalid' };
    }
    if (status === 400 || status === 401) {
      const refusal = GoogleTokenErrorSchema.safeParse(parseJson(text));
      return { ok: false, failure: refusal.success && refusal.data.error === 'invalid_grant' ? 'auth' : 'invalid' };
    }
    return { ok: false, failure: status === 408 || status === 429 || status >= 500 ? 'network' : 'invalid' };
  };

  const revoke = (token: string): Promise<void> => {
    const run = send(deps.fetch, config.endpoints.revokeUrl, { method: 'POST', headers: FORM_HEADERS(), body: new URLSearchParams({ token }).toString() }, timeouts).then((outcome) => {
      if (outcome.kind === 'network' || outcome.status < 200 || outcome.status > 299) log('gsc: revoking a token failed');
    });
    revoking.add(run);
    void run.finally(() => revoking.delete(run));
    return track(run);
  };

  // ---- Start ------------------------------------------------------------------------------------

  let text: string | null = null;
  try {
    text = store.read(GSC_SECRET);
  } catch {
    log('gsc: the stored connection could not be read');
  }
  if (text !== null) {
    const parsed = StoredGscSchema.safeParse(parseJson(text));
    if (parsed.success) {
      refreshToken = parsed.data.refreshToken;
      owner = parsed.data.owner;
      persisted = true;
      pin(refreshToken);
    } else {
      log('gsc: the stored connection is unreadable; discarded');
      forget();
    }
  }

  // ---- The flow ---------------------------------------------------------------------------------

  /** Ends `p` if it is still the pending connect. */
  const dropPending = (p: Pending, why: GscError | null, options: { closeListener: boolean }): boolean => {
    if (pending !== p) return false;
    pending = null;
    if (options.closeListener) p.loopback?.close();
    error = why;
    changed();
    return true;
  };

  /** The connection is over (refused refresh token, or a widened grant): nothing kept. */
  const endConnection = (why: GscError): void => {
    refreshToken = null;
    owner = null;
    persisted = false;
    access = null;
    refreshing = null;
    generation++;
    forget();
    error = why;
    changed();
  };

  const onCallback = async (p: Pending, callback: LoopbackCallback): Promise<void> => {
    if (pending !== p || p.phase !== 'awaiting') {
      log('gsc: a callback for no pending connect was ignored');
      return;
    }
    if (callback.error !== null || callback.code === null) {
      log('gsc: the browser reported the consent as refused or cancelled');
      dropPending(p, 'cancelled', { closeListener: false });
      return;
    }
    const code = callback.code;
    remember(code);
    if (!CODE_PATTERN.test(code)) {
      log('gsc: the callback carried no usable code');
      dropPending(p, 'exchange-failed', { closeListener: false });
      return;
    }
    p.phase = 'exchanging';
    const result = await grant({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.loopback?.redirectUri ?? '' });
    if (result.ok) {
      remember(result.value.access_token);
      pin(result.value.refresh_token ?? '');
    }
    if (pending !== p) {
      // Replaced or cancelled while exchanging: what it got is not kept.
      if (result.ok) void revoke(result.value.refresh_token ?? result.value.access_token);
      return;
    }
    if (!result.ok) {
      log(`gsc: the code exchange failed (${result.failure})`);
      dropPending(p, result.failure === 'network' ? 'network' : 'exchange-failed', { closeListener: false });
      return;
    }
    const { access_token: accessToken, refresh_token: newRefresh, expires_in: expiresIn, scope } = result.value;
    if (!grantsOnlyReadOnly(scope)) {
      log('gsc: Google granted other than the read-only scope; refused and revoked');
      void revoke(newRefresh ?? accessToken);
      dropPending(p, 'scope-refused', { closeListener: false });
      return;
    }
    if (newRefresh === undefined) {
      log('gsc: Google answered no refresh token; refused');
      void revoke(accessToken);
      dropPending(p, 'exchange-failed', { closeListener: false });
      return;
    }
    if (deps.currentUser() !== p.owner) {
      log('gsc: the frost account changed during the connect; refused and revoked');
      void revoke(newRefresh);
      dropPending(p, 'exchange-failed', { closeListener: false });
      return;
    }
    pending = null;
    refreshToken = newRefresh;
    owner = p.owner;
    access = { token: accessToken, expiresAt: deps.now() + expiresIn * 1000 };
    refreshFailures = 0;
    retryAt = 0;
    generation++;
    persisted = save(newRefresh, p.owner);
    error = null;
    log('gsc: connected');
    changed();
  };

  const doRefresh = async (token: string): Promise<TokenResult> => {
    const result = await grant({ grant_type: 'refresh_token', refresh_token: token });
    if (refreshToken !== token) return { ok: false, failure: 'not-connected' };
    if (!result.ok) {
      if (result.failure === 'auth') {
        log('gsc: Google no longer accepts the refresh token; disconnected');
        endConnection('auth-expired');
        return { ok: false, failure: 'auth-expired' };
      }
      refreshFailures++;
      lastFailure = result.failure;
      retryAt = deps.now() + Math.min(GSC_REFRESH_BACKOFF.maxMs, GSC_REFRESH_BACKOFF.initialMs * 2 ** Math.min(refreshFailures - 1, 30));
      log(`gsc: refreshing the access token failed (${result.failure}); backing off`);
      return { ok: false, failure: result.failure };
    }
    refreshFailures = 0;
    retryAt = 0;
    const value = result.value;
    remember(value.access_token);
    // The grant was checked at the exchange; a refresh cannot widen it, but one that names more is not used.
    if (value.scope !== undefined && !grantsOnlyReadOnly(value.scope)) {
      log('gsc: a refresh named other than the read-only scope; disconnected and revoked');
      void revoke(token);
      endConnection('scope-refused');
      return { ok: false, failure: 'auth-expired' };
    }
    if (value.refresh_token !== undefined && value.refresh_token !== token) {
      pin(value.refresh_token);
      refreshToken = value.refresh_token;
      persisted = save(value.refresh_token, owner ?? '');
    }
    access = { token: value.access_token, expiresAt: deps.now() + value.expires_in * 1000 };
    return { ok: true, token: value.access_token };
  };

  const disconnect = async (): Promise<boolean> => {
    if (pending) dropPending(pending, null, { closeListener: true });
    const token = refreshToken;
    if (token === null) return false;
    refreshToken = null;
    owner = null;
    persisted = false;
    access = null;
    refreshing = null;
    generation++;
    forget();
    error = null;
    log('gsc: disconnected');
    changed();
    await revoke(token);
    return true;
  };

  return {
    connected: () => refreshToken !== null && owner !== null && owner === deps.currentUser(),
    held: () => refreshToken !== null,
    owner: () => (refreshToken === null ? null : owner),
    pendingOwner: () => pending?.owner ?? null,
    persisted: () => refreshToken !== null && persisted,
    connecting: () => pending !== null,
    error: () => error,
    generation: () => generation,

    async connect(windowId) {
      if (disposed) return 'browser-failed';
      const user = deps.currentUser();
      if (user === null) return 'no-account';
      if (refreshToken !== null && owner === user) return 'already-connected';
      if (!deps.consumeGesture(windowId)) {
        log('gsc: connect refused without a user gesture');
        return 'needs-gesture';
      }
      // Another account's connection is not kept alongside (normally already dropped on the account change).
      if (refreshToken !== null) await disconnect();
      if (pending) dropPending(pending, null, { closeListener: true });
      const verifier = createVerifier();
      const challenge = challengeOf(verifier);
      const state = createState();
      remember(verifier, challenge, state);
      const p: Pending = { owner: user, state, verifier, challenge, phase: 'awaiting', loopback: null };
      pending = p;
      error = null;
      changed();
      let loopback: Loopback;
      try {
        loopback = await deps.startLoopback({
          state,
          onCallback: (callback) => void track(onCallback(p, callback)),
          onTimeout: () => {
            if (pending === p && p.phase === 'awaiting' && dropPending(p, 'timed-out', { closeListener: true })) log('gsc: no answer from the browser in time');
          },
          timeoutMs: deps.connectTimeoutMs ?? GSC_CONNECT_TIMEOUT_MS,
        });
      } catch {
        log('gsc: the connect listener could not start');
        dropPending(p, 'browser-failed', { closeListener: false });
        return 'browser-failed';
      }
      if (pending !== p) {
        // Replaced or cancelled while the listener started.
        loopback.close();
        return 'started';
      }
      p.loopback = loopback;
      // The gesture was spent above, on this window's request.
      if (!deps.openInBrowser(gscAuthorizeUrl(config, { redirectUri: loopback.redirectUri, state, challenge }), true)) {
        log('gsc: the system browser could not be opened');
        dropPending(p, 'browser-failed', { closeListener: true });
        return 'browser-failed';
      }
      log('gsc: connect started');
      return 'started';
    },

    cancelConnect() {
      const p = pending;
      if (!p) return false;
      dropPending(p, null, { closeListener: true });
      log('gsc: connect cancelled');
      return true;
    },

    disconnect,

    accessToken() {
      const token = refreshToken;
      // Another frost account's (or nobody's): neither token is sent.
      if (token === null || owner === null || owner !== deps.currentUser()) return Promise.resolve({ ok: false, failure: 'not-connected' });
      if (access && access.expiresAt - GSC_ACCESS_TOKEN_SKEW_MS > deps.now()) return Promise.resolve({ ok: true, token: access.token });
      if (refreshing?.refreshToken === token) return refreshing.run;
      if (refreshFailures > 0 && deps.now() < retryAt) return Promise.resolve({ ok: false, failure: lastFailure });
      const run: Promise<TokenResult> = doRefresh(token)
        .catch((): TokenResult => ({ ok: false, failure: 'invalid' }))
        .finally(() => {
          if (refreshing?.run === run) refreshing = null;
        });
      refreshing = { refreshToken: token, run };
      return track(run);
    },

    rejectAccessToken(token) {
      if (access?.token === token) access = null;
    },

    async whenIdle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    dispose() {
      disposed = true;
      if (pending) dropPending(pending, null, { closeListener: true });
      // A grant this run cannot keep is not left alive at Google.
      if (refreshToken !== null && !persisted) {
        const token = refreshToken;
        refreshToken = null;
        owner = null;
        access = null;
        refreshing = null;
        generation++;
        log('gsc: revoking a connection kept for this run only');
        void revoke(token);
      }
      if (inflight.size === 0) return null;
      return (async () => {
        while (inflight.size > 0) await Promise.allSettled([...inflight]);
      })();
    },
  };
}
