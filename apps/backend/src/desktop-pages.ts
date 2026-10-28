import { createHash } from 'node:crypto';
import {
  DESKTOP_AUTHORIZE_PATH,
  DESKTOP_PAGE_PATHS,
  MAGIC_LINK_TTL_SECONDS,
  PASSWORD_LIMITS,
  requestFingerprint,
  type DesktopAuthorizeQuery,
} from '@app/specs/account-api.schema';

// The browser pages of desktop sign-in (spec `account-backend.feature.md`, Desktop authorization).
// Hand-written, frost's own words, no script. Every interpolated value goes through `html`, which
// escapes it; only fragments built by `html` itself pass through unescaped. The one stylesheet is
// inline and allowed by its hash in the page's CSP, so `style-src` needs no `'unsafe-inline'`.

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text → HTML text or a double- or single-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Markup built by `html`: the only thing interpolated without escaping. */
class Markup {
  constructor(readonly text: string) {}
}

type Value = Markup | string | number | null | undefined | false | readonly Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Markup) return value.text;
  if (Array.isArray(value)) return value.map((v: Value) => render(v)).join('');
  return escapeHtml(String(value));
}

function html(strings: TemplateStringsArray, ...values: Value[]): Markup {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    out += render(value) + (strings[i + 1] ?? '');
  });
  return new Markup(out);
}

const CSS = `
:root { color-scheme: light dark; --fg: #1d232b; --muted: #5b6573; --bg: #f4f6f9; --card: #fff; --line: #d8dde5; --accent: #2a5bd7; --accent-fg: #fff; --warn: #9a3412; --ok: #166534; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6e9ee; --muted: #9aa4b2; --bg: #12161c; --card: #1b2129; --line: #2e3742; --accent: #6d95ff; --accent-fg: #0b1020; --warn: #fdba74; --ok: #86efac; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: min(26rem, calc(100vw - 2rem)); margin: 2rem 0; padding: 1.75rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
h1 { margin: 0 0 .5rem; font-size: 1.3rem; line-height: 1.3; overflow-wrap: anywhere; }
p { margin: .5rem 0; } .muted { color: var(--muted); font-size: .9rem; }
.notice, .problem { padding: .6rem .75rem; border-radius: 8px; border: 1px solid var(--line); }
.notice { color: var(--ok); } .problem { color: var(--warn); }
.email { font-weight: 600; overflow-wrap: anywhere; }
.fingerprint { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 1.05rem; letter-spacing: .08em; white-space: nowrap; }
form { margin: 1rem 0 0; display: grid; gap: .6rem; }
label { display: grid; gap: .2rem; font-size: .9rem; }
input { font: inherit; padding: .5rem .6rem; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
button { font: inherit; font-weight: 600; padding: .55rem .9rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
button.link { padding: 0; background: none; color: var(--accent); font-weight: 400; text-decoration: underline; }
details { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: .75rem; }
summary { cursor: pointer; color: var(--accent); }
.inline { display: flex; gap: .4rem; align-items: baseline; margin-top: 1rem; }
a { color: var(--accent); }
`;

const STYLE_HASH = `'sha256-${createHash('sha256').update(CSS).digest('base64')}'`;

/** A page body and the extra `form-action` sources its forms need (the loopback, on Continue). */
export interface Page {
  readonly html: string;
  readonly formTargets?: readonly string[] | undefined;
}

/** The page's `Content-Security-Policy`: nothing but its own stylesheet, its own forms, never framed. */
export function pageCsp(page: Page): string {
  return [
    "default-src 'none'",
    `style-src ${STYLE_HASH}`,
    ['form-action', "'self'", ...(page.formTargets ?? [])].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

function layout(title: string, body: Markup, formTargets?: readonly string[]): Page {
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${title} · frost</title>
<style>${new Markup(CSS)}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
  return { html: doc.text, formTargets };
}

const AUTHORIZE_KEYS = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method'] as const satisfies readonly (keyof DesktopAuthorizeQuery)[];

/** The authorize request as a query string, in a fixed order. */
export function authorizeQuery(params: DesktopAuthorizeQuery, extra: Readonly<Record<string, string>> = {}): string {
  const query = new URLSearchParams();
  for (const key of AUTHORIZE_KEYS) query.set(key, params[key]);
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

/** `DESKTOP_AUTHORIZE_PATH` with the request's parameters (a same-origin path). */
export const authorizePath = (params: DesktopAuthorizeQuery, extra?: Readonly<Record<string, string>>): string =>
  `${DESKTOP_AUTHORIZE_PATH}?${authorizeQuery(params, extra)}`;

const hidden = (params: DesktopAuthorizeQuery): Markup[] => AUTHORIZE_KEYS.map((key) => html`<input type="hidden" name="${key}" value="${params[key]}">`);

const caution = html`<p class="muted">Only continue if you just chose <strong>Sign in</strong> in the frost app on this computer.</p>`;

// ---- Signed out ---------------------------------------------------------------------------------

export type SignInSection = 'password' | 'magic-link' | 'sign-up';

export interface SignInPageOptions {
  readonly params: DesktopAuthorizeQuery;
  /** A fixed message from the handler (never text from a request or from better-auth). */
  readonly problem?: string | undefined;
  readonly notice?: 'verified' | 'link-failed' | undefined;
  /**
   * The browser is signed in as this address, but not recently enough to Continue
   * (`DESKTOP_RECENT_AUTH_SECONDS`): ask for a fresh sign-in, the address filled in.
   */
  readonly signedInAs?: string | undefined;
  /** Which form the message belongs to (it is opened). */
  readonly section?: SignInSection | undefined;
  /** What the user typed, shown again (escaped). Never the password. */
  readonly email?: string | undefined;
  readonly name?: string | undefined;
}

const NOTICES = {
  verified: html`<p class="notice">Your email is confirmed. Sign in to continue.</p>`,
  'link-failed': html`<p class="problem">That link did not work: it may have expired or been used already. Ask for a new one below, or sign in with your password.</p>`,
} as const;

export function signInPage(options: SignInPageOptions): Page {
  const { params, problem, notice, signedInAs, section = 'password', name = '' } = options;
  const email = options.email ?? signedInAs ?? '';
  const prefill = (s: SignInSection) => (section === s || (signedInAs !== undefined && s !== 'sign-up') ? email : '');
  const message = (s: SignInSection) => (problem && section === s ? html`<p class="problem" role="alert">${problem}</p>` : '');
  const open = (s: SignInSection) => (section === s ? html` open` : '');
  const passwordHint = `${PASSWORD_LIMITS.minLength} to ${PASSWORD_LIMITS.maxLength} characters`;
  return layout(
    'Sign in',
    html`<h1>Sign in to frost</h1>
<p>The frost app on this computer asked you to sign in.</p>
${caution}
${notice ? NOTICES[notice] : ''}
${signedInAs === undefined ? '' : html`<p class="notice">You are signed in as <span class="email">${signedInAs}</span>, but connecting the frost app needs a fresh sign-in. Sign in again below.</p>`}
${message('password')}
<form method="post" action="${DESKTOP_PAGE_PATHS.signIn}">
${hidden(params)}
<label>Email <input type="email" name="email" value="${prefill('password')}" autocomplete="username" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form>
<details${open('magic-link')}>
<summary>Email me a sign-in link instead</summary>
${message('magic-link')}
<form method="post" action="${DESKTOP_PAGE_PATHS.magicLink}">
${hidden(params)}
<label>Email <input type="email" name="email" value="${prefill('magic-link')}" autocomplete="email" required></label>
<button type="submit">Send link</button>
</form>
</details>
<details${open('sign-up')}>
<summary>Create a frost account</summary>
${message('sign-up')}
<form method="post" action="${DESKTOP_PAGE_PATHS.signUp}">
${hidden(params)}
<label>Name (optional) <input type="text" name="name" value="${section === 'sign-up' ? name : ''}" autocomplete="name" maxlength="200"></label>
<label>Email <input type="email" name="email" value="${prefill('sign-up')}" autocomplete="email" required></label>
<label>Password, ${passwordHint} <input type="password" name="password" autocomplete="new-password" minlength="${PASSWORD_LIMITS.minLength}" maxlength="${PASSWORD_LIMITS.maxLength}" required></label>
<button type="submit">Create account</button>
</form>
</details>`,
  );
}

/** After sign-up (`verify`) or a magic-link request (`magic-link`): the link is in the mail. */
export function checkEmailPage(params: DesktopAuthorizeQuery, email: string, kind: 'verify' | 'magic-link'): Page {
  const what =
    kind === 'verify'
      ? html`<p>Open it to confirm your address. It brings you back here to sign in.</p>`
      : html`<p>Open it in this browser to continue signing in to frost. It works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes.</p>`;
  return layout(
    'Check your email',
    html`<h1>Check your email</h1>
<p>If <span class="email">${email}</span> can receive mail, a link is on its way.</p>
${what}
<p class="muted">Nothing arrived? Check the spam folder, or <a href="${authorizePath(params)}">go back</a> and try again.</p>`,
  );
}

// ---- Signed in ----------------------------------------------------------------------------------

export function continuePage(params: DesktopAuthorizeQuery, email: string): Page {
  // Browsers apply `form-action` to the redirect that follows the form, so the loopback is listed.
  const loopback = new URL(params.redirect_uri).origin;
  return layout(
    'Continue to frost',
    html`<h1>Continue to frost as <span class="email">${email}</span></h1>
<p>The frost app on this computer will be signed in to this account. It asks you to confirm once more.</p>
<p>Check that frost shows the same code: <strong class="fingerprint">${requestFingerprint(params.code_challenge)}</strong>. If you didn't just choose Sign in in frost, close this page.</p>
<p class="muted">Continuing signs this browser out, so the next sign-in needs your password or a new link.</p>
<form method="post" action="${DESKTOP_AUTHORIZE_PATH}">
${hidden(params)}
<button type="submit">Continue</button>
</form>
<form class="inline" method="post" action="${DESKTOP_PAGE_PATHS.signOut}">
${hidden(params)}
<span>Not you?</span> <button class="link" type="submit">Sign out</button>
</form>`,
    [loopback],
  );
}

// ---- Refusals -----------------------------------------------------------------------------------

/** A request that cannot be used: plain text, no form, no link that carries its parameters. */
export function errorPage(title: string, reason: string): Page {
  return layout(
    title,
    html`<h1>${title}</h1>
<p>${reason}</p>
<p class="muted">Go back to the frost app and choose Sign in again.</p>`,
  );
}
