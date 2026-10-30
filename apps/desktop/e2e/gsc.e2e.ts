// Specs: specs/gsc.spec.ts (GSC_SCOPE, GSC_AUTH_PARAMS, GSC_AUTH_FIXED_PARAMS, gscDateRange), specs/gsc.schema.ts
// (GscStatusSchema, GscPerformanceAnswerSchema, GscQueriesAnswerSchema), specs/account-state.schema.ts (ACCOUNT_CONFIG_ENV)
// Acceptance: specs/gsc.feature.md (End to end) · review focus "Search Console asks for read-only access only",
// "The renderer never sees a token"
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT_CONFIG_ENV, AccountStateSchema } from '@app/specs/account-state.schema';
import {
  GSC_AUTH_FIXED_PARAMS,
  GSC_AUTH_PARAMS,
  GSC_LIMITS,
  GSC_SCOPE,
  GscPerformanceAnswerSchema,
  GscQueriesAnswerSchema,
  GscStatusSchema,
  gscDateRange,
  type GscStatus,
} from '@app/specs/gsc.schema';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { FAKE_GSC_CLIENT_SECRET, fakeDateRows, startFakeGoogle, type FakeGoogle } from './fake-google';
import { closeApp, launchApp, startLoopbackServer } from './harness';

test.describe.configure({ mode: 'serial' });

let backend: FakeBackend;
let google: FakeGoogle;
let site: { origin: string; close(): Promise<void> };
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;
/** Every answer the chrome got, and everything main printed: none may carry a secret. */
const answers: string[] = [];
const output: string[] = [];

/** Launches the app with the fakes' configuration and `shell.openExternal` replaced by a recorder (nothing opens). */
async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], {
    userDataDir: profile,
    env: { [ACCOUNT_CONFIG_ENV.apiBaseUrl]: backend.origin, [ACCOUNT_CONFIG_ENV.entitlementJwks]: JSON.stringify(backend.jwks), ...google.env },
  }));
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __frostOpened: string[] }).__frostOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
}

const openedUrls = (): Promise<string[]> => app!.evaluate(() => [...(globalThis as unknown as { __frostOpened: string[] }).__frostOpened]);

/** Calls a procedure from the chrome page, as the renderer would. */
async function call(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: name, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  answers.push(JSON.stringify(response));
  if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

const gscStatus = async (): Promise<GscStatus> => GscStatusSchema.parse(await call('query', 'gsc.status'));

/** A real click in the chrome (a trusted input: a user gesture in the app window). */
const realClick = (): Promise<void> => page.getByTestId('address').click();

test.beforeAll(async () => {
  backend = await startFakeBackend();
  google = await startFakeGoogle();
  site = await startLoopbackServer();
  google.sites = [
    { siteUrl: `${site.origin}/`, permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:example.org', permissionLevel: 'siteUnverifiedUser' },
  ];
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-gsc-'));
  await launch();
});

test.afterAll(async () => {
  await closeApp(app);
  await backend?.close();
  await google?.close();
  await site?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  // No answer the chrome got, and nothing main printed, carried a token, code, verifier or the client secret.
  const answered = answers.join('\n');
  const printed = output.join('');
  for (const secret of [...(google?.codes ?? []), ...(google?.accessTokens ?? []), ...(google?.refreshTokens ?? []), ...(google?.verifiers ?? [])]) {
    expect(answered).not.toContain(secret);
    expect(printed).not.toContain(secret);
  }
  expect(answered).not.toContain(FAKE_GSC_CLIENT_SECRET);
  expect(printed).not.toContain(FAKE_GSC_CLIENT_SECRET);
});

test('gsc-connect-needs-gesture', async () => {
  // Never signed in to frost: Search Console is not gated and needs no account (2026-10-29).
  await expect.poll(async () => (await gscStatus()).configured).toBe(true);
  expect(AccountStateSchema.parse(await call('query', 'account.state')).status).toBe('signed-out');
  expect(await gscStatus()).toMatchObject({ entitled: true, connected: false, connecting: false });
  expect(await call('query', 'gsc.performance', { url: `${site.origin}/page`, scope: 'page', days: 28 })).toEqual({ status: 'unavailable', reason: 'not-connected' });
  const opened = (await openedUrls()).length;
  // No click: nothing opens.
  expect(await call('mutation', 'gsc.connect')).toBe('needs-gesture');
  expect(await openedUrls()).toHaveLength(opened);
  expect(google.authRequests).toEqual([]);
  // Only the fake's own OAuth and API paths count: other local software may probe a new loopback port.
  expect(google.requests.filter((request) => / \/(o\/oauth2\/|token|revoke|webmasters\/)/.test(request))).toEqual([]);
  expect(await gscStatus()).toMatchObject({ connected: false, connecting: false });
});

test('gsc-connect-read-only-and-performance', async () => {
  const before = (await openedUrls()).length;
  await realClick();
  expect(await call('mutation', 'gsc.connect')).toBe('started');
  await expect.poll(async () => (await openedUrls()).length).toBe(before + 1);
  const consent = new URL((await openedUrls())[before]!);
  expect(`${consent.origin}${consent.pathname}`).toBe(google.endpoints.authUrl);
  expect([...consent.searchParams.keys()].sort()).toEqual([...GSC_AUTH_PARAMS].sort());
  for (const [name, value] of Object.entries(GSC_AUTH_FIXED_PARAMS)) expect(consent.searchParams.get(name), name).toBe(value);
  expect(consent.searchParams.get('scope')).toBe(GSC_SCOPE);
  expect((await gscStatus()).connecting).toBe(true);

  // The test is the browser: the consent page sends it to the loopback with a code, which is sent on.
  const toLoopback = await fetch(consent, { redirect: 'manual' });
  expect(toLoopback.status).toBe(302);
  const callback = await fetch(toLoopback.headers.get('location')!, { redirect: 'manual' });
  expect(callback.status).toBe(303);
  await expect.poll(async () => (await gscStatus()).connected).toBe(true);
  expect(await gscStatus()).toMatchObject({ connecting: false, error: null, entitled: true });
  expect(google.verifiers).toHaveLength(1);

  // A page on the loopback test site: its URL-prefix property's rows.
  const pageUrl = `${site.origin}/blog/post`;
  const range = gscDateRange(28, Date.now());
  const performance = GscPerformanceAnswerSchema.parse(await call('query', 'gsc.performance', { url: `${pageUrl}#top`, scope: 'page', days: 28 }));
  expect(performance).toMatchObject({ status: 'ok', property: { siteUrl: `${site.origin}/`, kind: 'url-prefix' }, scope: 'page', range });
  if (performance.status !== 'ok') throw new Error('not ok');
  expect(performance.rows).toEqual(fakeDateRows(range.start).map((row) => ({ date: row.keys[0], clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position })));
  expect(performance.totals).toMatchObject({ clicks: 60, impressions: 600 });
  const query = google.queries.at(-1)!;
  expect(query.siteUrl).toBe(`${site.origin}/`);
  expect(query.body).toMatchObject({ startDate: range.start, endDate: range.end, dimensions: ['date'], dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }] }] });

  // The whole property: no page filter.
  expect(await call('query', 'gsc.performance', { url: pageUrl, scope: 'property', days: 7 })).toMatchObject({ status: 'ok', scope: 'property' });
  expect(google.queries.at(-1)!.body).not.toHaveProperty('dimensionFilterGroups');

  const queries = GscQueriesAnswerSchema.parse(await call('query', 'gsc.topQueries', { url: pageUrl, scope: 'page', days: 28 }));
  expect(queries).toMatchObject({ status: 'ok', property: { siteUrl: `${site.origin}/` } });
  if (queries.status !== 'ok') throw new Error('not ok');
  expect(queries.rows).toHaveLength(GSC_LIMITS.maxTopQueries);
  expect(queries.rows[0]?.query).toBe('fake query 1');

  // The unverified property is not listed; another host has no property.
  expect(await call('query', 'gsc.properties')).toEqual({ status: 'ok', properties: [{ siteUrl: `${site.origin}/`, kind: 'url-prefix', permissionLevel: 'siteOwner' }] });
  expect(await call('query', 'gsc.performance', { url: 'https://example.org/', scope: 'page', days: 28 })).toEqual({ status: 'unavailable', reason: 'no-property' });
});

test('gsc-disconnect-revokes', async () => {
  const refresh = google.refreshTokens.at(-1)!;
  expect(await call('mutation', 'gsc.disconnect')).toBe(true);
  await expect.poll(() => google.revoked.includes(refresh)).toBe(true);
  expect(await gscStatus()).toMatchObject({ connected: false, connecting: false, error: null });
  expect(await call('query', 'gsc.performance', { url: `${site.origin}/blog/post`, scope: 'page', days: 28 })).toEqual({ status: 'unavailable', reason: 'not-connected' });
  expect(await call('mutation', 'gsc.disconnect')).toBe(false);
});
