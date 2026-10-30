import { CHATGPT_AGENT_NAME, CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_RESOURCE, CHATGPT_SCOPE, type ChatgptEndpoints } from '@app/specs/agent-chatgpt.spec';
import { ChatgptTokenAnswerSchema, ChatgptTokenErrorSchema, type ChatgptTokenAnswer } from '@app/specs/agent-chatgpt.schema';
import { parseJson, send, type FetchLike, type HttpOptions } from './http';

// The ChatGPT sign-in's OAuth requests (plan `docs/plans/agent-chatgpt-plan.md`, Protocol; spec
// `agent-chatgpt.spec.ts`; acceptance `agent-chatgpt.feature.md`, Sign-in and Tokens): the
// authorize URL, the code exchange, the refresh and the revocation, each exactly as the protocol
// names it. A public client: no secret. Pure request building plus one `send` each; the service
// decides what to do with the answers. Nothing here logs.

export interface AuthorizeRequest {
  /** The issued client id, or `null` for a first registration (`dynamic_agent_client` and the name hint then). */
  readonly clientId: string | null;
  /** `ext_agent_host_id`. */
  readonly hostId: string;
  /** `http://127.0.0.1:<port>/auth/callback`: the same string in the code exchange. */
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  /** The S256 PKCE challenge. */
  readonly challenge: string;
  /** Show the consent screen again (`prompt=consent`), to turn plan usage on after it was declined. */
  readonly reconsent?: boolean;
}

/** The authorize page's URL (opened in the system browser; never fetched by frost). */
export function authorizeUrl(endpoints: Pick<ChatgptEndpoints, 'authorize'>, request: AuthorizeRequest): string {
  const query = new URLSearchParams();
  query.set('response_type', 'code');
  query.set('client_id', request.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID);
  if (request.clientId === null) query.set('agent_name_hint', CHATGPT_AGENT_NAME);
  query.set('ext_agent_host_id', request.hostId);
  query.set('redirect_uri', request.redirectUri);
  query.set('scope', CHATGPT_SCOPE);
  query.set('resource', CHATGPT_RESOURCE);
  query.set('state', request.state);
  query.set('nonce', request.nonce);
  query.set('code_challenge', request.challenge);
  query.set('code_challenge_method', 'S256');
  if (request.reconsent === true) query.set('prompt', 'consent');
  return `${endpoints.authorize}?${query.toString()}`;
}

/**
 * The token endpoint's answer:
 * - `ok`: a usable token answer (parsed; unknown fields dropped);
 * - `refused`: an OAuth error answer (`error` is its code, e.g. `invalid_grant`);
 * - `network`: no answer, a `5xx`, `408` or `429` (worth trying again later);
 * - `invalid`: any other answer (unparsable, the wrong shape, an unexpected status).
 */
export type GrantOutcome =
  | { readonly ok: true; readonly answer: ChatgptTokenAnswer }
  | { readonly ok: false; readonly failure: 'refused'; readonly error: string }
  | { readonly ok: false; readonly failure: 'network' | 'invalid' };

export interface ChatgptHttp {
  readonly fetch: FetchLike;
  readonly options?: HttpOptions;
}

async function grant(http: ChatgptHttp, endpoints: Pick<ChatgptEndpoints, 'token'>, form: URLSearchParams): Promise<GrantOutcome> {
  const outcome = await send(http.fetch, endpoints.token, { method: 'POST', headers: {}, form }, http.options);
  if (outcome.kind === 'network') return { ok: false, failure: 'network' };
  const { status, text } = outcome;
  if (status === 200) {
    const parsed = ChatgptTokenAnswerSchema.safeParse(parseJson(text));
    return parsed.success ? { ok: true, answer: parsed.data } : { ok: false, failure: 'invalid' };
  }
  if (status === 408 || status === 429 || status >= 500) return { ok: false, failure: 'network' };
  const refusal = ChatgptTokenErrorSchema.safeParse(parseJson(text));
  return refusal.success ? { ok: false, failure: 'refused', error: refusal.data.error } : { ok: false, failure: 'invalid' };
}

/** `grant_type=authorization_code` with the issued client id, the code, the verifier, the same redirect and the resource. */
export function exchangeCode(
  http: ChatgptHttp,
  endpoints: Pick<ChatgptEndpoints, 'token'>,
  request: { readonly clientId: string; readonly code: string; readonly verifier: string; readonly redirectUri: string },
): Promise<GrantOutcome> {
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('client_id', request.clientId);
  form.set('code', request.code);
  form.set('code_verifier', request.verifier);
  form.set('redirect_uri', request.redirectUri);
  form.set('resource', CHATGPT_RESOURCE);
  return grant(http, endpoints, form);
}

/** `grant_type=refresh_token` with the issued client id, the refresh token and the resource (no `scope`: the grant is kept). */
export function refreshTokens(http: ChatgptHttp, endpoints: Pick<ChatgptEndpoints, 'token'>, request: { readonly clientId: string; readonly refreshToken: string }): Promise<GrantOutcome> {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', request.clientId);
  form.set('refresh_token', request.refreshToken);
  form.set('resource', CHATGPT_RESOURCE);
  return grant(http, endpoints, form);
}

/**
 * Revokes a refresh token (`token`, `token_type_hint=refresh_token`, `client_id`): `revoked` on a
 * `2xx` (also for a token already invalid), `retry` on no answer or a `5xx`, `refused` otherwise.
 */
export async function revokeRefreshToken(
  http: ChatgptHttp,
  endpoints: Pick<ChatgptEndpoints, 'revoke'>,
  request: { readonly clientId: string; readonly refreshToken: string },
): Promise<'revoked' | 'retry' | 'refused'> {
  const form = new URLSearchParams();
  form.set('token', request.refreshToken);
  form.set('token_type_hint', 'refresh_token');
  form.set('client_id', request.clientId);
  const outcome = await send(http.fetch, endpoints.revoke, { method: 'POST', headers: {}, form }, http.options);
  if (outcome.kind === 'network' || outcome.status >= 500 || outcome.status === 429 || outcome.status === 408) return 'retry';
  return outcome.status >= 200 && outcome.status <= 299 ? 'revoked' : 'refused';
}
