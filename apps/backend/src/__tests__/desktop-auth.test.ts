import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createLocalJWKSet, jwtVerify } from 'jose';
import {
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_CODE_TTL_SECONDS,
  DESKTOP_PAGE_PATHS,
  DESKTOP_RATE_LIMITS,
  DESKTOP_STATE_LIMITS,
  DESKTOP_TOKEN_PATH,
  DESKTOP_TOKEN_TTL_DAYS,
  DesktopTokenResponseSchema,
  ErrorResponseSchema,
  LOOPBACK_PORT_RANGE,
  LOOPBACK_REDIRECT_PATTERN,
  SESSION_PATH,
  SessionResponseSchema,
  SIGN_OUT_PATH,
  type DesktopAuthorizeQuery,
  type DesktopTokenResponse,
} from '@app/specs/account-api.schema';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_ISSUER,
  ENTITLEMENTS_PATH,
  EntitlementClaimsSchema,
  EntitlementsResponseSchema,
  PLAN_FEATURES,
} from '@app/specs/entitlements-snapshot.spec';
import { queryRows } from '../db/client';
import { escapeHtml } from '../desktop-pages';
import { setPlan } from '../entitlements';
import {
  BASE_URL,
  cookieFrom,
  createTestBackend,
  formPost,
  jsonPost,
  linkIn,
  PASSWORD,
  signedInWithPassword,
  TEST_PEER_HEADER,
  type TestBackend,
  type TestBackendOptions,
} from './helpers';

// Acceptance: specs/account-backend.feature.md (Desktop authorization).

const EVIL = 'https://evil.example';
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const DAY_MS = 86_400_000;

let backend: TestBackend | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await backend?.close();
  backend = undefined;
});

async function open(options?: TestBackendOptions): Promise<TestBackend> {
  backend = await createTestBackend(options);
  return backend;
}

/** A clock the test moves; the backend reads it for codes and desktop tokens. */
function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

// ---- The desktop's side (Task 5 does the same in main) -----------------------------------------

interface Pending {
  readonly params: DesktopAuthorizeQuery;
  readonly verifier: string;
}

function pending(overrides: Partial<Record<keyof DesktopAuthorizeQuery, string>> = {}): Pending {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = {
    redirect_uri: REDIRECT,
    state: randomBytes(32).toString('base64url'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...overrides,
  } as DesktopAuthorizeQuery;
  return { params, verifier };
}

const authorizePath = (params: Readonly<Record<string, string>>): string => `${DESKTOP_AUTHORIZE_PATH}?${new URLSearchParams(params).toString()}`;

/** Continue on the page (a same-origin form post with the session): answers the code. */
async function continueWith(b: TestBackend, cookie: string, p: Pending): Promise<string> {
  const res = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...p.params }, { cookie }));
  expect(res.status).toBe(303);
  const location = new URL(res.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(p.params.redirect_uri);
  expect(location.searchParams.get('state')).toBe(p.params.state);
  const code = location.searchParams.get('code');
  if (!code) throw new Error('no code');
  return code;
}

function exchange(b: TestBackend, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return b.request(DESKTOP_TOKEN_PATH, jsonPost(body, headers));
}

function tokenRequest(p: Pending, code: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.params.redirect_uri, ...overrides };
}

async function desktopToken(b: TestBackend, cookie: string): Promise<DesktopTokenResponse> {
  const p = pending();
  const code = await continueWith(b, cookie, p);
  const res = await exchange(b, tokenRequest(p, code));
  expect(res.status).toBe(200);
  return DesktopTokenResponseSchema.parse(await res.json());
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

async function expectInvalidGrant(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(ErrorResponseSchema.parse(await res.json())).toEqual({ error: 'invalid_grant' });
  expect(res.headers.get('cache-control')).toContain('no-store');
}

// ---- Reading the pages --------------------------------------------------------------------------

interface PageForm {
  readonly action: string;
  readonly method: string;
  readonly fields: Record<string, string>;
}

const decode = (text: string): string =>
  text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? undefined : decode(match[1]);
};

function formsIn(html: string): PageForm[] {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(([, attrs = '', body = '']) => {
    const fields: Record<string, string> = {};
    for (const [input = ''] of body.matchAll(/<input\b[^>]*>/g)) {
      const name = attribute(input, 'name');
      if (name) fields[name] = attribute(input, 'value') ?? '';
    }
    return { action: attribute(` ${attrs}`, 'action') ?? '', method: (attribute(` ${attrs}`, 'method') ?? 'get').toLowerCase(), fields };
  });
}

function formFor(html: string, action: string): PageForm {
  const form = formsIn(html).find((f) => f.action === action);
  if (!form) throw new Error(`no form posting to ${action}`);
  return form;
}

/** Submits a page's form as a browser would: its fields (hidden ones included) plus what the user typed. */
function submit(b: TestBackend, form: PageForm, typed: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  expect(form.method).toBe('post');
  return b.request(form.action, formPost({ ...form.fields, ...typed }, headers));
}

async function page(b: TestBackend, path: string, cookie?: string): Promise<{ res: Response; html: string }> {
  const res = await b.request(path, cookie ? { headers: { cookie } } : {});
  return { res, html: await res.text() };
}

const lastLink = (b: TestBackend, to: string): string => {
  const message = b.email.messages.filter((m) => m.to === to).at(-1);
  if (!message) throw new Error(`no email to ${to}`);
  return linkIn(message.text);
};

/** A path + query from a `Location`, which must be on the backend's own origin. */
function sameOriginPath(location: string | null): string {
  const url = new URL(location ?? '', BASE_URL);
  expect(url.origin).toBe(BASE_URL);
  return `${url.pathname}${url.search}`;
}

async function count(b: TestBackend, table: 'desktop_codes' | 'desktop_tokens'): Promise<number> {
  return (await queryRows<{ n: number }>(b.database.db, sql.raw(`SELECT count(*)::int AS n FROM ${table}`)))[0]?.n ?? -1;
}

function expectPlainErrorPage(res: Response, html: string): void {
  expect(res.status).toBe(400);
  expect(res.headers.get('location')).toBeNull();
  expect(res.headers.get('content-type')).toMatch(/^text\/html/);
  expect(html).not.toMatch(/<form/i);
}

// ---- Tests --------------------------------------------------------------------------------------

describe('authorize request', () => {
  it('loopback-redirect-pattern', () => {
    for (let port = 0; port <= 70_000; port += 1) {
      const inRange = port >= LOOPBACK_PORT_RANGE.min && port <= LOOPBACK_PORT_RANGE.max;
      expect(LOOPBACK_REDIRECT_PATTERN.test(`http://127.0.0.1:${port}/callback`), String(port)).toBe(inRange);
    }
    for (const uri of [
      `http://localhost:${PORT}/callback`,
      `http://[::1]:${PORT}/callback`,
      `https://127.0.0.1:${PORT}/callback`,
      `http://127.0.0.1:${PORT}/other`,
      `http://127.0.0.1:${PORT}/callback/`,
      `http://127.0.0.1:${PORT}/callback?x=1`,
      `http://127.0.0.1:${PORT}/callback#x`,
      `http://user@127.0.0.1:${PORT}/callback`,
      `http://127.0.0.1:0${PORT}/callback`,
      `http://127.0.0.1/callback`,
      `http://127.0.0.2:${PORT}/callback`,
      `HTTP://127.0.0.1:${PORT}/callback`,
      ` http://127.0.0.1:${PORT}/callback`,
      `http://127.0.0.1:${PORT}/callback\n`,
    ]) {
      expect(LOOPBACK_REDIRECT_PATTERN.test(uri), uri).toBe(false);
    }
  });

  it('authorize-refuses-bad-redirect', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    for (const redirect of [
      `http://localhost:${PORT}/callback`,
      `https://127.0.0.1:${PORT}/callback`,
      `http://127.0.0.1:${PORT}/other`,
      `http://[::1]:${PORT}/callback`,
      `${EVIL}/callback`,
      `http://127.0.0.1:80/callback`,
      'javascript:alert(1)',
    ]) {
      for (const who of [undefined, cookie]) {
        const { res, html } = await page(b, authorizePath({ ...pending().params, redirect_uri: redirect }), who);
        expectPlainErrorPage(res, html);
        expect(html).not.toContain(redirect);
      }
      // Continue re-validates: a signed-in POST with a bad redirect issues nothing either.
      const post = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...pending().params, redirect_uri: redirect }, { cookie }));
      expectPlainErrorPage(post, await post.text());
    }
    expect(await count(b, 'desktop_codes')).toBe(0);
  });

  it('authorize-refuses-bad-params', async () => {
    const b = await open();
    const good = pending().params;
    const { state: _state, ...withoutState } = good;
    const { code_challenge: _challenge, ...withoutChallenge } = good;
    const cases: string[] = [
      authorizePath(withoutState),
      authorizePath({ ...good, state: 's'.repeat(DESKTOP_STATE_LIMITS.minLength - 1) }),
      authorizePath({ ...good, state: 's'.repeat(DESKTOP_STATE_LIMITS.maxLength + 1) }),
      authorizePath({ ...good, state: 'has spaces and / slashes here' }),
      authorizePath(withoutChallenge),
      authorizePath({ ...good, code_challenge: 'short' }),
      authorizePath({ ...good, code_challenge_method: 'plain' }),
      `${authorizePath(good)}&state=${'t'.repeat(32)}`,
      `${authorizePath(good)}&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${PORT + 1}/callback`)}`,
      DESKTOP_AUTHORIZE_PATH,
    ];
    for (const path of cases) {
      const { res, html } = await page(b, path);
      expectPlainErrorPage(res, html);
    }
    // At the bounds it is accepted.
    for (const state of ['s'.repeat(DESKTOP_STATE_LIMITS.minLength), `${'s'.repeat(DESKTOP_STATE_LIMITS.maxLength - 4)}-._~`]) {
      expect((await page(b, authorizePath({ ...good, state }))).res.status).toBe(200);
    }
  });

  it('authorize-signed-out-shows-sign-in', async () => {
    const b = await open();
    const p = pending();
    const { res, html } = await page(b, authorizePath(p.params));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/i);
    expect(html).toMatch(/sign in to frost/i);
    for (const action of [DESKTOP_PAGE_PATHS.signIn, DESKTOP_PAGE_PATHS.magicLink, DESKTOP_PAGE_PATHS.signUp]) {
      const form = formFor(html, action);
      expect(form.method).toBe('post');
      for (const [name, value] of Object.entries(p.params)) expect(form.fields[name], `${action} ${name}`).toBe(value);
      expect(form.fields).toHaveProperty('email');
    }
    expect(formFor(html, DESKTOP_PAGE_PATHS.signIn).fields).toHaveProperty('password');
    expect(formFor(html, DESKTOP_PAGE_PATHS.signUp).fields).toHaveProperty('password');
    expect(formsIn(html).some((f) => f.action === DESKTOP_AUTHORIZE_PATH)).toBe(false);
  });

  it('authorize-signed-in-shows-continue', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const { res, html } = await page(b, authorizePath(p.params), cookie);
    expect(res.status).toBe(200);
    expect(html).toContain('Continue to frost as');
    expect(html).toContain('alice@example.com');
    expect(html).toMatch(/Not you\?/);
    const proceed = formFor(html, DESKTOP_AUTHORIZE_PATH);
    expect(proceed.fields).toEqual({ ...p.params });
    const signOut = formFor(html, DESKTOP_PAGE_PATHS.signOut);
    for (const [name, value] of Object.entries(p.params)) expect(signOut.fields[name]).toBe(value);
    // Showing the page issues nothing.
    expect(await count(b, 'desktop_codes')).toBe(0);
  });
});

describe('pages', () => {
  it('pages-carry-security-headers', async () => {
    const b = await open();
    const p = pending();
    const signInPage = await b.request(authorizePath(p.params));
    const errorPage = await b.request(authorizePath({ ...p.params, redirect_uri: `${EVIL}/` }));
    const checkEmail = await b.request(DESKTOP_PAGE_PATHS.magicLink, formPost({ ...p.params, email: 'bob@example.com' }));
    const cookie = await signedInWithPassword(b);
    const continuePage = await b.request(authorizePath(p.params), { headers: { cookie } });
    for (const res of [signInPage, errorPage, checkEmail, continuePage]) {
      const html = await res.text();
      const csp = res.headers.get('content-security-policy') ?? '';
      const directives = new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name = '', ...values]) => [name, values]));
      expect(directives.get('default-src')).toEqual(["'none'"]);
      expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
      expect(directives.get('base-uri')).toEqual(["'none'"]);
      expect(directives.get('form-action')?.[0]).toBe("'self'");
      expect(csp).not.toMatch(/unsafe|script-src|\*/);
      // The one inline stylesheet is allowed by its hash, and nothing else is.
      const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
      expect(style.length).toBeGreaterThan(0);
      expect(directives.get('style-src')).toEqual([`'sha256-${createHash('sha256').update(style).digest('base64')}'`]);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/i);
      expect(html).not.toMatch(/<script|\son[a-z]+=|javascript:/i);
    }
    // Continue's form is followed by a redirect to the loopback, which `form-action` must allow.
    expect(continuePage.headers.get('content-security-policy')).toMatch(new RegExp(`form-action 'self' http://127\\.0\\.0\\.1:${PORT}(;|$)`));
    expect(signInPage.headers.get('content-security-policy')).toMatch(/form-action 'self'(;|$)/);
  });

  it('pages-escape-hostile-values', async () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');

    const b = await open();
    const p = pending();
    // A hostile address on the continue page (written straight into the row: sign-up refuses it).
    const cookie = await signedInWithPassword(b, 'mallory@example.com');
    const hostile = `"><script>alert(1)</script><img src=x onerror=alert(2)>@example.com`;
    await b.database.db.execute(sql`UPDATE users SET email = ${hostile} WHERE email = 'mallory@example.com'`);
    const shown = await page(b, authorizePath(p.params), cookie);
    expect(shown.res.status).toBe(200);
    expect(shown.html).toContain(escapeHtml(hostile));
    // Inert text only: no tag of the address opens.
    expect(shown.html).not.toMatch(/<script|<img/i);

    // A hostile address typed into a form and shown again with the error.
    const typed = `<script>alert(3)</script>'"@example.com`;
    const again = await b.request(DESKTOP_PAGE_PATHS.signUp, formPost({ ...p.params, name: '<b>x</b>', email: typed, password: PASSWORD }));
    const againHtml = await again.text();
    expect(again.status).toBe(400);
    expect(againHtml).toContain(escapeHtml(typed));
    expect(againHtml).not.toMatch(/<script|<b>x/i);
    const magic = await b.request(DESKTOP_PAGE_PATHS.magicLink, formPost({ ...p.params, email: typed }));
    expect(await magic.text()).not.toMatch(/<script/i);

    // A hostile state is refused, and the refusal does not reflect it.
    const stateAttack = await page(b, authorizePath({ ...p.params, state: '<script>alert(4)</script>' }));
    expectPlainErrorPage(stateAttack.res, stateAttack.html);
    expect(stateAttack.html).not.toContain('alert(4)');
    expect(stateAttack.html).not.toMatch(/<script/i);
  });
});

describe('sign-in pages', () => {
  it('sign-up-shows-check-email', async () => {
    const b = await open();
    const p = pending();
    const start = (await page(b, authorizePath(p.params))).html;

    const signedUp = await submit(b, formFor(start, DESKTOP_PAGE_PATHS.signUp), { name: 'Carol', email: 'carol@example.com', password: PASSWORD });
    const signedUpHtml = await signedUp.text();
    expect(signedUp.status).toBe(200);
    expect(signedUpHtml).toMatch(/check your email/i);
    expect(signedUpHtml).toContain('carol@example.com');
    expect(cookieFrom(signedUp)).toBe('');

    // Not verified yet: the password is refused with a message, and no session is set.
    const early = await submit(b, formFor(start, DESKTOP_PAGE_PATHS.signIn), { email: 'carol@example.com', password: PASSWORD });
    expect(early.status).toBe(403);
    expect(cookieFrom(early)).toBe('');
    const earlyHtml = await early.text();
    expect(earlyHtml).toMatch(/confirm your email/i);
    expect(formFor(earlyHtml, DESKTOP_PAGE_PATHS.signIn).fields.email).toBe('carol@example.com');

    // The verification link comes back to this authorize request.
    const verified = await b.request(lastLink(b, 'carol@example.com'));
    expect(verified.status).toBe(302);
    const back = sameOriginPath(verified.headers.get('location'));
    expect(back.startsWith(`${DESKTOP_AUTHORIZE_PATH}?`)).toBe(true);
    const backPage = await page(b, back);
    expect(backPage.res.status).toBe(200);
    expect(backPage.html).toMatch(/email is confirmed/i);

    const signedIn = await submit(b, formFor(backPage.html, DESKTOP_PAGE_PATHS.signIn), { email: 'carol@example.com', password: PASSWORD });
    expect(signedIn.status).toBe(303);
    expect(sameOriginPath(signedIn.headers.get('location'))).toBe(authorizePath(p.params));
    const cookie = cookieFrom(signedIn);
    expect(cookie).not.toBe('');
    expect((await page(b, authorizePath(p.params), cookie)).html).toContain('Continue to frost as');

    // A wrong password re-shows the form with a message.
    const wrong = await submit(b, formFor(start, DESKTOP_PAGE_PATHS.signIn), { email: 'carol@example.com', password: 'not the password at all' });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toMatch(/email or password/i);
  });

  it('magic-link-round-trip', async () => {
    const b = await open();
    const p = pending();
    const start = (await page(b, authorizePath(p.params))).html;
    const sent = await submit(b, formFor(start, DESKTOP_PAGE_PATHS.magicLink), { email: 'bob@example.com' });
    expect(sent.status).toBe(200);
    const sentHtml = await sent.text();
    expect(sentHtml).toMatch(/check your email/i);
    expect(sentHtml).toContain('bob@example.com');

    const link = lastLink(b, 'bob@example.com');
    const followed = await b.request(link);
    expect(followed.status).toBe(302);
    expect(sameOriginPath(followed.headers.get('location'))).toBe(authorizePath(p.params));
    const cookie = cookieFrom(followed);
    const landed = await page(b, authorizePath(p.params), cookie);
    expect(landed.html).toContain('Continue to frost as');
    expect(landed.html).toContain('bob@example.com');
    // And Continue works from there.
    const code = await continueWith(b, cookie, p);
    expect((await exchange(b, tokenRequest(p, code))).status).toBe(200);

    // A used link comes back to the same page with a fixed message (never better-auth's text).
    const reused = await b.request(link);
    expect(reused.status).toBe(302);
    const errorPath = sameOriginPath(reused.headers.get('location'));
    expect(new URL(errorPath, BASE_URL).searchParams.get('error')).not.toBeNull();
    const errorPage = await page(b, errorPath);
    expect(errorPage.res.status).toBe(200);
    expect(errorPage.html).toMatch(/link did not work/i);
    const description = new URL(errorPath, BASE_URL).searchParams.get('error_description');
    if (description) expect(errorPage.html).not.toContain(escapeHtml(description));
    expect(formsIn(errorPage.html).some((f) => f.action === DESKTOP_PAGE_PATHS.magicLink)).toBe(true);
  });

  it('page-sign-out', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const continuePage = (await page(b, authorizePath(p.params), cookie)).html;
    const out = await submit(b, formFor(continuePage, DESKTOP_PAGE_PATHS.signOut), {}, { cookie });
    expect(out.status).toBe(303);
    expect(sameOriginPath(out.headers.get('location'))).toBe(authorizePath(p.params));
    expect(out.headers.getSetCookie().some((line) => /session_token=;|max-age=0/i.test(line))).toBe(true);
    expect((await b.request(SESSION_PATH, { headers: { cookie } })).status).toBe(401);
    expect((await page(b, authorizePath(p.params), cookie)).html).toMatch(/sign in to frost/i);
  });

  it('page-forms-need-same-origin', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const sent = b.email.messages.length;
    const p = pending();
    const fields = { ...p.params, name: 'Eve', email: 'alice@example.com', password: PASSWORD };
    for (const path of Object.values(DESKTOP_PAGE_PATHS)) {
      for (const headers of [{ origin: EVIL }, { origin: 'null' }, { origin: BASE_URL, 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
        const res = await b.request(path, formPost(fields, { cookie, ...headers }));
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
        expect(res.headers.get('location')).toBeNull();
        expect(cookieFrom(res)).toBe('');
      }
      // No Origin at all (b.app.request adds none).
      const bare = await b.app.request(`${BASE_URL}${path}`, formPost(fields, { cookie }));
      expect(bare.status).toBe(403);
    }
    expect(b.email.messages.length).toBe(sent);
    expect((await b.request(SESSION_PATH, { headers: { cookie } })).status).toBe(200);
  });
});

describe('continue', () => {
  it('continue-issues-code', async () => {
    const clock = fakeClock();
    const b = await open({ now: clock.now });
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const res = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...p.params }, { cookie }));
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    const location = res.headers.get('location') ?? '';
    // Exactly the redirect, then the code and the state: nothing else is added.
    const match = new RegExp(`^${REDIRECT.replace(/[.]/g, '\\.')}\\?code=([A-Za-z0-9_-]{43})&state=([A-Za-z0-9_-]+)$`).exec(location);
    expect(match, location).not.toBeNull();
    const code = match?.[1] ?? '';
    expect(match?.[2]).toBe(p.params.state);

    const rows = await queryRows<{ code_hash: string; user_id: string; code_challenge: string; redirect_uri: string; ttl: number; consumed: boolean }>(
      b.database.db,
      sql`SELECT c.code_hash, c.user_id, c.code_challenge, c.redirect_uri, extract(epoch FROM c.expires_at - c.created_at)::int AS ttl, c.consumed_at IS NOT NULL AS consumed
          FROM desktop_codes c`,
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(row?.code_challenge).toBe(p.params.code_challenge);
    expect(row?.redirect_uri).toBe(REDIRECT);
    expect(row?.ttl).toBe(DESKTOP_CODE_TTL_SECONDS);
    expect(row?.consumed).toBe(false);
    const [user] = await queryRows<{ id: string }>(b.database.db, sql`SELECT id FROM users WHERE email = 'alice@example.com'`);
    expect(row?.user_id).toBe(user?.id);

    // Two Continues are two codes.
    expect(await continueWith(b, cookie, p)).not.toBe(code);
  });

  it('continue-refuses-cross-site', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    for (const headers of [
      { origin: EVIL },
      { origin: 'null' },
      { origin: 'http://127.0.0.1:8788' },
      { origin: BASE_URL, 'sec-fetch-site': 'cross-site' },
      { origin: BASE_URL, 'sec-fetch-site': 'same-site' },
    ] as Record<string, string>[]) {
      const res = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...p.params }, { cookie, ...headers }));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    }
    for (const headers of [{ cookie }, { cookie, 'sec-fetch-site': 'same-origin' }] as Record<string, string>[]) {
      const bare = await b.app.request(`${BASE_URL}${DESKTOP_AUTHORIZE_PATH}`, formPost({ ...p.params }, headers));
      expect(bare.status).toBe(403);
      expect(bare.headers.get('location')).toBeNull();
    }
    expect(await count(b, 'desktop_codes')).toBe(0);
    // The same request from the page itself works.
    await continueWith(b, cookie, p);
    expect(await count(b, 'desktop_codes')).toBe(1);
  });

  it('continue-needs-web-session', async () => {
    const b = await open();
    const p = pending();
    const res = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...p.params }));
    expect(res.status).toBe(303);
    expect(sameOriginPath(res.headers.get('location'))).toBe(authorizePath(p.params));
    const bogus = await b.request(DESKTOP_AUTHORIZE_PATH, formPost({ ...p.params }, { cookie: 'frost.session_token=forged.value' }));
    expect(bogus.status).toBe(303);
    expect(sameOriginPath(bogus.headers.get('location'))).toBe(authorizePath(p.params));
    expect(await count(b, 'desktop_codes')).toBe(0);
  });
});

describe('token exchange', () => {
  it('desktop-full-flow', async () => {
    const b = await open();
    const p = pending();
    // The browser: sign up, confirm the address, sign in, Continue.
    const start = (await page(b, authorizePath(p.params))).html;
    expect((await submit(b, formFor(start, DESKTOP_PAGE_PATHS.signUp), { name: 'Alice', email: 'alice@example.com', password: PASSWORD })).status).toBe(200);
    const back = sameOriginPath((await b.request(lastLink(b, 'alice@example.com'))).headers.get('location'));
    const signedIn = await submit(b, formFor((await page(b, back)).html, DESKTOP_PAGE_PATHS.signIn), { email: 'alice@example.com', password: PASSWORD });
    expect(signedIn.status).toBe(303);
    const cookie = cookieFrom(signedIn);
    const continuePage = (await page(b, sameOriginPath(signedIn.headers.get('location')), cookie)).html;
    const proceed = await submit(b, formFor(continuePage, DESKTOP_AUTHORIZE_PATH), {}, { cookie });
    expect(proceed.status).toBe(303);
    const callback = new URL(proceed.headers.get('location') ?? '');
    expect(callback.searchParams.get('state')).toBe(p.params.state);
    const code = callback.searchParams.get('code') ?? '';

    // The desktop: exchange with no cookie, then use the bearer.
    const [user] = await queryRows<{ id: string }>(b.database.db, sql`SELECT id FROM users WHERE email = 'alice@example.com'`);
    await setPlan(b.database.db, user?.id ?? '', 'pro');
    const before = Date.now();
    const res = await b.app.request(`${BASE_URL}${DESKTOP_TOKEN_PATH}`, jsonPost(tokenRequest(p, code)));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(cookieFrom(res)).toBe('');
    const answer = DesktopTokenResponseSchema.parse(await res.json());
    expect(answer.user).toEqual({ id: user?.id, email: 'alice@example.com', name: 'Alice' });
    expect(answer.expiresAt).toBeGreaterThanOrEqual(before + DESKTOP_TOKEN_TTL_DAYS * DAY_MS);
    expect(answer.expiresAt).toBeLessThanOrEqual(Date.now() + DESKTOP_TOKEN_TTL_DAYS * DAY_MS);

    const session = await b.request(SESSION_PATH, { headers: bearer(answer.token) });
    expect(session.status).toBe(200);
    expect(SessionResponseSchema.parse(await session.json())).toEqual({ user: answer.user, expiresAt: new Date(answer.expiresAt).toISOString() });

    const entitlements = await b.request(ENTITLEMENTS_PATH, { headers: bearer(answer.token) });
    expect(entitlements.status).toBe(200);
    const { snapshot } = EntitlementsResponseSchema.parse(await entitlements.json());
    const { payload } = await jwtVerify(snapshot, createLocalJWKSet(b.signingKey.jwks), {
      algorithms: [ENTITLEMENT_ALG],
      issuer: ENTITLEMENT_ISSUER,
      audience: ENTITLEMENT_AUDIENCE,
    });
    const claims = EntitlementClaimsSchema.parse(payload);
    expect(claims.sub).toBe(user?.id);
    expect(claims.features).toEqual([...PLAN_FEATURES.pro]);
  });

  it('token-wrong-verifier-refused', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const code = await continueWith(b, cookie, p);
    await expectInvalidGrant(await exchange(b, tokenRequest(p, code, { code_verifier: pending().verifier })));
    // The failed attempt used the code up.
    await expectInvalidGrant(await exchange(b, tokenRequest(p, code)));
    expect(await count(b, 'desktop_tokens')).toBe(0);
  });

  it('token-reused-code-refused', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const code = await continueWith(b, cookie, p);
    const first = await exchange(b, tokenRequest(p, code));
    expect(first.status).toBe(200);
    const { token } = DesktopTokenResponseSchema.parse(await first.json());
    expect((await b.request(SESSION_PATH, { headers: bearer(token) })).status).toBe(200);
    await expectInvalidGrant(await exchange(b, tokenRequest(p, code)));
    // RFC 6749 §4.1.2: a replayed code revokes what it issued.
    expect((await b.request(SESSION_PATH, { headers: bearer(token) })).status).toBe(401);
    // An unknown (never issued) code is the same answer.
    await expectInvalidGrant(await exchange(b, tokenRequest(p, randomBytes(32).toString('base64url'))));
  });

  it('token-expired-code-refused', async () => {
    const clock = fakeClock();
    const b = await open({ now: clock.now });
    const cookie = await signedInWithPassword(b);
    const late = pending();
    const lateCode = await continueWith(b, cookie, late);
    clock.advance(DESKTOP_CODE_TTL_SECONDS * 1000 + 1000);
    await expectInvalidGrant(await exchange(b, tokenRequest(late, lateCode)));

    const inTime = pending();
    const inTimeCode = await continueWith(b, cookie, inTime);
    clock.advance(DESKTOP_CODE_TTL_SECONDS * 1000 - 1000);
    expect((await exchange(b, tokenRequest(inTime, inTimeCode))).status).toBe(200);
  });

  it('token-other-redirect-refused', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const code = await continueWith(b, cookie, p);
    await expectInvalidGrant(await exchange(b, tokenRequest(p, code, { redirect_uri: `http://127.0.0.1:${PORT + 1}/callback` })));
    await expectInvalidGrant(await exchange(b, tokenRequest(p, code)));
  });

  it('token-malformed-request', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const code = await continueWith(b, cookie, p);
    const good = tokenRequest(p, code);
    const { code_verifier: _v, ...withoutVerifier } = good;
    const requests: RequestInit[] = [
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(good) },
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(good as Record<string, string>).toString() },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([good]) },
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...good, padding: 'x'.repeat(20_000) }) },
      jsonPost({ ...good, grant_type: 'password' }),
      jsonPost({ ...good, code_verifier: 'v'.repeat(42) }),
      jsonPost({ ...good, code_verifier: `${'v'.repeat(42)} ` }),
      jsonPost(withoutVerifier),
      jsonPost({ ...good, redirect_uri: `http://localhost:${PORT}/callback` }),
    ];
    for (const init of requests) {
      const res = await b.request(DESKTOP_TOKEN_PATH, init);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
    // A malformed request does not use the code up.
    expect((await exchange(b, good)).status).toBe(200);
    // GET is not the exchange.
    expect((await b.request(DESKTOP_TOKEN_PATH)).status).toBe(404);
  });

  it('token-rate-limited', async () => {
    const b = await open();
    const junk = { grant_type: 'authorization_code', code: 'c'.repeat(43), code_verifier: 'v'.repeat(43), redirect_uri: REDIRECT };
    for (let i = 0; i < DESKTOP_RATE_LIMITS.token.max; i += 1) expect((await exchange(b, junk)).status).toBe(400);
    const limited = await exchange(b, junk);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client is not locked out.
    expect((await exchange(b, junk, { [TEST_PEER_HEADER]: '198.51.100.7' })).status).toBe(400);
  });

  it('tokens-stored-hashed', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const p = pending();
    const code = await continueWith(b, cookie, p);
    const res = await exchange(b, tokenRequest(p, code));
    const { token } = DesktopTokenResponseSchema.parse(await res.json());
    const tables = await queryRows<{ table_name: string }>(b.database.db, sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(['desktop_codes', 'desktop_tokens']));
    let everything = '';
    for (const { table_name } of tables) {
      const rows = await queryRows<{ row: string }>(b.database.db, sql.raw(`SELECT t::text AS row FROM "${table_name}" t`));
      everything += rows.map((r) => r.row).join('\n');
    }
    const secretPart = token.replace(/^frost_dt_/, '');
    for (const secret of [code, token, secretPart, p.verifier]) expect(everything).not.toContain(secret);
    expect(everything).toContain(createHash('sha256').update(token).digest('hex'));
    // The database refuses anything but a hash.
    const [user] = await queryRows<{ id: string }>(b.database.db, sql`SELECT id FROM users LIMIT 1`);
    await expect(
      b.database.db.execute(sql`INSERT INTO desktop_tokens (token_hash, user_id, expires_at) VALUES (${token}, ${user?.id}, now() + interval '1 day')`),
    ).rejects.toThrow();
  });
});

describe('desktop tokens', () => {
  it('bearer-expired-or-revoked-401', async () => {
    const clock = fakeClock();
    const b = await open({ now: clock.now });
    const cookie = await signedInWithPassword(b);
    const expiring = await desktopToken(b, cookie);
    const revoked = await desktopToken(b, cookie);
    const kept = await desktopToken(b, cookie);
    for (const t of [expiring, revoked, kept]) expect((await b.request(SESSION_PATH, { headers: bearer(t.token) })).status).toBe(200);

    const hash = createHash('sha256').update(revoked.token).digest('hex');
    await b.database.db.execute(sql`UPDATE desktop_tokens SET revoked_at = now() WHERE token_hash = ${hash}`);
    for (const path of [SESSION_PATH, ENTITLEMENTS_PATH]) {
      const res = await b.request(path, { headers: bearer(revoked.token) });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
      // A revoked bearer never falls back to the cookie riding along.
      expect((await b.request(path, { headers: { ...bearer(revoked.token), cookie } })).status).toBe(401);
    }
    expect((await b.request(SESSION_PATH, { headers: bearer(kept.token) })).status).toBe(200);

    clock.advance(DESKTOP_TOKEN_TTL_DAYS * DAY_MS + 1000);
    for (const t of [expiring, kept]) {
      for (const path of [SESSION_PATH, ENTITLEMENTS_PATH]) expect((await b.request(path, { headers: bearer(t.token) })).status).toBe(401);
    }
    // A well-formed token that was never issued.
    expect((await b.request(SESSION_PATH, { headers: bearer(`frost_dt_${randomBytes(32).toString('base64url')}`) })).status).toBe(401);
  });

  it('sign-out-revokes-idempotent', async () => {
    const b = await open();
    const cookie = await signedInWithPassword(b);
    const mine = await desktopToken(b, cookie);
    const other = await desktopToken(b, cookie);
    const out = await b.request(SIGN_OUT_PATH, { method: 'POST', headers: bearer(mine.token) });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
    expect(out.headers.get('cache-control')).toBe('no-store');
    expect((await b.request(SESSION_PATH, { headers: bearer(mine.token) })).status).toBe(401);
    expect((await b.request(SIGN_OUT_PATH, { method: 'POST', headers: bearer(mine.token) })).status).toBe(204);
    // Only that token: the account's other desktop token and its web session still work.
    expect((await b.request(SESSION_PATH, { headers: bearer(other.token) })).status).toBe(200);
    expect((await b.request(SESSION_PATH, { headers: { cookie } })).status).toBe(200);
    // Bearer only.
    expect((await b.request(SIGN_OUT_PATH, { method: 'POST' })).status).toBe(401);
    expect((await b.request(SIGN_OUT_PATH, { method: 'POST', headers: { cookie } })).status).toBe(401);
    expect((await b.request(SIGN_OUT_PATH, { method: 'POST', headers: { authorization: 'Basic abc' } })).status).toBe(401);
    expect((await b.request(SIGN_OUT_PATH, { method: 'POST', headers: bearer('frost_dt_unknown') })).status).toBe(204);
    expect((await b.request(SESSION_PATH, { headers: { cookie } })).status).toBe(200);
  });
});
