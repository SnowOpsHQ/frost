// Spec: specs/seo-snapshot.spec.ts (SeoTabInputSchema, SeoHighlightInputSchema, SeoLinksCsvInputSchema,
// SeoCopyUrlInputSchema, SeoCopySchemaInputSchema), specs/seo-sidebar.spec.ts (statuses, HIGHLIGHT_MODES, link filters), specs/ipc-sender.spec.ts
// Acceptance: specs/seo-sidebar.feature.md (Router), specs/seo-panels.feature.md (Router), specs/seo-schema.feature.md (Controller and router),
// specs/seo-speed.feature.md (Router), specs/seo-compliance.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import type { SeoAuditResponse, SpeedResponse } from '@app/seo-core';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { LINK_FILTER_QUERY_MAX_CHARS } from '@app/specs/seo-sidebar.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type SeoService } from '../index';
import { createIpcRequestHandler } from '../transport/main';

const WINDOW_ID = 7;
const PENDING: SeoAuditResponse = { status: 'pending', url: 'https://example.com/' };
const SPEED_BACKGROUND: SpeedResponse = { status: 'unavailable', url: 'https://example.com/', reason: 'background' };

function fakeSeo() {
  return {
    getAudit: vi.fn((_tabId: number): SeoAuditResponse => PENDING),
    rerun: vi.fn((tabId: number) => tabId === 1),
    setHighlight: vi.fn((tabId: number, _mode: 'off' | 'links' | 'headings') => tabId === 1),
    copyLinksCsv: vi.fn((tabId: number, _audit: { url: string; takenAt: number }, _filter: { type: string; rel: string; query: string }): number | null => (tabId === 1 ? 4 : null)),
    copyUrl: vi.fn((tabId: number, _audit: { url: string; takenAt: number }, _url: string) => tabId === 1),
    copySchemaJson: vi.fn((tabId: number, _audit: { url: string; takenAt: number }, _block: number) => tabId === 1),
    measureSpeed: vi.fn((_tabId: number): Promise<SpeedResponse> => Promise.resolve(SPEED_BACKGROUND)),
    runAccessibility: vi.fn((tabId: number) => tabId === 1),
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

const FILTER = { type: 'all', rel: 'all', query: '' };
const AUDIT = { url: 'https://example.com/', takenAt: 1_760_000_000_000 };
const VALID_INPUT: Record<string, unknown> = {
  getAudit: { tabId: 1 },
  rerun: { tabId: 1 },
  setHighlight: { tabId: 1, mode: 'links' },
  copyLinksCsv: { tabId: 1, audit: AUDIT, filter: FILTER },
  copyUrl: { tabId: 1, audit: AUDIT, url: 'https://example.com/a' },
  copySchemaJson: { tabId: 1, audit: AUDIT, block: 0 },
  measureSpeed: { tabId: 1 },
  runAccessibility: { tabId: 1 },
};
const SEO_PROCEDURES = Object.keys(VALID_INPUT);
/** No service method was called. */
const untouched = (seo: ReturnType<typeof fakeSeo>) => {
  for (const fn of Object.values(seo)) expect(fn).not.toHaveBeenCalled();
};

describe('seo router', () => {
  test('seo-procedures-reject-foreign-sender-first', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('seo.'));
    expect(paths.sort()).toEqual(SEO_PROCEDURES.map((n) => `seo.${n}`).sort());
    for (const name of SEO_PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const seo = fakeSeo();
        // Malformed input too: the sender check runs before input parsing.
        for (const input of [VALID_INPUT[name], { bogus: true }, 42, undefined]) {
          const error = await errorOf(procedure(ctxFor(seo, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(seo);
      }
    }
  });

  test('seo-procedures-validate-input', async () => {
    const badTabIds = [undefined, 1, {}, { tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, { tabId: Number.NaN }, { tabId: Number.MAX_SAFE_INTEGER + 1 }, { id: 1 }];
    const extras: Record<string, unknown[]> = {
      getAudit: [{ tabId: 1, extra: true }],
      rerun: [{ tabId: 1, extra: true }],
      measureSpeed: [{ tabId: 1, extra: true }, { tabId: 1, url: 'https://example.com/' }],
      setHighlight: [{ tabId: 1 }, { tabId: 1, mode: 'images' }, { tabId: 1, mode: 'LINKS' }, { tabId: 1, mode: 'links', extra: 1 }],
      copyLinksCsv: [
        { tabId: 1, audit: AUDIT },
        { tabId: 1, filter: FILTER },
        { tabId: 1, audit: { url: AUDIT.url }, filter: FILTER },
        { tabId: 1, audit: { ...AUDIT, takenAt: -1 }, filter: FILTER },
        { tabId: 1, audit: { ...AUDIT, url: '' }, filter: FILTER },
        { tabId: 1, audit: { ...AUDIT, extra: 1 }, filter: FILTER },
        { tabId: 1, audit: AUDIT, filter: { ...FILTER, type: 'nofollow' } },
        { tabId: 1, audit: AUDIT, filter: { ...FILTER, rel: 'internal' } },
        { tabId: 1, audit: AUDIT, filter: { ...FILTER, query: 'x'.repeat(LINK_FILTER_QUERY_MAX_CHARS + 1) } },
        { tabId: 1, audit: AUDIT, filter: { ...FILTER, extra: true } },
        { tabId: 1, audit: AUDIT, filter: { type: 'all', rel: 'all' } },
        { tabId: 1, audit: AUDIT, filter: FILTER, extra: true },
      ],
      copyUrl: [
        { tabId: 1, audit: AUDIT },
        { tabId: 1, url: 'https://example.com/' },
        { tabId: 1, audit: { ...AUDIT, takenAt: 'now' }, url: 'https://example.com/' },
        { tabId: 1, audit: AUDIT, url: '' },
        { tabId: 1, audit: AUDIT, url: 5 },
        { tabId: 1, audit: AUDIT, url: `https://example.com/${'x'.repeat(SNAPSHOT_LIMITS.maxUrlChars)}` },
        { tabId: 1, audit: AUDIT, url: 'https://example.com/', extra: 1 },
      ],
      copySchemaJson: [
        { tabId: 1, audit: AUDIT },
        { tabId: 1, block: 0 },
        { tabId: 1, audit: AUDIT, block: -1 },
        { tabId: 1, audit: AUDIT, block: 0.5 },
        { tabId: 1, audit: AUDIT, block: '0' },
        { tabId: 1, audit: AUDIT, block: SNAPSHOT_LIMITS.maxJsonLdBlocks },
        { tabId: 1, audit: { ...AUDIT, takenAt: 'now' }, block: 0 },
        { tabId: 1, audit: AUDIT, block: 0, text: '{}' },
      ],
      runAccessibility: [{ tabId: 1, extra: true }, { tabId: 1, rules: ['image-alt'] }],
    };
    for (const name of SEO_PROCEDURES) {
      const valid = VALID_INPUT[name] as Record<string, unknown>;
      const withIds = badTabIds.map((ids) => (ids !== null && typeof ids === 'object' ? { ...valid, tabId: undefined, ...ids } : ids));
      for (const input of [...withIds, ...extras[name]!]) {
        const seo = fakeSeo();
        const error = await errorOf(procedure(ctxFor(seo), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(seo);
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

    await expect(procedure(ctxFor(seo), 'setHighlight')({ tabId: 1, mode: 'headings' })).resolves.toBe(true);
    expect(seo.setHighlight).toHaveBeenLastCalledWith(1, 'headings');
    await expect(procedure(ctxFor(seo), 'setHighlight')({ tabId: 2, mode: 'off' })).resolves.toBe(false);
    const filter = { type: 'external', rel: 'nofollow', query: 'shop' };
    await expect(procedure(ctxFor(seo), 'copyLinksCsv')({ tabId: 1, audit: AUDIT, filter })).resolves.toBe(4);
    expect(seo.copyLinksCsv).toHaveBeenLastCalledWith(1, AUDIT, filter);
    await expect(procedure(ctxFor(seo), 'copyLinksCsv')({ tabId: 2, audit: AUDIT, filter })).resolves.toBeNull();
    await expect(procedure(ctxFor(seo), 'copyUrl')({ tabId: 1, audit: AUDIT, url: 'https://example.com/a' })).resolves.toBe(true);
    expect(seo.copyUrl).toHaveBeenLastCalledWith(1, AUDIT, 'https://example.com/a');
    await expect(procedure(ctxFor(seo), 'copyUrl')({ tabId: 2, audit: AUDIT, url: 'https://example.com/a' })).resolves.toBe(false);
    await expect(procedure(ctxFor(seo), 'copySchemaJson')({ tabId: 1, audit: AUDIT, block: SNAPSHOT_LIMITS.maxJsonLdBlocks - 1 })).resolves.toBe(true);
    expect(seo.copySchemaJson).toHaveBeenLastCalledWith(1, AUDIT, SNAPSHOT_LIMITS.maxJsonLdBlocks - 1);
    await expect(procedure(ctxFor(seo), 'copySchemaJson')({ tabId: 2, audit: AUDIT, block: 0 })).resolves.toBe(false);
    // Compliance (seo-compliance.feature.md, Router): the accessibility check, a mutation answering a boolean.
    await expect(procedure(ctxFor(seo), 'runAccessibility')({ tabId: 1 })).resolves.toBe(true);
    expect(seo.runAccessibility).toHaveBeenLastCalledWith(1);
    await expect(procedure(ctxFor(seo), 'runAccessibility')({ tabId: 2 })).resolves.toBe(false);

    await expect(procedure(ctxFor(seo), 'measureSpeed')({ tabId: 4 })).resolves.toEqual(SPEED_BACKGROUND);
    expect(seo.measureSpeed).toHaveBeenCalledExactlyOnceWith(4);

    // Over the transport too: getAudit is a query, rerun and measureSpeed mutations.
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
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'seo.measureSpeed', input: { tabId: 1 } })).toStrictEqual({ result: { data: SPEED_BACKGROUND } });
    expect(await handle({ sender, senderFrame }, { type: 'query', path: 'seo.runAccessibility', input: { tabId: 1 } })).not.toStrictEqual({ result: { data: true } });
    expect(await handle({ sender, senderFrame }, { type: 'mutation', path: 'seo.runAccessibility', input: { tabId: 1 } })).toStrictEqual({ result: { data: true } });
  });

  test('missing-seo-service-is-internal-error', async () => {
    for (const name of SEO_PROCEDURES) {
      const error = await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]));
      expect(error.code, name).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });
});
