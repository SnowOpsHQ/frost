// Spec: specs/telemetry-privacy.spec.ts (TELEMETRY_CHANNELS, DEFAULT_CONSENT, RESOURCE_ATTRIBUTE_KEYS,
// FORBIDDEN_RESOURCE_PREFIXES, OS_TYPE_BY_PLATFORM, SPAN_ATTRIBUTE_ALLOWLIST, SPAN_NAME_FALLBACK,
// TELEMETRY_LIMITS, TELEMETRY_SERVICE_NAME, SENTRY_EVENT_KEYS, SENTRY_CONTEXT_ALLOWLIST,
// SENTRY_FRAME_KEYS, APP_FRAME_PREFIX, SENTRY_ENVELOPE_ITEM_TYPES)
// Acceptance: specs/telemetry.feature.md (Package)
import os from 'node:os';
import { getCurrentScope, getGlobalScope, getIsolationScope } from '@sentry/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  APP_FRAME_PREFIX,
  DEFAULT_CONSENT,
  FORBIDDEN_RESOURCE_PREFIXES,
  OS_TYPE_BY_PLATFORM,
  RESOURCE_ATTRIBUTE_KEYS,
  SENTRY_CONTEXT_ALLOWLIST,
  SENTRY_ENVELOPE_ITEM_TYPES,
  SENTRY_EVENT_KEYS,
  SENTRY_FRAME_KEYS,
  SPAN_NAME_FALLBACK,
  TELEMETRY_LIMITS,
  TELEMETRY_SERVICE_NAME,
} from '@app/specs/telemetry-privacy.spec';
import { createTelemetry, type Telemetry, type TelemetryOptions } from '../index';
import { attributeMap, fakeTransport, OTEL_ENDPOINT, otlpBodies, otlpSpans, parseEnvelope, RESOURCE, SENTRY_DSN, sentryEvents, tick, type FakeTransport } from './fakes';

const created: Telemetry[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const telemetry of created.splice(0)) {
    telemetry.setConsent('usage', false);
    telemetry.setConsent('errors', false);
    await telemetry.shutdown();
  }
  // Undo what `events-are-scrubbed` put on Sentry's shared scopes.
  getIsolationScope().setUser(null).setTags({ page: undefined }).setExtras({ cookie: undefined }).clearBreadcrumbs();
  getGlobalScope().setContext('device', null);
  getCurrentScope().setTags({ user: undefined });
});

interface Setup {
  telemetry: Telemetry;
  otel: FakeTransport;
  sentry: FakeTransport;
}

function setup(overrides: Partial<TelemetryOptions> = {}): Setup {
  const otel = fakeTransport();
  const sentry = fakeTransport();
  const telemetry = createTelemetry({
    resource: RESOURCE,
    otel: { endpoint: OTEL_ENDPOINT, send: otel.send },
    sentry: { dsn: SENTRY_DSN, send: sentry.send },
    redact: [],
    ...overrides,
  });
  created.push(telemetry);
  return { telemetry, otel, sentry };
}

/** An error with a fixed stack, so the frames are known. */
function errorWithStack(message: string, frames: string[]): Error {
  const error = new Error(message);
  error.stack = [`Error: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n');
  return error;
}

describe('telemetry consent gate', () => {
  test('nothing-sent-before-consent', async () => {
    for (const consent of [undefined, DEFAULT_CONSENT]) {
      const { telemetry, otel, sentry } = setup(consent ? { consent } : {});
      expect(telemetry.consent()).toEqual({ usage: false, errors: false });
      expect(telemetry.configured()).toEqual({ usage: true, errors: true });

      expect(telemetry.span('app.start', { outcome: 'ok' }, () => 7)).toBe(7);
      await telemetry.span('seo.audit', { rule_count: 3 }, async () => {
        await tick(1);
      });
      telemetry.captureException(new Error('boom'));
      telemetry.captureException('a string');
      await telemetry.flush();
      await tick(20);
      await telemetry.shutdown();

      expect(otel.calls).toHaveLength(0);
      expect(sentry.calls).toHaveLength(0);
    }
  });

  test('off-stops-export-immediately', async () => {
    vi.useFakeTimers();
    // Queued spans: ended while on, not yet exported; turning off discards them, without a flush.
    {
      const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
      telemetry.span('app.start', {}, () => undefined);
      telemetry.span('seo.audit', {}, () => undefined);
      telemetry.setConsent('usage', false);
      expect(otel.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.exportDelayMs * 3);
      await telemetry.flush();
      await telemetry.shutdown();
      expect(otel.calls).toHaveLength(0);
    }
    // A span that ends after turn-off (started while on) is dropped.
    {
      const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
      let finish!: () => void;
      const running = telemetry.span('seo.audit', {}, () => new Promise<void>((resolve) => (finish = resolve)));
      telemetry.setConsent('usage', false);
      finish();
      await running;
      telemetry.setConsent('usage', true);
      await telemetry.flush();
      expect(otel.calls).toHaveLength(0);
    }
    // A request in flight is aborted.
    {
      const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
      otel.hold();
      telemetry.span('app.start', {}, () => undefined);
      const flushing = telemetry.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(otel.calls).toHaveLength(1);
      expect(otel.calls[0]!.signal.aborted).toBe(false);
      telemetry.span('seo.audit', {}, () => undefined);
      telemetry.setConsent('usage', false);
      expect(otel.calls[0]!.signal.aborted).toBe(true);
      await flushing;
      await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.exportDelayMs * 3);
      expect(otel.calls).toHaveLength(1);
      otel.release();
    }
    vi.useRealTimers();
    // Errors: an event captured and not yet sent is dropped when errors is turned off.
    {
      const { telemetry, sentry } = setup({ otel: undefined, consent: { usage: false, errors: true } });
      telemetry.captureException(new Error('queued then off'));
      telemetry.captureException(new Error('queued then off, too'));
      telemetry.setConsent('errors', false);
      await telemetry.flush();
      await tick(20);
      await telemetry.shutdown();
      expect(sentry.calls).toHaveLength(0);
    }
    // Errors: a request in flight is aborted.
    {
      const { telemetry, sentry } = setup({ otel: undefined, consent: { usage: false, errors: true } });
      sentry.hold();
      telemetry.captureException(new Error('in flight'));
      await tick(20);
      expect(sentry.calls).toHaveLength(1);
      telemetry.setConsent('errors', false);
      expect(sentry.calls[0]!.signal.aborted).toBe(true);
      telemetry.captureException(new Error('after off'));
      await telemetry.flush();
      await tick(20);
      expect(sentry.calls).toHaveLength(1);
      sentry.release();
    }
  });

  test('on-again-resumes', async () => {
    const { telemetry, otel, sentry } = setup({ consent: { usage: true, errors: true } });
    telemetry.span('first.span', {}, () => undefined);
    telemetry.captureException(new Error('first error'));
    telemetry.setConsent('usage', false);
    telemetry.setConsent('errors', false);

    telemetry.span('while.off', {}, () => undefined);
    telemetry.captureException(new Error('while off'));
    await telemetry.flush();
    await tick(20);
    expect(otel.calls).toHaveLength(0);
    expect(sentry.calls).toHaveLength(0);

    telemetry.setConsent('usage', true);
    telemetry.setConsent('errors', true);
    expect(telemetry.consent()).toEqual({ usage: true, errors: true });
    telemetry.span('third.span', {}, () => undefined);
    telemetry.captureException(new Error('third error'));
    await telemetry.flush();

    expect(otlpSpans(otel).map((span) => span.name)).toEqual(['third.span']);
    const events = sentryEvents(sentry);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('third error');
  });
});

describe('what leaves', () => {
  test('events-are-scrubbed', async () => {
    const appRoot = '/home/alice/Projects/frost/apps/desktop';
    const { telemetry, otel, sentry } = setup({ consent: { usage: true, errors: true }, appRoot, redact: ['alice-laptop', 'alice'] });
    // Whatever else in the process put on Sentry's shared scopes never leaves.
    getIsolationScope().setUser({ id: 'u-1', email: 'alice@example.com', ip_address: '203.0.113.9' });
    getIsolationScope().setTag('page', 'https://example.com/private');
    getIsolationScope().setExtra('cookie', 'sid=s3cr3t');
    getIsolationScope().addBreadcrumb({ message: 'visited https://example.com/private' });
    getGlobalScope().setContext('device', { name: 'alice-laptop' });
    getCurrentScope().setTag('user', 'alice');

    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXZhbHVl';
    const message = `Failed to load https://example.com/p?q=tea for alice@example.com from /home/alice/notes/tea.txt on alice-laptop with Bearer abcdefghijklmnop and ${jwt} at 192.168.1.20`;
    const error = errorWithStack(message, [
      `loadPage (${appRoot}/out/main/index.js:10:5)`,
      'Object.<anonymous> (/Users/alice/Library/Scripts/hook.js:3:1)',
      'C:\\Users\\alice\\AppData\\Local\\frost\\resources\\app.asar\\out\\main\\chunk.js:1:2',
      'process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      `fn (${appRoot}/node_modules/@scope/pkg/index.js:1:1)`,
      'render (app://app/chrome/assets/index-abc123.js?v=alice@example.com:4:9)',
      'eval (https://example.com/alice/app.js:1:1)',
    ]);
    telemetry.captureException(error);
    telemetry.span('seo.audit', { command: 'open alice@example.com', 'app.version': 'https://example.com/alice', outcome: 'ok' }, (span) => {
      span.setAttributes({ panel: 'links' });
    });
    await telemetry.flush();

    const sent = [...otel.calls, ...sentry.calls].map((call) => call.body).join('\n');
    for (const secret of ['alice', 'example.com', 'abcdefghijklmnop', jwt, 'eyJ', '192.168.1.20', 's3cr3t', '203.0.113.9', 'u-1', '/home/', '/Users/', 'C:\\']) {
      expect(sent, secret).not.toContain(secret);
    }

    const [event] = sentryEvents(sentry);
    expect(event).toBeDefined();
    for (const key of Object.keys(event!)) expect(SENTRY_EVENT_KEYS).toContain(key);
    for (const key of ['request', 'user', 'server_name', 'extra', 'breadcrumbs', 'tags', 'modules', 'debug_meta', 'transaction', 'sdk']) expect(event).not.toHaveProperty(key);
    const contexts = (event!['contexts'] ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, fields] of Object.entries(contexts)) {
      expect(Object.keys(SENTRY_CONTEXT_ALLOWLIST)).toContain(name);
      for (const field of Object.keys(fields)) expect(SENTRY_CONTEXT_ALLOWLIST[name as keyof typeof SENTRY_CONTEXT_ALLOWLIST] as readonly string[]).toContain(field);
    }
    expect(contexts['app']).toEqual({ app_version: RESOURCE.serviceVersion });

    const exception = (event!['exception'] as { values: { type: string; value: string; stacktrace: { frames: Record<string, unknown>[] } }[] }).values[0]!;
    expect(exception.value).toContain('Failed to load [url] for [email] from [path] on [redacted] with Bearer [redacted] and [token] at [ip]');
    const frames = exception.stacktrace.frames;
    for (const frame of frames) for (const key of Object.keys(frame)) expect(SENTRY_FRAME_KEYS).toContain(key);
    // Sentry orders frames outermost first.
    expect(frames.map((frame) => frame['filename']).reverse()).toEqual([
      `${APP_FRAME_PREFIX}out/main/index.js`,
      'hook.js',
      `${APP_FRAME_PREFIX}out/main/chunk.js`,
      'node:internal/process/task_queues',
      'node_modules/@scope/pkg/index.js',
      `${APP_FRAME_PREFIX}chrome/assets/index-abc123.js`,
      '[url]',
    ]);

    const [span] = otlpSpans(otel);
    expect(attributeMap(span!.attributes)).toEqual({ outcome: 'ok', panel: 'links' });
  });

  test('only-allowlisted-attributes-leave', async () => {
    const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
    const attributes = {
      duration_ms: 12.5,
      rule_count: 42,
      outcome: 'ok',
      panel: 'links',
      platform: 'linux',
      'app.version': '1.4.0-beta.2',
      command: 'x'.repeat(200),
      cached: true,
      // Not allowlisted.
      url: 'https://example.com/',
      'http.url': 'https://example.com/',
      'user.id': 'u-1',
      'enduser.id': 'u-1',
      'service.instance.id': 'a7c1',
    };
    telemetry.span('seo.audit', attributes as never, (span) => {
      span.setAttributes({ 'host.name': 'alice-laptop' } as never);
    });
    // Out of range, wrong kind, not one of the values, free text.
    telemetry.span(
      'seo.audit',
      { duration_ms: -1, rule_count: 1.5, outcome: 'weird', panel: 'nope', platform: 'plan9', 'app.version': 'one point four', command: 'open history', cached: 'yes' } as never,
      () => undefined,
    );
    telemetry.span('seo.audit', { rule_count: 10_001, duration_ms: Number.NaN } as never, () => undefined);
    // A name built from data is exported as the fallback; a throw sets only the status code.
    expect(() =>
      telemetry.span('GET https://example.com/alice', {}, () => {
        throw new Error('secret https://example.com/alice');
      }),
    ).toThrow('secret');
    telemetry.span('a'.repeat(TELEMETRY_LIMITS.maxSpanNameChars + 1), {}, () => undefined);
    await telemetry.flush();

    const spans = otlpSpans(otel);
    expect(spans).toHaveLength(5);
    expect(attributeMap(spans[0]!.attributes)).toEqual({
      duration_ms: 12.5,
      rule_count: 42,
      outcome: 'ok',
      panel: 'links',
      platform: 'linux',
      'app.version': '1.4.0-beta.2',
      command: 'x'.repeat(48),
      cached: true,
    });
    expect(spans[1]!.attributes).toEqual([]);
    expect(spans[2]!.attributes).toEqual([]);
    expect(spans[3]!.name).toBe(SPAN_NAME_FALLBACK);
    expect(spans[3]!.status).toEqual({ code: 2 });
    expect(spans[4]!.name).toBe(SPAN_NAME_FALLBACK);
    for (const span of spans) {
      expect(span.events ?? []).toEqual([]);
      expect(span.links ?? []).toEqual([]);
    }
    expect(otel.calls.map((call) => call.body).join('')).not.toContain('example.com');
  });

  test('resource-has-no-identifier', async () => {
    const { telemetry, otel, sentry } = setup({ consent: { usage: true, errors: true }, redact: undefined });
    telemetry.span('app.start', {}, () => undefined);
    telemetry.captureException(new Error('boom'));
    await telemetry.flush();

    const [body] = otlpBodies(otel);
    const resource = attributeMap(body!.resourceSpans[0]!.resource.attributes);
    expect(Object.keys(resource).sort()).toEqual([...RESOURCE_ATTRIBUTE_KEYS].sort());
    expect(resource).toEqual({ 'service.name': TELEMETRY_SERVICE_NAME, 'service.version': RESOURCE.serviceVersion, 'os.type': OS_TYPE_BY_PLATFORM.linux });
    for (const key of Object.keys(resource)) for (const prefix of FORBIDDEN_RESOURCE_PREFIXES) expect(key.startsWith(prefix)).toBe(false);

    const sent = [...otel.calls, ...sentry.calls].map((call) => call.body).join('\n');
    expect(sent).not.toContain('process.pid');
    expect(sent).not.toContain('host.name');
    expect(sent).not.toContain('server_name');
    expect(sent).not.toContain(process.execPath);
    const hostname = os.hostname();
    if (hostname.length >= 4) expect(sent).not.toContain(hostname);
    let username = '';
    try {
      username = os.userInfo().username;
    } catch {
      // No passwd entry: nothing to leak.
    }
    if (username.length >= 4) expect(sent).not.toContain(username);
  });

  test('missing-endpoint-is-noop', async () => {
    const consent = { usage: true, errors: true };
    const cases: Partial<TelemetryOptions>[] = [
      { otel: undefined, sentry: undefined },
      { otel: { endpoint: '', send: fakeTransport().send }, sentry: { dsn: '', send: fakeTransport().send } },
      { otel: { endpoint: undefined, send: fakeTransport().send }, sentry: { dsn: undefined, send: fakeTransport().send } },
      { otel: { endpoint: 'not a url', send: fakeTransport().send }, sentry: { dsn: 'not a dsn', send: fakeTransport().send } },
      { otel: { endpoint: 'ftp://otel.example.test/v1/traces', send: fakeTransport().send }, sentry: { dsn: 'ftp://key@errors.example.test/1', send: fakeTransport().send } },
    ];
    for (const overrides of cases) {
      const otel = fakeTransport();
      const sentry = fakeTransport();
      const withSends: Partial<TelemetryOptions> = {
        otel: overrides.otel ? { ...overrides.otel, send: otel.send } : undefined,
        sentry: overrides.sentry ? { ...overrides.sentry, send: sentry.send } : undefined,
      };
      const { telemetry } = setup({ ...withSends, consent });
      expect(telemetry.configured()).toEqual({ usage: false, errors: false });
      expect(telemetry.consent()).toEqual(consent);
      expect(telemetry.span('app.start', {}, () => 'ran')).toBe('ran');
      telemetry.captureException(new Error('boom'));
      await telemetry.flush();
      await tick(10);
      expect(otel.calls).toHaveLength(0);
      expect(sentry.calls).toHaveLength(0);
    }
  });
});

describe('export formats', () => {
  test('otlp-json-export', async () => {
    const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
    await telemetry.span('app.start', { outcome: 'ok' }, async () => {
      await tick(1);
      telemetry.span('seo.audit', { rule_count: 3 }, () => undefined);
    });
    await telemetry.flush();

    expect(otel.calls).toHaveLength(1);
    const call = otel.calls[0]!;
    expect(call.url).toBe(OTEL_ENDPOINT);
    expect(call.headers['content-type']).toBe('application/json');
    const [body] = otlpBodies(otel);
    expect(body!.resourceSpans[0]!.scopeSpans[0]!.scope.name).toBe(TELEMETRY_SERVICE_NAME);
    const spans = otlpSpans(otel);
    const child = spans.find((span) => span.name === 'seo.audit')!;
    const parent = spans.find((span) => span.name === 'app.start')!;
    for (const span of [child, parent]) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.startTimeUnixNano).toMatch(/^\d+$/);
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
      expect(span.kind).toBe(1);
      expect(span.status).toEqual({ code: 0 });
    }
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(parent.parentSpanId).toBeUndefined();

    // Batches are capped; the queue is bounded.
    const total = TELEMETRY_LIMITS.maxQueuedSpans + 50;
    for (let i = 0; i < total; i += 1) telemetry.span('seo.rule', {}, () => undefined);
    await telemetry.flush();
    const batches = otel.calls.slice(1).map((c) => (JSON.parse(c.body) as typeof body)!.resourceSpans[0]!.scopeSpans[0]!.spans.length);
    for (const size of batches) expect(size).toBeLessThanOrEqual(TELEMETRY_LIMITS.maxExportBatch);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(TELEMETRY_LIMITS.maxQueuedSpans);
  });

  test('otlp-export-is-scheduled', async () => {
    vi.useFakeTimers();
    const { telemetry, otel } = setup({ sentry: undefined, consent: { usage: true, errors: false } });
    telemetry.span('app.start', {}, () => undefined);
    await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.exportDelayMs - 1);
    expect(otel.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(otel.calls).toHaveLength(1);
  });

  test('sentry-sends-only-events', async () => {
    const { telemetry, sentry } = setup({ otel: undefined, consent: { usage: false, errors: true } });
    telemetry.captureException(new Error('boom'), { mechanism: 'onuncaughtexception', handled: false });
    await telemetry.flush();

    expect(sentry.calls).toHaveLength(1);
    const call = sentry.calls[0]!;
    const url = new URL(call.url);
    expect(url.origin).toBe('https://errors.example.test');
    expect(url.pathname).toBe('/api/42/envelope/');
    expect(url.searchParams.get('sentry_key')).toBe('publickey');
    expect(call.headers['content-type']).toBe('application/x-sentry-envelope');
    const envelope = parseEnvelope(call.body);
    expect(envelope.header).not.toHaveProperty('trace');
    for (const item of envelope.items) expect(SENTRY_ENVELOPE_ITEM_TYPES as readonly string[]).toContain(item.header.type);
    const event = envelope.items[0]!.payload;
    expect(event['level']).toBe('error');
    expect(event['release']).toBe(`frost@${RESOURCE.serviceVersion}`);
    const exception = (event['exception'] as { values: { type: string; value: string; mechanism: unknown }[] }).values[0]!;
    expect(exception.type).toBe('Error');
    expect(exception.value).toBe('boom');
    expect(exception.mechanism).toEqual({ type: 'onuncaughtexception', handled: false });
  });

  test('span-runs-the-function', async () => {
    for (const consent of [DEFAULT_CONSENT, { usage: true, errors: false }]) {
      const { telemetry } = setup({ sentry: undefined, consent });
      expect(telemetry.span('a.sync', {}, () => 1)).toBe(1);
      await expect(telemetry.span('a.async', {}, async () => 2)).resolves.toBe(2);
      expect(() =>
        telemetry.span('a.throw', {}, () => {
          throw new TypeError('sync');
        }),
      ).toThrow(TypeError);
      await expect(telemetry.span('a.reject', {}, () => Promise.reject(new RangeError('async')))).rejects.toThrow(RangeError);
    }
  });

  test('send-failures-are-swallowed', async () => {
    for (const answer of ['reject', 500] as const) {
      const { telemetry, otel, sentry } = setup({ consent: { usage: true, errors: true } });
      otel.answer(answer);
      sentry.answer(answer);
      telemetry.span('app.start', {}, () => undefined);
      telemetry.captureException(new Error('boom'));
      await expect(telemetry.flush()).resolves.toBeUndefined();
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      expect(otel.calls.length).toBeGreaterThan(0);
      expect(sentry.calls.length).toBeGreaterThan(0);
    }
  });

  test('consent-is-validated', () => {
    const { telemetry } = setup();
    expect(() => telemetry.setConsent('bogus' as never, true)).toThrow();
    expect(() => telemetry.setConsent('usage', 'yes' as never)).toThrow();
    const copy = telemetry.consent();
    copy.usage = true;
    expect(telemetry.consent().usage).toBe(false);
    expect(() => createTelemetry({ resource: RESOURCE, consent: { usage: 1 } as never })).toThrow();
  });
});
