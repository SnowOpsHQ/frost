import {
  CHATGPT_ENDPOINTS,
  CHATGPT_LIMITS,
  CHATGPT_REDIRECT_PATH,
  CHATGPT_REFRESH_MARGIN_MS,
  chatgptModelId,
  isChatgptRedirectUri,
  isIssuedClientId,
  isRefreshFailureCode,
  planUsageOf,
  type ChatgptAccountView,
  type ChatgptEndpoints,
  type ChatgptModelView,
  type ChatgptSignInError,
  type ChatgptSignInResult,
  type ChatgptSignOutResult,
} from '@app/specs/agent-chatgpt.spec';
import { ChatgptModelEntrySchema, EMPTY_CHATGPT_STATE, earliestRefreshAtMs, type ChatgptStoredState, type ChatgptStoredTokens, type ChatgptTokenAnswer } from '@app/specs/agent-chatgpt.schema';
import type { Loopback, LoopbackCallback, StartLoopbackOptions } from '../../account/loopback';
import { challengeOf, createState, createVerifier } from '../../account/pkce';
import type { HostIdStore } from './host-id';
import { parseJson, send, type FetchLike, type HttpOutcome } from './http';
import { createJwks, isTimeOnlyFailure, verifyIdToken, type Jwks } from './id-token';
import { authorizeUrl, exchangeCode, refreshTokens, revokeRefreshToken, type ChatgptHttp } from './oauth';
import type { ChatgptStore } from './store';

// The ChatGPT sign-in and its tokens, in main (plan `docs/plans/agent-chatgpt-plan.md`, Task 2 and
// Protocol; spec `agent-chatgpt.spec.ts`, `agent-chatgpt.schema.ts`; acceptance
// `agent-chatgpt.feature.md`). No Electron import: main injects the session's `fetch`, the clock,
// the encrypted store, the host id, the loopback listener and the browser opener.
//
// 1. `signIn` (OS keychain required) makes sure the host id is on disk, starts a loopback listener on
//    `127.0.0.1` at `/auth/callback` bound to a fresh `state`, and opens the authorize URL (a fresh
//    nonce and PKCE S256 challenge; `dynamic_agent_client` and the name hint on a first
//    registration, the issued client id after). Only one sign-in is pending at a time.
// 2. The redirect's `state` is checked by the listener. A first registration needs the issued
//    `client_id` in the redirect (`registration-incomplete` otherwise), and it is written to the
//    store **before** the code is exchanged; a returning sign-in's redirect may name no client, but
//    never another (`client-mismatch`).
// 3. The code exchange (the issued client id, the verifier, the same redirect, the resource), then
//    the ID token (`id-token.ts`: RS256, issuer, audience, `azp`, expiry, nonce). A returning
//    account must keep its `sub` (`account-mismatch`). Plan usage is `on` only when the granted scope
//    holds `chatgpt.tokens.use.direct` in the **token answer's** `scope` (no scope there: declined).
//    Tokens are stored before the sign-in counts; whatever fails after the exchange revokes the new
//    refresh token, and a sign-in that replaces held tokens (re-consent) revokes the old refresh
//    token once the new ones are stored.
// 4. `withAccessToken(fn)` (the model proxy's, Task 3) hands `fn` a live access token: refreshed
//    `CHATGPT_REFRESH_MARGIN_MS` before it expires and never before `earliest_refresh_at`; one
//    refresh at a time, callers coalesced (refresh tokens rotate); the replacement stored before the
//    new access token is handed out. A refused refresh (`CHATGPT_REFRESH_FAILURE_CODES`) forgets the
//    tokens: `expired` (client id, account and host id kept). Any other failure keeps them, and no
//    refresh is tried again for `refreshBackoffMs` (the current token is used while it lasts). A
//    refreshed ID token that fails only on time keeps the new tokens and the last verified identity.
//    `earliest_refresh_at` is read as at most `expiresAt - CHATGPT_REFRESH_MARGIN_MS`.
// 5. `signOut` waits for a refresh in flight, revokes the refresh token (retrying a network failure
//    or `5xx`), then forgets the tokens (only if they are still the ones it revoked); the client id,
//    the account's `sub` and the host id stay. No sign-in starts while a sign-out runs. "Use a
//    different account" revokes the same way but forgets nothing unless the revocation is confirmed
//    (`not-revoked`: it stops, and a retry revokes again).
// 6. A stored sign-in that exists but can't be read (`failed`: the keychain refused it) is never
//    overwritten: nothing is written and no sign-in starts (`store-unreadable`) until a later read
//    succeeds (each sign-in reads it again).
// 7. `view()` is all the renderer gets: state, email, plan usage, the notice flag, the last
//    sign-in failure. Logs are fixed lines; no token, code, verifier or nonce goes anywhere but the
//    auth server.

export interface ChatgptAuthDeps {
  /** The `agent-chatgpt` session's `fetch` (main); `redirect: 'error'` and `credentials: 'omit'` are set per call. */
  readonly fetch: FetchLike;
  /** Epoch ms. */
  readonly now: () => number;
  readonly store: ChatgptStore;
  readonly hostId: HostIdStore;
  readonly startLoopback: (options: StartLoopbackOptions) => Promise<Loopback>;
  /**
   * Opens the authorize URL in the system browser (main passes its scheme-allowlisted opener):
   * `userGesture` is whether the sign-in was backed by a live user gesture the IPC spent
   * (`signIn({ userGesture })`); `false` when it couldn't open.
   */
  readonly openExternal: (url: string, userGesture: boolean) => boolean;
  /** Brings app window `windowId` to the front once a sign-in started from it succeeds (as the account sign-in does). */
  readonly focusWindow?: (windowId: number) => void;
  /** Fixed lines only. */
  readonly log?: (line: string) => void;
  /** Waits between revocation attempts (tests make it instant). */
  readonly delay?: (ms: number) => Promise<void>;
  /** Defaults to `CHATGPT_ENDPOINTS` (the e2e seam, Task 6, points them at a local fake). */
  readonly endpoints?: ChatgptEndpoints;
  /** Defaults to `CHATGPT_LIMITS.signInTimeoutMs`. */
  readonly signInTimeoutMs?: number;
  /** Defaults to `CHATGPT_LIMITS.requestTimeoutMs`. */
  readonly requestTimeoutMs?: number;
  /** The issuer's keys (tests may pass their own; default: fetched from `endpoints.jwks`). */
  readonly jwks?: Jwks;
}

/**
 * Why no access token: `signed-out` (none, or signing out), `expired` (a refresh was refused: sign in
 * again), `plan-usage-off` (the grant lacks plan usage), `network` (the auth server couldn't be
 * reached; tokens kept), `failed` (anything else: an unusable answer, a token that can't be renewed
 * yet, the keychain).
 */
export type ChatgptTokenFailure = 'signed-out' | 'expired' | 'plan-usage-off' | 'network' | 'failed';
export type WithAccessTokenResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ChatgptTokenFailure };
export type ListModelsResult = { readonly ok: true; readonly models: readonly ChatgptModelView[] } | { readonly ok: false; readonly reason: ChatgptTokenFailure };

export interface WithAccessTokenOptions {
  /**
   * The access token a request was just refused with (`401`): refreshed once if it is still the
   * current one, so the retry uses a new token (a single 401 is not proof of revocation).
   */
  readonly rejected?: string;
}

export interface ChatgptSignInOptions {
  readonly reconsent?: boolean;
  readonly differentAccount?: boolean;
  readonly userGesture?: boolean;
  /** The app window the sign-in was asked from: focused once it succeeds. */
  readonly windowId?: number;
}

export interface ChatgptAuth {
  /** Reads the stored sign-in once (later calls share it). Never rejects. */
  load(): Promise<void>;
  /** What the renderer may see: never a token, a client id, a host id or a `sub`. */
  view(): ChatgptAccountView;
  onChange(listener: () => void): () => void;
  /**
   * Starts a sign-in (`reconsent`: ask for consent again, to turn plan usage on). `differentAccount`
   * ("Use a different account"; v1 keeps one account) first signs the held account out (revoking
   * its refresh token) and forgets the registration (client id, account, notice flag; the host id
   * stays), so the sign-in registers fresh and may come back as any account; if ChatGPT doesn't
   * confirm that revocation it stops (`not-revoked`) having forgotten nothing, so a retry revokes
   * again. `userGesture`: a live user gesture backs this sign-in (the IPC spent it), passed to
   * `openExternal`. `windowId`: the window focused when the sign-in succeeds.
   */
  signIn(options?: ChatgptSignInOptions): Promise<ChatgptSignInResult>;
  /** Ends a pending sign-in (`cancelled`); `false` if none was pending. */
  cancel(): boolean;
  /** Revokes, then forgets the tokens (the client id and the host id stay). */
  signOut(): Promise<ChatgptSignOutResult>;
  /** Dismisses the one-time "You're using your ChatGPT plan" notice. */
  acknowledge(): Promise<boolean>;
  /** Runs `fn` with a live access token (the model proxy only); `fn` must not keep or return it. */
  withAccessToken<T>(fn: (token: string) => T | Promise<T>, options?: WithAccessTokenOptions): Promise<WithAccessTokenResult<T>>;
  /** The account's listed models (`visibility === 'list'`), in the server's order, each with the reasoning levels it advertises. */
  listModels(): Promise<ListModelsResult>;
  /** Ends a pending sign-in and resolves once nothing started here is still running. */
  dispose(): Promise<void>;
}

interface Pending {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  /** The issued client id this attempt uses, `null` for a first registration. */
  readonly clientId: string | null;
  readonly hostId: string;
  readonly reconsent: boolean;
  /** The window to focus when this sign-in succeeds, `null` for none. */
  readonly windowId: number | null;
  phase: 'awaiting' | 'exchanging';
  loopback: Loopback | null;
}

type TokenOutcome = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: ChatgptTokenFailure };

/** An authorization code as it may arrive (printable ASCII; the listener caps its length). */
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const EMAIL_PATTERN = /^[^\s@]{1,256}@[^\s@]{1,256}$/;

/**
 * `earliest_refresh_at` as epoch ms, at most `expiresAt - CHATGPT_REFRESH_MARGIN_MS`: a bound past
 * expiry would otherwise leave no time to refresh (`null`: none given).
 */
function earliestRefreshAt(answer: Pick<ChatgptTokenAnswer, 'earliest_refresh_at' | 'expires_in'>, now: number): number | null {
  const earliest = earliestRefreshAtMs(answer.earliest_refresh_at);
  if (earliest === null) return null;
  return Math.max(0, Math.min(earliest, now + answer.expires_in * 1000 - CHATGPT_REFRESH_MARGIN_MS));
}

const scopesOf = (scope: string | undefined | null): string[] => (scope ?? '').split(/\s+/).filter((word) => word !== '' && word.length <= 128 && /^[\x21-\x7e]+$/.test(word)).slice(0, 32);

export function createChatgptAuth(deps: ChatgptAuthDeps): ChatgptAuth {
  const endpoints = deps.endpoints ?? CHATGPT_ENDPOINTS;
  const log = deps.log ?? (() => undefined);
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const requestTimeoutMs = deps.requestTimeoutMs ?? CHATGPT_LIMITS.requestTimeoutMs;
  const http: ChatgptHttp = { fetch: deps.fetch, options: { timeoutMs: requestTimeoutMs } };
  const jwks = deps.jwks ?? createJwks({ fetch: deps.fetch, url: endpoints.jwks, now: deps.now, timeoutMs: requestTimeoutMs });

  let state: ChatgptStoredState = EMPTY_CHATGPT_STATE;
  let loading: Promise<void> | null = null;
  let pending: Pending | null = null;
  let lastError: ChatgptSignInError | null = null;
  /** Raised by every sign-in, sign-out and expiry: a refresh begun before it is not kept. */
  let generation = 0;
  let refreshing: Promise<TokenOutcome> | null = null;
  /** After a refresh failed without ending the sign-in: no refresh before this (epoch ms), and why it failed. */
  let refreshBlocked: { readonly until: number; readonly reason: ChatgptTokenFailure } | null = null;
  let signingOut = false;
  /** While a sign-out or account switch runs: settles once it has ended. */
  let signOutSettled: Promise<void> | null = null;
  /** The stored record exists but couldn't be read: nothing may be written over it. */
  let storeFailed = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => undefined);
    return work;
  };

  const changed = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        log('agent chatgpt: a change listener failed');
      }
    }
  };

  const load = (): Promise<void> => {
    loading ??= (async () => {
      const read = await deps.store.read().catch(() => 'failed' as const);
      // `unavailable`: a record is stored but no OS keychain can open it yet; it counts as unreadable.
      storeFailed = read === 'failed' || read === 'unavailable';
      if (typeof read === 'object' && read !== null) state = read;
      else if (storeFailed) {
        lastError = 'store-unreadable';
        log('agent chatgpt: the stored sign-in could not be read; it is left as it is');
      }
    })();
    return loading;
  };

  /** Writes the current state (the store's queue keeps writes in call order); never over a record that couldn't be read. */
  const persist = async (): Promise<boolean> => {
    if (storeFailed) return false;
    try {
      return (await deps.store.write(state)) === true;
    } catch {
      return false;
    }
  };

  const revokeOnce = (clientId: string, refreshToken: string): Promise<'revoked' | 'retry' | 'refused'> => track(revokeRefreshToken(http, endpoints, { clientId, refreshToken }));

  /** Best effort: tokens this run won't keep are not left alive at the server. */
  const discard = (clientId: string, answer: Pick<ChatgptTokenAnswer, 'refresh_token'>): void => {
    if (answer.refresh_token === undefined) return;
    void revokeOnce(clientId, answer.refresh_token).then((outcome) => {
      if (outcome !== 'revoked') log('agent chatgpt: revoking an unused sign-in was not confirmed');
    });
  };

  // ---- The sign-in ------------------------------------------------------------------------------

  /**
   * Ends `p` if it is still the pending sign-in. The listener is closed unless the redirect already
   * arrived (it then serves its "you can close this tab" page once and closes itself).
   */
  const dropPending = (p: Pending, why: ChatgptSignInError | null, closeListener = true): boolean => {
    if (pending !== p) return false;
    pending = null;
    if (closeListener) p.loopback?.close();
    lastError = why;
    changed();
    return true;
  };

  const fail = (p: Pending, why: ChatgptSignInError, line: string, closeListener = true): void => {
    if (dropPending(p, why, closeListener)) log(`agent chatgpt: ${line}`);
  };

  const onCallback = async (p: Pending, callback: LoopbackCallback): Promise<void> => {
    const failAfterRedirect = (why: ChatgptSignInError, line: string): void => fail(p, why, line, false);
    if (pending !== p || p.phase !== 'awaiting' || p.loopback === null) return;
    if (callback.error !== null) {
      failAfterRedirect(callback.error === 'access_denied' ? 'declined' : 'exchange-failed', 'the browser reported the sign-in as declined or failed');
      return;
    }
    const code = callback.code;
    if (code === null || !CODE_PATTERN.test(code)) {
      failAfterRedirect('exchange-failed', 'the redirect carried no usable code');
      return;
    }
    const named = callback.params.getAll('client_id');
    if (named.length > 1) {
      failAfterRedirect('client-mismatch', 'the redirect named more than one client');
      return;
    }
    const callbackClient = named[0] ?? null;
    let clientId: string;
    p.phase = 'exchanging';
    if (p.clientId === null) {
      // A first registration: the issued client id comes with the redirect and is kept before the exchange.
      if (!isIssuedClientId(callbackClient)) {
        failAfterRedirect('registration-incomplete', 'a first registration came back without an issued client id');
        return;
      }
      clientId = callbackClient;
      const before = state;
      state = { ...state, clientId };
      if (!(await persist())) {
        state = before;
        failAfterRedirect('store-failed', 'the issued client id could not be stored');
        return;
      }
      if (pending !== p) return;
    } else {
      if (callbackClient !== null && callbackClient !== p.clientId) {
        failAfterRedirect('client-mismatch', 'the redirect named another client');
        return;
      }
      clientId = p.clientId;
    }
    changed();

    const grant = await exchangeCode(http, endpoints, { clientId, code, verifier: p.verifier, redirectUri: p.loopback.redirectUri });
    if (pending !== p) {
      // Cancelled while exchanging: what it got is not kept.
      if (grant.ok) discard(clientId, grant.answer);
      return;
    }
    if (!grant.ok) {
      failAfterRedirect(grant.failure === 'network' ? 'network' : 'exchange-failed', `the code exchange failed (${grant.failure})`);
      return;
    }
    const answer = grant.answer;
    if (answer.refresh_token === undefined || answer.id_token === undefined) {
      discard(clientId, answer);
      failAfterRedirect('exchange-failed', 'the code exchange answered no refresh or ID token');
      return;
    }
    const verified = await verifyIdToken(answer.id_token, { issuer: endpoints.issuer, clientId, nonce: p.nonce, now: deps.now() }, jwks);
    if (pending !== p) {
      discard(clientId, answer);
      return;
    }
    if (!verified.ok) {
      discard(clientId, answer);
      failAfterRedirect(verified.failure === 'keys-unavailable' ? 'network' : 'id-token', `the ID token was refused (${verified.failure})`);
      return;
    }
    const { sub, email } = verified.claims;
    if (state.account !== null && state.account.sub !== sub) {
      discard(clientId, answer);
      failAfterRedirect('account-mismatch', 'the sign-in came back as another account');
      return;
    }
    const now = deps.now();
    const tokens: ChatgptStoredTokens = {
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token,
      idToken: answer.id_token,
      expiresAt: now + answer.expires_in * 1000,
      earliestRefreshAt: earliestRefreshAt(answer, now),
      // Only the token answer's granted scopes decide plan usage (none there: declined); the redirect's are not used.
      scopes: scopesOf(answer.scope),
      savedAt: now,
    };
    const before = state;
    state = { ...state, clientId, account: { sub, email: email !== undefined && EMAIL_PATTERN.test(email) ? email : null }, tokens, expired: false };
    // While it was being stored, a sign-out or an account switch may have taken the state over. One
    // still running (and any queued behind it) is waited for: a switch that ends `not-revoked` keeps
    // the tokens, handing them back. The wait is inline, not in a helper, so the check and what follows
    // run in one step, before a sign-out queued behind the one waited for can start.
    const owned = (): boolean => !signingOut && state.tokens === tokens;
    // Not owned any more: nothing is put back, and the new grant and the refresh token it displaced are revoked.
    const endUnowned = (): void => {
      discard(clientId, answer);
      const displaced = before.tokens;
      if (displaced !== null && displaced.refreshToken !== tokens.refreshToken) discard(before.clientId ?? clientId, { refresh_token: displaced.refreshToken });
      log('agent chatgpt: a sign-in ended while being stored was not kept');
      changed();
    };
    if (!(await persist())) {
      while (signingOut && state.tokens === tokens) await signOutSettled;
      if (!owned()) {
        endUnowned();
        return;
      }
      state = before;
      discard(clientId, answer);
      if (pending === p) failAfterRedirect('store-failed', 'the sign-in could not be stored');
      else changed();
      return;
    }
    if (pending !== p) {
      while (signingOut && state.tokens === tokens) await signOutSettled;
      if (!owned()) {
        endUnowned();
        return;
      }
      // Cancelled while it was being stored: the previous record goes back and the new grant is revoked.
      state = before;
      if (!(await persist())) await deps.store.clear().catch(() => false);
      discard(clientId, answer);
      log('agent chatgpt: a sign-in cancelled while being stored was not kept');
      changed();
      return;
    }
    pending = null;
    lastError = null;
    generation++;
    refreshing = null;
    refreshBlocked = null;
    // A sign-in over held tokens (re-consent): the replaced refresh token is not left alive.
    const replaced = before.tokens;
    if (replaced !== null && replaced.refreshToken !== tokens.refreshToken) discard(before.clientId ?? clientId, { refresh_token: replaced.refreshToken });
    log(`agent chatgpt: signed in (plan usage ${planUsageOf(tokens.scopes)})`);
    changed();
    // Back from the browser: the window the sign-in was asked from comes to the front.
    if (p.windowId !== null) {
      try {
        deps.focusWindow?.(p.windowId);
      } catch {
        log('agent chatgpt: the window could not be focused');
      }
    }
  };

  /**
   * "Use a different account": the held account is signed out (its refresh token revoked) and the
   * registration forgotten, so the next sign-in is a first registration. `not-revoked`: ChatGPT
   * didn't confirm the revocation, so nothing was forgotten (a retry revokes the same token again);
   * `failed`: it couldn't be done.
   */
  const forgetAccount = async (): Promise<'forgotten' | 'not-revoked' | 'failed'> => {
    if (state.tokens !== null && (await revokeAndForget(true)) === 'not-revoked') return 'not-revoked';
    if (state.tokens !== null || storeFailed) return 'failed';
    state = { ...state, clientId: null, account: null, expired: false, acknowledged: false };
    generation++;
    refreshBlocked = null;
    if (!(await persist())) {
      // Nothing of the old registration may stay on disk: the whole record goes.
      if ((await deps.store.clear().catch(() => false)) !== true) return 'failed';
    }
    log('agent chatgpt: the registration was forgotten to use a different account');
    changed();
    return 'forgotten';
  };

  const signIn = async (options: ChatgptSignInOptions = {}): Promise<ChatgptSignInResult> => {
    if (disposed) return 'failed';
    // A sign-out in progress finishes first (its tokens must not be cleared over a new sign-in's).
    if (signingOut) return 'failed';
    await load();
    if (storeFailed) {
      // The keychain may be unlocked by now: read again before deciding.
      loading = null;
      await load();
      if (storeFailed) {
        changed();
        log('agent chatgpt: sign-in refused while the stored sign-in cannot be read');
        return 'failed';
      }
      changed();
    }
    if (signingOut) return 'failed';
    let protection: string;
    try {
      protection = await deps.store.protection();
    } catch {
      protection = 'unavailable';
    }
    if (protection !== 'os') {
      lastError = 'no-keychain';
      changed();
      log('agent chatgpt: sign-in refused without an OS keychain');
      return 'no-keychain';
    }
    let hostId: string;
    try {
      hostId = await deps.hostId.get();
    } catch {
      lastError = 'store-failed';
      changed();
      return 'failed';
    }
    if (pending) dropPending(pending, null);
    if (options.differentAccount === true) {
      const forgot = await forgetAccount();
      // Not revoked: the held account stays signed in (nothing forgotten), and the user is told.
      if (forgot === 'not-revoked') return 'not-revoked';
      if (forgot === 'failed') {
        lastError = 'store-failed';
        changed();
        return 'failed';
      }
      if (disposed || signingOut || pending !== null) return 'failed';
    }
    const verifier = createVerifier();
    const windowId = typeof options.windowId === 'number' && Number.isInteger(options.windowId) ? options.windowId : null;
    const p: Pending = { state: createState(), nonce: createState(), verifier, clientId: state.clientId, hostId, reconsent: options.reconsent === true, windowId, phase: 'awaiting', loopback: null };
    pending = p;
    lastError = null;
    changed();
    let loopback: Loopback;
    try {
      loopback = await deps.startLoopback({
        state: p.state,
        callbackPath: CHATGPT_REDIRECT_PATH,
        onCallback: (callback) => void track(onCallback(p, callback).catch(() => fail(p, 'exchange-failed', 'the sign-in failed', false))),
        onTimeout: () => {
          if (pending === p && p.phase === 'awaiting') fail(p, 'timed-out', 'no answer from the browser in time');
        },
        timeoutMs: deps.signInTimeoutMs ?? CHATGPT_LIMITS.signInTimeoutMs,
      });
    } catch {
      fail(p, 'browser-failed', 'the sign-in listener could not start');
      return 'browser-failed';
    }
    if (pending !== p) {
      // Cancelled or replaced while the listener started.
      loopback.close();
      return 'started';
    }
    if (!isChatgptRedirectUri(loopback.redirectUri)) {
      loopback.close();
      fail(p, 'browser-failed', 'the sign-in listener has an unexpected address');
      return 'browser-failed';
    }
    p.loopback = loopback;
    const url = authorizeUrl(endpoints, { clientId: p.clientId, hostId, redirectUri: loopback.redirectUri, state: p.state, nonce: p.nonce, challenge: challengeOf(verifier), reconsent: p.reconsent });
    let opened = false;
    try {
      opened = deps.openExternal(url, options.userGesture === true) === true;
    } catch {
      opened = false;
    }
    if (!opened) {
      fail(p, 'browser-failed', 'the system browser could not be opened');
      return 'browser-failed';
    }
    log('agent chatgpt: sign-in started');
    return 'started';
  };

  // ---- Tokens -----------------------------------------------------------------------------------

  /** The sign-in is over (a refused refresh, or a refreshed ID token that fails): tokens forgotten, the rest kept. */
  const expire = async (line: string): Promise<void> => {
    state = { ...state, tokens: null, expired: true };
    generation++;
    refreshBlocked = null;
    log(`agent chatgpt: ${line}; sign in again`);
    if (!(await persist())) await deps.store.clear().catch(() => false);
    changed();
  };

  const doRefresh = async (): Promise<TokenOutcome> => {
    const current = state.tokens;
    const clientId = state.clientId;
    if (current === null || clientId === null) return { ok: false, reason: 'signed-out' };
    const started = generation;
    const grant = await refreshTokens(http, endpoints, { clientId, refreshToken: current.refreshToken });
    if (generation !== started || state.tokens?.refreshToken !== current.refreshToken) {
      // Signed out (or in again) meanwhile: a replacement isn't kept.
      if (grant.ok) discard(clientId, grant.answer);
      return { ok: false, reason: 'signed-out' };
    }
    if (!grant.ok) {
      if (grant.failure === 'refused' && isRefreshFailureCode(grant.error)) {
        await expire('the refresh token was refused');
        return { ok: false, reason: 'expired' };
      }
      // Not the end of the sign-in: kept, and not tried again for a while.
      const reason: ChatgptTokenFailure = grant.failure === 'network' ? 'network' : 'failed';
      refreshBlocked = { until: deps.now() + CHATGPT_LIMITS.refreshBackoffMs, reason };
      log(`agent chatgpt: refreshing the access token failed (${grant.failure})`);
      return { ok: false, reason };
    }
    const answer = grant.answer;
    let idToken = current.idToken;
    if (answer.id_token !== undefined) {
      const verified = await verifyIdToken(answer.id_token, { issuer: endpoints.issuer, clientId, nonce: null, now: deps.now() }, jwks);
      if (verified.ok && verified.claims.sub === state.account?.sub) idToken = answer.id_token;
      else if (verified.ok || (verified.failure !== 'keys-unavailable' && !isTimeOnlyFailure(verified.failure))) {
        discard(clientId, answer);
        await expire('a refreshed ID token was refused');
        return { ok: false, reason: 'expired' };
      } else {
        // Keys unavailable, or a clock far off (every other check held): the new tokens are kept (the
        // old refresh token is spent) and the last verified ID token and identity stay.
        log(`agent chatgpt: a refreshed ID token was not checked (${verified.failure}); the last verified identity is kept`);
      }
    }
    const now = deps.now();
    refreshBlocked = null;
    const tokens: ChatgptStoredTokens = {
      accessToken: answer.access_token,
      refreshToken: answer.refresh_token ?? current.refreshToken,
      idToken,
      expiresAt: now + answer.expires_in * 1000,
      earliestRefreshAt: earliestRefreshAt(answer, now),
      scopes: answer.scope === undefined ? current.scopes : scopesOf(answer.scope),
      savedAt: now,
    };
    state = { ...state, tokens };
    // The rotated refresh token is stored before the new access token is used.
    if (!(await persist())) log('agent chatgpt: the refreshed sign-in could not be stored; kept for this run only');
    changed();
    if (planUsageOf(tokens.scopes) !== 'on') return { ok: false, reason: 'plan-usage-off' };
    return { ok: true, token: tokens.accessToken };
  };

  const accessToken = (options: WithAccessTokenOptions): Promise<TokenOutcome> => {
    const tokens = state.tokens;
    if (tokens === null || signingOut) return Promise.resolve({ ok: false, reason: state.expired ? 'expired' : 'signed-out' });
    if (planUsageOf(tokens.scopes) !== 'on') return Promise.resolve({ ok: false, reason: 'plan-usage-off' });
    const now = deps.now();
    const rejected = options.rejected !== undefined && options.rejected === tokens.accessToken;
    /** After a refresh that failed without ending the sign-in: this token while it lasts (never one the server just refused), or why not. */
    const fallback = (outcome: TokenOutcome): TokenOutcome =>
      outcome.ok || (outcome.reason !== 'network' && outcome.reason !== 'failed') || state.tokens !== tokens || rejected || deps.now() >= tokens.expiresAt ? outcome : { ok: true, token: tokens.accessToken };
    if (refreshing !== null) return refreshing.then(fallback);
    const due = rejected || now >= tokens.expiresAt - CHATGPT_REFRESH_MARGIN_MS;
    if (!due) return Promise.resolve({ ok: true, token: tokens.accessToken });
    if (tokens.earliestRefreshAt !== null && now < tokens.earliestRefreshAt) return Promise.resolve(fallback({ ok: false, reason: 'failed' }));
    // A refresh failed a moment ago: not tried again on every request.
    if (refreshBlocked !== null && now < refreshBlocked.until) return Promise.resolve(fallback({ ok: false, reason: refreshBlocked.reason }));
    const run = track(doRefresh())
      .catch((): TokenOutcome => ({ ok: false, reason: 'failed' }))
      .finally(() => {
        if (refreshing === run) refreshing = null;
      });
    refreshing = run;
    return run.then(fallback);
  };

  const withAccessToken = async <T>(fn: (token: string) => T | Promise<T>, options: WithAccessTokenOptions = {}): Promise<WithAccessTokenResult<T>> => {
    await load();
    const outcome = await accessToken(options);
    if (!outcome.ok) return outcome;
    return { ok: true, value: await fn(outcome.token) };
  };

  // ---- Sign-out, models, the view -----------------------------------------------------------------

  /**
   * Revokes the refresh token, then forgets the tokens. `keepUnrevoked` ("Use a different account"):
   * an unconfirmed revocation forgets nothing, so the caller can stop and a retry revokes again.
   */
  const revokeAndForget = async (keepUnrevoked: boolean): Promise<ChatgptSignOutResult> => {
    await load();
    // One at a time: a sign-out or switch already running ends first, so `signingOut` and
    // `signOutSettled` always describe this run alone.
    while (signOutSettled !== null) await signOutSettled;
    if (pending) dropPending(pending, null);
    signingOut = true;
    let settle!: () => void;
    signOutSettled = new Promise<void>((resolve) => (settle = resolve));
    try {
      // A refresh in flight finishes first, so the token revoked is the live one.
      if (refreshing !== null) await refreshing.catch(() => undefined);
      const tokens = state.tokens;
      const clientId = state.clientId;
      let result: ChatgptSignOutResult = 'signed-out';
      if (tokens !== null && clientId !== null) {
        let outcome: 'revoked' | 'retry' | 'refused' = 'retry';
        for (let attempt = 0; attempt < CHATGPT_LIMITS.revokeAttempts; attempt++) {
          if (attempt > 0) await delay(CHATGPT_LIMITS.revokeBackoffMs[Math.min(attempt - 1, CHATGPT_LIMITS.revokeBackoffMs.length - 1)]!);
          outcome = await revokeOnce(clientId, tokens.refreshToken);
          if (outcome !== 'retry') break;
        }
        if (outcome !== 'revoked') {
          result = 'not-revoked';
          log('agent chatgpt: the sign-out was not confirmed by the server');
          if (keepUnrevoked) return result;
        }
      }
      // Then forgotten (only the tokens revoked above: nothing else may have replaced them, but if
      // something did, they are not cleared unrevoked): the client id, the account's identity and the
      // notice flag stay.
      if (state.tokens !== tokens) return result;
      if (storeFailed) return result;
      state = { ...state, tokens: null, expired: false };
      generation++;
      refreshBlocked = null;
      if (!(await persist())) {
        // The tokens must not stay on disk: the whole record goes (the next sign-in registers again).
        log('agent chatgpt: the sign-out could not be stored; the stored sign-in is removed');
        await deps.store.clear().catch(() => false);
      }
      log('agent chatgpt: signed out');
      return result;
    } finally {
      signingOut = false;
      signOutSettled = null;
      settle();
      changed();
    }
  };
  const signOut = (): Promise<ChatgptSignOutResult> => revokeAndForget(false);

  const listModels = async (): Promise<ListModelsResult> => {
    // The token a 401 came back for is refreshed once, then the list is asked for again.
    const request = async (token: string): Promise<{ readonly outcome: HttpOutcome; readonly token: string }> => ({
      outcome: await send(deps.fetch, endpoints.models, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, { timeoutMs: requestTimeoutMs, maxBytes: CHATGPT_LIMITS.maxModelListBytes }),
      token,
    });
    let result = await withAccessToken(request);
    if (result.ok && result.value.outcome.kind === 'answer' && result.value.outcome.status === 401) result = await withAccessToken(request, { rejected: result.value.token });
    if (!result.ok) return result;
    const outcome = result.value.outcome;
    if (outcome.kind === 'network') return { ok: false, reason: 'network' };
    if (outcome.status !== 200) {
      log(`agent chatgpt: the model list answered HTTP ${outcome.status}`);
      return { ok: false, reason: outcome.status >= 500 || outcome.status === 429 ? 'network' : 'failed' };
    }
    const document = parseJson(outcome.text);
    const entries = typeof document === 'object' && document !== null && Array.isArray((document as { models?: unknown }).models) ? ((document as { models: unknown[] }).models as unknown[]) : null;
    if (entries === null) {
      // Names only (never values): which shape came back instead of `{ models: [...] }`.
      const keys = typeof document === 'object' && document !== null ? Object.keys(document).slice(0, 8).filter((key) => /^[A-Za-z_]{1,32}$/.test(key)) : [];
      const why = outcome.text === null ? 'over the size limit' : document === undefined ? `not JSON (${outcome.text.length} chars)` : Array.isArray(document) ? 'an array' : `keys: ${keys.join(', ') || 'none'}`;
      log(`agent chatgpt: the model list had no models array (${why})`);
      return { ok: false, reason: 'failed' };
    }
    const models: ChatgptModelView[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (models.length >= CHATGPT_LIMITS.maxModels) break;
      const parsed = ChatgptModelEntrySchema.safeParse(entry);
      if (!parsed.success || parsed.data.visibility !== 'list' || seen.has(parsed.data.slug)) continue;
      const id = chatgptModelId(parsed.data.slug);
      if (id === null) continue;
      seen.add(parsed.data.slug);
      // The levels the entry advertises (Phase 8 Task 8b; already filtered by the schema), when any.
      models.push({ id, label: parsed.data.display_name.trim(), ...(parsed.data.efforts !== undefined ? { efforts: parsed.data.efforts } : {}) });
    }
    if (models.length === 0 && entries.length > 0) {
      const first = entries[0];
      const keys = typeof first === 'object' && first !== null ? Object.keys(first).slice(0, 12).filter((key) => /^[A-Za-z_]{1,32}$/.test(key)) : [];
      log(`agent chatgpt: none of the ${entries.length} listed models was kept (entry keys: ${keys.join(', ') || 'none'})`);
    }
    return { ok: true, models };
  };

  const view = (): ChatgptAccountView => {
    const error = lastError === null ? {} : { error: lastError };
    if (pending !== null) return { state: 'pending', acknowledged: state.acknowledged, ...error };
    const email = state.account?.email ?? null;
    if (state.tokens !== null) {
      return { state: 'signed-in', ...(email !== null ? { email } : {}), planUsage: planUsageOf(state.tokens.scopes), acknowledged: state.acknowledged, ...error };
    }
    if (state.expired) return { state: 'expired', ...(email !== null ? { email } : {}), acknowledged: state.acknowledged, ...error };
    return { state: 'signed-out', acknowledged: state.acknowledged, ...error };
  };

  return {
    load,
    view,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signIn,
    cancel() {
      const p = pending;
      if (p === null) return false;
      dropPending(p, 'cancelled');
      log('agent chatgpt: sign-in cancelled');
      return true;
    },
    signOut,
    async acknowledge() {
      await load();
      if (state.acknowledged) return true;
      const before = state;
      state = { ...state, acknowledged: true };
      if (!(await persist())) {
        state = before;
        return false;
      }
      changed();
      return true;
    },
    withAccessToken,
    listModels,
    async dispose() {
      disposed = true;
      if (pending) dropPending(pending, null);
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
