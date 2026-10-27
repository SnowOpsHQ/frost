// Spec: specs/command-palette.schema.ts (SeoCopyValueInputSchema, PageCommandInputSchema), specs/command-palette.spec.ts
// (COPY_VALUE_KEYS), specs/page-commands.spec.ts (PAGE_COMMANDS), specs/ipc-sender.spec.ts
// Acceptance: specs/command-palette.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import type { SeoAuditResponse, SpeedResponse } from '@app/seo-core';
import type { BrowserState } from '@app/specs/browser.spec';
import { COPY_VALUE_KEYS } from '@app/specs/command-palette.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { PAGE_COMMANDS } from '@app/specs/page-commands.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type BrowserService, type IpcContext, type SeoService } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;
const AUDIT = { url: 'https://example.com/', takenAt: 1_760_000_000_000 };
const STATE: BrowserState = { version: 1, tabs: [], activeTabId: null, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };

function fakes() {
  const browser = {
    navigate: vi.fn(() => false),
    newTab: vi.fn((): number | null => null),
    closeTab: vi.fn(() => false),
    activateTab: vi.fn(() => false),
    openBackgroundTab: vi.fn((): number | null => null),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    setPageBounds: vi.fn(),
    answerPermission: vi.fn(() => false),
    runPageCommand: vi.fn((_command: string) => undefined),
    focusPage: vi.fn(() => true),
    clearBrowsingData: vi.fn(() => undefined),
    setRenderProfile: vi.fn(() => false),
    clearRenderProfile: vi.fn(() => false),
    getState: vi.fn(() => STATE),
    watch: vi.fn(async () => STATE),
  } satisfies BrowserService;
  const seo = {
    getAudit: vi.fn((): SeoAuditResponse => ({ status: 'pending', url: AUDIT.url })),
    rerun: vi.fn(() => false),
    setHighlight: vi.fn(() => false),
    copyLinksCsv: vi.fn((): number | null => null),
    copyUrl: vi.fn(() => false),
    copySchemaJson: vi.fn(() => false),
    measureSpeed: vi.fn(async (): Promise<SpeedResponse> => ({ status: 'pending', url: AUDIT.url })),
    runAccessibility: vi.fn(() => false),
    copyValue: vi.fn((tabId: number, _audit: { url: string; takenAt: number }, _key: string) => tabId === 1),
  } satisfies SeoService;
  return { browser, seo };
}

function ctxFor(services: ReturnType<typeof fakes>, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services,
  };
}

function procedure(ctx: IpcContext, path: string): (input?: unknown) => Promise<unknown> {
  const [space, name] = path.split('.') as [string, string];
  const caller = appRouter.createCaller(ctx) as unknown as Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
  const fn = caller[space]?.[name];
  if (!fn) throw new Error(`no ${path}`);
  return fn;
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

const untouched = (services: ReturnType<typeof fakes>) => {
  for (const fn of [...Object.values(services.browser), ...Object.values(services.seo)]) expect(fn).not.toHaveBeenCalled();
};

const VALID: Record<string, unknown> = {
  'seo.copyValue': { tabId: 1, audit: AUDIT, key: 'title' },
  'browser.pageCommand': { command: 'zoom-in' },
  'browser.focusPage': undefined,
  'browser.clearBrowsingData': undefined,
};

describe('palette router', () => {
  test('palette-procedures-reject-foreign-sender-first', async () => {
    for (const path of Object.keys(VALID)) {
      expect(Object.keys(appRouter._def.procedures)).toContain(path);
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const services = fakes();
        for (const input of [VALID[path], { bogus: true }, 42]) {
          const error = await errorOf(procedure(ctxFor(services, origin), path)(input));
          expect(error.code, `${path} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(services);
      }
    }
  });

  test('copy-value-validates-input', async () => {
    const malformed = [
      undefined,
      { tabId: 1, audit: AUDIT },
      { tabId: 1, key: 'title' },
      { audit: AUDIT, key: 'title' },
      { tabId: 0, audit: AUDIT, key: 'title' },
      { tabId: 1, audit: AUDIT, key: 'TITLE' },
      { tabId: 1, audit: AUDIT, key: 'body' },
      { tabId: 1, audit: AUDIT, key: 'json-ld' },
      { tabId: 1, audit: AUDIT, key: '__proto__' },
      { tabId: 1, audit: AUDIT, key: 1 },
      { tabId: 1, audit: { url: AUDIT.url }, key: 'title' },
      { tabId: 1, audit: { ...AUDIT, takenAt: 'now' }, key: 'title' },
      { tabId: 1, audit: { ...AUDIT, extra: 1 }, key: 'title' },
      // The chrome never sends what to copy.
      { tabId: 1, audit: AUDIT, key: 'title', text: 'forged' },
      { tabId: 1, audit: AUDIT, key: 'title', value: 'forged' },
    ];
    for (const input of malformed) {
      const services = fakes();
      const error = await errorOf(procedure(ctxFor(services), 'seo.copyValue')(input));
      expect(error.code, JSON.stringify(input) ?? 'undefined').toBe('BAD_REQUEST');
      untouched(services);
    }
  });

  test('page-command-validates-input', async () => {
    for (const input of [undefined, {}, 'zoom-in', { command: 'zoom' }, { command: 'ZOOM-IN' }, { command: 'close-tab' }, { command: 'zoom-in', extra: 1 }, { command: 1 }]) {
      const services = fakes();
      const error = await errorOf(procedure(ctxFor(services), 'browser.pageCommand')(input));
      expect(error.code, JSON.stringify(input) ?? 'undefined').toBe('BAD_REQUEST');
      untouched(services);
    }
  });

  test('palette-procedures-call-service', async () => {
    const services = fakes();
    const ctx = ctxFor(services);
    for (const key of COPY_VALUE_KEYS) {
      await expect(procedure(ctx, 'seo.copyValue')({ tabId: 1, audit: AUDIT, key })).resolves.toBe(true);
      expect(services.seo.copyValue).toHaveBeenLastCalledWith(1, AUDIT, key);
    }
    await expect(procedure(ctx, 'seo.copyValue')({ tabId: 2, audit: AUDIT, key: 'h1' })).resolves.toBe(false);
    for (const command of PAGE_COMMANDS) {
      await expect(procedure(ctx, 'browser.pageCommand')({ command })).resolves.toBeNull();
      expect(services.browser.runPageCommand).toHaveBeenLastCalledWith(command);
    }
    await expect(procedure(ctx, 'browser.focusPage')()).resolves.toBe(true);
    services.browser.focusPage.mockReturnValueOnce(false);
    await expect(procedure(ctx, 'browser.focusPage')()).resolves.toBe(false);
    await expect(procedure(ctx, 'browser.clearBrowsingData')()).resolves.toBeNull();
    expect(services.browser.clearBrowsingData).toHaveBeenCalledTimes(1);

    // Over the transport: all four are mutations.
    const sender = { id: 1, mainFrame: { frameTreeNodeId: 100 }, isDestroyed: () => false };
    const senderFrame = { origin: APP_ORIGIN, frameTreeNodeId: 100, parent: null, detached: false, isDestroyed: () => false };
    const handle = createIpcRequestHandler({
      router: appRouter,
      policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
      fromWebContents: () => ({ id: WINDOW_ID, webContents: sender, isDestroyed: () => false }),
      services,
    });
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'seo.copyValue', input: { tabId: 1, audit: AUDIT, key: 'url' } })).toStrictEqual({ result: { data: true } });
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'browser.focusPage' })).toStrictEqual({ result: { data: true } });
    expect(await handle({ sender, senderFrame }, { type: 'query', path: 'browser.clearBrowsingData' })).not.toStrictEqual({ result: { data: null } });
  });
});
