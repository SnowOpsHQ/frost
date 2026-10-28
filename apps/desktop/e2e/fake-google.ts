// Test-only: an in-process stand-in for Google's OAuth 2.0 endpoints and the Search Console API v3
// (`specs/gsc.spec.ts`, `GSC_ENDPOINTS`), on 127.0.0.1, used by the unit tests
// (`src/main/gsc/__tests__`) and `gsc.e2e.ts`. Written from Google's public API shapes; every token,
// code and client value is fake and made per run. The consent page signs nobody in: it answers 302 to
// the loopback at once with a fresh code (the browser and Google's pages are not what these tests are
// about). It checks what Google checks: the client, the redirect, PKCE S256, one-time codes.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GSC_CONFIG_ENV, GSC_ENDPOINT_ENV, GSC_SCOPE, type GscEndpoints } from '@app/specs/gsc.spec';

export const FAKE_GSC_CLIENT_ID = 'test-client-id.apps.example';
export const FAKE_GSC_CLIENT_SECRET = 'test-client-secret';

/**
 * - `ok`: answers like the API.
 * - `down`: the API answers 503.
 * - `quota`: the API answers 429 (`RESOURCE_EXHAUSTED`).
 * - `quota-403`: the API answers 403 with the `quotaExceeded` reason.
 * - `forbidden`: the API answers 403 (`forbidden`: no permission for the property).
 * - `garbage`: the API answers a body that is not JSON.
 * - `unauthorized`: the API answers 401 to every token (a refresh does not help).
 */
export type FakeGoogleMode = 'ok' | 'down' | 'quota' | 'quota-403' | 'forbidden' | 'garbage' | 'unauthorized';

/** A Search Analytics row as Google answers it. */
export interface FakeRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface FakeSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface FakeQuery {
  readonly siteUrl: string;
  readonly body: Record<string, unknown>;
}

export interface FakeGoogle {
  readonly origin: string;
  readonly endpoints: GscEndpoints;
  /** The unpackaged run-time configuration that points frost at this fake (`GSC_CONFIG_ENV` and `GSC_ENDPOINT_ENV`). */
  readonly env: Record<string, string>;
  mode: FakeGoogleMode;
  /** The `scope` the token endpoint answers (default exactly `GSC_SCOPE`); `null` omits it. */
  grantScope: string | null;
  /** Whether a code exchange answers a refresh token (default `true`). */
  issueRefreshToken: boolean;
  /** `expires_in` of the access tokens issued (default one hour). */
  accessTokenTtlSeconds: number;
  /** When set, the consent page answers the redirect with `error=<value>` instead of a code. */
  consentError: string | null;
  /** The properties `GET /sites` answers. */
  sites: FakeSite[];
  /** The rows a `['date']` query answers (default `fakeDateRows(startDate)`). */
  dateRows: (startDate: string, endDate: string) => FakeRow[];
  /** The rows a `['query']` query answers (default `fakeQueryRows(30)`). */
  queryRows: () => FakeRow[];
  /** Every consent request's query, token request's form and revoke request's token, in order. */
  readonly authRequests: URLSearchParams[];
  readonly tokenRequests: URLSearchParams[];
  readonly revoked: string[];
  /** Every Search Analytics query (decoded site URL and JSON body), and the `sites` calls counted. */
  readonly queries: FakeQuery[];
  sitesCalls: number;
  /** Every API request's bearer token, in order (`null` without one). */
  readonly apiTokens: (string | null)[];
  /** Every code, access token and refresh token issued, in order. */
  readonly codes: string[];
  readonly accessTokens: string[];
  readonly refreshTokens: string[];
  /** Every PKCE verifier the token endpoint accepted (it matched its code's S256 challenge). */
  readonly verifiers: string[];
  /** Every access token issued so far answers 401 from now on (refresh still works). */
  expireAccessTokens(): void;
  /** The refresh tokens issued so far are refused (`invalid_grant`) from now on. */
  revokeRefreshTokens(): void;
  /** Every request seen (method and path), in order. */
  readonly requests: string[];
  close(): Promise<void>;
}

const AUTH_PATH = '/o/oauth2/v2/auth';
const TOKEN_PATH = '/token';
const REVOKE_PATH = '/revoke';
const API_PATH = '/webmasters/v3';
const QUERY_PATH = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/;
const DAY_MS = 86_400_000;

const random = (prefix: string): string => `${prefix}${randomBytes(24).toString('base64url')}`;

/** The rows the fake answers for a date query: the range's first three days. */
export function fakeDateRows(startDate: string): FakeRow[] {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return [0, 1, 2].map((i) => ({
    keys: [new Date(start + i * DAY_MS).toISOString().slice(0, 10)],
    clicks: 10 * (i + 1),
    impressions: 100 * (i + 1),
    ctr: 0.1,
    position: 2 + i,
  }));
}

/** The rows the fake answers for a query query: `count` queries, most clicks first. */
export function fakeQueryRows(count: number): FakeRow[] {
  return Array.from({ length: count }, (_, i) => ({ keys: [`fake query ${i + 1}`], clicks: 1000 - i, impressions: 10_000, ctr: (1000 - i) / 10_000, position: 1 + i / 10 }));
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const pendingCodes = new Map<string, { challenge: string; redirectUri: string }>();
  const liveAccess = new Set<string>();
  const liveRefresh = new Set<string>();

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  };
  const apiError = (res: ServerResponse, code: number, status: string, reason: string): void =>
    json(res, code, { error: { code, message: 'fake', status, errors: [{ reason, domain: 'global', message: 'fake' }] } });

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let text = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
      req.on('error', reject);
    });

  const clientOk = (form: URLSearchParams): boolean => form.get('client_id') === FAKE_GSC_CLIENT_ID && form.get('client_secret') === FAKE_GSC_CLIENT_SECRET;

  const issueAccess = (): string => {
    const token = random('fake-at-');
    liveAccess.add(token);
    google.accessTokens.push(token);
    return token;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    google.requests.push(`${req.method} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === AUTH_PATH) {
      google.authRequests.push(new URLSearchParams(url.searchParams));
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      const challenge = q.get('code_challenge') ?? '';
      if (
        q.get('client_id') !== FAKE_GSC_CLIENT_ID ||
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri) ||
        !q.get('state') ||
        !q.get('scope')
      ) {
        return void res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid_request');
      }
      const back = new URL(redirectUri);
      if (google.consentError !== null) {
        back.search = new URLSearchParams({ error: google.consentError, state: q.get('state')! }).toString();
      } else {
        const code = random('4/fake-code-');
        pendingCodes.set(code, { challenge, redirectUri });
        google.codes.push(code);
        back.search = new URLSearchParams({ code, scope: google.grantScope ?? '', state: q.get('state')! }).toString();
      }
      return void res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' }).end();
    }

    if (req.method === 'POST' && url.pathname === TOKEN_PATH) {
      if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return json(res, 400, { error: 'invalid_request' });
      const form = new URLSearchParams(await readBody(req));
      google.tokenRequests.push(form);
      if (!clientOk(form)) return json(res, 401, { error: 'invalid_client' });
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        const pending = pendingCodes.get(code);
        pendingCodes.delete(code);
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (!pending || pending.redirectUri !== form.get('redirect_uri') || pending.challenge !== challenge) return json(res, 400, { error: 'invalid_grant' });
        google.verifiers.push(verifier);
        const answer: Record<string, unknown> = { access_token: issueAccess(), expires_in: google.accessTokenTtlSeconds, token_type: 'Bearer' };
        if (google.grantScope !== null) answer.scope = google.grantScope;
        if (google.issueRefreshToken) {
          const refresh = random('1//fake-rt-');
          liveRefresh.add(refresh);
          google.refreshTokens.push(refresh);
          answer.refresh_token = refresh;
        }
        return json(res, 200, answer);
      }
      if (grant === 'refresh_token') {
        if (!liveRefresh.has(form.get('refresh_token') ?? '')) return json(res, 400, { error: 'invalid_grant' });
        const answer: Record<string, unknown> = { access_token: issueAccess(), expires_in: google.accessTokenTtlSeconds, token_type: 'Bearer' };
        if (google.grantScope !== null) answer.scope = google.grantScope;
        return json(res, 200, answer);
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === REVOKE_PATH) {
      const token = new URLSearchParams(await readBody(req)).get('token') ?? '';
      google.revoked.push(token);
      liveRefresh.delete(token);
      liveAccess.delete(token);
      return json(res, 200, {});
    }

    if (url.pathname === `${API_PATH}/sites` || QUERY_PATH.test(url.pathname)) {
      const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;
      google.apiTokens.push(bearer);
      if (bearer === null || !liveAccess.has(bearer) || google.mode === 'unauthorized') return apiError(res, 401, 'UNAUTHENTICATED', 'authError');
      if (google.mode === 'down') return json(res, 503, { error: { code: 503, status: 'UNAVAILABLE' } });
      if (google.mode === 'quota') return apiError(res, 429, 'RESOURCE_EXHAUSTED', 'rateLimitExceeded');
      if (google.mode === 'quota-403') return apiError(res, 403, 'PERMISSION_DENIED', 'quotaExceeded');
      if (google.mode === 'forbidden') return apiError(res, 403, 'PERMISSION_DENIED', 'forbidden');
      if (google.mode === 'garbage') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('<html>not json');
      if (req.method === 'GET' && url.pathname === `${API_PATH}/sites`) {
        google.sitesCalls++;
        return json(res, 200, google.sites.length === 0 ? {} : { siteEntry: google.sites });
      }
      const match = QUERY_PATH.exec(url.pathname);
      if (req.method === 'POST' && match) {
        const siteUrl = decodeURIComponent(match[1]!);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          return apiError(res, 400, 'INVALID_ARGUMENT', 'badRequest');
        }
        google.queries.push({ siteUrl, body });
        if (!google.sites.some((site) => site.siteUrl === siteUrl && site.permissionLevel !== 'siteUnverifiedUser')) return apiError(res, 403, 'PERMISSION_DENIED', 'forbidden');
        const dimensions = body.dimensions as unknown;
        if (Array.isArray(dimensions) && dimensions[0] === 'date') return json(res, 200, { rows: google.dateRows(String(body.startDate), String(body.endDate)), responseAggregationType: 'byProperty' });
        if (Array.isArray(dimensions) && dimensions[0] === 'query') return json(res, 200, { rows: google.queryRows(), responseAggregationType: 'byProperty' });
        return json(res, 200, {});
      }
    }
    json(res, 404, { error: { code: 404, status: 'NOT_FOUND' } });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const endpoints: GscEndpoints = { authUrl: `${origin}${AUTH_PATH}`, tokenUrl: `${origin}${TOKEN_PATH}`, revokeUrl: `${origin}${REVOKE_PATH}`, apiBase: `${origin}${API_PATH}` };

  const google: FakeGoogle = {
    origin,
    endpoints,
    env: {
      [GSC_CONFIG_ENV.clientId]: FAKE_GSC_CLIENT_ID,
      [GSC_CONFIG_ENV.clientSecret]: FAKE_GSC_CLIENT_SECRET,
      [GSC_ENDPOINT_ENV.authUrl]: endpoints.authUrl,
      [GSC_ENDPOINT_ENV.tokenUrl]: endpoints.tokenUrl,
      [GSC_ENDPOINT_ENV.revokeUrl]: endpoints.revokeUrl,
      [GSC_ENDPOINT_ENV.apiBase]: endpoints.apiBase,
    },
    mode: 'ok',
    grantScope: GSC_SCOPE,
    issueRefreshToken: true,
    accessTokenTtlSeconds: 3_600,
    consentError: null,
    sites: [],
    dateRows: (startDate) => fakeDateRows(startDate),
    queryRows: () => fakeQueryRows(30),
    authRequests: [],
    tokenRequests: [],
    revoked: [],
    queries: [],
    sitesCalls: 0,
    apiTokens: [],
    codes: [],
    accessTokens: [],
    refreshTokens: [],
    verifiers: [],
    requests: [],
    expireAccessTokens: () => liveAccess.clear(),
    revokeRefreshTokens: () => liveRefresh.clear(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
  return google;
}
