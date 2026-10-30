// Test-only: an in-process stand-in for Sign in with ChatGPT's auth server and the two OpenAI API
// endpoints the ChatGPT plan route reaches (`specs/agent-chatgpt.spec.ts`, `CHATGPT_ENDPOINTS`), on
// 127.0.0.1, for `agent-chatgpt.e2e.ts` through the unpackaged seam (`--frost-e2e-chatgpt=<file>`,
// `specs/agent-chatgpt-e2e.schema.ts`). Written from OpenAI's published protocol shapes; every key,
// token, code and client id is fake and made per run. No request leaves the machine.
//
// - `GET /api/accounts/authorize`: checks the request frost sends (code flow, PKCE S256, the scope,
//   the resource, a loopback redirect, the host id, the name hint on a first registration only) and
//   answers its "consent" at once: a 302 to the loopback callback with a one-time code (and, on a
//   first registration with `dynamic_agent_client`, the newly issued `client_id`).
// - `POST /api/accounts/oauth/token`: the code exchange (the issued client, the verifier, the same
//   redirect) and the refresh grant (rotating); an RS256 ID token signed by a key made at start.
// - `POST /api/accounts/oauth/revoke`, `GET /.well-known/jwks.json`.
// - `GET /v1/models` and `POST /v1/responses` (Bearer access token): the model list, and a scripted
//   Server-Sent Events stream per request (text, a namespaced function call, an error answer).
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CHATGPT_AGENT_NAME, CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_RESOURCE, CHATGPT_SCOPE, isChatgptRedirectUri, type ChatgptEndpoints } from '@app/specs/agent-chatgpt.spec';

export interface FakeChatgptAccount {
  readonly sub: string;
  readonly email: string;
}

/** One scripted `/v1/responses` answer. */
export type FakeResponse =
  | { readonly kind: 'text'; readonly text: string }
  /** A function call in a namespace (default `frost`), as the plan's models make them. */
  | { readonly kind: 'call'; readonly name: string; readonly args: Record<string, unknown>; readonly namespace?: string }
  /** An error answer (JSON `{ error: { code, message, type } }`) with `status`. */
  | { readonly kind: 'error'; readonly status: number; readonly code: string };

export interface RecordedAuthorize {
  readonly clientId: string;
  readonly params: URLSearchParams;
}

export interface RecordedResponsesRequest {
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface FakeChatgpt {
  readonly origin: string;
  readonly endpoints: ChatgptEndpoints;
  /** Who the next sign-in comes back as. */
  account: FakeChatgptAccount;
  /** The listed models (`GET /v1/models`). */
  models: { slug: string; display_name: string; visibility: string }[];
  /** What the next `/v1/responses` requests answer, in order (then a fixed text). */
  readonly responses: FakeResponse[];
  readonly authorizeRequests: RecordedAuthorize[];
  readonly tokenRequests: URLSearchParams[];
  readonly revoked: URLSearchParams[];
  readonly responsesRequests: RecordedResponsesRequest[];
  /** Every access, refresh and ID token issued so far (to prove none leaves main). */
  readonly issued: { readonly access: string[]; readonly refresh: string[]; readonly id: string[] };
  /** Requests the fake refused (anything frost shouldn't have sent), as `METHOD path: why`. */
  readonly refused: string[];
  close(): Promise<void>;
}

export const FAKE_CHATGPT_DEFAULT_TEXT = 'The fake has no more responses.';

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const sseOf = (events: readonly Record<string, unknown>[]) => events.map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join('');

export async function startFakeChatgpt(): Promise<FakeChatgpt> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `e2e-${randomBytes(4).toString('hex')}`;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const signJwt = (claims: Record<string, unknown>) => {
    const head = `${b64url({ alg: 'RS256', kid, typ: 'JWT' })}.${b64url(claims)}`;
    return `${head}.${sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`;
  };

  let origin = '';
  let counter = 0;
  const next = (prefix: string) => `${prefix}${++counter}-${randomBytes(6).toString('hex')}`;
  /** Codes not yet exchanged. */
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; nonce: string; account: FakeChatgptAccount }>();
  /** Live refresh tokens: their client and account. */
  const refreshTokens = new Map<string, { clientId: string; account: FakeChatgptAccount }>();
  const accessTokens = new Set<string>();
  /** Issued client ids and the account each registered. */
  const clients = new Map<string, FakeChatgptAccount>();

  const fake: FakeChatgpt = {
    origin: '',
    endpoints: {} as ChatgptEndpoints,
    account: { sub: 'e2e-user-1', email: 'ada@example.com' },
    models: [
      { slug: 'gpt-e2e', display_name: 'GPT E2E', visibility: 'list' },
      { slug: 'gpt-e2e-mini', display_name: 'GPT E2E Mini', visibility: 'list' },
      { slug: 'gpt-e2e-hidden', display_name: 'GPT E2E Hidden', visibility: 'hide' },
    ],
    responses: [],
    authorizeRequests: [],
    tokenRequests: [],
    revoked: [],
    responsesRequests: [],
    issued: { access: [], refresh: [], id: [] },
    refused: [],
    close: async () => undefined,
  };

  const json = (response: ServerResponse, status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  const refuse = (request: IncomingMessage, response: ServerResponse, status: number, why: string, error = 'invalid_request') => {
    fake.refused.push(`${request.method} ${new URL(request.url ?? '/', 'http://x').pathname}: ${why}`);
    json(response, status, { error, error_description: why });
  };

  const issueTokens = (clientId: string, account: FakeChatgptAccount, nonce: string | null) => {
    const access = next('fake-access-');
    const refresh = next('fake-refresh-');
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt({ iss: origin, sub: account.sub, aud: clientId, azp: clientId, email: account.email, iat: now, exp: now + 3600, ...(nonce === null ? {} : { nonce }) });
    accessTokens.add(access);
    refreshTokens.set(refresh, { clientId, account });
    fake.issued.access.push(access);
    fake.issued.refresh.push(refresh);
    fake.issued.id.push(idToken);
    return { access_token: access, refresh_token: refresh, id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: CHATGPT_SCOPE };
  };

  const bearer = (request: IncomingMessage): string | null => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    return match !== null && accessTokens.has(match[1]!) ? match[1]! : null;
  };

  const authorize = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    const first = clientId === CHATGPT_DYNAMIC_CLIENT_ID;
    const problems = [
      q.get('response_type') !== 'code' && 'response_type',
      !isChatgptRedirectUri(redirectUri) && 'redirect_uri',
      q.get('scope') !== CHATGPT_SCOPE && 'scope',
      q.get('resource') !== CHATGPT_RESOURCE && 'resource',
      !q.get('state') && 'state',
      !q.get('nonce') && 'nonce',
      !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') ?? '') && 'code_challenge',
      q.get('code_challenge_method') !== 'S256' && 'code_challenge_method',
      !/^urn:uuid:[0-9a-f-]{36}$/.test(q.get('ext_agent_host_id') ?? '') && 'ext_agent_host_id',
      !first && !clients.has(clientId) && 'client_id',
      first !== (q.get('agent_name_hint') === CHATGPT_AGENT_NAME) && 'agent_name_hint',
    ].filter((problem): problem is string => problem !== false);
    fake.authorizeRequests.push({ clientId, params: new URLSearchParams(q) });
    if (problems.length > 0) return refuse(request, response, 400, problems.join(', '));
    // A first registration issues a client id; a returning one comes back as the account it registered.
    const issued = first ? next('oaiapp_e2e') : clientId;
    if (first) clients.set(issued, fake.account);
    const code = next('fake-code-');
    codes.set(code, { clientId: issued, challenge: q.get('code_challenge')!, redirectUri, nonce: q.get('nonce')!, account: clients.get(issued)! });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', q.get('state')!);
    target.searchParams.set('scope', CHATGPT_SCOPE);
    if (first) target.searchParams.set('client_id', issued);
    response.writeHead(302, { Location: target.href }).end();
  };

  const token = async (request: IncomingMessage, response: ServerResponse) => {
    const form = new URLSearchParams(await readBody(request));
    fake.tokenRequests.push(form);
    if (form.get('resource') !== CHATGPT_RESOURCE) return refuse(request, response, 400, 'resource');
    if (form.get('grant_type') === 'authorization_code') {
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      if (entry === undefined) return refuse(request, response, 400, 'unknown code', 'invalid_grant');
      if (form.get('client_id') !== entry.clientId) return refuse(request, response, 400, 'client_id', 'invalid_client');
      if (form.get('redirect_uri') !== entry.redirectUri) return refuse(request, response, 400, 'redirect_uri', 'invalid_grant');
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== entry.challenge) return refuse(request, response, 400, 'code_verifier', 'invalid_grant');
      return json(response, 200, issueTokens(entry.clientId, entry.account, entry.nonce));
    }
    if (form.get('grant_type') === 'refresh_token') {
      const entry = refreshTokens.get(form.get('refresh_token') ?? '');
      if (entry === undefined || form.get('client_id') !== entry.clientId) return refuse(request, response, 400, 'refresh_token', 'invalid_grant');
      refreshTokens.delete(form.get('refresh_token')!);
      return json(response, 200, issueTokens(entry.clientId, entry.account, null));
    }
    return refuse(request, response, 400, 'grant_type', 'unsupported_grant_type');
  };

  const revoke = async (request: IncomingMessage, response: ServerResponse) => {
    const form = new URLSearchParams(await readBody(request));
    fake.revoked.push(form);
    refreshTokens.delete(form.get('token') ?? '');
    response.writeHead(200).end();
  };

  const responses = async (request: IncomingMessage, response: ServerResponse) => {
    const text = await readBody(request);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return refuse(request, response, 400, 'not JSON');
    }
    fake.responsesRequests.push({ headers: request.headers, body });
    if (bearer(request) === null) return json(response, 401, { error: { code: 'invalid_api_key', message: 'Unknown access token.', type: 'invalid_request_error' } });
    const scripted = fake.responses.shift() ?? { kind: 'text', text: FAKE_CHATGPT_DEFAULT_TEXT };
    if (scripted.kind === 'error') return json(response, scripted.status, { error: { code: scripted.code, message: 'Scripted failure.', type: 'invalid_request_error', param: null } });
    const id = next('resp_');
    const model = typeof body.model === 'string' ? body.model : 'gpt-e2e';
    const usage = { input_tokens: 120, output_tokens: 12 };
    const events: Record<string, unknown>[] = [{ type: 'response.created', response: { id, created_at: Math.floor(Date.now() / 1000), model } }];
    if (scripted.kind === 'text') {
      const item = next('msg_');
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: item, role: 'assistant', status: 'in_progress', content: [] } },
        ...scripted.text.split(/(?<= )/).map((delta) => ({ type: 'response.output_text.delta', item_id: item, output_index: 0, content_index: 0, delta })),
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: item, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: scripted.text, annotations: [] }] } },
      );
    } else {
      const item = next('fc_');
      const callId = next('call_');
      const args = JSON.stringify(scripted.args);
      const call = { type: 'function_call', id: item, call_id: callId, name: scripted.name, namespace: scripted.namespace ?? 'frost' };
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', item_id: item, output_index: 0, delta: args },
        { type: 'response.function_call_arguments.done', item_id: item, output_index: 0, arguments: args },
        { type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: args, status: 'completed' } },
      );
    }
    events.push({ type: 'response.completed', response: { id, status: 'completed', incomplete_details: null, usage } });
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }).end(sseOf(events));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = `${request.method} ${url.pathname}`;
    void (async () => {
      switch (route) {
        case 'GET /api/accounts/authorize':
          return authorize(request, response, url);
        case 'POST /api/accounts/oauth/token':
          return token(request, response);
        case 'POST /api/accounts/oauth/revoke':
          return revoke(request, response);
        case 'GET /.well-known/jwks.json':
          return json(response, 200, { keys: [jwk] });
        case 'GET /v1/models':
          if (bearer(request) === null) return json(response, 401, { error: { code: 'invalid_api_key', message: 'Unknown access token.' } });
          return json(response, 200, { models: fake.models });
        case 'POST /v1/responses':
          return responses(request, response);
        default:
          return refuse(request, response, 404, 'no such endpoint', 'not_found');
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    origin,
    endpoints: {
      issuer: origin,
      authorize: `${origin}/api/accounts/authorize`,
      token: `${origin}/api/accounts/oauth/token`,
      revoke: `${origin}/api/accounts/oauth/revoke`,
      jwks: `${origin}/.well-known/jwks.json`,
      models: `${origin}/v1/models`,
      responses: `${origin}/v1/responses`,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
