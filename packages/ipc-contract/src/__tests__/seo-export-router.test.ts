// Spec: specs/seo-exports.schema.ts (SeoExportInputSchema), specs/seo-exports.spec.ts (SEO_EXPORT_KINDS),
// specs/seo-sidebar.spec.ts (IMAGE_FILTERS), specs/ipc-sender.spec.ts
// Acceptance: specs/seo-exports.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { SEO_EXPORT_KINDS, type SeoExportKind } from '@app/specs/seo-exports.spec';
import { IMAGE_FILTERS, type ImageFilter } from '@app/specs/seo-sidebar.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type SeoAuditRef, type SeoExportService } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const AUDIT = { url: PAGE, takenAt: 1_760_000_000_000 };

function fakeExports() {
  return { copyCsv: vi.fn((tabId: number, _audit: SeoAuditRef, kind: SeoExportKind, _filter?: ImageFilter) => (tabId === 1 ? (kind === 'speed' ? null : 3) : null)) } satisfies SeoExportService;
}

function ctxFor(seoExport: SeoExportService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: seoExport === undefined ? {} : { seoExport },
  };
}

function copyCsv(ctx: IpcContext): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { seoExport: Record<string, (input?: unknown) => Promise<unknown>> };
  return caller.seoExport.copyCsv!;
}

async function errorOf(run: Promise<unknown>): Promise<TRPCError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return error as TRPCError;
}

describe('seoExport router', () => {
  test('enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('seoExport.'));
    expect(paths).toEqual(['seoExport.copyCsv']);
    for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'file://']) {
      const seoExport = fakeExports();
      for (const input of [{ tabId: 1, audit: AUDIT, kind: 'images' }, { bogus: true }, undefined]) {
        const error = await errorOf(copyCsv(ctxFor(seoExport, origin))(input));
        expect(error.code, origin).toBe(IPC_SENDER_ERROR_CODE);
      }
      expect(seoExport.copyCsv).not.toHaveBeenCalled();
    }
    // Without the service: a masked internal error, never a call.
    expect((await errorOf(copyCsv(ctxFor(undefined))({ tabId: 1, audit: AUDIT, kind: 'images' }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    // From the app: the service is called with the validated input, and its answer passed back.
    const seoExport = fakeExports();
    for (const kind of SEO_EXPORT_KINDS) {
      await expect(copyCsv(ctxFor(seoExport))({ tabId: 1, audit: AUDIT, kind })).resolves.toBe(kind === 'speed' ? null : 3);
      expect(seoExport.copyCsv).toHaveBeenLastCalledWith(1, AUDIT, kind, undefined);
    }
    for (const filter of IMAGE_FILTERS) {
      await expect(copyCsv(ctxFor(seoExport))({ tabId: 1, audit: AUDIT, kind: 'images', filter })).resolves.toBe(3);
      expect(seoExport.copyCsv).toHaveBeenLastCalledWith(1, AUDIT, 'images', filter);
    }
    await expect(copyCsv(ctxFor(seoExport))({ tabId: 2, audit: AUDIT, kind: 'images' })).resolves.toBeNull();
    // A service answering garbage never reaches the chrome as anything but a row count or null.
    const odd = { copyCsv: vi.fn(() => 'rows' as unknown as number) } satisfies SeoExportService;
    await expect(copyCsv(ctxFor(odd))({ tabId: 1, audit: AUDIT, kind: 'images' })).resolves.toBeNull();
  });

  test('input-bounded', async () => {
    const longUrl = `https://example.com/${'x'.repeat(SNAPSHOT_LIMITS.maxUrlChars)}`;
    const bad: unknown[] = [
      undefined,
      {},
      { tabId: 0, audit: AUDIT, kind: 'images' },
      { tabId: -1, audit: AUDIT, kind: 'images' },
      { tabId: 1.5, audit: AUDIT, kind: 'images' },
      { tabId: '1', audit: AUDIT, kind: 'images' },
      { tabId: 1, kind: 'images' },
      { tabId: 1, audit: { url: PAGE }, kind: 'images' },
      { tabId: 1, audit: { url: '', takenAt: 1 }, kind: 'images' },
      { tabId: 1, audit: { url: longUrl, takenAt: 1 }, kind: 'images' },
      { tabId: 1, audit: { url: PAGE, takenAt: -1 }, kind: 'images' },
      { tabId: 1, audit: { ...AUDIT, extra: 1 }, kind: 'images' },
      { tabId: 1, audit: AUDIT },
      { tabId: 1, audit: AUDIT, kind: 'links' },
      { tabId: 1, audit: AUDIT, kind: 'IMAGES' },
      { tabId: 1, audit: AUDIT, kind: 'images', filter: 'broken' },
      { tabId: 1, audit: AUDIT, kind: 'images', filter: null },
      { tabId: 1, audit: AUDIT, kind: 'headings', filter: 'all' },
      { tabId: 1, audit: AUDIT, kind: 'speed', filter: 'missing-alt' },
      { tabId: 1, audit: AUDIT, kind: 'images', csv: 'URL,Alt\r\n=1+1' },
    ];
    for (const input of bad) {
      const seoExport = fakeExports();
      const error = await errorOf(copyCsv(ctxFor(seoExport))(input));
      expect(error.code, JSON.stringify(input)).toBe('BAD_REQUEST');
      expect(seoExport.copyCsv).not.toHaveBeenCalled();
    }
  });
});
