// Spec: specs/render-profile.schema.spec.ts (SetRenderProfileInputSchema, ClearRenderProfileInputSchema, RenderProfileSchema),
// specs/render-profile.spec.ts (MAX_CUSTOM_USER_AGENT_LENGTH), specs/ipc-sender.spec.ts
// Acceptance: specs/render-profile.feature.md (Procedures)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import type { BrowserState } from '@app/specs/browser.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { DEFAULT_RENDER_PROFILE, MAX_CUSTOM_USER_AGENT_LENGTH } from '@app/specs/render-profile.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type BrowserService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const PHONE = { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' } as const;

function fakeService() {
  const state = { version: 1, tabs: [], activeTabId: null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, notice: null } as unknown as BrowserState;
  return {
    navigate: vi.fn(() => true),
    newTab: vi.fn(() => 1),
    closeTab: vi.fn(() => true),
    activateTab: vi.fn(() => true),
    openBackgroundTab: vi.fn(() => null),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    setPageBounds: vi.fn(),
    answerPermission: vi.fn(() => false),
    runPageCommand: vi.fn(),
    focusPage: vi.fn(() => false),
    clearBrowsingData: vi.fn(),
    setRenderProfile: vi.fn((tabId: number) => tabId === 1),
    clearRenderProfile: vi.fn((tabId: number) => tabId === 1),
    getState: vi.fn(() => state),
    watch: vi.fn(async () => state),
  } satisfies BrowserService;
}

function call(service: BrowserService, name: 'setRenderProfile' | 'clearRenderProfile', input: unknown, origin: string = APP_ORIGIN): Promise<unknown> {
  const ctx: IpcContext = {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: { browser: service },
  };
  const caller = appRouter.createCaller(ctx) as unknown as { browser: Record<string, (input?: unknown) => Promise<unknown>> };
  return caller.browser[name]!(input);
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

describe('render-profile procedures', () => {
  test('render-profile-procedures-enforce-sender', async () => {
    const service = fakeService();
    for (const [name, input] of [
      ['setRenderProfile', { tabId: 1, profile: PHONE, pin: false }],
      ['clearRenderProfile', { tabId: 1 }],
    ] as const) {
      // Malformed input too: the sender check runs first.
      for (const value of [input, { bogus: true }]) expect(await codeOf(call(service, name, value, 'https://evil.example'))).toBe(IPC_SENDER_ERROR_CODE);
    }
    expect(service.setRenderProfile).not.toHaveBeenCalled();
    expect(service.clearRenderProfile).not.toHaveBeenCalled();
  });

  test('set-render-profile-validates', async () => {
    const service = fakeService();
    const bad: unknown[] = [
      undefined,
      { tabId: 1, profile: PHONE },
      { tabId: 0, profile: PHONE, pin: false },
      { tabId: 1, profile: { ...PHONE, device: 'watch' }, pin: false },
      { tabId: 1, profile: { ...PHONE, network: '5g' }, pin: false },
      { tabId: 1, profile: { ...PHONE, extra: 1 }, pin: false },
      { tabId: 1, profile: { ...PHONE, javascriptDisabled: 'yes' }, pin: false },
      // A custom user agent: non-blank, printable ASCII, capped; and only with `custom`.
      { tabId: 1, profile: { ...PHONE, userAgent: 'custom', customUserAgent: '' }, pin: false },
      { tabId: 1, profile: { ...PHONE, userAgent: 'custom', customUserAgent: '   ' }, pin: false },
      { tabId: 1, profile: { ...PHONE, userAgent: 'custom', customUserAgent: 'a\r\nX-Injected: 1' }, pin: false },
      { tabId: 1, profile: { ...PHONE, userAgent: 'custom', customUserAgent: 'boté' }, pin: false },
      { tabId: 1, profile: { ...PHONE, userAgent: 'custom', customUserAgent: 'x'.repeat(MAX_CUSTOM_USER_AGENT_LENGTH + 1) }, pin: false },
      { tabId: 1, profile: { ...PHONE, customUserAgent: 'not custom' }, pin: false },
      { tabId: 1, profile: PHONE, pin: false, extra: true },
    ];
    for (const input of bad) expect(await codeOf(call(service, 'setRenderProfile', input)), JSON.stringify(input)).toBe('BAD_REQUEST');
    expect(service.setRenderProfile).not.toHaveBeenCalled();
    const custom = { ...PHONE, userAgent: 'custom', customUserAgent: 'x'.repeat(MAX_CUSTOM_USER_AGENT_LENGTH) };
    expect(await call(service, 'setRenderProfile', { tabId: 1, profile: custom, pin: true })).toBe(true);
    expect(service.setRenderProfile).toHaveBeenCalledExactlyOnceWith(1, custom, true);
    expect(await call(service, 'setRenderProfile', { tabId: 2, profile: PHONE, pin: false })).toBe(false);
  });

  test('clear-render-profile', async () => {
    const service = fakeService();
    for (const input of [undefined, {}, { tabId: -1 }, { tabId: 1.5 }, { tabId: 1, extra: 1 }]) expect(await codeOf(call(service, 'clearRenderProfile', input))).toBe('BAD_REQUEST');
    expect(service.clearRenderProfile).not.toHaveBeenCalled();
    expect(await call(service, 'clearRenderProfile', { tabId: 1 })).toBe(true);
    expect(await call(service, 'clearRenderProfile', { tabId: 3 })).toBe(false);
    expect(service.clearRenderProfile).toHaveBeenCalledTimes(2);
  });
});
