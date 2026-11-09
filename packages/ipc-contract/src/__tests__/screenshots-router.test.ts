// Spec: specs/screenshot.schema.ts (the screenshots.* inputs), specs/screenshot.spec.ts (answers), specs/ipc-sender.spec.ts
// Acceptance: specs/screenshot.feature.md (Scenarios every-screenshots-procedure-enforces-sender,
// screenshots-inputs-are-validated, screenshots-procedures-call-service; Editing: save-edit-enforces-sender-and-bounds-input)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { MAX_HISTORY_PAGE } from '@app/specs/capture-db.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import {
  MAX_OVERLAY_DATA_URL_CHARS,
  SCREENSHOT_EDIT_LIMITS,
  SCREENSHOT_LIMITS,
  SCREENSHOT_OVERLAY_PREFIX,
  type SaveScreenshotEditAnswer,
  type SaveScreenshotEditInput,
  type ScreenshotEditOp,
  type ScreenshotsAnswer,
  type TakeScreenshotAnswer,
} from '@app/specs/screenshot.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { SaveScreenshotEditInputSchema } from '@app/specs/screenshot.schema';
import { CHANGES_READ_API } from '../changes-service';
import { appRouter, createSenderPolicy, type IpcContext, type ScreenshotsService } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const ID = '01920000-0000-7000-8000-000000000001';
const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const HASH = 'a'.repeat(64);
const SAVED: TakeScreenshotAnswer = { status: 'saved', id: ID, kind: 'viewport', width: 800, height: 600, bytes: 1_234, truncated: false };
const LIST: ScreenshotsAnswer = { screenshots: [], next: { createdAt: 5, id: ID } };
const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const EDIT_SAVED: SaveScreenshotEditAnswer = { status: 'saved', id: ID, width: 300, height: 200, bytes: 999 };
const ARROW: ScreenshotEditOp = { tool: 'arrow', color: '#e5484d', size: 4, from: { x: 1, y: 2 }, to: { x: 30, y: 40 } };
const EDIT: SaveScreenshotEditInput = {
  sourceId: ID,
  crop: { x: 10, y: 20, width: 300, height: 200 },
  overlay: DATA_URL,
  ops: [ARROW, { tool: 'box', color: '#111111', size: 2, rect: { x: 5, y: 5, width: 10, height: 10 }, filled: true }, { tool: 'text', color: '#0090ff', size: 16, at: { x: 0, y: 0 }, text: 'Look here' }],
};

function fakeScreenshots() {
  return {
    take: vi.fn(async (_tabId: number, _options: { kind: string; projectId?: string }): Promise<TakeScreenshotAnswer> => SAVED),
    list: vi.fn(async () => LIST),
    image: vi.fn(async (_id: string, _size: 'thumb' | 'preview'): Promise<string | null> => DATA_URL),
    reveal: vi.fn(async (_id: string) => true),
    copy: vi.fn(async (_id: string) => true),
    cancelArea: vi.fn(async (_tabId: number) => true),
    saveEdit: vi.fn(async (_input: SaveScreenshotEditInput): Promise<SaveScreenshotEditAnswer> => EDIT_SAVED),
  } satisfies ScreenshotsService;
}

function ctxFor(screenshots: ScreenshotsService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: screenshots === undefined ? {} : { screenshots },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { screenshots: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.screenshots[name];
  if (!fn) throw new Error(`no screenshots.${name}`);
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
  take: { tabId: 1, kind: 'full', projectId: PROJECT },
  list: { url: PAGE, projectId: PROJECT, cursor: { createdAt: 5, id: ID }, limit: 20 },
  image: { id: ID, size: 'thumb' },
  reveal: { id: ID },
  copy: { id: ID },
  cancelArea: { tabId: 1 },
  saveEdit: EDIT,
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (screenshots: ReturnType<typeof fakeScreenshots>) => {
  for (const fn of Object.values(screenshots)) expect(fn).not.toHaveBeenCalled();
};

describe('screenshots router', () => {
  test('every-screenshots-procedure-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('screenshots.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `screenshots.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null', 'file://']) {
        const screenshots = fakeScreenshots();
        for (const input of [VALID_INPUT[name], { bogus: true }, { path: '/etc/passwd' }, undefined]) {
          const error = await errorOf(procedure(ctxFor(screenshots, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(screenshots);
      }
    }
    // Without the service: a masked internal error, never a call.
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('screenshots-inputs-are-validated', async () => {
    const badIds = ['', 'not-an-id', PROJECT.toUpperCase(), '01920000-0000-4000-8000-000000000001', `${ID}0`, HASH, `../${ID}`, 5, null];
    const badTabs = [{ tabId: 0 }, { tabId: -1 }, { tabId: 1.5 }, { tabId: '1' }, {}, undefined];
    // Never a path, a file name or a hash, under any key.
    const smuggled = [{ path: '/tmp/x.png' }, { file: `${HASH}.png` }, { sha256: HASH }, { hash: HASH }, { dir: '/' }];
    const bad: Record<string, unknown[]> = {
      take: [
        ...badTabs.map((tab) => ({ ...(tab ?? {}), kind: 'viewport' })),
        { tabId: 1 },
        { tabId: 1, kind: 'page' },
        { tabId: 1, kind: 'VIEWPORT' },
        { tabId: 1, kind: 'area', rect: { x: 0, y: 0, width: 5, height: 5 } },
        { tabId: 1, kind: 'viewport', captureId: ID },
        { tabId: 1, kind: 'viewport', searchParams: null },
        ...badIds.map((projectId) => ({ tabId: 1, kind: 'viewport', projectId })),
        ...smuggled.map((extra) => ({ tabId: 1, kind: 'viewport', ...extra })),
      ],
      list: [
        { url: '' },
        { url: 'javascript:alert(1)' },
        { url: 'file:///etc/passwd' },
        { url: 'not a url' },
        { url: 5 },
        { limit: 0 },
        { limit: MAX_HISTORY_PAGE + 1 },
        { limit: 1.5 },
        { cursor: { createdAt: -1, id: ID } },
        { cursor: { createdAt: 1, id: 'x' } },
        { cursor: { createdAt: 1, id: ID, extra: 1 } },
        { cursor: null },
        ...badIds.map((projectId) => ({ projectId })),
        ...smuggled,
      ],
      image: [{ id: ID }, { size: 'thumb' }, { id: ID, size: 'full' }, { id: ID, size: 'thumb', extra: 1 }, ...badIds.map((id) => ({ id, size: 'thumb' })), ...smuggled.map((extra) => ({ id: ID, size: 'preview', ...extra }))],
      reveal: [{}, undefined, ...badIds.map((id) => ({ id })), ...smuggled, ...smuggled.map((extra) => ({ id: ID, ...extra }))],
      copy: [{}, undefined, ...badIds.map((id) => ({ id })), ...smuggled, ...smuggled.map((extra) => ({ id: ID, ...extra }))],
      cancelArea: [...badTabs, { tabId: 1, extra: 1 }],
      // Phase 11 Task 7: the edit's own bounds are in save-edit-enforces-sender-and-bounds-input.
      saveEdit: [{}, undefined, ...badIds.map((sourceId) => ({ ...EDIT, sourceId })), ...smuggled.map((extra) => ({ ...EDIT, ...extra }))],
    };
    for (const name of PROCEDURES) {
      for (const input of bad[name]!) {
        const screenshots = fakeScreenshots();
        const outcome = await procedure(ctxFor(screenshots), name)(input).then(() => 'accepted', (e: unknown) => (e instanceof TRPCError ? e.code : 'other'));
        expect(outcome, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(screenshots);
      }
    }
  });

  test('screenshots-procedures-call-service', async () => {
    const screenshots = fakeScreenshots();
    const call = (name: string, input?: unknown) => procedure(ctxFor(screenshots), name)(input);
    await expect(call('take', { tabId: 1, kind: 'viewport' })).resolves.toEqual(SAVED);
    expect(screenshots.take).toHaveBeenLastCalledWith(1, { kind: 'viewport' });
    await expect(call('take', VALID_INPUT.take)).resolves.toEqual(SAVED);
    expect(screenshots.take).toHaveBeenLastCalledWith(1, { kind: 'full', projectId: PROJECT });
    screenshots.take.mockResolvedValueOnce({ status: 'refused', reason: 'busy' });
    await expect(call('take', { tabId: 2, kind: 'area' })).resolves.toEqual({ status: 'refused', reason: 'busy' });
    await expect(call('list', VALID_INPUT.list)).resolves.toEqual(LIST);
    expect(screenshots.list).toHaveBeenLastCalledWith(VALID_INPUT.list);
    await expect(call('list', {})).resolves.toEqual(LIST);
    expect(screenshots.list).toHaveBeenLastCalledWith({});
    await expect(call('image', { id: ID, size: 'preview' })).resolves.toBe(DATA_URL);
    expect(screenshots.image).toHaveBeenLastCalledWith(ID, 'preview');
    screenshots.image.mockResolvedValueOnce(null);
    await expect(call('image', { id: ID, size: 'thumb' })).resolves.toBeNull();
    await expect(call('reveal', { id: ID })).resolves.toBe(true);
    expect(screenshots.reveal).toHaveBeenLastCalledWith(ID);
    await expect(call('copy', { id: ID })).resolves.toBe(true);
    expect(screenshots.copy).toHaveBeenLastCalledWith(ID);
    await expect(call('cancelArea', { tabId: 3 })).resolves.toBe(true);
    expect(screenshots.cancelArea).toHaveBeenLastCalledWith(3);
    // Answers are checked on the way out: a malformed answer, or a data URL over the cap, never reaches the chrome.
    screenshots.take.mockResolvedValueOnce({ status: 'saved', id: 'not-an-id' } as unknown as TakeScreenshotAnswer);
    expect((await errorOf(call('take', { tabId: 1, kind: 'viewport' }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    screenshots.image.mockResolvedValueOnce(`data:image/jpeg;base64,${'A'.repeat(SCREENSHOT_LIMITS.maxImageDataUrlChars)}`);
    expect((await errorOf(call('image', { id: ID, size: 'preview' }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    screenshots.image.mockResolvedValueOnce('file:///home/someone/shot.png');
    expect((await errorOf(call('image', { id: ID, size: 'thumb' }))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    // Phase 5 lists screenshots through CHANGES_READ_API too.
    expect(Object.keys(CHANGES_READ_API).sort()).toEqual(['diff', 'getVersion', 'history', 'listPages', 'listScreenshots']);
    expect(CHANGES_READ_API.listScreenshots.input.safeParse({ url: PAGE, path: '/etc' }).success).toBe(false);
  });
});

describe('screenshots.saveEdit (Phase 11 Task 7)', () => {
  test('save-edit-enforces-sender-and-bounds-input', async () => {
    // A foreign sender is refused before anything (also covered for every procedure above).
    for (const origin of ['https://evil.com', 'null']) {
      const screenshots = fakeScreenshots();
      expect((await errorOf(procedure(ctxFor(screenshots, origin), 'saveEdit')(EDIT))).code).toBe(IPC_SENDER_ERROR_CODE);
      expect(screenshots.saveEdit).not.toHaveBeenCalled();
    }
    // Inputs: bounded before main decodes anything.
    const base64Max = MAX_OVERLAY_DATA_URL_CHARS - SCREENSHOT_OVERLAY_PREFIX.length;
    const longest = `${SCREENSHOT_OVERLAY_PREFIX}${'A'.repeat(base64Max)}`;
    const text = (value: string): ScreenshotEditOp => ({ tool: 'text', color: '#111111', size: 12, at: { x: 0, y: 0 }, text: value });
    const bad: unknown[] = [
      { ...EDIT, overlay: `${longest}AAAA` },
      { ...EDIT, overlay: 'data:image/jpeg;base64,AAAA' },
      { ...EDIT, overlay: 'data:image/svg+xml;base64,AAAA' },
      { ...EDIT, overlay: `${SCREENSHOT_OVERLAY_PREFIX}` },
      { ...EDIT, overlay: `${SCREENSHOT_OVERLAY_PREFIX}AA AA` },
      { ...EDIT, overlay: `${SCREENSHOT_OVERLAY_PREFIX}AAAA"><script>` },
      { ...EDIT, overlay: 'file:///etc/passwd' },
      { ...EDIT, overlay: 5 },
      { ...EDIT, sourceId: 'x' },
      { ...EDIT, sourceId: HASH },
      { ...EDIT, crop: { x: -1, y: 0, width: 5, height: 5 } },
      { ...EDIT, crop: { x: 0, y: 0, width: 0, height: 5 } },
      { ...EDIT, crop: { x: 0.5, y: 0, width: 5, height: 5 } },
      { ...EDIT, crop: { x: 0, y: 0, width: SCREENSHOT_EDIT_LIMITS.maxCoordinate + 1, height: 5 } },
      { ...EDIT, crop: undefined },
      { ...EDIT, ops: Array.from({ length: SCREENSHOT_EDIT_LIMITS.maxOps + 1 }, () => ARROW) },
      { ...EDIT, ops: [{ ...ARROW, color: '#123456' }] },
      { ...EDIT, ops: [{ ...ARROW, color: 'red' }] },
      { ...EDIT, ops: [{ ...ARROW, tool: 'pen' }] },
      { ...EDIT, ops: [{ ...ARROW, tool: 'crop' }] },
      { ...EDIT, ops: [{ ...ARROW, size: 0 }] },
      { ...EDIT, ops: [{ ...ARROW, size: SCREENSHOT_EDIT_LIMITS.maxOpSize + 1 }] },
      { ...EDIT, ops: [{ ...ARROW, from: { x: 1.5, y: 0 } }] },
      { ...EDIT, ops: [{ ...ARROW, extra: 1 }] },
      { ...EDIT, ops: [text('')] },
      { ...EDIT, ops: [text('x'.repeat(SCREENSHOT_EDIT_LIMITS.maxTextChars + 1))] },
      { ...EDIT, ops: [{ tool: 'box', color: '#111111', size: 2, rect: { x: 0, y: 0, width: 4, height: 4 } }] },
      { ...EDIT, path: '/tmp/x.png' },
      { ...EDIT, sha256: HASH },
      { ...EDIT, file: `${HASH}.png` },
      { sourceId: ID, crop: null, ops: [] },
      undefined,
    ];
    for (const input of bad) {
      const screenshots = fakeScreenshots();
      const outcome = await procedure(ctxFor(screenshots), 'saveEdit')(input).then(() => 'accepted', (e: unknown) => (e instanceof TRPCError ? e.code : 'other'));
      expect(outcome, JSON.stringify(input)?.slice(0, 160)).toBe('BAD_REQUEST');
      expect(screenshots.saveEdit).not.toHaveBeenCalled();
    }
    // An overlay past the cap is refused at once: the base64 check never scans it (only `too_big`).
    const oversized = SaveScreenshotEditInputSchema.safeParse({ ...EDIT, overlay: `${SCREENSHOT_OVERLAY_PREFIX}${'!'.repeat(base64Max + 1)}` });
    expect(oversized.success ? [] : oversized.error.issues.map((issue) => issue.code)).toEqual(['too_big']);
    const notBase64 = SaveScreenshotEditInputSchema.safeParse({ ...EDIT, overlay: `${SCREENSHOT_OVERLAY_PREFIX}!!!!` });
    expect(notBase64.success ? [] : notBase64.error.issues.map((issue) => issue.code)).toEqual(['custom']);
    // At the caps: accepted and passed on as given.
    const screenshots = fakeScreenshots();
    const call = (input: unknown) => procedure(ctxFor(screenshots), 'saveEdit')(input);
    const atCaps = { ...EDIT, crop: null, overlay: longest, ops: [...Array.from({ length: SCREENSHOT_EDIT_LIMITS.maxOps - 1 }, () => ARROW), text('x'.repeat(SCREENSHOT_EDIT_LIMITS.maxTextChars))] };
    await expect(call(atCaps)).resolves.toEqual(EDIT_SAVED);
    expect(screenshots.saveEdit).toHaveBeenLastCalledWith(atCaps);
    await expect(call(EDIT)).resolves.toEqual(EDIT_SAVED);
    expect(screenshots.saveEdit).toHaveBeenLastCalledWith(EDIT);
    // Answers are checked on the way out.
    for (const status of ['no-source', 'invalid', 'too-large', 'store-failed', 'busy'] as const) {
      screenshots.saveEdit.mockResolvedValueOnce({ status });
      await expect(call(EDIT)).resolves.toEqual({ status });
    }
    for (const answer of [{ status: 'saved', id: 'nope', width: 1, height: 1, bytes: 1 }, { status: 'refused' }, { status: 'saved' }, { status: 'invalid', path: '/x' }]) {
      screenshots.saveEdit.mockResolvedValueOnce(answer as unknown as SaveScreenshotEditAnswer);
      expect((await errorOf(call(EDIT))).code).toBe(IPC_INTERNAL_ERROR_CODE);
    }
  });
});
