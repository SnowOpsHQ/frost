// Specs: specs/telemetry-consent.schema.ts (TELEMETRY_CONFIG_ENV, TelemetryStateSchema, TELEMETRY_CONSENT_FILE,
// TelemetryConsentFileSchema, RENDERER_ERROR_MECHANISMS), specs/telemetry-privacy.spec.ts (TELEMETRY_LIMITS,
// RESOURCE_ATTRIBUTE_KEYS), specs/ipc-transport.spec.ts (IPC_BRIDGE_KEY)
// Acceptance: specs/telemetry.feature.md (Desktop, End to end) · review focus "Telemetry UI matches behaviour"
// (`nothing-sent-before-consent`, `off-stops-export-immediately`, `events-are-scrubbed`)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import {
  RENDERER_ERROR_MECHANISMS,
  TELEMETRY_CONFIG_ENV,
  TELEMETRY_CONSENT_FILE,
  TelemetryConsentFileSchema,
  TelemetryStateSchema,
  type TelemetryState,
} from '@app/specs/telemetry-consent.schema';
import { RESOURCE_ATTRIBUTE_KEYS, TELEMETRY_LIMITS } from '@app/specs/telemetry-privacy.spec';
import { envelopeEvents, spanNames, startFakeTelemetry, type FakeTelemetry } from './fake-telemetry';
import { closeApp, launchApp } from './harness';

test.describe.configure({ mode: 'serial' });

let fake: FakeTelemetry;
let profile: string;
let app: ElectronApplication | undefined;
let page: Page;

/** Long enough for a span to be exported (`exportDelayMs`) and an error's queue to drain. */
const QUIET_MS = TELEMETRY_LIMITS.exportDelayMs + 2_000;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a renderer or main error carries: none of it may arrive. */
const PRIVATE = ['private-site.example.com', 'alice@example.com', '/home/alice', 'secret-project', 'token=abc123'];
const privateMessage = (where: string) => `${where} failed for https://private-site.example.com/account?token=abc123 (alice@example.com) at /home/alice/secret-project/notes.txt`;

async function launch(): Promise<void> {
  ({ app, page } = await launchApp([], {
    userDataDir: profile,
    env: { [TELEMETRY_CONFIG_ENV.otelEndpoint]: fake.otelEndpoint, [TELEMETRY_CONFIG_ENV.sentryDsn]: fake.sentryDsn },
  }));
}

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
const setConsent = async (channel: 'usage' | 'errors', on: boolean): Promise<TelemetryState> => TelemetryStateSchema.parse(await call('mutation', 'setConsent', { channel, on }));

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
});

test.afterAll(async () => {
  await closeApp(app);
  await fake?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('telemetry-nothing-before-consent', async () => {
  test.setTimeout(60_000);
  expect(await telemetryState()).toEqual({ consent: { usage: false, errors: false }, configured: { usage: true, errors: true }, version: 0 });
  await rendererErrors('default');
  await mainRejection('default');
  // The startup span has ended by now; with the defaults neither it nor the errors leave.
  await wait(QUIET_MS);
  expect(fake.posts()).toEqual([]);
});

test('telemetry-errors-on-sends-scrubbed', async () => {
  const on = await setConsent('errors', true);
  expect(on).toEqual({ consent: { usage: false, errors: true }, configured: { usage: true, errors: true }, version: 1 });
  await rendererErrors('on');
  await mainRejection('on');
  await expect.poll(mechanisms).toEqual(expect.arrayContaining([RENDERER_ERROR_MECHANISMS.error, RENDERER_ERROR_MECHANISMS.unhandledrejection, 'onunhandledrejection']));
  // Only error events, and none of what they carried about the user or the site.
  expect(fake.traces()).toEqual([]);
  for (const request of fake.envelopes()) {
    expect(request.headers['cookie']).toBeUndefined();
    for (const secret of PRIVATE) expect(request.body, secret).not.toContain(secret);
  }
  const messages = allEvents().map((event) => JSON.stringify(event['exception']));
  expect(messages.some((text) => text.includes('renderer on failed for'))).toBe(true);
  expect(messages.some((text) => text.includes('main on failed for'))).toBe(true);
});

test('telemetry-off-stops-at-once', async () => {
  const off = await setConsent('errors', false);
  expect(off.consent).toEqual({ usage: false, errors: false });
  const before = fake.posts().length;
  await rendererErrors('off');
  await mainRejection('off');
  await wait(3_000);
  expect(fake.posts().length).toBe(before);
  expect(allEvents().some((event) => JSON.stringify(event).includes(' off failed for'))).toBe(false);
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

  // Back off, so the profile ends as it began.
  await setConsent('usage', false);
  await setConsent('errors', false);
});
