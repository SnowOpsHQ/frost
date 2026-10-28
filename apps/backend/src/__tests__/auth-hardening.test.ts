import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ACCOUNT_USER_LIMITS,
  AUTH_BASE_PATH,
  AUTH_RATE_LIMITS,
  AUTH_ROUTES,
  HEALTH_PATH,
  SESSION_PATH,
} from '@app/specs/account-api.schema';
import { CLIENT_IP_HEADER } from '../auth';
import { queryRows } from '../db/client';
import { resolvePrincipal } from '../principal';
import {
  authPath,
  BASE_URL,
  cookieFrom,
  createTestBackend,
  jsonPost,
  linkIn,
  PASSWORD,
  signedInWithPassword,
  signUp,
  TEST_PEER_HEADER,
  verifyEmail,
  type TestBackend,
} from './helpers';

// Acceptance: specs/account-backend.feature.md (Hardening). Regression tests for properties the
// backend gets from better-auth's configuration, so an upgrade that loses one fails here.

const EVIL = 'https://evil.example';

let backend: TestBackend | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  backend = undefined;
});

async function open(overrides?: Parameters<typeof createTestBackend>[0]): Promise<TestBackend> {
  backend = await createTestBackend(overrides);
  return backend;
}

async function credentialAccounts(b: TestBackend, email: string): Promise<number> {
  const rows = await queryRows<{ n: number }>(
    b.database.db,
    sql`SELECT count(*)::int AS n FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = ${email} AND a.provider_id = 'credential'`,
  );
  return rows[0]?.n ?? -1;
}

/** Everything written to the console while `fn` runs. */
async function captureConsole(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack ?? ''} ${JSON.stringify(a)}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, method).mockImplementation(record);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (record(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (record(String(chunk)), true));
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return lines.join('\n');
}

describe('sign-in hardening', () => {
  it('magic-link-drops-squatter-password', async () => {
    const b = await open();
    // Someone registers Alice's address with their own password and never verifies it.
    expect((await signUp(b, 'alice@example.com', 'Squatter', 'squatter password 123')).status).toBe(200);
    expect(await credentialAccounts(b, 'alice@example.com')).toBe(1);
    // Alice signs in with a magic link: the address is now proven...
    await b.request(authPath('signInMagicLink'), jsonPost({ email: 'alice@example.com', callbackURL: '/' }));
    const link = linkIn(b.email.messages.find((m) => m.subject === 'Sign in to frost')?.text ?? '');
    expect(cookieFrom(await b.request(link))).not.toBe('');
    // ...and the squatter's unproven password is gone.
    expect(await credentialAccounts(b, 'alice@example.com')).toBe(0);
    const squatter = await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: 'squatter password 123' }));
    expect(squatter.status).toBe(401);
    expect(cookieFrom(squatter)).toBe('');
  });

  it('duplicate-sign-up-is-generic', async () => {
    const b = await open();
    const first = await signUp(b, 'alice@example.com', 'Alice', PASSWORD);
    const second = await signUp(b, 'alice@example.com', 'Mallory', 'mallory password 123');
    expect(second.status).toBe(first.status);
    const a = (await first.json()) as { user: Record<string, unknown> };
    const c = (await second.json()) as { user: Record<string, unknown> };
    expect(Object.keys(c).sort()).toEqual(Object.keys(a).sort());
    expect(Object.keys(c.user).sort()).toEqual(Object.keys(a.user).sort());
    expect(cookieFrom(second)).toBe('');
    // The second password never became the account's.
    await verifyEmail(b, 'alice@example.com');
    expect((await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: 'mallory password 123' }))).status).toBe(401);
    expect((await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: PASSWORD }))).status).toBe(200);
  });

  it('cross-origin-auth-post-refused', async () => {
    const b = await open();
    await signedInWithPassword(b);
    const crossSignIn = await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: PASSWORD }, { origin: EVIL }));
    expect(crossSignIn.status).toBe(403);
    expect(cookieFrom(crossSignIn)).toBe('');
    const crossSignUp = await b.request(authPath('signUpEmail'), jsonPost({ email: 'eve@example.com', password: PASSWORD, name: 'Eve' }, { origin: EVIL }));
    expect(crossSignUp.status).toBe(403);
    // A browser fetch from another site (Fetch Metadata, no cookie yet): refused.
    const fetchMetadata = await b.app.request(`${BASE_URL}${authPath('signInEmail')}`, {
      ...jsonPost({ email: 'alice@example.com', password: PASSWORD }, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }),
    });
    expect(fetchMetadata.status).toBe(403);
    // better-auth's own check (no Origin, so the app's guard lets it through): a cookie-bearing
    // write whose Referer is another site is refused.
    const cookie = cookieFrom(await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: PASSWORD })));
    const refererOnly = await b.app.request(`${BASE_URL}${authPath('signOut')}`, jsonPost({}, { cookie, referer: `${EVIL}/page` }));
    expect(refererOnly.status).toBe(403);
    expect((await b.request(SESSION_PATH, { headers: { cookie } })).status).toBe(200);
  });

  it('foreign-callback-refused', async () => {
    const b = await open();
    const send = await b.request(authPath('signInMagicLink'), jsonPost({ email: 'bob@example.com', callbackURL: `${EVIL}/` }));
    expect(send.status).toBe(403);
    expect(b.email.messages).toHaveLength(0);

    await b.request(authPath('signInMagicLink'), jsonPost({ email: 'bob@example.com', callbackURL: '/' }));
    const link = new URL(linkIn(b.email.messages[0]?.text ?? ''));
    link.searchParams.set('callbackURL', `${EVIL}/`);
    const follow = await b.request(link.toString());
    expect(follow.status).toBe(403);
    expect(cookieFrom(follow)).toBe('');
    expect(follow.headers.get('location')).toBeNull();
  });

  it('sign-in-rate-limited', async () => {
    const b = await open();
    const attempt = (headers: Record<string, string> = {}) =>
      b.request(authPath('signInEmail'), jsonPost({ email: 'nobody@example.com', password: 'not the password at all' }, headers));
    for (let i = 0; i < AUTH_RATE_LIMITS.signIn.max; i += 1) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0);
    // The client cannot pick its own key...
    expect((await attempt({ [CLIENT_IP_HEADER]: '198.51.100.99' })).status).toBe(429);
    // ...but another client (another TCP peer) is not locked out.
    expect((await attempt({ [TEST_PEER_HEADER]: '198.51.100.7' })).status).toBe(401);
  });

  it('user-fields-bounded', async () => {
    const b = await open();
    const longName = await b.request(authPath('signUpEmail'), jsonPost({ email: 'long@example.com', password: PASSWORD, name: 'n'.repeat(5000) }));
    expect(longName.status).toBe(400);
    const longEmail = `${'e'.repeat(ACCOUNT_USER_LIMITS.maxEmailChars)}@example.com`;
    const longAddress = await b.request(authPath('signUpEmail'), jsonPost({ email: longEmail, password: PASSWORD, name: 'Long' }));
    expect(longAddress.status).toBe(400);
    const rows = await queryRows<{ n: number }>(b.database.db, sql`SELECT count(*)::int AS n FROM users`);
    expect(rows[0]?.n).toBe(0);
  });

  it('auth-endpoints-allowlisted', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    for (const [path, method] of [
      ['/update-user', 'POST'],
      ['/delete-user', 'POST'],
      ['/list-sessions', 'GET'],
      ['/change-password', 'POST'],
      ['/ok', 'GET'],
      ['/error', 'GET'],
      [AUTH_ROUTES.signInEmail, 'GET'],
    ] as const) {
      const res = await b.request(`${AUTH_BASE_PATH}${path}`, method === 'POST' ? jsonPost({}, { cookie }) : { headers: { cookie } });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('auth-answers-carry-no-session-token', async () => {
    const b = await open();
    await signUp(b);
    await verifyEmail(b, 'alice@example.com');
    const signIn = await b.request(authPath('signInEmail'), jsonPost({ email: 'alice@example.com', password: PASSWORD }));
    expect(signIn.status).toBe(200);
    const cookie = cookieFrom(signIn);
    const sessionToken = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const signInBody = (await signIn.json()) as Record<string, unknown>;
    expect(signInBody).not.toHaveProperty('token');
    expect(JSON.stringify(signInBody)).not.toContain(sessionToken);

    const session = await b.request(authPath('getSession'), { headers: { cookie } });
    expect(session.status).toBe(200);
    const text = await session.text();
    expect(text).not.toContain(sessionToken);
    expect((JSON.parse(text) as { session: Record<string, unknown> }).session).not.toHaveProperty('token');
  });

  it('db-errors-not-logged', async () => {
    const b = await open();
    await b.database.db.execute(sql.raw('ALTER TABLE accounts RENAME COLUMN password TO pw'));
    let res: Response | undefined;
    const printed = await captureConsole(async () => {
      res = await signUp(b, 'secret.person@example.com', 'Secret Person');
    });
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: 'internal' });
    const everything = `${printed}\n${b.logs.join('\n')}`;
    expect(everything).not.toContain('secret.person');
    expect(everything).not.toContain('Secret Person');
    expect(everything).not.toMatch(/[0-9a-f]{32,}/);
    expect(everything).not.toMatch(/params|Failing row/i);
  });
});

describe('session hardening', () => {
  it('session-answer-validated', async () => {
    const b = await open({
      verifyBearer: () => Promise.resolve({ user: { id: 'u1', email: 'dana@example.com', name: 'n'.repeat(ACCOUNT_USER_LIMITS.maxNameChars + 1) } }),
    });
    let res: Response | undefined;
    await captureConsole(async () => {
      res = await b.request(SESSION_PATH, { headers: { authorization: 'Bearer desktop-token-1' } });
    });
    expect(res?.status).toBe(500);
    expect(await res?.json()).toEqual({ error: 'internal' });
  });

  it('bearer-verifier-errors-and-scheme', async () => {
    const throwing = await open({ verifyBearer: () => Promise.reject(new Error('database down')) });
    let res: Response | undefined;
    await captureConsole(async () => {
      res = await throwing.request(SESSION_PATH, { headers: { authorization: 'Bearer desktop-token-1' } });
    });
    expect(res?.status).toBe(401);
    await throwing.close();

    const b = await open({ verifyBearer: (t) => Promise.resolve(t === 'tok' ? { user: { id: 'u1', email: 'dana@example.com', name: null } } : null) });
    expect((await b.request(SESSION_PATH, { headers: { authorization: 'bearer tok' } })).status).toBe(200);
    expect((await b.request(SESSION_PATH, { headers: { authorization: 'BEARER tok' } })).status).toBe(200);
  });

  it('cookie-on-unsafe-method-needs-same-origin', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const post = (headers: Record<string, string>) => new Request(`${BASE_URL}/v1/anything`, { method: 'POST', headers: { cookie, ...headers } });
    expect(await resolvePrincipal(b.resolvers, new Request(`${BASE_URL}/v1/anything`, { headers: { cookie } }))).not.toBeNull();
    expect(await resolvePrincipal(b.resolvers, post({ origin: BASE_URL }))).not.toBeNull();
    expect(await resolvePrincipal(b.resolvers, post({ 'sec-fetch-site': 'same-origin' }))).not.toBeNull();
    expect(await resolvePrincipal(b.resolvers, post({}))).toBeNull();
    expect(await resolvePrincipal(b.resolvers, post({ origin: EVIL }))).toBeNull();
    expect(await resolvePrincipal(b.resolvers, post({ 'sec-fetch-site': 'cross-site' }))).toBeNull();
  });

  it('healthz-503-when-db-closed', async () => {
    const b = await open();
    expect((await b.request(HEALTH_PATH)).status).toBe(200);
    await b.close();
    const res = await b.request(HEALTH_PATH);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
  });
});
