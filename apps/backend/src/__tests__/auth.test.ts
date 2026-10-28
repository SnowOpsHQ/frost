import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  AUTH_SECRET_MIN_LENGTH,
  ErrorResponseSchema,
  HEALTH_PATH,
  HealthResponseSchema,
  SESSION_PATH,
  SessionResponseSchema,
} from '@app/specs/account-api.schema';
import { EnvError, parseEnv } from '../env';
import { createConsoleTransport } from '../email';
import { cookieFrom, createTestBackend, jsonPost, linkIn, type TestBackend } from './helpers';

// Acceptance: specs/account-backend.feature.md (Environment, Sign-in, Session).

const auth = (route: keyof typeof AUTH_ROUTES): string => `${AUTH_BASE_PATH}${AUTH_ROUTES[route]}`;
const PASSWORD = 'correct horse battery staple';
const VALID_SECRET = 's'.repeat(AUTH_SECRET_MIN_LENGTH);

let backend: TestBackend | undefined;
afterEach(async () => {
  await backend?.close();
  backend = undefined;
});

async function open(overrides?: Parameters<typeof createTestBackend>[0]): Promise<TestBackend> {
  backend = await createTestBackend(overrides);
  return backend;
}

async function signUp(b: TestBackend, email = 'alice@example.com', name = 'Alice'): Promise<Response> {
  return b.request(auth('signUpEmail'), jsonPost({ email, password: PASSWORD, name }));
}

/** Sign up, follow the verification link, sign in with the password; answers the session cookie. */
async function signedInWithPassword(b: TestBackend, email = 'alice@example.com'): Promise<string> {
  expect((await signUp(b, email)).status).toBe(200);
  const verification = b.email.messages.find((m) => m.to === email);
  if (!verification) throw new Error('no verification email');
  const verified = await b.request(linkIn(verification.text));
  expect(verified.status).toBeLessThan(400);
  const res = await b.request(auth('signInEmail'), jsonPost({ email, password: PASSWORD }));
  expect(res.status).toBe(200);
  const cookie = cookieFrom(res);
  expect(cookie).not.toBe('');
  return cookie;
}

describe('environment', () => {
  it('env-refuses-missing-secret', () => {
    expect(() => parseEnv({})).toThrow(EnvError);
    expect(() => parseEnv({})).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('env-refuses-short-secret', () => {
    const short = 'x'.repeat(AUTH_SECRET_MIN_LENGTH - 1);
    let error: unknown;
    try {
      parseEnv({ BETTER_AUTH_SECRET: short });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as Error).message).toMatch(/BETTER_AUTH_SECRET/);
    expect((error as Error).message).not.toContain(short);
  });

  it('env-defaults', () => {
    const env = parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGLITE_DIR).toMatch(/[/\\]\.data[/\\]pglite$/);
    expect(env.EMAIL_TRANSPORT).toBe('console');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(8787);
    expect(env.BETTER_AUTH_URL).toBe('http://127.0.0.1:8787');
    expect(parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET, PORT: '9000' }).BETTER_AUTH_URL).toBe('http://127.0.0.1:9000');
  });

  it('env-refuses-console-email-in-production', () => {
    expect(() => parseEnv({ BETTER_AUTH_SECRET: VALID_SECRET, NODE_ENV: 'production', EMAIL_TRANSPORT: 'console' })).toThrow(/EMAIL_TRANSPORT/);
  });
});

describe('sign-in', () => {
  it('sign-up-with-password', async () => {
    const b = await open();
    const res = await signUp(b);
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toBe('');
    expect(b.email.messages).toHaveLength(1);
    const [message] = b.email.messages;
    expect(message?.to).toBe('alice@example.com');
    expect(linkIn(message?.text ?? '')).toContain(`${AUTH_BASE_PATH}${AUTH_ROUTES.verifyEmail}`);
  });

  it('sign-in-with-password', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const res = await b.request(SESSION_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('unverified-password-sign-in-refused', async () => {
    const b = await open();
    await signUp(b);
    const res = await b.request(auth('signInEmail'), jsonPost({ email: 'alice@example.com', password: PASSWORD }));
    expect(res.status).toBe(403);
    expect(cookieFrom(res)).toBe('');
  });

  it('wrong-password-refused', async () => {
    const b = await open();
    await signedInWithPassword(b);
    const wrong = await b.request(auth('signInEmail'), jsonPost({ email: 'alice@example.com', password: 'not the password at all' }));
    const unknown = await b.request(auth('signInEmail'), jsonPost({ email: 'nobody@example.com', password: 'not the password at all' }));
    expect(wrong.status).toBe(401);
    expect(cookieFrom(wrong)).toBe('');
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('magic-link-signs-in', async () => {
    const b = await open();
    const sent = await b.request(auth('signInMagicLink'), jsonPost({ email: 'bob@example.com', callbackURL: '/' }));
    expect(sent.status).toBe(200);
    expect(cookieFrom(sent)).toBe('');
    const [message] = b.email.messages;
    expect(message?.to).toBe('bob@example.com');
    const link = linkIn(message?.text ?? '');
    expect(link).toContain(`${AUTH_BASE_PATH}${AUTH_ROUTES.verifyMagicLink}`);

    const followed = await b.request(link);
    expect(followed.status).toBe(302);
    const cookie = cookieFrom(followed);
    const session = await b.request(SESSION_PATH, { headers: { cookie } });
    expect(session.status).toBe(200);
    const body = SessionResponseSchema.parse(await session.json());
    expect(body.user.email).toBe('bob@example.com');
    expect(body.user.name).toBeNull();
  });

  it('magic-link-single-use', async () => {
    const b = await open();
    await b.request(auth('signInMagicLink'), jsonPost({ email: 'bob@example.com', callbackURL: '/' }));
    const link = linkIn(b.email.messages[0]?.text ?? '');
    expect(cookieFrom(await b.request(link))).not.toBe('');
    const again = await b.request(link);
    expect(cookieFrom(again)).toBe('');
    expect(again.headers.get('location') ?? '').toMatch(/error=/);
  });

  it('console-transport-prints-link', async () => {
    const lines: string[] = [];
    const transport = createConsoleTransport((line) => lines.push(line));
    await transport.send({ to: 'carol@example.com', subject: 'Sign in to frost', text: 'Open http://127.0.0.1:8787/x?token=abc' });
    const printed = lines.join('\n');
    expect(printed).toContain('carol@example.com');
    expect(printed).toContain('Sign in to frost');
    expect(printed).toContain('http://127.0.0.1:8787/x?token=abc');
  });
});

describe('session', () => {
  it('session-answers-signed-in-user', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const res = await b.request(SESSION_PATH, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = SessionResponseSchema.parse(await res.json());
    expect(body.user).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
    expect(body.user.id).not.toBe('');
    expect(Date.parse(body.expiresAt ?? '')).toBeGreaterThan(Date.now());
  });

  it('session-401-without-credentials', async () => {
    const b = await open();
    const res = await b.request(SESSION_PATH);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('session-401-after-sign-out', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const out = await b.request(auth('signOut'), jsonPost({}, { cookie }));
    expect(out.status).toBe(200);
    const res = await b.request(SESSION_PATH, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('session-bearer-hook', async () => {
    const noVerifier = await open();
    const cookie = await signedInWithPassword(noVerifier);
    expect((await noVerifier.request(SESSION_PATH, { headers: { authorization: 'Bearer anything' } })).status).toBe(401);
    // A presented bearer is the credential: an invalid one never falls back to the cookie.
    expect((await noVerifier.request(SESSION_PATH, { headers: { authorization: 'Bearer anything', cookie } })).status).toBe(401);
    await noVerifier.close();

    const expiresAt = new Date(Date.now() + 60_000);
    const b = await open({
      verifyBearer: (token) =>
        Promise.resolve(token === 'desktop-token-1' ? { user: { id: 'u1', email: 'dana@example.com', name: null }, expiresAt } : null),
    });
    const good = await b.request(SESSION_PATH, { headers: { authorization: 'Bearer desktop-token-1' } });
    expect(good.status).toBe(200);
    expect(SessionResponseSchema.parse(await good.json())).toEqual({
      user: { id: 'u1', email: 'dana@example.com', name: null },
      expiresAt: expiresAt.toISOString(),
    });
    expect((await b.request(SESSION_PATH, { headers: { authorization: 'Bearer desktop-token-2' } })).status).toBe(401);
    expect((await b.request(SESSION_PATH, { headers: { authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('answers-match-spec', async () => {
    const b = await open();
    const health = await b.request(HEALTH_PATH);
    expect(health.status).toBe(200);
    HealthResponseSchema.parse(await health.json());

    const cookie = await signedInWithPassword(b);
    SessionResponseSchema.parse(await (await b.request(SESSION_PATH, { headers: { cookie } })).json());

    const unauthorized = await b.request(SESSION_PATH);
    expect(unauthorized.headers.get('content-type') ?? '').toMatch(/application\/json/);
    ErrorResponseSchema.parse(await unauthorized.json());
    ErrorResponseSchema.parse(await (await b.request('/v1/nope')).json());
  });

  it('answers-carry-no-secret', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const res = await b.request(SESSION_PATH, { headers: { cookie } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'user']);
    expect(Object.keys(body.user as object).sort()).toEqual(['email', 'id', 'name']);
    const sessionToken = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    expect(sessionToken.length).toBeGreaterThan(8);
    expect(text).not.toContain(sessionToken);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/password|token|scrypt/i);
  });

  it('unknown-route-404', async () => {
    const b = await open();
    const res = await b.request('/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
