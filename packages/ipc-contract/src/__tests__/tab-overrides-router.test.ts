// Spec: specs/render-profile.schema.spec.ts (SetTabOverridesInputSchema, TabOverridesSchema), specs/render-profile.spec.ts
// (DEFAULT_TAB_OVERRIDES, GEOLOCATION_LIMITS), specs/ipc-sender.spec.ts
// Acceptance: specs/render-profile.feature.md (Tab overrides: Procedure)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { DEFAULT_TAB_OVERRIDES, GEOLOCATION_LIMITS, type TabOverrides } from '@app/specs/render-profile.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type TabOverridesService } from '../index';

const WINDOW_ID = 7;
const PARIS: TabOverrides = { cssDisabled: true, cookiesDisabled: true, geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 100 } };

const fakeService = () => ({ set: vi.fn((tabId: number, _overrides: TabOverrides) => tabId === 1) }) satisfies TabOverridesService;

function call(service: TabOverridesService | undefined, input: unknown, origin: string = APP_ORIGIN): Promise<unknown> {
  const ctx: IpcContext = {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service ? { tabOverrides: service } : {},
  };
  const caller = appRouter.createCaller(ctx) as unknown as { tabOverrides: { set(input: unknown): Promise<unknown> } };
  return caller.tabOverrides.set(input);
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

describe('tab overrides procedure', () => {
  test('tab-overrides-procedure-enforces-sender', async () => {
    const service = fakeService();
    // Malformed input too: the sender check runs first.
    for (const input of [{ tabId: 1, overrides: PARIS }, { bogus: true }]) expect(await codeOf(call(service, input, 'https://evil.example'))).toBe(IPC_SENDER_ERROR_CODE);
    expect(service.set).not.toHaveBeenCalled();
    // No service: a masked internal error, after the sender check.
    expect(await codeOf(call(undefined, { tabId: 1, overrides: PARIS }))).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('set-tab-overrides-validates', async () => {
    const service = fakeService();
    const geo = (geolocation: unknown) => ({ tabId: 1, overrides: { ...DEFAULT_TAB_OVERRIDES, geolocation } });
    const bad: unknown[] = [
      undefined,
      { tabId: 1 },
      { tabId: 0, overrides: PARIS },
      { tabId: 1, overrides: { ...PARIS, extra: true } },
      { tabId: 1, overrides: { ...PARIS, cssDisabled: 'yes' } },
      { tabId: 1, overrides: { cssDisabled: true, cookiesDisabled: false } },
      // A render-profile field never rides along.
      { tabId: 1, overrides: { ...PARIS, javascriptDisabled: true } },
      { tabId: 1, overrides: PARIS, profile: {} },
      geo({ latitude: GEOLOCATION_LIMITS.maxLatitude + 1, longitude: 0, accuracy: 10 }),
      geo({ latitude: 0, longitude: -GEOLOCATION_LIMITS.maxLongitude - 0.5, accuracy: 10 }),
      geo({ latitude: 1.123456, longitude: 0, accuracy: 10 }),
      geo({ latitude: 0, longitude: 0, accuracy: 0 }),
      geo({ latitude: 0, longitude: 0, accuracy: GEOLOCATION_LIMITS.maxAccuracy + 1 }),
      geo({ latitude: 0, longitude: 0, accuracy: 2.5 }),
      geo({ latitude: '1', longitude: 0, accuracy: 10 }),
      geo({ latitude: 0, longitude: 0 }),
      geo({ latitude: 0, longitude: 0, accuracy: 10, altitude: 5 }),
    ];
    for (const input of bad) expect(await codeOf(call(service, input)), JSON.stringify(input)).toBe('BAD_REQUEST');
    expect(service.set).not.toHaveBeenCalled();
    expect(await call(service, { tabId: 1, overrides: PARIS })).toBe(true);
    expect(service.set).toHaveBeenCalledExactlyOnceWith(1, PARIS);
    expect(await call(service, { tabId: 2, overrides: DEFAULT_TAB_OVERRIDES })).toBe(false);
  });
});
