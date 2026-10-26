// Spec: specs/seo-snapshot.spec.ts (SeoTabInputSchema), specs/seo-sidebar.spec.ts (statuses), specs/ipc-sender.spec.ts
// Acceptance: specs/seo-sidebar.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import type { SeoAuditResponse } from '@app/seo-core';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type SeoService } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;
const PENDING: SeoAuditResponse = { status: 'pending', url: 'https://example.com/' };

function fakeSeo() {
  return {
    getAudit: vi.fn((_tabId: number): SeoAuditResponse => PENDING),
    rerun: vi.fn((tabId: number) => tabId === 1),
  } satisfies SeoService;
}

function ctxFor(seo: SeoService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: seo === undefined ? {} : { seo },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { seo: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.seo[name];
  if (!fn) throw new Error(`no seo.${name}`);
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

const SEO_PROCEDURES = ['getAudit', 'rerun'];

describe('seo router', () => {
  test('seo-procedures-reject-foreign-sender-first', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('seo.'));
    expect(paths.sort()).toEqual(SEO_PROCEDURES.map((n) => `seo.${n}`).sort());
    for (const name of SEO_PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const seo = fakeSeo();
        // Malformed input too: the sender check runs before input parsing.
        for (const input of [{ tabId: 1 }, { bogus: true }, 42, undefined]) {
          const error = await errorOf(procedure(ctxFor(seo, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        expect(seo.getAudit).not.toHaveBeenCalled();
        expect(seo.rerun).not.toHaveBeenCalled();
      }
    }
  });

  test('seo-procedures-validate-input', async () => {
    const malformed = [undefined, 1, {}, { tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, { tabId: Number.NaN }, { tabId: Number.MAX_SAFE_INTEGER + 1 }, { tabId: 1, extra: true }, { id: 1 }];
    for (const name of SEO_PROCEDURES) {
      for (const input of malformed) {
        const seo = fakeSeo();
        const error = await errorOf(procedure(ctxFor(seo), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        expect(seo.getAudit).not.toHaveBeenCalled();
        expect(seo.rerun).not.toHaveBeenCalled();
      }
    }
  });

  test('seo-procedures-call-service', async () => {
    const seo = fakeSeo();
    await expect(procedure(ctxFor(seo), 'getAudit')({ tabId: 3 })).resolves.toEqual(PENDING);
    expect(seo.getAudit).toHaveBeenCalledExactlyOnceWith(3);
    await expect(procedure(ctxFor(seo), 'rerun')({ tabId: 1 })).resolves.toBe(true);
    await expect(procedure(ctxFor(seo), 'rerun')({ tabId: 2 })).resolves.toBe(false);
    expect(seo.rerun).toHaveBeenLastCalledWith(2);

    // Over the transport too: getAudit is a query, rerun a mutation.
    const sender = { id: 1, mainFrame: { frameTreeNodeId: 100 }, isDestroyed: () => false };
    const senderFrame = { origin: APP_ORIGIN, frameTreeNodeId: 100, parent: null, detached: false, isDestroyed: () => false };
    const handle = createIpcRequestHandler({
      router: appRouter,
      policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
      fromWebContents: () => ({ id: WINDOW_ID, webContents: sender, isDestroyed: () => false }),
      services: { seo },
    });
    expect(await handle({ sender, senderFrame }, { type: 'query', path: 'seo.getAudit', input: { tabId: 3 } })).toStrictEqual({ result: { data: PENDING } });
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'seo.rerun', input: { tabId: 1 } })).toStrictEqual({ result: { data: true } });
  });

  test('missing-seo-service-is-internal-error', async () => {
    for (const name of SEO_PROCEDURES) {
      const error = await errorOf(procedure(ctxFor(undefined), name)({ tabId: 1 }));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });
});
