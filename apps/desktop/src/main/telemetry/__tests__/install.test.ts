// Spec: specs/telemetry-consent.schema.ts (TelemetryStateSchema, RENDERER_ERROR_MECHANISMS), specs/telemetry-privacy.spec.ts
// (DEFAULT_CONSENT, TELEMETRY_LIMITS, RESOURCE_ATTRIBUTE_KEYS, APP_FRAME_PREFIX)
// Acceptance: specs/telemetry.feature.md (Desktop, Main wiring) · review focus "Telemetry UI matches behaviour"
// (`nothing-sent-before-consent`, `off-stops-export-immediately`, `events-are-scrubbed`)
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RENDERER_ERROR_MECHANISMS, TelemetryStateSchema, type RendererErrorInput } from '@app/specs/telemetry-consent.schema';
import { APP_FRAME_PREFIX, DEFAULT_CONSENT, RESOURCE_ATTRIBUTE_KEYS, TELEMETRY_LIMITS, type TelemetryConsent } from '@app/specs/telemetry-privacy.spec';
import type { ConsentStore } from '../consent-store';
import type { TelemetryConfig } from '../config';
import { installTelemetry, TELEMETRY_REQUEST_HEADERS, type TelemetryAppLike, type TelemetryFetch, type TelemetryMain, type TelemetryProcessLike } from '../install';

const OTEL_ENDPOINT = 'https://otel.example.test/v1/traces';
const SENTRY_DSN = 'https://publickey@errors.example.test/42';
const CONFIG: TelemetryConfig = { otelEndpoint: OTEL_ENDPOINT, sentryDsn: SENTRY_DSN };
const APP_ROOT = '/opt/frost/resources/app';

// ---- Fakes ----------------------------------------------------------------------------------------

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function fakeApp(options: { ready?: Promise<unknown> } = {}) {
  const quitListeners: ((event: { preventDefault(): void }) => void)[] = [];
  const app = {
    isPackaged: true,
    getVersion: () => '1.2.3',
    getAppPath: () => APP_ROOT,
    whenReady: vi.fn(() => options.ready ?? Promise.resolve()),
    on: vi.fn((_event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown => {
      quitListeners.push(listener);
      return undefined;
    }),
    quit: vi.fn((): void => undefined),
  } satisfies TelemetryAppLike;
  /** Fires `will-quit` as Electron does; answers whether a listener held it. */
  const willQuit = (): boolean => {
    let held = false;
    for (const listener of [...quitListeners]) listener({ preventDefault: () => (held = true) });
    return held;
  };
  return Object.assign(app, { willQuit });
}

function fakeProcess() {
  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, {
    platform: 'linux',
    versions: { electron: '45.0.0' },
    emitWarning: vi.fn((_warning: string, _type: string) => undefined),
  });
  return proc as typeof proc & TelemetryProcessLike;
}

interface FetchCall {
  url: string;
  init: RequestInit;
  body: string;
}

function fakeFetch() {
  const calls: FetchCall[] = [];
  let mode: 'answer' | 'hang' = 'answer';
  let response = () => new Response(null, { status: 200 });
  const fetch = vi.fn((url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    calls.push({ url, init, body });
    if (mode === 'hang') {
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return Promise.resolve(response());
  }) satisfies TelemetryFetch;
  return {
    fetch,
    calls,
    hang: () => (mode = 'hang'),
    respond: (next: () => Response) => (response = next),
  };
}

function fakeStore(initial: TelemetryConsent = DEFAULT_CONSENT) {
  let current = { ...initial };
  let failing = false;
  const store = {
    consent: () => ({ ...current }),
    write: vi.fn((consent: TelemetryConsent) => {
      current = { ...consent };
      return !failing;
    }),
    /** Makes later writes fail (the disk is then off, as the real store leaves it). */
    failWrites: (on: boolean) => (failing = on),
  } satisfies ConsentStore & Record<string, unknown>;
  return store;
}

interface Setup {
  main: TelemetryMain;
  app: ReturnType<typeof fakeApp>;
  proc: ReturnType<typeof fakeProcess>;
  net: ReturnType<typeof fakeFetch>;
  store: ReturnType<typeof fakeStore>;
  started: ReturnType<typeof deferred>;
}

const installed: TelemetryMain[] = [];
afterEach(async () => {
  vi.useRealTimers();
  // Off drops every queue and timer.
  for (const main of installed.splice(0)) {
    main.service.setConsent('usage', false);
    main.service.setConsent('errors', false);
  }
});

function setup(options: { consent?: TelemetryConsent; config?: TelemetryConfig; ready?: Promise<unknown>; now?: () => number } = {}): Setup {
  const app = fakeApp({ ready: options.ready });
  const proc = fakeProcess();
  const net = fakeFetch();
  const store = fakeStore(options.consent);
  const started = deferred();
  const main = installTelemetry({
    app,
    process: proc,
    fetch: net.fetch,
    store,
    config: options.config ?? CONFIG,
    started: started.promise,
    log: () => undefined,
    redact: [],
    ...(options.now ? { now: options.now } : {}),
  });
  installed.push(main);
  return { main, app, proc, net, store, started };
}

const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Sentry event payloads in the envelopes sent. */
function sentryEvents(calls: FetchCall[]): Record<string, unknown>[] {
  return calls
    .filter((call) => call.url.includes('/envelope/'))
    .flatMap((call) => {
      const lines = call.body.split('\n').filter((line) => line.length > 0);
      const out: Record<string, unknown>[] = [];
      for (let i = 1; i + 1 < lines.length; i += 2) {
        if ((JSON.parse(lines[i]!) as { type: string }).type === 'event') out.push(JSON.parse(lines[i + 1]!) as Record<string, unknown>);
      }
      return out;
    });
}

interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}
interface OtlpSpan {
  name: string;
  attributes: OtlpAttribute[];
}
function otlp(calls: FetchCall[]) {
  const bodies = calls.filter((call) => call.url === OTEL_ENDPOINT).map((call) => JSON.parse(call.body) as { resourceSpans: { resource: { attributes: OtlpAttribute[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] });
  const spans = bodies.flatMap((body) => body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
  const resources = bodies.flatMap((body) => body.resourceSpans.map((rs) => rs.resource.attributes));
  return { spans, resources };
}
const attrs = (list: OtlpAttribute[]) => Object.fromEntries(list.map(({ key, value }) => [key, value['stringValue'] ?? (value['intValue'] !== undefined ? Number(value['intValue']) : (value['doubleValue'] ?? value['boolValue']))]));

const mechanismOf = (event: Record<string, unknown>) => (event['exception'] as { values: { mechanism: { type: string; handled: boolean } }[] }).values.at(-1)!.mechanism;

const RENDERER_ERROR: RendererErrorInput = {
  source: 'error',
  name: 'TypeError',
  message: 'failed to load https://private-site.example.com/account?id=12345 for alice@example.com',
  stack: [
    'TypeError: failed to load https://private-site.example.com/account?id=12345 for alice@example.com',
    '    at render (app://app/assets/index-abc123.js:10:5)',
    '    at /home/alice/projects/secret/file.js:1:1',
  ].join('\n'),
};

// ---- Tests ----------------------------------------------------------------------------------------

describe('telemetry main wiring', () => {
  test('consent-off-sends-nothing', async () => {
    const { main, app, proc, net, started } = setup();
    expect(main.service.state()).toEqual({ consent: { usage: false, errors: false }, configured: { usage: true, errors: true }, persisted: true, version: 0 });
    started.resolve();
    await tick();
    proc.emit('uncaughtExceptionMonitor', new Error('main crash'), 'uncaughtException');
    proc.emit('unhandledRejection', new Error('main rejection'), Promise.resolve());
    main.telemetry.captureException(new Error('handled'));
    main.telemetry.span('seo.audit', { outcome: 'ok' }, () => undefined);
    expect(main.service.reportError(RENDERER_ERROR)).toBe('dropped');
    await main.telemetry.flush({ timeoutMs: 50 });
    await tick(20);
    // Quitting is not held when nothing is on.
    expect(app.willQuit()).toBe(false);
    await tick(20);
    expect(net.fetch).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  test('set-consent-is-synchronous', async () => {
    const { main, net, store, started } = setup();
    started.resolve();
    const on = main.service.setConsent('errors', true);
    // Answered after the store and the telemetry changed, synchronously.
    expect(TelemetryStateSchema.parse(on)).toEqual({ consent: { usage: false, errors: true }, configured: { usage: true, errors: true }, persisted: true, version: 1 });
    expect(store.write).toHaveBeenCalledExactlyOnceWith({ usage: false, errors: true });
    expect(main.telemetry.consent()).toEqual({ usage: false, errors: true });
    expect(main.service.state()).toEqual(on);

    // An event queued for the next macrotask is dropped when `errors` goes off before it leaves.
    main.telemetry.captureException(new Error('queued'));
    const off = main.service.setConsent('errors', false);
    expect(off).toMatchObject({ consent: { usage: false, errors: false }, version: 2 });
    expect(store.write).toHaveBeenLastCalledWith({ usage: false, errors: false });
    expect(main.telemetry.consent().errors).toBe(false);
    await tick(30);
    expect(net.fetch).not.toHaveBeenCalled();

    // The same value again changes nothing (no write, same version).
    expect(main.service.setConsent('errors', false).version).toBe(2);
    expect(store.write).toHaveBeenCalledTimes(2);
    // On again: the next error is sent.
    main.service.setConsent('errors', true);
    main.telemetry.captureException(new Error('after on'));
    await vi.waitFor(() => expect(sentryEvents(net.calls)).toHaveLength(1));

    // A failed write still applies the consent, for this run only (`persisted: false`); a later good write clears it.
    store.failWrites(true);
    expect(main.service.setConsent('usage', true)).toMatchObject({ consent: { usage: true, errors: true }, persisted: false });
    expect(main.telemetry.consent().usage).toBe(true);
    expect(main.service.state().persisted).toBe(false);
    store.failWrites(false);
    expect(main.service.setConsent('usage', false)).toMatchObject({ consent: { usage: false, errors: true }, persisted: true });
  });

  test('off-drops-queued-span', async () => {
    vi.useFakeTimers();
    const { main, net, started } = setup({ consent: { usage: true, errors: false } });
    started.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The `app.start` span is queued (its batch leaves `exportDelayMs` after it ended) ...
    expect(net.fetch).not.toHaveBeenCalled();
    main.service.setConsent('usage', false);
    // ... and turning `usage` off drops it: nothing leaves, at the delay or on flush.
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.exportDelayMs * 2);
    await main.telemetry.flush({ timeoutMs: 10 });
    expect(net.fetch).not.toHaveBeenCalled();
    // Turned on again, the old span stays dropped; only new spans leave.
    main.service.setConsent('usage', true);
    main.telemetry.span('seo.audit', { outcome: 'ok' }, () => undefined);
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.exportDelayMs + 10);
    expect(otlp(net.calls).spans.map((span) => span.name)).toEqual(['seo.audit']);
  });

  test('transport-is-net-fetch', async () => {
    const ready = deferred();
    const { main, net, started } = setup({ consent: { usage: false, errors: true }, ready: ready.promise });
    started.resolve();
    main.telemetry.captureException(new Error('before ready'));
    await tick(30);
    // Nothing goes out before the app is ready (net.fetch needs it).
    expect(net.fetch).not.toHaveBeenCalled();
    net.respond(() => new Response(null, { status: 429, headers: { 'retry-after': '60' } }));
    ready.resolve();
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
    const [call] = net.calls;
    expect(call!.url.startsWith('https://errors.example.test/api/42/envelope/')).toBe(true);
    expect(call!.init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(call!.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call!.init.headers);
    expect(headers.get('content-type')).toBe('application/x-sentry-envelope');
    // Chromium's detailed user agent and the user's locale are replaced.
    expect(TELEMETRY_REQUEST_HEADERS).toEqual({ 'user-agent': 'frost-telemetry', 'accept-language': '' });
    expect(headers.get('user-agent')).toBe('frost-telemetry');
    expect(headers.get('accept-language')).toBe('');
    // `retry-after` reached Sentry: the next event within the minute is not sent.
    main.telemetry.captureException(new Error('rate limited'));
    await tick(30);
    expect(net.fetch).toHaveBeenCalledTimes(1);
  });

  test('crash-behaviour-is-unchanged', async () => {
    const { main, proc, net, started } = setup();
    started.resolve();
    // Electron's default uncaught-exception handler (its dialog) stays: only the monitor is used.
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    // The listener silences Node's `warn`-mode warning, so it emits that warning itself.
    const rejection = new Error('nobody caught me');
    proc.emit('unhandledRejection', rejection, Promise.resolve());
    expect(proc.emitWarning).toHaveBeenCalledExactlyOnceWith(rejection.stack, 'UnhandledPromiseRejectionWarning');
    proc.emit('unhandledRejection', 'a plain reason', Promise.resolve());
    expect(proc.emitWarning).toHaveBeenLastCalledWith('a plain reason', 'UnhandledPromiseRejectionWarning');
    await tick(30);
    expect(net.fetch).not.toHaveBeenCalled();

    // With `errors` on, both are reported, unhandled, with their mechanism; an error seen twice once.
    main.service.setConsent('errors', true);
    const crash = new Error('main crash');
    const rejected = new Error('main rejection');
    proc.emit('uncaughtExceptionMonitor', crash, 'uncaughtException');
    proc.emit('unhandledRejection', rejected, Promise.resolve());
    proc.emit('uncaughtExceptionMonitor', rejected, 'unhandledRejection');
    await vi.waitFor(() => expect(sentryEvents(net.calls)).toHaveLength(2));
    await tick(30);
    const events = sentryEvents(net.calls);
    expect(events).toHaveLength(2);
    expect(events.map(mechanismOf)).toEqual([
      { type: 'onuncaughtexception', handled: false },
      { type: 'onunhandledrejection', handled: false },
    ]);
  });

  test('app-start-span', async () => {
    let clock = 1_000;
    const { main, net, started } = setup({ consent: { usage: true, errors: false }, now: () => clock });
    clock = 1_250;
    await tick();
    await main.telemetry.flush({ timeoutMs: 100 });
    // The span ends when startup completes, not before.
    expect(otlp(net.calls).spans).toEqual([]);
    started.resolve();
    await tick();
    await main.telemetry.flush({ timeoutMs: 1_000 });
    const { spans, resources } = otlp(net.calls);
    expect(spans.map((span) => span.name)).toEqual(['app.start']);
    expect(attrs(spans[0]!.attributes)).toEqual({ platform: 'linux', outcome: 'ok', duration_ms: 250 });
    // The resource is the version and platform only.
    expect(resources.map((list) => list.map((a) => a.key).sort())).toEqual([[...RESOURCE_ATTRIBUTE_KEYS].sort()]);
    expect(attrs(resources[0]!)).toMatchObject({ 'service.version': '1.2.3', 'os.type': 'linux' });
    expect(net.calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(new Headers(net.calls[0]!.init.headers).get('user-agent')).toBe('frost-telemetry');

    // A startup that rejects (main's never does) ends the span as an error, without an outcome, and
    // is not an unhandled rejection.
    const failed = setup({ consent: { usage: true, errors: false } });
    failed.started.reject(new Error('startup failed'));
    await tick();
    await failed.main.telemetry.flush({ timeoutMs: 1_000 });
    const [errored] = otlp(failed.net.calls).spans as (OtlpSpan & { status: { code: number } })[];
    expect(errored?.name).toBe('app.start');
    expect(errored?.status.code).toBe(2);
    expect(attrs(errored!.attributes)).toEqual({ platform: 'linux' });
  });

  test('shutdown-on-will-quit-is-bounded', async () => {
    vi.useFakeTimers();
    const { app, net, started } = setup({ consent: { usage: true, errors: false } });
    started.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // A collector that never answers.
    net.hang();
    expect(app.willQuit()).toBe(true);
    // A second `will-quit` while holding is held too, without a second shutdown.
    expect(app.willQuit()).toBe(true);
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.shutdownTimeoutMs - 10);
    expect(app.quit).not.toHaveBeenCalled();
    expect(net.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // What was in flight was aborted at the deadline; the next `will-quit` passes.
    expect(net.calls[0]!.init.signal?.aborted).toBe(true);
    expect(app.willQuit()).toBe(false);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  test('renderer-errors-are-reported', async () => {
    const { main, net, started } = setup({ consent: { usage: false, errors: true } });
    started.resolve();
    expect(main.service.reportError(RENDERER_ERROR)).toBe('reported');
    expect(main.service.reportError({ source: 'unhandledrejection', name: 'Error', message: 'rejected', stack: null })).toBe('reported');
    await vi.waitFor(() => expect(sentryEvents(net.calls)).toHaveLength(2));
    const [error, rejection] = sentryEvents(net.calls);
    expect(mechanismOf(error!)).toEqual({ type: RENDERER_ERROR_MECHANISMS.error, handled: false });
    expect(mechanismOf(rejection!)).toEqual({ type: RENDERER_ERROR_MECHANISMS.unhandledrejection, handled: false });
    const value = (error!['exception'] as { values: { type: string; value: string; stacktrace?: { frames: { filename: string }[] } }[] }).values.at(-1)!;
    expect(value.type).toBe('TypeError');
    expect(value.stacktrace?.frames.map((frame) => frame.filename)).toEqual(['file.js', `${APP_FRAME_PREFIX}assets/index-abc123.js`]);
    const sent = net.calls.map((call) => call.body).join('\n');
    for (const secret of ['private-site.example.com', 'alice@example.com', '/home/alice', 'id=12345', 'projects/secret']) expect(sent).not.toContain(secret);
    // No main stack leaks into a renderer error without one.
    expect((rejection!['exception'] as { values: { stacktrace?: unknown }[] }).values.at(-1)!.stacktrace).toBeUndefined();

    main.service.setConsent('errors', false);
    expect(main.service.reportError(RENDERER_ERROR)).toBe('dropped');
    // Not configured: dropped whatever the consent.
    const unconfigured = setup({ consent: { usage: true, errors: true }, config: { otelEndpoint: null, sentryDsn: null } });
    expect(unconfigured.main.service.state()).toMatchObject({ consent: { usage: true, errors: true }, configured: { usage: false, errors: false }, persisted: true });
    expect(unconfigured.main.service.reportError(RENDERER_ERROR)).toBe('dropped');
    await tick(30);
    expect(unconfigured.net.fetch).not.toHaveBeenCalled();
    expect(sentryEvents(net.calls)).toHaveLength(2);
  });
});
