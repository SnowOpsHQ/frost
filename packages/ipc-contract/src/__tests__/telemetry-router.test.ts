// Spec: specs/telemetry-consent.schema.ts (TelemetryStateSchema, SetConsentInputSchema, RendererErrorInputSchema,
// RENDERER_ERROR_LIMITS, RENDERER_ERROR_RATE_LIMIT, RENDERER_ERROR_RESULTS), specs/ipc-sender.spec.ts,
// specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/telemetry.feature.md (Desktop, Router) · plan Global Constraint "Telemetry defaults off"
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import {
  RENDERER_ERROR_LIMITS,
  RENDERER_ERROR_RATE_LIMIT,
  RENDERER_ERROR_RESULTS,
  type RendererErrorInput,
  type RendererErrorResult,
  type TelemetryState,
} from '@app/specs/telemetry-consent.schema';
import type { TelemetryChannel } from '@app/specs/telemetry-privacy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type TelemetryService } from '../index';

const WINDOW_ID = 4;
const FAKE_DSN = 'https://0123456789abcdef0123456789abcdef@errors.example.test/42';
const FAKE_ENDPOINT = 'https://otel.example.test/v1/traces';
const SECRETS = [FAKE_DSN, FAKE_ENDPOINT, '0123456789abcdef0123456789abcdef', 'errors.example.test', 'otel.example.test'];

const ERROR: RendererErrorInput = { source: 'error', name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x is not a function\n    at f (app://app/assets/index.js:1:2)' };

function fakeTelemetry() {
  let state: TelemetryState = { consent: { usage: false, errors: false }, configured: { usage: true, errors: true }, persisted: true, version: 0 };
  const service = {
    // The service knows the DSN and endpoint; none of it may reach an answer.
    dsn: FAKE_DSN,
    endpoint: FAKE_ENDPOINT,
    state: vi.fn(() => state),
    setConsent: vi.fn((channel: TelemetryChannel, on: boolean, _windowId: number | null) => {
      state = { ...state, consent: { ...state.consent, [channel]: on }, version: state.version + 1 };
      return state;
    }),
    reportError: vi.fn((_input: RendererErrorInput): RendererErrorResult => (state.consent.errors ? 'reported' : 'dropped')),
  } satisfies TelemetryService & Record<string, unknown>;
  return service;
}

/** Every telemetry procedure, its type and a valid input. */
const TELEMETRY_PROCEDURES: Record<string, { type: 'query' | 'mutation'; input?: unknown }> = {
  state: { type: 'query' },
  setConsent: { type: 'mutation', input: { channel: 'errors', on: true } },
  reportError: { type: 'mutation', input: ERROR },
};

function ctxFor(telemetry: TelemetryService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: telemetry === undefined ? {} : { telemetry },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { telemetry: Record<string, (input?: unknown) => Promise<unknown>> }).telemetry;
  const fn = caller[name];
  if (!fn) throw new Error(`no telemetry.${name}`);
  return fn(input);
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

afterEach(() => vi.useRealTimers());

describe('telemetry router', () => {
  test('telemetry-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('telemetry.'));
    expect(paths.sort()).toEqual(Object.keys(TELEMETRY_PROCEDURES).map((n) => `telemetry.${n}`).sort());
    for (const [name, { input }] of Object.entries(TELEMETRY_PROCEDURES)) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const telemetry = fakeTelemetry();
        expect((await errorOf(call(ctxFor(telemetry, origin), name, input))).code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        for (const fn of Object.values(telemetry)) if (vi.isMockFunction(fn)) expect(fn, name).not.toHaveBeenCalled();
      }
      // Without the service: a masked internal error.
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    for (const [name, { type }] of Object.entries(TELEMETRY_PROCEDURES)) {
      expect((appRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>)[`telemetry.${name}`]?._def.type, name).toBe(type);
    }
  });

  test('set-consent-passes-window-id', async () => {
    const telemetry = fakeTelemetry();
    await call(ctxFor(telemetry), 'setConsent', { channel: 'usage', on: true });
    await call(ctxFor(telemetry), 'setConsent', { channel: 'usage', on: false });
    // The service decides whether the sender's window has a live gesture (needed to turn on).
    expect(telemetry.setConsent.mock.calls).toEqual([
      ['usage', true, WINDOW_ID],
      ['usage', false, WINDOW_ID],
    ]);
  });

  test('telemetry-answers-carry-no-secret', async () => {
    const telemetry = fakeTelemetry();
    const answers: unknown[] = [];
    answers.push(await call(ctxFor(telemetry), 'state'));
    const on = await call(ctxFor(telemetry), 'setConsent', { channel: 'errors', on: true });
    expect(on).toEqual({ consent: { usage: false, errors: true }, configured: { usage: true, errors: true }, persisted: true, version: 1 });
    expect(telemetry.setConsent).toHaveBeenCalledExactlyOnceWith('errors', true, WINDOW_ID);
    answers.push(on, await call(ctxFor(telemetry), 'reportError', ERROR));
    expect(answers.at(-1)).toBe('reported');
    const text = JSON.stringify(answers);
    for (const secret of SECRETS) expect(text).not.toContain(secret);

    // A service answer with anything else (the DSN, the endpoint, a string for a boolean) is refused.
    const bad: [string, unknown, (t: ReturnType<typeof fakeTelemetry>) => void][] = [
      ['state', undefined, (t) => t.state.mockReturnValue({ ...t.state(), dsn: FAKE_DSN } as TelemetryState)],
      ['state', undefined, (t) => t.state.mockReturnValue({ ...t.state(), configured: { usage: FAKE_ENDPOINT, errors: true } } as unknown as TelemetryState)],
      ['setConsent', { channel: 'usage', on: true }, (t) => t.setConsent.mockReturnValue({ consent: { usage: true, errors: false }, configured: { usage: true, errors: true, endpoint: FAKE_ENDPOINT }, persisted: true, version: 1 } as unknown as TelemetryState)],
      ['reportError', ERROR, (t) => t.reportError.mockReturnValue(FAKE_DSN as RendererErrorResult)],
    ];
    for (const [name, input, poison] of bad) {
      const fresh = fakeTelemetry();
      poison(fresh);
      const error = await errorOf(call(ctxFor(fresh), name, input));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
      expect(JSON.stringify({ message: error.message }), name).not.toContain(FAKE_DSN);
    }
    expect(RENDERER_ERROR_RESULTS).toContain('rate-limited');
  });

  test('telemetry-inputs-are-validated', async () => {
    for (const [name, input] of [
      ['setConsent', { channel: 'crashes', on: true }],
      ['setConsent', { channel: 'usage', on: 'yes' }],
      ['setConsent', { channel: 'usage', on: true, dsn: FAKE_DSN }],
      ['setConsent', undefined],
      ['reportError', { ...ERROR, source: 'console' }],
      ['reportError', { ...ERROR, message: 'm'.repeat(RENDERER_ERROR_LIMITS.maxMessageChars + 1) }],
      ['reportError', { ...ERROR, stack: 's'.repeat(RENDERER_ERROR_LIMITS.maxStackChars + 1) }],
      ['reportError', { ...ERROR, name: 'n'.repeat(RENDERER_ERROR_LIMITS.maxNameChars + 1) }],
      ['reportError', { ...ERROR, url: 'https://example.com/' }],
      ['reportError', { source: 'error', message: 'no name or stack' }],
    ] as const) {
      const telemetry = fakeTelemetry();
      expect((await errorOf(call(ctxFor(telemetry), name, input))).code, `${name} ${JSON.stringify(input)?.slice(0, 60)}`).toBe('BAD_REQUEST');
      expect(telemetry.setConsent).not.toHaveBeenCalled();
      expect(telemetry.reportError).not.toHaveBeenCalled();
    }
  });

  test('report-error-is-rate-limited', async () => {
    vi.useFakeTimers();
    const telemetry = fakeTelemetry();
    telemetry.setConsent('errors', true, WINDOW_ID);
    for (let i = 0; i < RENDERER_ERROR_RATE_LIMIT.maxReports; i += 1) {
      expect(await call(ctxFor(telemetry), 'reportError', ERROR), `report ${i}`).toBe('reported');
    }
    expect(await call(ctxFor(telemetry), 'reportError', ERROR)).toBe('rate-limited');
    expect(await call(ctxFor(telemetry), 'reportError', ERROR)).toBe('rate-limited');
    expect(telemetry.reportError).toHaveBeenCalledTimes(RENDERER_ERROR_RATE_LIMIT.maxReports);
    // Another service (another run) has its own budget.
    const other = fakeTelemetry();
    expect(await call(ctxFor(other), 'reportError', ERROR)).toBe('dropped');
    // The next window resumes.
    vi.advanceTimersByTime(RENDERER_ERROR_RATE_LIMIT.windowMs);
    expect(await call(ctxFor(telemetry), 'reportError', ERROR)).toBe('reported');
    expect(telemetry.reportError).toHaveBeenCalledTimes(RENDERER_ERROR_RATE_LIMIT.maxReports + 1);
  });
});
