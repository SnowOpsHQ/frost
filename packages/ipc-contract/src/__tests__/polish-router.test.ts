// Spec: specs/browser-polish.schema.ts (the find.* / history.* / settings.* inputs), specs/browser-polish.spec.ts (caps),
// specs/ipc-sender.spec.ts
// Acceptance: specs/browser-polish.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { FIND_TEXT_MAX_CHARS, HISTORY_PAGE_SIZE, HISTORY_QUERY_MAX_CHARS } from '@app/specs/browser-polish.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type FindService, type HistoryService, type IpcContext, type SettingsService } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/a';
const VISIT = { url: PAGE, title: 'A', visitCount: 2, lastVisitAt: 5 };

function fakes() {
  const find = {
    open: vi.fn(),
    search: vi.fn((tabId: number, _text: string, _matchCase: boolean) => tabId === 1),
    step: vi.fn((tabId: number, _forward: boolean) => tabId === 1),
    close: vi.fn((tabId: number) => tabId === 1),
  } satisfies FindService;
  const history = {
    list: vi.fn(async (_query: string, _after: unknown, _limit?: number) => ({ visits: [VISIT], next: null })),
    jumpBackIn: vi.fn(async () => ({ mostVisited: [VISIT], recent: [] })),
    remove: vi.fn(async (_url: string) => true),
    clearAll: vi.fn(async () => true),
    reopenClosedTab: vi.fn(() => 9 as number | null),
    show: vi.fn(),
  } satisfies HistoryService;
  const settings = {
    searchEngine: vi.fn(() => 'bing' as const),
    setSearchEngine: vi.fn(async (_engine: string) => true),
  } satisfies SettingsService;
  return { find, history, settings };
}
type Fakes = ReturnType<typeof fakes>;

function ctxFor(services: Partial<Fakes>, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services,
  };
}

type Caller = Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
function procedure(ctx: IpcContext, path: string): (input?: unknown) => Promise<unknown> {
  const [ns, name] = path.split('.') as [string, string];
  const fn = (appRouter.createCaller(ctx) as unknown as Caller)[ns]?.[name];
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

const VALID_INPUT: Record<string, unknown> = {
  'find.open': undefined,
  'find.search': { tabId: 1, text: 'tea', matchCase: false },
  'find.step': { tabId: 1, forward: true },
  'find.close': { tabId: 1 },
  'history.list': { query: '', after: null },
  'history.jumpBackIn': undefined,
  'history.remove': { url: PAGE },
  'history.clearAll': undefined,
  'history.reopenClosedTab': undefined,
  'history.show': undefined,
  'settings.searchEngine': undefined,
  'settings.setSearchEngine': { engine: 'duckduckgo' },
};
const PATHS = Object.keys(VALID_INPUT);
const untouched = (all: Fakes) => {
  for (const service of Object.values(all)) for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
};

/** Every input in `bad` is refused (`BAD_REQUEST`) before any service is called. */
async function expectRefused(bad: Record<string, unknown[]>): Promise<void> {
  for (const [path, inputs] of Object.entries(bad)) {
    for (const input of inputs) {
      const all = fakes();
      expect((await errorOf(procedure(ctxFor(all), path)(input))).code, `${path} ${JSON.stringify(input)}`).toBe('BAD_REQUEST');
      untouched(all);
    }
  }
}

describe('browser polish router', () => {
  test('polish-router-guards-and-validates', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => /^(find|history|settings)\./.test(p));
    expect(paths.sort()).toEqual([...PATHS].sort());
    // A foreign sender is refused before anything runs, whatever the input.
    for (const path of PATHS) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const all = fakes();
        for (const input of [VALID_INPUT[path], { bogus: true }, undefined]) {
          expect((await errorOf(procedure(ctxFor(all, origin), path)(input))).code, `${path} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(all);
      }
    }
    // Without the service: a masked internal error, never a call.
    for (const path of PATHS) expect((await errorOf(procedure(ctxFor({}), path)(VALID_INPUT[path]))).code, path).toBe(IPC_INTERNAL_ERROR_CODE);

    const bad: Record<string, unknown[]> = {
      'history.list': [
        { query: '' },
        { query: 'q'.repeat(HISTORY_QUERY_MAX_CHARS + 1), after: null },
        { query: '', after: null, limit: HISTORY_PAGE_SIZE + 1 },
        { query: '', after: null, limit: 0 },
        { query: '', after: { lastVisitAt: -1, url: PAGE } },
        { query: '', after: { lastVisitAt: 1 } },
        { query: '', after: null, sql: 'DROP TABLE' },
      ],
      'history.remove': [{ url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }, { url: '' }, { url: `https://e.com/${'x'.repeat(MAX_STORED_URL_LENGTH)}` }, {}],
      'settings.setSearchEngine': [{ engine: 'evil' }, { engine: 'https://evil.example/?q={q}' }, {}, { engine: 'bing', template: 'x' }],
    };
    await expectRefused(bad);
  });

  // The find text is capped and strictly shaped before main's find runs (`browser-polish.feature.md`, Find in page).
  test('find-input-is-validated', async () => {
    await expectRefused({
      'find.search': [
        { tabId: 0, text: 'a', matchCase: false },
        { tabId: 1, text: 'a'.repeat(FIND_TEXT_MAX_CHARS + 1), matchCase: false },
        { tabId: 1, text: 'a' },
        { tabId: 1, text: 'a', matchCase: false, forward: true },
        { tabId: 1, text: 5, matchCase: false },
        { tabId: 1, text: ['a'], matchCase: false },
      ],
      'find.step': [{ tabId: 1 }, { tabId: -1, forward: true }, { tabId: 1, forward: 'yes' }, { tabId: 1, forward: true, text: 'a' }],
      'find.close': [{}, { tabId: 1.5 }, { tabId: 1, text: 'x' }],
    });
    // At the cap exactly, the text reaches the service unchanged.
    const all = fakes();
    const longest = 'a'.repeat(FIND_TEXT_MAX_CHARS);
    await expect(procedure(ctxFor(all), 'find.search')({ tabId: 1, text: longest, matchCase: false })).resolves.toBe(true);
    expect(all.find.search).toHaveBeenCalledExactlyOnceWith(1, longest, false);
  });

  test('polish-procedures-call-services', async () => {
    const all = fakes();
    const call = (path: string, input?: unknown) => procedure(ctxFor(all), path)(input);
    await expect(call('find.open')).resolves.toBeNull();
    expect(all.find.open).toHaveBeenCalledOnce();
    await expect(call('find.search', { tabId: 1, text: 'tea', matchCase: true })).resolves.toBe(true);
    expect(all.find.search).toHaveBeenCalledWith(1, 'tea', true);
    await expect(call('find.search', { tabId: 2, text: 'tea', matchCase: true })).resolves.toBe(false);
    await expect(call('find.step', { tabId: 1, forward: false })).resolves.toBe(true);
    expect(all.find.step).toHaveBeenCalledWith(1, false);
    await expect(call('find.close', { tabId: 1 })).resolves.toBe(true);
    await expect(call('history.list', { query: 'tea', after: { lastVisitAt: 3, url: PAGE }, limit: 5 })).resolves.toEqual({ visits: [VISIT], next: null });
    expect(all.history.list).toHaveBeenCalledWith('tea', { lastVisitAt: 3, url: PAGE }, 5);
    await expect(call('history.jumpBackIn')).resolves.toEqual({ mostVisited: [VISIT], recent: [] });
    await expect(call('history.remove', { url: PAGE })).resolves.toBe(true);
    expect(all.history.remove).toHaveBeenCalledWith(PAGE);
    await expect(call('history.clearAll')).resolves.toBe(true);
    await expect(call('history.reopenClosedTab')).resolves.toBe(9);
    all.history.reopenClosedTab.mockReturnValueOnce(null);
    await expect(call('history.reopenClosedTab')).resolves.toBeNull();
    await expect(call('history.show')).resolves.toBeNull();
    expect(all.history.show).toHaveBeenCalledOnce();
    await expect(call('settings.searchEngine')).resolves.toBe('bing');
    await expect(call('settings.setSearchEngine', { engine: 'duckduckgo' })).resolves.toBe(true);
    expect(all.settings.setSearchEngine).toHaveBeenCalledWith('duckduckgo');
  });
});
