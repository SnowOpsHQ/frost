// Specs: specs/telemetry-consent.schema.ts (TELEMETRY_CONFIG_ENV, TelemetryStateSchema, TELEMETRY_CONSENT_FILE,
// TelemetryConsentFileSchema, RENDERER_ERROR_MECHANISMS), specs/telemetry-privacy.spec.ts (TELEMETRY_LIMITS,
// RESOURCE_ATTRIBUTE_KEYS), specs/ipc-transport.spec.ts (IPC_BRIDGE_KEY)
// Acceptance: specs/telemetry.feature.md (Desktop, End to end) · review focus "Telemetry UI matches behaviour"
// (`nothing-sent-before-consent`, `off-stops-export-immediately`, `events-are-scrubbed`)
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import {
  RENDERER_ERROR_MECHANISMS,
  TELEMETRY_CONFIG_ENV,
  TELEMETRY_TEST_ENV,
  TELEMETRY_CONSENT_FILE,
  TelemetryConsentFileSchema,
  TelemetryStateSchema,
  type TelemetryState,
} from '@app/specs/telemetry-consent.schema';
import { MIN_LITERAL_REDACTION_CHARS, MIN_UNBOUNDED_LITERAL_CHARS, RESOURCE_ATTRIBUTE_KEYS, TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';
import { envelopeEvents, spanNames, startFakeTelemetry, type FakeTelemetry } from './fake-telemetry';
import { APP_DIR, closeApp, launchApp } from './harness';

test.describe.configure({ mode: 'serial' });

let fake: FakeTelemetry;
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;

/** Long enough for a span to be exported (`exportDelayMs`) and an error's queue to drain. */
const QUIET_MS = TELEMETRY_LIMITS.exportDelayMs + 2_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** This machine's names (the package redacts them by default) and the checkout's path. */
const HOST_NAME = os.hostname();
const HOST_LABEL = HOST_NAME.split('.')[0] ?? '';
const USER_NAME = os.userInfo().username;
const COOKIE_VALUE = 'frost-e2e-cookie-0123456789';

/** What a renderer or main error carries: none of it may arrive. */
const PRIVATE = ['private-site.example.com', 'alice@example.com', '/home/alice', 'secret-project', 'token=abc123', APP_DIR, COOKIE_VALUE];
/**
 * The machine's names, planted in parentheses. A name of `MIN_UNBOUNDED_LITERAL_CHARS` or more must not
 * appear anywhere; a shorter one is redacted only as a whole word (it may be part of other words), so
 * its planted `(name)` must not; one shorter than `MIN_LITERAL_REDACTION_CHARS` is not redacted.
 */
const MACHINE = [...new Set([HOST_NAME, HOST_LABEL, USER_NAME])].filter((name) => name.length >= MIN_LITERAL_REDACTION_CHARS);
const machineLeaks = (body: string): string[] =>
  MACHINE.filter((name) => (name.length >= MIN_UNBOUNDED_LITERAL_CHARS ? body.includes(name) : body.includes(`(${name})`)));
const privateMessage = (where: string) =>
  `${where} failed for https://private-site.example.com/account?token=abc123 (alice@example.com) at /home/alice/secret-project/notes.txt ` +
  `on (${HOST_NAME}) (${HOST_LABEL}) as (${USER_NAME}) in ${APP_DIR}/src/main/index.ts`;

async function launch(env: Readonly<Record<string, string>> = {}): Promise<void> {
  ({ app, page } = await launchApp([], {
    userDataDir: profile,
    env: { [TELEMETRY_CONFIG_ENV.otelEndpoint]: fake.otelEndpoint, [TELEMETRY_CONFIG_ENV.sentryDsn]: fake.sentryDsn, ...env },
  }));
}

/** Holds span batches back for the whole run (tests only, unpackaged): a span waits in the queue until quitting flushes it. */
const HOLD_BATCHES = { [TELEMETRY_TEST_ENV.exportDelayMs]: String(TELEMETRY_LIMITS.maxExportDelayMs) };

/** Calls a `telemetry.*` procedure from the chrome page, as the renderer would. */
async function call(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: `telemetry.${name}`, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  if (!response.result) throw new Error(`telemetry.${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

const telemetryState = async (): Promise<TelemetryState> => TelemetryStateSchema.parse(await call('query', 'state'));
/** A real click in the chrome (a trusted input: the user gesture turning a channel on needs). */
const realClick = (): Promise<void> => page.getByTestId('address').click();
/** `telemetry.setConsent`; turning a channel on follows a real click, as the Settings switch's does. */
const setConsent = async (channel: 'usage' | 'errors', on: boolean): Promise<TelemetryState> => {
  if (on) await realClick();
  return TelemetryStateSchema.parse(await call('mutation', 'setConsent', { channel, on }));
};

/** An uncaught error and an unhandled rejection in the chrome page (its own `window` listeners report them). */
async function rendererErrors(tag: string): Promise<void> {
  await page.evaluate((message) => {
    setTimeout(() => {
      throw new TypeError(message);
    }, 0);
    void Promise.reject(new RangeError(`${message} (rejected)`));
  }, privateMessage(`renderer ${tag}`));
}

/** An unhandled rejection in main (an uncaught exception there would open Electron's error dialog). */
async function mainRejection(tag: string): Promise<void> {
  await app!.evaluate((_electron, message) => {
    void Promise.reject(new Error(message));
  }, privateMessage(`main ${tag}`));
}

const allEvents = () => fake.envelopes().flatMap(envelopeEvents);
const mechanisms = () => allEvents().map((event) => (event['exception'] as { values: { mechanism: { type: string } }[] } | undefined)?.values.at(-1)?.mechanism.type);

test.beforeAll(async () => {
  fake = await startFakeTelemetry();
  profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-telemetry-'));
  await launch();
  // A cookie for the collector's origin in main's session: `credentials: 'omit'` must keep it home.
  await app!.evaluate(({ session }, { url, value }) => session.defaultSession.cookies.set({ url, name: 'frost_e2e', value }), { url: fake.origin, value: COOKIE_VALUE });
  expect(await app!.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).length, fake.origin)).toBe(1);
});

/** What every request frost sent carries: no cookie, no detailed user agent, no locale. */
function expectAnonymousRequests(): void {
  for (const request of fake.posts()) {
    expect(request.headers['cookie']).toBeUndefined();
    expect(request.headers['user-agent']).toBe('frost-telemetry');
    expect(request.headers['accept-language'] ?? '').toBe('');
    expect(request.body).not.toContain(COOKIE_VALUE);
  }
}

test.afterAll(async () => {
  await closeApp(app);
  await fake?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('telemetry-nothing-before-consent', async () => {
  test.setTimeout(60_000);
  expect(await telemetryState()).toEqual({ consent: { usage: false, errors: false }, configured: { usage: true, errors: true }, persisted: true, version: 0 });
  await rendererErrors('default');
  await mainRejection('default');
  // The startup span has ended by now; with the defaults neither it nor the errors leave.
  await wait(QUIET_MS);
  expect(fake.posts()).toEqual([]);
  // A page cannot opt the user in: without a real click, turning a channel on changes nothing.
  expect(TelemetryStateSchema.parse(await call('mutation', 'setConsent', { channel: 'errors', on: true })).consent).toEqual({ usage: false, errors: false });
  expect((await telemetryState()).version).toBe(0);
});

test('telemetry-errors-on-sends-scrubbed', async () => {
  const on = await setConsent('errors', true);
  expect(on).toEqual({ consent: { usage: false, errors: true }, configured: { usage: true, errors: true }, persisted: true, version: 1 });
  await rendererErrors('on');
  await mainRejection('on');
  await expect.poll(mechanisms).toEqual(expect.arrayContaining([RENDERER_ERROR_MECHANISMS.error, RENDERER_ERROR_MECHANISMS.unhandledrejection, 'onunhandledrejection']));
  // Only error events, and none of what they carried about the user or the site.
  expect(fake.traces()).toEqual([]);
  expect(fake.envelopes().length).toBeGreaterThan(0);
  expectAnonymousRequests();
  for (const request of fake.envelopes()) {
    for (const secret of PRIVATE) expect(request.body, secret).not.toContain(secret);
    expect(machineLeaks(request.body)).toEqual([]);
  }
  const messages = allEvents().map((event) => JSON.stringify(event['exception']));
  expect(messages.some((text) => text.includes('renderer on failed for'))).toBe(true);
  expect(messages.some((text) => text.includes('main on failed for'))).toBe(true);
});

test('telemetry-off-stops-at-once', async () => {
  test.setTimeout(90_000);
  const off = await setConsent('errors', false);
  expect(off.consent).toEqual({ usage: false, errors: false });
  const before = fake.posts().length;
  await rendererErrors('off');
  await mainRejection('off');
  await wait(3_000);
  expect(fake.posts().length).toBe(before);
  expect(allEvents().some((event) => JSON.stringify(event).includes(' off failed for'))).toBe(false);

  // End to end, a queued span: start with `usage` on (written before launch) and the batches held back
  // (so nothing here depends on how fast the app launches). First the control: the startup span waits
  // in the queue, and quitting flushes it to the collector.
  const usageOn = () => writeFile(path.join(profile, TELEMETRY_CONSENT_FILE), JSON.stringify({ v: 1, usage: true, errors: false, decidedAt: Date.now() }));
  await closeApp(app);
  app = undefined;
  await usageOn();
  let traces = fake.traces().length;
  await launch(HOLD_BATCHES);
  expect((await telemetryState()).consent).toEqual({ usage: true, errors: false });
  await wait(2_000);
  expect(fake.traces().length).toBe(traces);
  await closeApp(app);
  app = undefined;
  await expect.poll(() => fake.traces().slice(traces).flatMap(spanNames)).toContain('app.start');

  // Then the same start, turned off before quitting: the queued span is dropped, never sent.
  await usageOn();
  traces = fake.traces().length;
  const posts = fake.posts().length;
  await launch(HOLD_BATCHES);
  expect((await setConsent('usage', false)).consent).toEqual({ usage: false, errors: false });
  await closeApp(app);
  app = undefined;
  await wait(2_000);
  expect(fake.posts().length).toBe(posts);
  expect(fake.traces().slice(traces).flatMap(spanNames)).not.toContain('app.start');
  await launch();
});

test('telemetry-consent-persists', async () => {
  test.setTimeout(60_000);
  await setConsent('usage', true);
  await setConsent('errors', true);
  await closeApp(app);
  app = undefined;
  const file = TelemetryConsentFileSchema.parse(JSON.parse(await readFile(path.join(profile, TELEMETRY_CONSENT_FILE), 'utf8')));
  expect(file).toMatchObject({ v: 1, usage: true, errors: true });

  const tracesBefore = fake.traces().length;
  await launch();
  expect((await telemetryState()).consent).toEqual({ usage: true, errors: true });
  // With `usage` on from the start, the startup span arrives at the collector.
  await expect.poll(() => fake.traces().slice(tracesBefore).flatMap(spanNames), { timeout: QUIET_MS + 10_000 }).toContain('app.start');
  const trace = JSON.parse(fake.traces().at(-1)!.body) as { resourceSpans: { resource: { attributes: { key: string }[] } }[] };
  expect(trace.resourceSpans[0]!.resource.attributes.map((a) => a.key).sort()).toEqual([...RESOURCE_ATTRIBUTE_KEYS].sort());
  expectAnonymousRequests();
  for (const request of fake.traces()) expect(machineLeaks(request.body)).toEqual([]);

  // Back off, so the profile ends as it began.
  await setConsent('usage', false);
  await setConsent('errors', false);
});
