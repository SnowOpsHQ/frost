// Spec: specs/changes.schema.ts (the changes.* inputs), specs/changes.spec.ts (answers), specs/ipc-sender.spec.ts
// Acceptance: specs/changes-capture.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { CAPTURE_LIMITS } from '@app/specs/capture.spec';
import { MAX_HISTORY_PAGE } from '@app/specs/capture-db.spec';
import type { CaptureAnswer, HistoryAnswer, PagesAnswer } from '@app/specs/changes.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { CHANGES_READ_API } from '../changes-service';
import { appRouter, createSenderPolicy, type ChangesService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const V1 = '01920000-0000-7000-8000-000000000001';
const V2 = '01920000-0000-7000-8000-000000000002';
const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const CAPTURED: CaptureAnswer = { status: 'captured', captureId: V1, versionId: V2, newVersion: true, changeCount: 3 };
const HISTORY: HistoryAnswer = { versions: [], next: { createdAt: 5, id: V1 } };
const PAGES: PagesAnswer = { pages: [{ url: PAGE, captureCount: 2, lastCapturedAt: 9 }] };

function fakeChanges() {
  return {
    capture: vi.fn(async (_tabId: number, _options: { projectId?: string }): Promise<CaptureAnswer> => CAPTURED),
    history: vi.fn(async () => HISTORY),
    version: vi.fn(async () => null),
    diff: vi.fn(async () => null),
    pages: vi.fn(async () => PAGES),
  } satisfies ChangesService;
}

function ctxFor(changes: ChangesService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: changes === undefined ? {} : { changes },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { changes: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.changes[name];
  if (!fn) throw new Error(`no changes.${name}`);
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

const VALID_INPUT: Record<string, unknown> = {
  capture: { tabId: 1, projectId: PROJECT },
  history: { url: PAGE, projectId: PROJECT, cursor: { createdAt: 5, id: V1 }, limit: 20 },
  version: { versionId: V1 },
  diff: { fromVersionId: V1, toVersionId: V2 },
  pages: { projectId: PROJECT, limit: 10 },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (changes: ReturnType<typeof fakeChanges>) => {
  for (const fn of Object.values(changes)) expect(fn).not.toHaveBeenCalled();
};

describe('changes router', () => {
  test('every-changes-procedure-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('changes.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `changes.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const changes = fakeChanges();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          const error = await errorOf(procedure(ctxFor(changes, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(changes);
      }
    }
    // Without the service: a masked internal error, never a call.
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('changes-inputs-are-validated', async () => {
    const longUrl = `https://example.com/${'x'.repeat(CAPTURE_LIMITS.maxUrlChars)}`;
    const badIds = ['', 'not-an-id', PROJECT.toUpperCase(), '01920000-0000-4000-8000-000000000001', `${V1}0`, 5, null];
    const bad: Record<string, unknown[]> = {
      capture: [{ tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, {}, undefined, { tabId: 1, extra: 1 }, { tabId: 1, source: 'project' }, { tabId: 1, searchParams: null }, ...badIds.map((projectId) => ({ tabId: 1, projectId }))],
      history: [
        { url: '' },
        { url: 'javascript:alert(1)' },
        { url: 'file:///etc/passwd' },
        { url: 'not a url' },
        { url: longUrl },
        { url: 5 },
        {},
        { url: PAGE, limit: 0 },
        { url: PAGE, limit: MAX_HISTORY_PAGE + 1 },
        { url: PAGE, limit: 1.5 },
        { url: PAGE, cursor: { createdAt: -1, id: V1 } },
        { url: PAGE, cursor: { createdAt: 1, id: 'x' } },
        { url: PAGE, cursor: { createdAt: 1, id: V1, extra: 1 } },
        { url: PAGE, cursor: null },
        { url: PAGE, extra: 1 },
        ...badIds.map((projectId) => ({ url: PAGE, projectId })),
      ],
      version: [{}, undefined, { versionId: V1, extra: 1 }, ...badIds.map((versionId) => ({ versionId }))],
      diff: [{ fromVersionId: V1 }, { toVersionId: V2 }, { fromVersionId: V1, toVersionId: V2, extra: 1 }, ...badIds.map((toVersionId) => ({ fromVersionId: V1, toVersionId })), ...badIds.map((fromVersionId) => ({ fromVersionId, toVersionId: V2 }))],
      pages: [{ limit: 0 }, { limit: MAX_HISTORY_PAGE + 1 }, { limit: '5' }, { extra: 1 }, ...badIds.map((projectId) => ({ projectId }))],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const changes = fakeChanges();
        const error = await errorOf(procedure(ctxFor(changes), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(changes);
      }
    }
  });

  test('changes-procedures-call-service', async () => {
    const changes = fakeChanges();
    await expect(procedure(ctxFor(changes), 'capture')({ tabId: 1 })).resolves.toEqual(CAPTURED);
    expect(changes.capture).toHaveBeenLastCalledWith(1, {});
    await expect(procedure(ctxFor(changes), 'capture')(VALID_INPUT.capture)).resolves.toEqual(CAPTURED);
    expect(changes.capture).toHaveBeenLastCalledWith(1, { projectId: PROJECT });
    changes.capture.mockResolvedValueOnce({ status: 'refused', reason: 'busy' });
    await expect(procedure(ctxFor(changes), 'capture')({ tabId: 2 })).resolves.toEqual({ status: 'refused', reason: 'busy' });
    await expect(procedure(ctxFor(changes), 'history')(VALID_INPUT.history)).resolves.toEqual(HISTORY);
    expect(changes.history).toHaveBeenCalledExactlyOnceWith(VALID_INPUT.history);
    await expect(procedure(ctxFor(changes), 'history')({ url: PAGE })).resolves.toEqual(HISTORY);
    expect(changes.history).toHaveBeenLastCalledWith({ url: PAGE });
    await expect(procedure(ctxFor(changes), 'version')(VALID_INPUT.version)).resolves.toBeNull();
    expect(changes.version).toHaveBeenCalledExactlyOnceWith({ versionId: V1 });
    await expect(procedure(ctxFor(changes), 'diff')(VALID_INPUT.diff)).resolves.toBeNull();
    expect(changes.diff).toHaveBeenCalledExactlyOnceWith({ fromVersionId: V1, toVersionId: V2 });
    await expect(procedure(ctxFor(changes), 'pages')({})).resolves.toEqual(PAGES);
    expect(changes.pages).toHaveBeenLastCalledWith({});
    // Phase 5 reads the same operations through CHANGES_READ_API, exported from this package.
    expect(Object.keys(CHANGES_READ_API).sort()).toEqual(['diff', 'getVersion', 'history', 'listPages', 'listScreenshots']);
  });
});
