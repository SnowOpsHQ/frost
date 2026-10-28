import type { z } from 'zod';
import {
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_TOKEN_PATH,
  DesktopTokenResponseSchema,
  PKCE_METHOD,
  SESSION_PATH,
  SessionResponseSchema,
  SIGN_OUT_PATH,
  type DesktopTokenRequest,
  type DesktopTokenResponse,
  type SessionResponse,
} from '@app/specs/account-api.schema';
import { ACCOUNT_API_MAX_BODY_BYTES, ACCOUNT_API_TIMEOUT_MS } from '@app/specs/account-state.schema';
import { ENTITLEMENTS_PATH, EntitlementsResponseSchema, type EntitlementsResponse } from '@app/specs/entitlements-snapshot.spec';

// The account backend as main calls it (spec `account-api.schema.ts`; acceptance
// `account-signin.feature.md`, API client; plan Global Constraint "Outbound calls"). No Electron import:
// main injects `net.fetch`. Every call: `credentials: 'omit'` (no cookie jar), `cache: 'no-store'`,
// `redirect: 'error'` (a token endpoint is never followed elsewhere), a timeout, a capped body, and a
// Zod-validated answer. Failures are reported by kind only, never with a body, a URL or a token.

/**
 * - `network`: no answer (refused, DNS, TLS, timeout), 408, 429 or a 5xx: try again later.
 * - `auth`: 401: the credential is not accepted.
 * - `invalid`: any other answer: another status, or a body that is not the expected JSON.
 */
export type ApiFailure = 'network' | 'auth' | 'invalid';
export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ApiFailure };

/** What the client uses of `net.fetch` (Electron) / `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExchangeRequest {
  readonly code: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface AccountApi {
  /** `POST DESKTOP_TOKEN_PATH`: the code and its PKCE verifier for a desktop token. */
  exchange(request: ExchangeRequest): Promise<ApiResult<DesktopTokenResponse>>;
  /** `GET SESSION_PATH` with the token. */
  session(token: string): Promise<ApiResult<SessionResponse>>;
  /** `GET ENTITLEMENTS_PATH` with the token: the signed snapshot (it stays in main). */
  entitlements(token: string): Promise<ApiResult<EntitlementsResponse>>;
  /** `POST SIGN_OUT_PATH` with the token: revokes it (204). */
  signOut(token: string): Promise<ApiResult<null>>;
}

/** The authorize page for one request: `DESKTOP_AUTHORIZE_PATH` with exactly the four parameters. */
export function authorizeUrl(apiBase: string, request: { readonly redirectUri: string; readonly state: string; readonly challenge: string }): string {
  const query = new URLSearchParams({
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: PKCE_METHOD,
  });
  return `${apiBase}${DESKTOP_AUTHORIZE_PATH}?${query.toString()}`;
}

const fail = (failure: ApiFailure): ApiResult<never> => ({ ok: false, failure });

function failureOf(status: number): ApiFailure {
  if (status === 401) return 'auth';
  if (status === 408 || status === 429 || status >= 500) return 'network';
  return 'invalid';
}

/** The body as text, or `null` when it is longer than `ACCOUNT_API_MAX_BODY_BYTES`. */
async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ACCOUNT_API_MAX_BODY_BYTES) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ACCOUNT_API_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface CreateAccountApiOptions {
  /** The API origin (`AccountConfig.apiBase`). */
  readonly apiBase: string;
  readonly fetch: FetchLike;
  /** Defaults to `ACCOUNT_API_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export function createAccountApi(options: CreateAccountApiOptions): AccountApi {
  const { apiBase, fetch } = options;
  const timeoutMs = options.timeoutMs ?? ACCOUNT_API_TIMEOUT_MS;

  /** One call; `schema` `null` expects an empty 2xx answer. */
  async function call<S extends z.ZodType>(method: 'GET' | 'POST', path: string, init: { token?: string; json?: unknown }, schema: S | null): Promise<ApiResult<z.infer<S> | null>> {
    const headers = new Headers({ Accept: 'application/json' });
    if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`);
    if (init.json !== undefined) headers.set('Content-Type', 'application/json');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase}${path}`, {
          method,
          headers,
          body: init.json === undefined ? null : JSON.stringify(init.json),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return fail('network');
      }
      if (response.status < 200 || response.status > 299) {
        await response.body?.cancel().catch(() => undefined);
        return fail(failureOf(response.status));
      }
      let text: string | null;
      try {
        text = await readCapped(response);
      } catch {
        return fail(controller.signal.aborted ? 'network' : 'invalid');
      }
      if (text === null) return fail('invalid');
      if (schema === null) return { ok: true, value: null };
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail('invalid');
      }
      const parsed = schema.safeParse(body);
      return parsed.success ? { ok: true, value: parsed.data } : fail('invalid');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    exchange: async ({ code, verifier, redirectUri }) => {
      const body: DesktopTokenRequest = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri };
      return (await call('POST', DESKTOP_TOKEN_PATH, { json: body }, DesktopTokenResponseSchema)) as ApiResult<DesktopTokenResponse>;
    },
    session: async (token) => (await call('GET', SESSION_PATH, { token }, SessionResponseSchema)) as ApiResult<SessionResponse>,
    entitlements: async (token) => (await call('GET', ENTITLEMENTS_PATH, { token }, EntitlementsResponseSchema)) as ApiResult<EntitlementsResponse>,
    signOut: async (token) => (await call('POST', SIGN_OUT_PATH, { token }, null)) as ApiResult<null>,
  };
}
