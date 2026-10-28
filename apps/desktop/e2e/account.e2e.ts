// Specs: specs/account-state.schema.ts (AccountStateSchema, ACCOUNT_CONFIG_ENV, LOOPBACK_RESPONSE_HEADERS),
// specs/account-api.schema.ts (requestFingerprint, DesktopAuthorizeQuerySchema), specs/entitlements-snapshot.spec.ts,
// specs/secret-store.spec.ts (SECRETS_DIR_NAME, SECRET_FILE_SUFFIX)
// Acceptance: specs/account-signin.feature.md (End to end) · review focus "A website or another app cannot sign
// the user in to someone else's account", "The renderer never sees a token"
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { DesktopAuthorizeQuerySchema, requestFingerprint } from '@app/specs/account-api.schema';
import { ACCOUNT_CONFIG_ENV, AccountStateSchema, LOOPBACK_DONE_PATH, LOOPBACK_RESPONSE_HEADERS, type AccountState } from '@app/specs/account-state.schema';
import { PLAN_FEATURES } from '@app/specs/entitlements-snapshot.spec';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import { SECRET_FILE_SUFFIX, SECRETS_DIR_NAME } from '@app/specs/secret-store.spec';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { closeApp, launchApp } from './harness';

test.describe.configure({ mode: 'serial' });

let backend: FakeBackend;
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;
/** Every account answer the chrome got, serialized: none may carry a secret. */
const answers: string[] = [];

const envFor = (): Record<string, string> => ({
  [ACCOUNT_CONFIG_ENV.apiBaseUrl]: backend.origin,
  [ACCOUNT_CONFIG_ENV.entitlementJwks]: JSON.stringify(backend.jwks),
});

/** Launches the app on the suite's profile, with `shell.openExternal` replaced by a recorder (nothing opens). */
async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], { userDataDir: profile, env: envFor() }));
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __frostOpened: string[] }).__frostOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

const openedUrls = (): Promise<string[]> => app!.evaluate(() => [...(globalThis as unknown as { __frostOpened: string[] }).__frostOpened]);

/** Calls an `account.*` procedure from the chrome page, as the renderer would. */
async function call(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: `account.${name}`, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  answers.push(JSON.stringify(response));
  if (!response.result) throw new Error(`account.${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

const accountState = async (): Promise<AccountState> => AccountStateSchema.parse(await call('query', 'state'));

/** A real click in the chrome (a trusted input: a user gesture in the app window). */
const realClick = (): Promise<void> => page.getByTestId('address').click();

/** Signs in through the whole flow (a real click, the browser leg by `fetch`, the confirmation). */
async function signIn(): Promise<AccountState> {
  const before = (await openedUrls()).length;
  await realClick();
  expect(await call('mutation', 'signIn')).toBe('started');
  await expect.poll(async () => (await openedUrls()).length).toBe(before + 1);
  const authorize = (await openedUrls())[before]!;
  const toLoopback = await fetch(authorize, { redirect: 'manual' });
  expect(toLoopback.status).toBe(303);
  const callback = await fetch(toLoopback.headers.get('location')!, { redirect: 'manual' });
  expect(callback.status).toBe(303);
  await expect.poll(async () => (await accountState()).status).toBe('confirming');
  const confirming = await accountState();
  expect(await call('mutation', 'confirmSignIn', { requestId: confirming.requestId })).toBe(true);
  await expect.poll(async () => (await accountState()).entitlements.status).toBe('active');
  return accountState();
}

test.beforeAll(async () => {
  backend = await startFakeBackend();
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-account-'));
  await launch();
});

test.afterAll(async () => {
  await closeApp(app);
  await backend?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  // No answer the chrome got carried a code or token the backend issued.
  const text = answers.join('\n');
  for (const secret of [...(backend?.codes ?? []), ...(backend?.tokens ?? [])]) expect(text).not.toContain(secret);
});

test('account-sign-in-needs-gesture', async () => {
  await expect.poll(async () => (await accountState()).status).toBe('signed-out');
  expect(await call('mutation', 'signIn')).toBe('needs-gesture');
  expect(await openedUrls()).toEqual([]);
  expect((await accountState()).status).toBe('signed-out');
  expect(backend.challenges).toEqual([]);
});

test('account-sign-in-confirm-is-pro', async () => {
  await realClick();
  expect(await call('mutation', 'signIn')).toBe('started');
  await expect.poll(openedUrls).toHaveLength(1);
  const authorize = new URL((await openedUrls())[0]!);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${backend.origin}/desktop/authorize`);
  const query = DesktopAuthorizeQuerySchema.parse(Object.fromEntries(authorize.searchParams));
  const awaiting = await accountState();
  expect(awaiting).toMatchObject({ status: 'awaiting-browser', fingerprint: requestFingerprint(query.code_challenge) });

  // The test is the browser: the authorize page sends it to the loopback with a code ...
  const toLoopback = await fetch(authorize, { redirect: 'manual' });
  expect(toLoopback.status).toBe(303);
  const callbackUrl = new URL(toLoopback.headers.get('location')!);
  expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(query.redirect_uri);
  // ... a forged state is refused and does not end the request ...
  const forged = new URL(callbackUrl);
  forged.searchParams.set('state', 'forged-state-0123456789');
  expect((await fetch(forged, { redirect: 'manual' })).status).toBe(400);
  // ... the real callback is sent on to a code-free page.
  const callback = await fetch(callbackUrl, { redirect: 'manual' });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('location')).toBe(LOOPBACK_DONE_PATH);
  for (const [name, value] of Object.entries(LOOPBACK_RESPONSE_HEADERS)) expect(callback.headers.get(name), name).toBe(value);
  const done = await fetch(new URL(LOOPBACK_DONE_PATH, callbackUrl));
  expect(done.status).toBe(200);
  const doneText = await done.text();
  expect(doneText).not.toContain(callbackUrl.searchParams.get('code')!);
  expect(done.headers.get('referrer-policy')).toBe('no-referrer');

  // Confirmation in the app: the account named, nothing entitled yet.
  await expect.poll(async () => (await accountState()).status).toBe('confirming');
  const confirming = await accountState();
  expect(confirming).toMatchObject({ user: { email: backend.user.email, name: backend.user.name }, entitlements: { plan: 'free', status: 'none' } });
  expect(confirming.fingerprint).toBe(awaiting.fingerprint);
  expect(await call('query', 'entitlements')).toMatchObject({ plan: 'free', features: [] });
  expect(await call('mutation', 'confirmSignIn', { requestId: 'AAAAAAAAAAAAAAAAAAAAAA' })).toBe(false);
  expect(await call('mutation', 'confirmSignIn', { requestId: confirming.requestId })).toBe(true);

  await expect.poll(async () => (await accountState()).entitlements.status).toBe('active');
  const signedIn = await accountState();
  expect(signedIn).toMatchObject({ status: 'signed-in', user: { email: backend.user.email }, requestId: null, fingerprint: null });
  expect(signedIn.entitlements.plan).toBe('pro');
  expect([...signedIn.entitlements.features].sort()).toEqual([...PLAN_FEATURES.pro].sort());
  expect(await call('query', 'entitlements')).toMatchObject({ plan: 'pro', status: 'active' });
  // The listener is gone.
  await expect.poll(() => fetch(callbackUrl).then(() => 'open', () => 'closed')).toBe('closed');
});

test('account-restart-keeps-account-only-with-keychain', async () => {
  const { keychain } = await accountState();
  // Under Playwright, Linux is always memory-only: its Electron loader appends `--password-store=basic`
  // (and `--use-mock-keychain` on macOS, where the mock keychain is persistent).
  test.info().annotations.push({ type: 'keychain', description: keychain });
  await closeApp(app);
  await launch();
  if (keychain === 'persistent') {
    await expect.poll(async () => (await accountState()).entitlements.status).toBe('active');
    expect(await accountState()).toMatchObject({ status: 'signed-in', keychain: 'persistent', entitlements: { plan: 'pro' } });
  } else {
    // No real keychain (Linux CI without a keyring): kept for that run only, so signed out now.
    expect(await accountState()).toMatchObject({ status: 'signed-out', keychain: 'memory-only', entitlements: { plan: 'free' } });
  }
});

test('account-tampered-snapshot-is-free', async () => {
  if ((await accountState()).status !== 'signed-in') await signIn();
  // A snapshot changed after signing, from the server: refused, free.
  backend.mode = 'tampered';
  expect(await call('mutation', 'refresh')).toBe(true);
  expect((await accountState()).entitlements).toMatchObject({ plan: 'free', features: [], status: 'invalid' });
  backend.mode = 'ok';
  expect(await call('mutation', 'refresh')).toBe(true);
  expect((await accountState()).entitlements).toMatchObject({ plan: 'pro', status: 'active' });

  // A stored snapshot changed on disk (only with a keychain: memory-only writes nothing).
  if ((await accountState()).keychain !== 'persistent') return;
  const file = path.join(profile, SECRETS_DIR_NAME, `entitlements${SECRET_FILE_SUFFIX}`);
  const plain = await app!.evaluate(({ safeStorage }, b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')), (await readFile(file)).toString('base64'));
  const stored = JSON.parse(plain) as { held: { kind: string; jws: string } };
  expect(stored.held.kind).toBe('snapshot');
  const [header, payload, signature] = stored.held.jws.split('.');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as { exp: number };
  stored.held.jws = `${header}.${Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 365 * 86_400 })).toString('base64url')}.${signature}`;
  const encrypted = await app!.evaluate(({ safeStorage }, text) => safeStorage.encryptString(text).toString('base64'), JSON.stringify(stored));
  await closeApp(app);
  await writeFile(file, Buffer.from(encrypted, 'base64'));
  // The backend is unreachable, so the start-up refresh cannot replace what was read.
  backend.mode = 'down';
  await launch();
  await expect.poll(async () => (await accountState()).status).toBe('signed-in');
  expect((await accountState()).entitlements).toMatchObject({ plan: 'free', features: [], status: 'invalid' });
  expect(await call('query', 'entitlements')).toMatchObject({ plan: 'free', features: [] });
  backend.mode = 'ok';
  expect(await call('mutation', 'refresh')).toBe(true);
  expect((await accountState()).entitlements).toMatchObject({ plan: 'pro', status: 'active' });
});

test('account-sign-out-revokes', async () => {
  if ((await accountState()).status !== 'signed-in') await signIn();
  const token = backend.tokens.at(-1)!;
  expect(await call('mutation', 'signOut')).toBe(true);
  await expect.poll(() => backend.revoked.includes(token)).toBe(true);
  expect(await accountState()).toMatchObject({ status: 'signed-out', user: null, entitlements: { plan: 'free', status: 'none' } });
  expect(await call('query', 'entitlements')).toMatchObject({ plan: 'free', features: [] });
});
