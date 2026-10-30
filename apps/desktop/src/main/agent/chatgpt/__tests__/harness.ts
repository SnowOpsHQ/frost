// A fake ChatGPT auth server, browser and clock for the ChatGPT service's tests (not a test file
// itself). Spec: specs/agent-chatgpt.spec.ts (CHATGPT_ENDPOINTS, CHATGPT_ISSUER). The server answers
// the token, revocation, JWKS and model-list endpoints from scripts; the "browser" follows the
// authorize URL main opened by sending the redirect to main's real loopback listener. No request
// leaves the machine.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { request } from 'node:http';
import { expect, vi } from 'vitest';
import { CHATGPT_ENDPOINTS, CHATGPT_ISSUER, CHATGPT_SCOPE } from '@app/specs/agent-chatgpt.spec';
import { startLoopback, type Loopback } from '../../../account/loopback';
import { createFakeSafeStorage, createMemoryFs } from '../../__tests__/fakes';
import { createHostIdStore } from '../host-id';
import { createChatgptAuth, type ChatgptAuthDeps } from '../service';
import { createChatgptStore, type ChatgptStore } from '../store';

export const T0 = Date.parse('2026-10-29T12:00:00Z');
export const CLIENT_ID = 'oaiapp_TestClient-0123456789';
export const SUB = 'user-sub-0123456789';
export const EMAIL = 'ada@example.com';
export const CREDENTIALS_FILE = '/user-data/agent-chatgpt-credentials.json';
export const HOST_FILE = '/user-data/agent-chatgpt-host.json';
export const HOST_UUID = '3f1c2a9e-8b7d-4c6e-9f1a-0b2c3d4e5f60';

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

export function makeKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}

/** Generated once per test file (RSA key generation is slow). */
export const KEY = makeKey('key-1');
export const OTHER_KEY = makeKey('key-2');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A signed RS256 JWT with `claims`. */
export function signJwt(claims: Record<string, unknown>, key: SigningKey = KEY, header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }): string {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${sign('sha256', Buffer.from(head), key.privateKey).toString('base64url')}`;
}

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly form: URLSearchParams | null;
  readonly headers: Record<string, string>;
  readonly init: RequestInit;
}

type TokenScript = (form: URLSearchParams, n: number) => Response | Promise<Response>;

const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export function createHarness(options: { protection?: 'os' | 'weak' | 'unavailable' } = {}) {
  const clock = { now: T0 };
  const events: string[] = [];
  const logs: string[] = [];
  const recorded: Recorded[] = [];
  const opened: string[] = [];
  /** The user-gesture flag each browser open was given. */
  const gestures: boolean[] = [];
  /** The windows a successful sign-in brought to the front. */
  const focused: number[] = [];
  const loopbacks: Loopback[] = [];
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage({ available: options.protection !== 'unavailable', weak: options.protection === 'weak' });
  let issued = 0;
  /** Every ID token the server issued (to check none leaks). */
  const idTokens: string[] = [];
  /** The last sign-in's nonce (read from the authorize URL), signed into the next ID token. */
  let nonce = '';

  const server = {
    /** Claims (merged over the defaults) for the next ID tokens. */
    claims: {} as Record<string, unknown>,
    key: KEY,
    scope: CHATGPT_SCOPE as string | undefined,
    expiresIn: 3600,
    earliestRefreshAt: undefined as number | string | undefined,
    /** Overrides the token endpoint's answer (`n`: the token request's number, from 1). */
    token: null as TokenScript | null,
    revokeStatus: [200] as number[],
    models: { models: [] as unknown[] } as unknown,
    modelsStatus: [] as number[],
    jwks: () => ({ keys: [server.key.jwk] }),
    tokenRequests: 0,
  };

  const idToken = (extra: Record<string, unknown> = {}) => {
    const token = signJwt({ iss: CHATGPT_ISSUER, sub: SUB, aud: [CLIENT_ID], nonce, iat: Math.floor(clock.now / 1000), exp: Math.floor(clock.now / 1000) + 3600, email: EMAIL, ...server.claims, ...extra }, server.key);
    idTokens.push(token);
    return token;
  };

  const tokenAnswer = (withIdToken: boolean, extra: Record<string, unknown> = {}) => {
    issued += 1;
    return json(200, {
      access_token: `access-token-${issued}`,
      refresh_token: `refresh-token-${issued}`,
      ...(withIdToken ? { id_token: idToken() } : {}),
      token_type: 'Bearer',
      expires_in: server.expiresIn,
      ...(server.scope !== undefined ? { scope: server.scope } : {}),
      ...(server.earliestRefreshAt !== undefined ? { earliest_refresh_at: server.earliestRefreshAt } : {}),
      ...extra,
    });
  };

  const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const form = typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    recorded.push({ url, method: init.method ?? 'GET', form, headers, init });
    switch (url) {
      case CHATGPT_ENDPOINTS.token: {
        server.tokenRequests += 1;
        events.push(`token ${form?.get('grant_type')}`);
        if (server.token) return server.token(form!, server.tokenRequests);
        return tokenAnswer(form?.get('grant_type') === 'authorization_code');
      }
      case CHATGPT_ENDPOINTS.revoke: {
        events.push('revoke');
        const status = server.revokeStatus.length > 1 ? server.revokeStatus.shift()! : server.revokeStatus[0]!;
        if (status === 0) throw new TypeError('network');
        return new Response('', { status });
      }
      case CHATGPT_ENDPOINTS.jwks:
        events.push('jwks');
        return json(200, server.jwks());
      case CHATGPT_ENDPOINTS.models: {
        events.push('models');
        const status = server.modelsStatus.shift() ?? 200;
        return json(status, status === 200 ? server.models : { error: { code: 'invalid_token' } });
      }
      default:
        throw new TypeError(`unexpected request to ${url}`);
    }
  });

  const realStore = createChatgptStore({ safeStorage: safe.storage, fs: memory.fs, file: CREDENTIALS_FILE, platform: 'linux', tempSuffix: () => `t${Math.random().toString(36).slice(2)}` });
  const store: ChatgptStore = {
    protection: () => realStore.protection(),
    read: () => realStore.read(),
    async write(state) {
      const ok = await realStore.write(state);
      events.push(`store ${state.clientId ?? '-'} ${state.tokens === null ? 'no-tokens' : state.tokens.refreshToken}`);
      return ok;
    },
    clear: () => realStore.clear(),
  };

  const hostId = createHostIdStore({ fs: memory.fs, file: HOST_FILE, randomUUID: () => HOST_UUID, tempSuffix: () => 'host' });
  const hostIdTracked = {
    async get() {
      const value = await hostId.get();
      events.push('host-id');
      return value;
    },
  };

  const deps: ChatgptAuthDeps = {
    fetch,
    now: () => clock.now,
    store,
    hostId: hostIdTracked,
    startLoopback: async (loopbackOptions) => {
      const loopback = await startLoopback({ ...loopbackOptions, doneLingerMs: 20 });
      loopbacks.push(loopback);
      return loopback;
    },
    openExternal: (url, userGesture) => {
      events.push('browser');
      opened.push(url);
      gestures.push(userGesture);
      nonce = new URL(url).searchParams.get('nonce') ?? '';
      return true;
    },
    focusWindow: (windowId) => void focused.push(windowId),
    log: (line) => void logs.push(line),
    delay: async () => undefined,
  };

  const auth = createChatgptAuth(deps);

  /** The browser's redirect to main's listener for the last authorize URL: `params` replace the defaults. */
  async function redirect(params: Record<string, string | null> = {}): Promise<number> {
    const url = new URL(opened.at(-1)!);
    const redirectUri = new URL(url.searchParams.get('redirect_uri')!);
    const query = new URLSearchParams();
    const values: Record<string, string | null> = { code: 'auth-code-0123456789', state: url.searchParams.get('state'), scope: CHATGPT_SCOPE, client_id: CLIENT_ID, ...params };
    for (const [name, value] of Object.entries(values)) if (value !== null) query.set(name, value);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: Number(redirectUri.port), path: `${redirectUri.pathname}?${query.toString()}`, headers: { Host: redirectUri.host, Connection: 'close' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** Waits until `check` holds (the sign-in finishes on the listener's callback, asynchronously). */
  async function until(check: () => boolean, what = 'condition'): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`harness: timed out waiting for ${what}`);
  }

  /** Signs in end to end (first registration unless a client id is stored). */
  async function signIn(params: Record<string, string | null> = {}, signInOptions: { reconsent?: boolean; differentAccount?: boolean; userGesture?: boolean; windowId?: number } = {}) {
    expect(await auth.signIn(signInOptions)).toBe('started');
    expect(await redirect(params)).toBe(303);
    await until(() => auth.view().state !== 'pending', 'the sign-in to finish');
    return auth.view();
  }

  async function close() {
    for (const loopback of loopbacks.splice(0)) {
      loopback.close();
      await loopback.closed;
    }
  }

  return { auth, deps, server, fetch, recorded, opened, gestures, focused, events, logs, memory, safe, store, realStore, clock, redirect, until, signIn, close, idToken, tokenAnswer, json, idTokens, nonce: () => nonce };
}
