// Spec: specs/seo-content.schema.ts (the content.* inputs), specs/seo-content.spec.ts (caps), specs/ipc-sender.spec.ts
// Acceptance: specs/seo-content.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { MAX_SNIPPET_VARIANTS, SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS, SNIPPET_VARIANT_TITLE_MAX_CHARS, TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type ContentNotesAnswer, type ContentService, type IpcContext } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const NOTES: ContentNotesAnswer = { query: 'green tea', variants: [{ slot: 0, title: 'T', description: 'D', updatedAt: 1 }], generation: 3 };
/** The notes generation each write carries (main refuses one from another; seo-content.feature.md). */
const GENERATION = 3;
const AUDIT = { url: PAGE, takenAt: 1_760_000_000_000 };

function fakeContent() {
  return {
    notes: vi.fn(async (_url: string) => NOTES),
    setTargetQuery: vi.fn(async (_url: string, _query: string, _generation: number) => true),
    saveVariant: vi.fn(async (_url: string, _variant: { slot: number; title: string; description: string }, _generation: number) => true),
    deleteVariant: vi.fn(async (_url: string, _slot: number, _generation: number) => true),
    copySnippetHtml: vi.fn(async (tabId: number, _audit: { url: string; takenAt: number }, _source: 'page' | { slot: number }) => tabId === 1),
    clearAllNotes: vi.fn(async () => true),
  } satisfies ContentService;
}

function ctxFor(content: ContentService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: content === undefined ? {} : { content },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { content: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.content[name];
  if (!fn) throw new Error(`no content.${name}`);
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
  getNotes: { url: PAGE },
  setTarget: { url: PAGE, query: 'green tea', generation: GENERATION },
  saveVariant: { url: PAGE, slot: 0, title: 'A title', description: 'A description', generation: GENERATION },
  deleteVariant: { url: PAGE, slot: 0, generation: GENERATION },
  copySnippetHtml: { tabId: 1, audit: AUDIT, source: 'page' },
  // Phase 2.5 Task 3 review: "Delete all notes" (main confirms); no input.
  clearAllNotes: undefined,
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (content: ReturnType<typeof fakeContent>) => {
  for (const fn of Object.values(content)) expect(fn).not.toHaveBeenCalled();
};

describe('content router', () => {
  test('content-procedures-enforce-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('content.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `content.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const content = fakeContent();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          const error = await errorOf(procedure(ctxFor(content, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(content);
      }
    }
    // Without the service: a masked internal error, never a call.
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('content-inputs-are-validated', async () => {
    const longUrl = `https://example.com/${'x'.repeat(SNAPSHOT_LIMITS.maxUrlChars)}`;
    const badUrls = [{ url: '' }, { url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }, { url: 'not a url' }, { url: longUrl }, { url: 5 }, {}];
    const bad: Record<string, unknown[]> = {
      getNotes: [...badUrls, { url: PAGE, extra: 1 }, undefined],
      setTarget: [...badUrls.map((u) => ({ query: 'q', ...u })), { url: PAGE }, { url: PAGE, query: 'q'.repeat(TARGET_QUERY_MAX_CHARS + 1) }, { url: PAGE, query: 3 }, { url: PAGE, query: 'q', extra: 1 }],
      saveVariant: [
        ...badUrls.map((u) => ({ slot: 0, title: '', description: '', ...u })),
        { url: PAGE, slot: -1, title: '', description: '' },
        { url: PAGE, slot: MAX_SNIPPET_VARIANTS, title: '', description: '' },
        { url: PAGE, slot: 0.5, title: '', description: '' },
        { url: PAGE, slot: 0, title: 't'.repeat(SNIPPET_VARIANT_TITLE_MAX_CHARS + 1), description: '' },
        { url: PAGE, slot: 0, title: '', description: 'd'.repeat(SNIPPET_VARIANT_DESCRIPTION_MAX_CHARS + 1) },
        { url: PAGE, slot: 0, title: '' },
        { url: PAGE, slot: 0, title: '', description: '', updatedAt: 1 },
      ],
      deleteVariant: [...badUrls.map((u) => ({ slot: 0, ...u })), { url: PAGE }, { url: PAGE, slot: MAX_SNIPPET_VARIANTS }, { url: PAGE, slot: '0' }],
      copySnippetHtml: [
        { tabId: 0, audit: AUDIT, source: 'page' },
        { tabId: 1, source: 'page' },
        { tabId: 1, audit: { url: PAGE }, source: 'page' },
        { tabId: 1, audit: AUDIT, source: 'draft' },
        { tabId: 1, audit: AUDIT, source: 'variant' },
        { tabId: 1, audit: AUDIT, source: 'page', slot: 0 },
        { tabId: 1, audit: AUDIT, source: 'variant', slot: MAX_SNIPPET_VARIANTS },
        { tabId: 1, audit: AUDIT, source: 'page', html: '<title>x</title>' },
      ],
      clearAllNotes: [],
    };
    // Each write's bad inputs carry a generation (one defect each); without one, or a bad one, is refused too.
    const generations = [undefined, -1, 1.5, '3'];
    for (const name of ['setTarget', 'saveVariant', 'deleteVariant']) {
      const valid = VALID_INPUT[name] as Record<string, unknown>;
      bad[name] = [
        ...bad[name]!.map((input) => (typeof input === 'object' && input !== null ? { generation: GENERATION, ...input } : input)),
        ...generations.map((generation) => {
          const { generation: _, ...rest } = valid;
          return generation === undefined ? rest : { ...rest, generation };
        }),
      ];
    }
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const content = fakeContent();
        const error = await errorOf(procedure(ctxFor(content), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(content);
      }
    }
  });

  test('content-procedures-call-service', async () => {
    const content = fakeContent();
    await expect(procedure(ctxFor(content), 'getNotes')({ url: PAGE })).resolves.toEqual(NOTES);
    expect(content.notes).toHaveBeenCalledExactlyOnceWith(PAGE);
    await expect(procedure(ctxFor(content), 'setTarget')({ url: PAGE, query: '', generation: 0 })).resolves.toBe(true);
    expect(content.setTargetQuery).toHaveBeenCalledExactlyOnceWith(PAGE, '', 0);
    await expect(procedure(ctxFor(content), 'saveVariant')({ url: PAGE, slot: 2, title: 'T', description: 'D', generation: GENERATION })).resolves.toBe(true);
    expect(content.saveVariant).toHaveBeenCalledExactlyOnceWith(PAGE, { slot: 2, title: 'T', description: 'D' }, GENERATION);
    await expect(procedure(ctxFor(content), 'deleteVariant')({ url: PAGE, slot: 2, generation: GENERATION })).resolves.toBe(true);
    expect(content.deleteVariant).toHaveBeenCalledExactlyOnceWith(PAGE, 2, GENERATION);
    await expect(procedure(ctxFor(content), 'copySnippetHtml')({ tabId: 1, audit: AUDIT, source: 'page' })).resolves.toBe(true);
    expect(content.copySnippetHtml).toHaveBeenLastCalledWith(1, AUDIT, 'page');
    await expect(procedure(ctxFor(content), 'copySnippetHtml')({ tabId: 1, audit: AUDIT, source: 'variant', slot: 3 })).resolves.toBe(true);
    expect(content.copySnippetHtml).toHaveBeenLastCalledWith(1, AUDIT, { slot: 3 });
    await expect(procedure(ctxFor(content), 'copySnippetHtml')({ tabId: 2, audit: AUDIT, source: 'page' })).resolves.toBe(false);
    await expect(procedure(ctxFor(content), 'clearAllNotes')()).resolves.toBe(true);
    expect(content.clearAllNotes).toHaveBeenCalledOnce();
    content.clearAllNotes.mockResolvedValueOnce(false);
    await expect(procedure(ctxFor(content), 'clearAllNotes')()).resolves.toBe(false);
  });
});
