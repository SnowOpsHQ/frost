// Spec: specs/projects.schema.ts (the projects.* inputs and answers), specs/projects.spec.ts, specs/ipc-sender.spec.ts
// Acceptance: specs/projects.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/capture-search-params.schema';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { ProjectsAnswer, RunState } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE } from '@app/specs/render-profile.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type ProjectsService } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ITEM = '01920000-0000-7000-8000-000000000001';
const PARAMS: SearchParams = { engine: 'google', query: 'green tea', country: 'de', language: 'de', location: 'Berlin', device: null };
const LIST: ProjectsAnswer = { projects: [{ id: UNFILED_PROJECT_ID, name: 'Unfiled', unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null } }] };
const STATE: RunState = { version: 3, runId: ITEM, projectId: PROJECT, state: 'running', current: 1, total: 1, omitted: 0, screenshot: false, targets: [{ kind: 'page', label: PAGE, outcome: 'running', changeCount: null, screenshot: null }] };

function fakeProjects() {
  return {
    list: vi.fn(async () => LIST),
    get: vi.fn(async (_projectId: string) => null),
    create: vi.fn(async (_name: string) => ({ status: 'created' as const, project: LIST.projects[0]! })),
    rename: vi.fn(async () => ({ status: 'ok' as const })),
    setRenderProfile: vi.fn(async () => ({ status: 'ok' as const })),
    remove: vi.fn(async () => ({ status: 'deleted' as const, purged: { captures: 1, versions: 1, diffs: 0, screenshots: 0 } })),
    addPage: vi.fn(async () => ({ status: 'added' as const, page: { id: ITEM, url: PAGE } })),
    addCurrentPage: vi.fn(async () => ({ status: 'refused' as const, reason: 'no-page' as const })),
    removePage: vi.fn(async () => ({ status: 'ok' as const })),
    addQuery: vi.fn(async () => ({ status: 'added' as const, query: { id: ITEM } })),
    removeQuery: vi.fn(async () => ({ status: 'ok' as const })),
    forPage: vi.fn(async () => LIST),
    startRun: vi.fn(async () => ({ status: 'started' as const, runId: ITEM })),
    cancelRun: vi.fn(() => true),
    runState: vi.fn(async () => STATE),
  } satisfies ProjectsService;
}

function ctxFor(projects: ProjectsService | undefined, origin: string = APP_ORIGIN): IpcContext {
  return {
    sender: { origin, live: true, windowId: WINDOW_ID, isWindowContents: true, isMainFrame: true },
    policy: createSenderPolicy({ knownWindowIds: new Set([WINDOW_ID]) }),
    services: projects === undefined ? {} : { projects },
  };
}

function procedure(ctx: IpcContext, name: string): (input?: unknown) => Promise<unknown> {
  const caller = appRouter.createCaller(ctx) as unknown as { projects: Record<string, (input?: unknown) => Promise<unknown>> };
  const fn = caller.projects[name];
  if (!fn) throw new Error(`no projects.${name}`);
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
  list: undefined,
  get: { projectId: PROJECT },
  create: { name: 'Coffee guides' },
  rename: { projectId: PROJECT, name: 'Tea guides' },
  setRenderProfile: { projectId: PROJECT, profile: { ...DEFAULT_RENDER_PROFILE, device: 'phone' } },
  remove: { projectId: PROJECT },
  addPage: { projectId: PROJECT, url: PAGE },
  addCurrentPage: { projectId: PROJECT },
  removePage: { projectId: PROJECT, pageId: ITEM },
  addSearch: { projectId: PROJECT, params: PARAMS },
  removeSearch: { projectId: PROJECT, queryId: ITEM },
  forPage: { url: PAGE },
  startRun: { projectId: PROJECT, screenshot: true },
  cancelRun: undefined,
  runState: { sinceVersion: 2 },
};
const PROCEDURES = Object.keys(VALID_INPUT);
const untouched = (projects: ReturnType<typeof fakeProjects>) => {
  for (const fn of Object.values(projects)) expect(fn).not.toHaveBeenCalled();
};

describe('projects router', () => {
  test('every-projects-procedure-enforces-sender', async () => {
    const paths = Object.keys(appRouter._def.procedures).filter((p) => p.startsWith('projects.'));
    expect(paths.sort()).toEqual(PROCEDURES.map((n) => `projects.${n}`).sort());
    for (const name of PROCEDURES) {
      for (const origin of ['https://evil.com', 'http://127.0.0.1:8080', 'null']) {
        const projects = fakeProjects();
        for (const input of [VALID_INPUT[name], { bogus: true }, undefined]) {
          const error = await errorOf(procedure(ctxFor(projects, origin), name)(input));
          expect(error.code, `${name} ${origin}`).toBe(IPC_SENDER_ERROR_CODE);
        }
        untouched(projects);
      }
    }
    // Without the service: a masked internal error, never a call (fail closed).
    for (const name of PROCEDURES) expect((await errorOf(procedure(ctxFor(undefined), name)(VALID_INPUT[name]))).code, name).toBe(IPC_INTERNAL_ERROR_CODE);
  });

  test('projects-inputs-are-validated', async () => {
    const badIds = ['', 'not-an-id', PROJECT.toUpperCase(), '01920000-0000-4000-8000-000000000001', `${ITEM}0`, 5, null];
    const badUrls = ['', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'app://frost/index.html', `https://example.com/${'x'.repeat(MAX_STORED_URL_LENGTH)}`, 5, null];
    const badNames = ['', '   ', 'x'.repeat(PROJECT_NAME_MAX_CHARS * 2 + 1), 'a‮b', 'line\nbreak', 5, null];
    const badParams = [
      { ...PARAMS, engine: 'other' },
      { ...PARAMS, query: '' },
      { ...PARAMS, query: ' padded ' },
      { ...PARAMS, country: 'DE' },
      { ...PARAMS, country: 'deu' },
      { ...PARAMS, language: 'EN' },
      { ...PARAMS, device: 'tablet' },
      { ...PARAMS, location: '' },
      { ...PARAMS, extra: 1 },
      { engine: 'google', query: 'x' },
    ];
    const bad: Record<string, unknown[]> = {
      get: [{}, undefined, { projectId: PROJECT, extra: 1 }, ...badIds.map((projectId) => ({ projectId }))],
      create: [{}, undefined, { name: 'x', extra: 1 }, ...badNames.map((name) => ({ name }))],
      rename: [{ projectId: PROJECT }, ...badNames.map((name) => ({ projectId: PROJECT, name })), ...badIds.map((projectId) => ({ projectId, name: 'x' }))],
      setRenderProfile: [{ projectId: PROJECT }, { projectId: PROJECT, profile: { device: 'phone' } }, { projectId: PROJECT, profile: { ...DEFAULT_RENDER_PROFILE, userAgent: 'custom', customUserAgent: '' } }, { projectId: PROJECT, profile: null, extra: 1 }],
      remove: [{}, ...badIds.map((projectId) => ({ projectId }))],
      addPage: [{ projectId: PROJECT }, { projectId: PROJECT, url: PAGE, extra: 1 }, ...badUrls.map((url) => ({ projectId: PROJECT, url })), ...badIds.map((projectId) => ({ projectId, url: PAGE }))],
      addCurrentPage: [{}, { projectId: PROJECT, url: PAGE }, ...badIds.map((projectId) => ({ projectId }))],
      removePage: [{ projectId: PROJECT }, ...badIds.map((pageId) => ({ projectId: PROJECT, pageId }))],
      addSearch: [{ projectId: PROJECT }, { projectId: PROJECT, params: null }, ...badParams.map((params) => ({ projectId: PROJECT, params }))],
      removeSearch: [{ projectId: PROJECT }, ...badIds.map((queryId) => ({ projectId: PROJECT, queryId }))],
      forPage: [{}, { url: PAGE, extra: 1 }, ...badUrls.map((url) => ({ url }))],
      startRun: [{ projectId: PROJECT }, { projectId: PROJECT, screenshot: 'yes' }, { projectId: PROJECT, screenshot: true, extra: 1 }, ...badIds.map((projectId) => ({ projectId, screenshot: false }))],
      runState: [{}, undefined, { sinceVersion: -1 }, { sinceVersion: 1.5 }, { sinceVersion: '1' }, { sinceVersion: 1, extra: 1 }],
    };
    for (const [name, inputs] of Object.entries(bad)) {
      for (const input of inputs) {
        const projects = fakeProjects();
        const error = await errorOf(procedure(ctxFor(projects), name)(input));
        expect(error.code, `${name} ${String(JSON.stringify(input))}`).toBe('BAD_REQUEST');
        untouched(projects);
      }
    }
  });

  test('projects-procedures-call-service', async () => {
    const projects = fakeProjects();
    const call = (name: string, input: unknown = VALID_INPUT[name]) => procedure(ctxFor(projects), name)(input);
    await expect(call('list')).resolves.toEqual(LIST);
    await expect(call('get')).resolves.toBeNull();
    expect(projects.get).toHaveBeenCalledWith(PROJECT);
    await expect(call('create')).resolves.toMatchObject({ status: 'created' });
    expect(projects.create).toHaveBeenCalledWith('Coffee guides');
    await call('rename');
    expect(projects.rename).toHaveBeenCalledWith(PROJECT, 'Tea guides');
    await call('setRenderProfile', { projectId: PROJECT, profile: null });
    expect(projects.setRenderProfile).toHaveBeenCalledWith(PROJECT, null);
    await expect(call('remove')).resolves.toMatchObject({ status: 'deleted' });
    expect(projects.remove).toHaveBeenCalledWith(PROJECT);
    await call('addPage');
    expect(projects.addPage).toHaveBeenCalledWith(PROJECT, PAGE);
    await expect(call('addCurrentPage')).resolves.toEqual({ status: 'refused', reason: 'no-page' });
    await call('removePage');
    expect(projects.removePage).toHaveBeenCalledWith(PROJECT, ITEM);
    await call('addSearch');
    expect(projects.addQuery).toHaveBeenCalledWith(PROJECT, PARAMS);
    await call('removeSearch');
    expect(projects.removeQuery).toHaveBeenCalledWith(PROJECT, ITEM);
    await call('forPage');
    expect(projects.forPage).toHaveBeenCalledWith(PAGE);
    await expect(call('startRun')).resolves.toEqual({ status: 'started', runId: ITEM });
    expect(projects.startRun).toHaveBeenCalledWith(PROJECT, true);
    await expect(call('cancelRun')).resolves.toBe(true);
    await expect(call('runState')).resolves.toEqual(STATE);
    expect(projects.runState).toHaveBeenCalledWith(2);
  });

  test('projects-answers-are-checked', async () => {
    // An answer that does not fit its schema never reaches the chrome.
    const projects = fakeProjects();
    projects.list.mockResolvedValueOnce({ projects: [{ ...LIST.projects[0]!, name: '' }] });
    expect((await errorOf(procedure(ctxFor(projects), 'list')(undefined))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.runState.mockResolvedValueOnce({ ...STATE, state: 'bogus' } as unknown as RunState);
    expect((await errorOf(procedure(ctxFor(projects), 'runState')({ sinceVersion: 0 }))).code).toBe('INTERNAL_SERVER_ERROR');
  });
});
