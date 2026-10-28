import { z } from 'zod';
import type { AccountService } from '@app/ipc-contract';
import { AccountUserSchema, DESKTOP_CODE_PATTERN, DESKTOP_TOKEN_PATTERN, type AccountUser } from '@app/specs/account-api.schema';
import {
  ACCOUNT_REFRESH_INTERVAL_MS,
  CONFIRM_TIMEOUT_MS,
  MAX_PENDING_ACCOUNT_WATCHES,
  type AccountError,
  type AccountState,
  type AccountStatus,
  type SignInResult,
} from '@app/specs/account-state.schema';
import { NO_ENTITLEMENTS, type Entitlements } from '@app/specs/entitlements-snapshot.spec';
import type { SecretName } from '@app/specs/secret-store.spec';
import { authorizeUrl, type AccountApi, type ApiFailure } from './api-client';
import type { AccountConfig } from './config';
import type { EntitlementsController } from './entitlements';
import type { Loopback, LoopbackCallback, StartLoopbackOptions } from './loopback';
import { createSignInRequest, type SignInRequest } from './pkce';
import type { SecretStore } from './secret-store';

// The desktop sign-in flow and the account (spec `account-state.schema.ts`; acceptance
// `account-signin.feature.md`, The flow; review focus "A website or another app cannot sign the user in
// to someone else's account" and "The renderer never sees a token"). No Electron import: main injects
// the gesture check, the browser opener, the window focus, the loopback, the API and the stores.
//
// 1. `signIn(windowId)` needs a live gesture in that window; it makes a request (ID, `state`, PKCE),
//    starts the loopback with its `state` and opens the authorize page (`awaiting-browser`, with the
//    fingerprint the page shows). One request at a time: a new one replaces (and revokes) the old.
// 2. The callback's code is exchanged with the verifier (the token kept in memory only), and the
//    session names the account: `confirming`, and the window that asked is focused.
// 3. `confirmSignIn(windowId, requestId)` (from the window that started it, with a live gesture
//    there) stores the token (`account` blob) and fetches entitlements:
//    `signed-in`. `cancelSignIn` drops the request and revokes its token. Nothing is stored or used
//    before the confirmation: `entitlements()` is `none` unless signed in.
// 4. Refresh at start, every `ACCOUNT_REFRESH_INTERVAL_MS` and on `refresh()`: 401 signs out
//    (`session-ended`), a network failure keeps grace, a bad snapshot is `invalid` (free).
//
// Logs: fixed messages through `redact`, which also replaces any token, JWS, email or code/state
// query value that might reach it.

/** The secret blob the account (token, its expiry, the user) lives in. */
export const ACCOUNT_SECRET: SecretName = 'account';

/** The stored account (version 1). Strict: anything else is discarded. */
const StoredAccountSchema = z.strictObject({
  v: z.literal(1),
  token: z.string().regex(DESKTOP_TOKEN_PATTERN),
  expiresAt: z.int().positive(),
  user: AccountUserSchema.strict(),
});
type StoredAccount = z.infer<typeof StoredAccountSchema>;

export interface AccountServiceDeps {
  /** `null`: unconfigured; nothing is sent anywhere. */
  readonly config: AccountConfig | null;
  /** `null` exactly when `config` is. */
  readonly api: AccountApi | null;
  readonly store: Pick<SecretStore, 'persistent' | 'read' | 'write' | 'delete'>;
  /** `null` when unconfigured. */
  readonly entitlements: EntitlementsController | null;
  readonly startLoopback: (options: StartLoopbackOptions) => Promise<Loopback>;
  /** Opens `url` in the system browser: main passes `openExternalIfAllowed` (scheme allowlist, given the gesture verdict). */
  readonly openInBrowser: (url: string, userGesture: boolean) => boolean;
  /** Spends window `windowId`'s live user gesture (`createWindowGestures().consume`). */
  readonly consumeGesture: (windowId: number) => boolean;
  /** Brings window `windowId` to the front (the confirmation is there). */
  readonly focusWindow: (windowId: number) => void;
  /** Receives redacted, fixed messages only. */
  readonly log: (message: string) => void;
  /** Epoch ms; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Main's account service: the IPC `AccountService` plus what main and tests drive. */
export interface AccountMainService extends AccountService {
  /**
   * The signed-in (confirmed) account's user ID, or `null` (signed out, or a sign-in not confirmed
   * yet). Main only: never part of an IPC answer. Search Console binds its connection to it.
   */
  userId(): string | null;
  /** Calls `listener` after every change of the state (with the watchers). Answers the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Resolves once no exchange, refresh or revocation started so far is still running. */
  whenIdle(): Promise<void>;
  /**
   * Stops the refresh timer, drops a pending sign-in (revoking a token it exchanged) and releases
   * watchers. Answers the revocations still running (to hold the quit for, bounded), or `null`.
   */
  dispose(): Promise<void> | null;
}

// ---- Redaction ----------------------------------------------------------------------------------

const REDACTIONS: readonly RegExp[] = [
  /frost_dt_[A-Za-z0-9_-]*/g,
  /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}/g,
  /[^\s@"'<>]+@[^\s@"'<>]+/g,
  /\b(code|state|code_verifier|token|access_token|refresh_token)=[^&\s"']*/gi,
  /\bBearer\s+\S+/gi,
];

/** Replaces token-, snapshot-, email- and code-shaped values in `message`. */
export function redact(message: string): string {
  let out = message;
  for (const pattern of REDACTIONS) out = out.replace(pattern, '[redacted]');
  return out;
}

// ---- The service --------------------------------------------------------------------------------

interface Exchanged {
  readonly token: string;
  readonly expiresAt: number;
  readonly user: AccountUser;
}

interface Pending {
  readonly request: SignInRequest;
  readonly windowId: number;
  phase: 'awaiting' | 'exchanging' | 'confirming';
  loopback: Loopback | null;
  exchanged: Exchanged | null;
  confirmTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Waiter {
  readonly since: number;
  readonly resolve: (state: AccountState) => void;
}

const errorOfFailure = (failure: ApiFailure): AccountError => (failure === 'network' ? 'network' : 'exchange-failed');

export function createAccountService(deps: AccountServiceDeps): AccountMainService {
  const { config, api, store, entitlements } = deps;
  const now = deps.now ?? (() => Date.now());
  /** Secrets seen in this run, scrubbed from every message as a second line of defence. */
  const known = new Set<string>();
  const remember = (...values: string[]): void => {
    for (const value of values) if (value.length >= 6) known.add(value);
    while (known.size > 64) known.delete(known.values().next().value as string);
  };
  const log = (message: string): void => {
    let out = message;
    for (const secret of known) out = out.split(secret).join('[redacted]');
    deps.log(redact(out));
  };

  let account: StoredAccount | null = null;
  let pending: Pending | null = null;
  let error: AccountError | null = null;
  let version = 0;
  let disposed = false;
  const waiters: Waiter[] = [];
  const listeners = new Set<() => void>();
  const inflight = new Set<Promise<unknown>>();
  /** Revocations still running (a quit waits for them, bounded). */
  const revoking = new Set<Promise<void>>();
  /** The refresh running, for the account (token) it runs for: never handed to another account. */
  let refreshing: { readonly token: string; readonly run: Promise<boolean> } | null = null;

  const track = <T>(work: Promise<T>): Promise<T> => {
    inflight.add(work);
    void work.finally(() => inflight.delete(work)).catch(() => undefined);
    return work;
  };

  const status = (): AccountStatus => {
    if (config === null) return 'unconfigured';
    if (pending) return pending.phase === 'confirming' ? 'confirming' : 'awaiting-browser';
    return account ? 'signed-in' : 'signed-out';
  };

  /** Entitlements count only for a confirmed account (fails closed otherwise). */
  const currentEntitlements = (): Entitlements =>
    status() === 'signed-in' && entitlements ? entitlements.current() : { ...NO_ENTITLEMENTS, features: [] };

  const state = (): AccountState => {
    const s = status();
    const user = s === 'confirming' ? pending?.exchanged?.user : s === 'signed-in' ? account?.user : undefined;
    const showsRequest = s === 'awaiting-browser' || s === 'confirming';
    const ents = currentEntitlements();
    return {
      status: s,
      user: user ? { email: user.email, name: user.name } : null,
      entitlements: ents,
      keychain: store.persistent ? 'persistent' : 'memory-only',
      requestId: showsRequest ? (pending?.request.requestId ?? null) : null,
      fingerprint: showsRequest ? (pending?.request.fingerprint ?? null) : null,
      error,
      version,
    };
  };

  /** A change: the version goes up and watchers are answered (after the current call stack). */
  const bump = (): void => {
    version++;
    queueMicrotask(() => {
      const current = state();
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i]!;
        if (current.version > waiter.since) {
          waiters.splice(i, 1);
          waiter.resolve(current);
        }
      }
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          log('account: a change listener failed');
        }
      }
    });
  };

  const revoke = (token: string): Promise<void> => {
    if (!api) return Promise.resolve();
    const run = api.signOut(token).then(
      (result) => {
        if (!result.ok) log(`account: revoking a token failed (${result.failure})`);
      },
      () => log('account: revoking a token failed'),
    );
    revoking.add(run);
    void run.finally(() => revoking.delete(run));
    return track(run);
  };

  /** Ends `p` if it is still the pending request. A token it exchanged is revoked. */
  const dropPending = (p: Pending, why: AccountError | null, options: { closeListener: boolean }): boolean => {
    if (pending !== p) return false;
    pending = null;
    clearTimeout(p.confirmTimer);
    if (options.closeListener) p.loopback?.close();
    if (p.exchanged) void revoke(p.exchanged.token);
    error = why;
    bump();
    return true;
  };

  const writeAccount = (value: StoredAccount): void => {
    store.write(ACCOUNT_SECRET, JSON.stringify(value));
  };

  /** The backend no longer accepts the token (or it expired): signed out, nothing kept. */
  const endSession = (acc: StoredAccount): void => {
    if (account?.token !== acc.token) return;
    account = null;
    refreshing = null;
    store.delete(ACCOUNT_SECRET);
    entitlements?.markRefreshFailed('auth');
    error = 'session-ended';
    log('account: the session ended; signed out');
    bump();
  };

  // ---- The callback and the exchange ----------------------------------------------------------

  const onCallback = async (p: Pending, callback: LoopbackCallback): Promise<void> => {
    if (pending !== p || p.phase !== 'awaiting' || !api) {
      log('account: a callback for no pending sign-in was ignored');
      return;
    }
    if (callback.error !== null || callback.code === null) {
      log('account: the browser reported the sign-in as cancelled');
      dropPending(p, 'cancelled', { closeListener: false });
      return;
    }
    const code = callback.code;
    remember(code);
    if (!DESKTOP_CODE_PATTERN.test(code)) {
      log('account: the callback carried no usable code');
      dropPending(p, 'exchange-failed', { closeListener: false });
      return;
    }
    p.phase = 'exchanging';
    const exchanged = await api.exchange({ code, verifier: p.request.verifier, redirectUri: p.loopback?.redirectUri ?? '' });
    if (exchanged.ok) remember(exchanged.value.token, exchanged.value.user.email);
    if (pending !== p) {
      // Replaced or cancelled while exchanging: the token it got is not kept.
      if (exchanged.ok) void revoke(exchanged.value.token);
      return;
    }
    if (!exchanged.ok) {
      log(`account: the code exchange failed (${exchanged.failure})`);
      dropPending(p, errorOfFailure(exchanged.failure), { closeListener: false });
      return;
    }
    p.exchanged = exchanged.value;
    const session = await api.session(exchanged.value.token);
    if (pending !== p) return; // Dropped meanwhile: the drop revoked the token.
    if (!session.ok) {
      log(`account: reading the new session failed (${session.failure})`);
      dropPending(p, errorOfFailure(session.failure), { closeListener: false });
      return;
    }
    if (session.value.user.id !== exchanged.value.user.id) {
      log('account: the session names another account than the exchange; refused');
      dropPending(p, 'exchange-failed', { closeListener: false });
      return;
    }
    remember(session.value.user.email);
    p.exchanged = { ...exchanged.value, user: session.value.user };
    p.phase = 'confirming';
    p.confirmTimer = setTimeout(() => {
      if (dropPending(p, 'timed-out', { closeListener: true })) log('account: the sign-in was not confirmed in time');
    }, CONFIRM_TIMEOUT_MS);
    (p.confirmTimer as { unref?: () => void }).unref?.();
    log('account: waiting for the in-app confirmation');
    bump();
    deps.focusWindow(p.windowId);
  };

  // ---- Refresh --------------------------------------------------------------------------------

  const doRefresh = async (acc: StoredAccount): Promise<boolean> => {
    if (!api || !entitlements) return false;
    if (acc.expiresAt <= now()) {
      endSession(acc);
      return true;
    }
    const session = await api.session(acc.token);
    if (account?.token !== acc.token) return true;
    if (!session.ok && session.failure === 'auth') {
      endSession(acc);
      return true;
    }
    if (!session.ok && session.failure === 'network') {
      log('account: refresh could not reach the backend');
      entitlements.markRefreshFailed('network');
      return true;
    }
    if (session.ok) {
      const user = session.value.user;
      if (user.id !== acc.user.id) {
        // The token speaks for another account than the one confirmed: not used.
        endSession(acc);
        return true;
      }
      remember(user.email);
      if (user.email !== acc.user.email || user.name !== acc.user.name) {
        account = { ...acc, user };
        writeAccount(account);
        bump();
      }
    }
    const answer = await api.entitlements(acc.token);
    if (account?.token !== acc.token) return true;
    if (answer.ok) {
      remember(answer.value.snapshot);
      await entitlements.update(answer.value.snapshot, acc.user.id);
      return true;
    }
    log(`account: refreshing entitlements failed (${answer.failure})`);
    if (answer.failure === 'auth') endSession(acc);
    else entitlements.markRefreshFailed(answer.failure);
    return true;
  };

  const refresh = (): Promise<boolean> => {
    const acc = account;
    if (!acc || config === null) return Promise.resolve(false);
    if (refreshing?.token === acc.token) return refreshing.run;
    const run = doRefresh(acc)
      .catch(() => {
        log('account: refresh failed unexpectedly');
        return true;
      })
      .finally(() => {
        if (refreshing?.run === run) refreshing = null;
      });
    refreshing = { token: acc.token, run };
    return track(run);
  };

  // ---- Start ----------------------------------------------------------------------------------

  if (config !== null) {
    const text = store.read(ACCOUNT_SECRET);
    if (text !== null) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        value = undefined;
      }
      const parsed = StoredAccountSchema.safeParse(value);
      if (!parsed.success) {
        log('account: the stored account is unreadable; discarded');
        store.delete(ACCOUNT_SECRET);
      } else if (parsed.data.expiresAt <= now()) {
        log('account: the stored account expired; discarded');
        store.delete(ACCOUNT_SECRET);
      } else {
        account = parsed.data;
        remember(account.token, account.user.email);
      }
    }
    // A snapshot held without an account (left behind) is dropped, so nothing is entitled by it.
    if (!account && entitlements && entitlements.current().status !== 'none') entitlements.clear();
  }
  const unsubscribe = entitlements?.onChange(() => {
    if (account && !pending) bump();
  });
  const interval = config === null ? undefined : setInterval(() => void refresh(), ACCOUNT_REFRESH_INTERVAL_MS);
  (interval as { unref?: () => void } | undefined)?.unref?.();
  if (account) void refresh();

  // ---- The service ----------------------------------------------------------------------------

  return {
    entitlements: currentEntitlements,
    state,
    userId: () => (status() === 'signed-in' ? (account?.user.id ?? null) : null),
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    watch(sinceVersion, signal) {
      const current = state();
      if (current.version > sinceVersion || disposed) return Promise.resolve(current);
      return new Promise<AccountState>((resolve) => {
        const waiter: Waiter = { since: sinceVersion, resolve };
        waiters.push(waiter);
        if (waiters.length > MAX_PENDING_ACCOUNT_WATCHES) waiters.shift()?.resolve(state());
        signal?.addEventListener(
          'abort',
          () => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            resolve(state());
          },
          { once: true },
        );
      });
    },

    async signIn(windowId): Promise<SignInResult> {
      if (config === null || !api || disposed) return 'unconfigured';
      if (account) return 'already-signed-in';
      if (!deps.consumeGesture(windowId)) {
        log('account: sign-in refused without a user gesture');
        return 'needs-gesture';
      }
      if (pending) dropPending(pending, null, { closeListener: true });
      const request = createSignInRequest();
      remember(request.state, request.verifier);
      const p: Pending = { request, windowId, phase: 'awaiting', loopback: null, exchanged: null, confirmTimer: undefined };
      pending = p;
      error = null;
      bump();
      let loopback: Loopback;
      try {
        loopback = await deps.startLoopback({
          state: request.state,
          onCallback: (callback) => void track(onCallback(p, callback)),
          onTimeout: () => {
            if (pending === p && p.phase === 'awaiting' && dropPending(p, 'timed-out', { closeListener: true })) log('account: no answer from the browser in time');
          },
        });
      } catch {
        log('account: the sign-in listener could not start');
        dropPending(p, 'browser-failed', { closeListener: false });
        return 'browser-failed';
      }
      if (pending !== p) {
        // Replaced while the listener started.
        loopback.close();
        return 'started';
      }
      p.loopback = loopback;
      const url = authorizeUrl(config.apiBase, { redirectUri: loopback.redirectUri, state: request.state, challenge: request.challenge });
      // The gesture was spent above, on this window's request.
      if (!deps.openInBrowser(url, true)) {
        log('account: the system browser could not be opened');
        dropPending(p, 'browser-failed', { closeListener: true });
        return 'browser-failed';
      }
      log('account: sign-in started');
      return 'started';
    },

    async confirmSignIn(windowId, requestId) {
      const p = pending;
      if (!p || p.request.requestId !== requestId || p.phase !== 'confirming' || !p.exchanged) return false;
      // Only the window that started the request, on a live user gesture there.
      if (windowId !== p.windowId) {
        log('account: a confirmation from another window was refused');
        return false;
      }
      if (!deps.consumeGesture(windowId)) {
        log('account: a confirmation without a user gesture was refused');
        return false;
      }
      clearTimeout(p.confirmTimer);
      pending = null;
      const { token, expiresAt, user } = p.exchanged;
      account = { v: 1, token, expiresAt, user };
      writeAccount(account);
      error = null;
      log(store.persistent ? 'account: signed in' : 'account: signed in for this run only (no keychain)');
      bump();
      await refresh();
      return true;
    },

    async cancelSignIn(requestId) {
      const p = pending;
      if (!p || p.request.requestId !== requestId) return false;
      const token = p.exchanged?.token;
      dropPending(p, null, { closeListener: true });
      log('account: sign-in cancelled');
      if (token) await Promise.all([...inflight]).catch(() => undefined);
      return true;
    },

    async signOut() {
      if (pending) dropPending(pending, null, { closeListener: true });
      const acc = account;
      if (!acc) return false;
      account = null;
      refreshing = null;
      store.delete(ACCOUNT_SECRET);
      entitlements?.clear();
      error = null;
      log('account: signed out');
      bump();
      await revoke(acc.token);
      return true;
    },

    refresh,

    async whenIdle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    dispose() {
      disposed = true;
      clearInterval(interval);
      unsubscribe?.();
      if (pending) dropPending(pending, null, { closeListener: true });
      for (const waiter of waiters.splice(0)) waiter.resolve(state());
      listeners.clear();
      return revoking.size === 0 ? null : Promise.allSettled([...revoking]).then(() => undefined);
    },
  };
}
