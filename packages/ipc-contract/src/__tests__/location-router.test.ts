// Spec: specs/location-profiles.schema.ts (LocationProfilesViewSchema, LocationProfileInputSchema, LocationUpdateInputSchema,
// LocationIdInputSchema, LocationNewTabInputSchema), specs/location-profiles.spec.ts (LOCATION_WRITE_RESULTS,
// LOCATION_NEW_TAB_RESULTS, LOCATION_LIMITS), specs/ipc-sender.spec.ts, specs/ipc-transport.spec.ts (IPC_INTERNAL_ERROR_CODE)
// Acceptance: specs/location-profiles.feature.md (location-credentials-never-leave-main) · plan docs/plans/phase-12-big-bets.md, Task 10b (IPC)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { LOCATION_LIMITS, type LocationNewTabResult, type LocationWriteResult } from '@app/specs/location-profiles.spec';
import type { LocationProfileInput, LocationProfilesView } from '@app/specs/location-profiles.schema';
import { appRouter, createSenderPolicy, type IpcContext, type LocationService } from '../index';

const WINDOW_ID = 7;
const ID = '01920000-0000-7000-8000-0000000000c1';
const PASSWORD = 'proxy-pass-SECRET-0123';
const VIEW: LocationProfilesView = {
  protection: 'os',
  profiles: [{ id: ID, label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, hasCredentials: true }],
};
const INPUT: LocationProfileInput = { label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128, username: 'me', password: PASSWORD };

function fakeService(overrides: Partial<LocationService> = {}) {
  return {
    list: vi.fn(async (): Promise<LocationProfilesView> => VIEW),
    create: vi.fn(async (_input: LocationProfileInput): Promise<LocationWriteResult> => 'saved'),
    update: vi.fn(async (_id: string, _input: LocationProfileInput): Promise<LocationWriteResult> => 'saved'),
    remove: vi.fn(async (_id: string): Promise<LocationWriteResult> => 'removed'),
    newTab: vi.fn(async (_profileId: string): Promise<LocationNewTabResult> => 'opened'),
    ...overrides,
  } satisfies LocationService;
}

function ctxFor(service: LocationService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: service === undefined ? {} : { locations: service },
  };
}

function call(ctx: IpcContext, name: string, input?: unknown): Promise<unknown> {
  const caller = (appRouter.createCaller(ctx) as unknown as { locations: Record<string, (input?: unknown) => Promise<unknown>> }).locations;
  return caller[name]!(input);
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const PROCEDURES: Record<string, unknown> = {
  list: undefined,
  create: INPUT,
  update: { id: ID, profile: INPUT },
  remove: { id: ID },
  newTab: { profileId: ID },
};

describe('locations router', () => {
  test('location-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('locations.'));
    expect(paths.sort()).toEqual(Object.keys(PROCEDURES).map((n) => `locations.${n}`).sort());
    const service = fakeService();
    for (const [name, input] of Object.entries(PROCEDURES)) {
      expect((await errorOf(call(ctxFor(service, 'https://evil.example'), name, input))).code, name).toBe(IPC_SENDER_ERROR_CODE);
      expect((await errorOf(call(ctxFor(undefined), name, input))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
    for (const fn of [service.list, service.create, service.update, service.remove, service.newTab]) expect(fn).not.toHaveBeenCalled();
  });

  test('location-inputs-bounded', async () => {
    const service = fakeService();
    const ctx = ctxFor(service);
    expect(await call(ctx, 'create', INPUT)).toBe('saved');
    expect(await call(ctx, 'create', { label: 'Paris', scheme: 'socks5', host: '127.0.0.1', port: 9050 })).toBe('saved');
    expect(await call(ctx, 'update', { id: ID, profile: INPUT })).toBe('saved');
    expect(await call(ctx, 'remove', { id: ID })).toBe('removed');
    expect(await call(ctx, 'newTab', { profileId: ID })).toBe('opened');
    for (const input of [
      { ...INPUT, password: undefined },
      { ...INPUT, username: 'a:b' },
      { ...INPUT, password: 'a\nb' },
      { ...INPUT, password: 'x'.repeat(LOCATION_LIMITS.maxCredentialChars + 1) },
      { ...INPUT, port: 0 },
      { ...INPUT, port: 65_536 },
      { ...INPUT, scheme: 'socks4' },
      { ...INPUT, extra: 1 },
      { ...INPUT, host: 'h'.repeat(LOCATION_LIMITS.maxHostChars + 9) },
    ]) {
      await errorOf(call(ctx, 'create', input));
    }
    await errorOf(call(ctx, 'remove', { id: 'not-an-id' }));
    await errorOf(call(ctx, 'newTab', { profileId: ID, partition: 'persist:frost-browser' }));
    expect(service.create).toHaveBeenCalledTimes(2);
    expect(service.newTab).toHaveBeenCalledExactlyOnceWith(ID);
  });

  test('location-credentials-never-leave-main', async () => {
    // The view is strict: a service that leaked a secret field fails the output check.
    const leaky = fakeService({ list: vi.fn(async () => ({ ...VIEW, profiles: [{ ...VIEW.profiles[0]!, password: PASSWORD }] }) as unknown as LocationProfilesView) });
    await errorOf(call(ctxFor(leaky), 'list'));
    const answer = await call(ctxFor(fakeService()), 'list');
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
    expect(answer).toEqual(VIEW);
    // Results are only ever one of the fixed set.
    expect(await call(ctxFor(fakeService({ create: vi.fn(async () => PASSWORD as unknown as LocationWriteResult) })), 'create', INPUT)).toBe('failed');
    expect(await call(ctxFor(fakeService({ newTab: vi.fn(async () => 'nope' as unknown as LocationNewTabResult) })), 'newTab', { profileId: ID })).toBe('failed');
  });
});
