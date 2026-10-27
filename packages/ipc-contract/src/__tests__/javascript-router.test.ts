// Spec: specs/seo-javascript.schema.ts (RefetchServedInputSchema), specs/ipc-sender.spec.ts
// Acceptance: specs/seo-javascript.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type JavascriptService } from '../index';

const WINDOW_ID = 7;

function fakeJavascript() {
  return { refetchServed: vi.fn((tabId: number) => tabId === 1) } satisfies JavascriptService;
}

function ctxFor(javascript: JavascriptService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: javascript === undefined ? {} : { javascript },
  };
}

const refetch = (ctx: IpcContext) => (appRouter.createCaller(ctx) as unknown as { javascript: { refetchServed: (input?: unknown) => Promise<unknown> } }).javascript.refetchServed;

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

describe('javascript router', () => {
  test('javascript-refetch-is-guarded', async () => {
    expect(Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('javascript.'))).toEqual(['javascript.refetchServed']);
    // The sender is checked before anything (even a bad input).
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
      const javascript = fakeJavascript();
      for (const input of [{ tabId: 1 }, { bogus: true }, undefined]) expect((await errorOf(refetch(ctxFor(javascript, origin))(input))).code, origin).toBe(IPC_SENDER_ERROR_CODE);
      expect(javascript.refetchServed).not.toHaveBeenCalled();
    }
    // Strict input.
    for (const input of [{ tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, { tabId: 1, url: 'https://example.com/' }, {}, undefined]) {
      const javascript = fakeJavascript();
      expect((await errorOf(refetch(ctxFor(javascript))(input))).code, JSON.stringify(input)).toBe('BAD_REQUEST');
      expect(javascript.refetchServed).not.toHaveBeenCalled();
    }
    // The service's answer.
    const javascript = fakeJavascript();
    await expect(refetch(ctxFor(javascript))({ tabId: 1 })).resolves.toBe(true);
    await expect(refetch(ctxFor(javascript))({ tabId: 2 })).resolves.toBe(false);
    expect(javascript.refetchServed).toHaveBeenCalledTimes(2);
    // Without the service: a masked internal error.
    expect((await errorOf(refetch(ctxFor(undefined))({ tabId: 1 }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
  });
});
