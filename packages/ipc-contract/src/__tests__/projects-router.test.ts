// Spec: specs/projects.schema.ts (the projects.* inputs and answers), specs/projects.spec.ts, specs/ipc-sender.spec.ts
// Acceptance: specs/projects.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { MAX_RETENTION_DAYS, MAX_RETENTION_VERSIONS, PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import type { SavedSearchInput } from '@app/specs/projects.spec';
import { IPC_SENDER_ERROR_CODE } from '@app/specs/ipc-sender.spec';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import type { ProjectsAnswer, RunState } from '@app/specs/projects.spec';
import { PURGE_LOG_LIMIT, type PurgeLogEntry, type RetentionUsage } from '@app/specs/retention.spec';
import { DEFAULT_RENDER_PROFILE } from '@app/specs/render-profile.spec';
import { APP_ORIGIN } from '@app/specs/security-policy.spec';
import { appRouter, createSenderPolicy, type IpcContext, type ProjectsService } from '../index';

const WINDOW_ID = 7;
const PAGE = 'https://example.com/guides/tea';
const PROJECT = '01920000-0000-7000-8000-0000000000aa';
const ITEM = '01920000-0000-7000-8000-000000000001';
const PARAMS: SavedSearchInput = { engine: 'google', query: 'green tea', country: 'de', language: 'de', device: 'tablet' };
const LIST: ProjectsAnswer = { projects: [{ id: UNFILED_PROJECT_ID, name: 'Unfiled', unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null } }] };
const STATE: RunState = { version: 3, runId: ITEM, projectId: PROJECT, state: 'running', current: 1, total: 1, omitted: 0, screenshot: false, targets: [{ kind: 'page', label: PAGE, outcome: 'running', changeCount: null, screenshot: null }] };

const COUNTS = { captures: 2, versions: 2, diffs: 1, screenshots: 1 };
const USAGE: RetentionUsage = { projectId: PROJECT, captures: 1, versions: 1, sharedVersions: 0, snapshotBytes: 900, diffBytes: 0, screenshots: 1, files: { count: 1, bytes: 300, missing: 0, shared: 0 }, database: { bytes: 40_960, walBytes: 0 } };
const ENTRY: PurgeLogEntry = { id: ITEM, reason: 'purge-now', projectId: PROJECT, policy: { mode: 'versions', value: 1 }, counts: COUNTS, bytes: 1_200, createdAt: 1_700_000_000_000 };

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
    setRetention: vi.fn(async () => ({ status: 'ok' as const })),
    retentionPreview: vi.fn(async () => ({ status: 'ok' as const, policy: { mode: 'versions' as const, value: 1 }, counts: COUNTS, bytes: 1_200 })),
    purgeNow: vi.fn(async () => ({ status: 'purged' as const, counts: COUNTS, bytes: 1_200, files: 1 })),
    usage: vi.fn(async (_projectId: string | null) => ({ status: 'ok' as const, usage: USAGE })),
    purgeLog: vi.fn(async (_projectId: string | null) => ({ entries: [ENTRY] })),
    compact: vi.fn(async () => ({ status: 'compacted' as const, before: 81_920, after: 40_960 })),
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
  addSearch: { projectId: PROJECT, search: PARAMS },
  removeSearch: { projectId: PROJECT, queryId: ITEM },
  forPage: { url: PAGE },
  startRun: { projectId: PROJECT, screenshot: true },
  cancelRun: undefined,
  runState: { sinceVersion: 2 },
  setRetention: { projectId: PROJECT, policy: { mode: 'versions', value: 3 } },
  retentionPreview: { projectId: PROJECT },
  purgeNow: { projectId: PROJECT },
  usage: { projectId: PROJECT },
  purgeLog: { projectId: null },
  compact: undefined,
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
      { ...PARAMS, language: 'a'.repeat(14) },
      { ...PARAMS, device: null },
      { ...PARAMS, device: 'watch' },
      { ...PARAMS, location: 'Berlin' },
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
      addSearch: [{ projectId: PROJECT }, { projectId: PROJECT, search: null }, { projectId: PROJECT, params: PARAMS }, ...badParams.map((search) => ({ projectId: PROJECT, search }))],
      removeSearch: [{ projectId: PROJECT }, ...badIds.map((queryId) => ({ projectId: PROJECT, queryId }))],
      forPage: [{}, { url: PAGE, extra: 1 }, ...badUrls.map((url) => ({ url }))],
      startRun: [{ projectId: PROJECT }, { projectId: PROJECT, screenshot: 'yes' }, { projectId: PROJECT, screenshot: true, extra: 1 }, ...badIds.map((projectId) => ({ projectId, screenshot: false }))],
      runState: [{}, undefined, { sinceVersion: -1 }, { sinceVersion: 1.5 }, { sinceVersion: '1' }, { sinceVersion: 1, extra: 1 }],
      setRetention: [
        { projectId: PROJECT },
        { projectId: PROJECT, policy: null },
        { projectId: PROJECT, policy: { mode: 'forever', value: 1 } },
        { projectId: PROJECT, policy: { mode: 'forever' } },
        { projectId: PROJECT, policy: { mode: 'versions', value: 0 } },
        { projectId: PROJECT, policy: { mode: 'versions', value: MAX_RETENTION_VERSIONS + 1 } },
        { projectId: PROJECT, policy: { mode: 'days', value: MAX_RETENTION_DAYS + 1 } },
        { projectId: PROJECT, policy: { mode: 'days', value: 1.5 } },
        { projectId: PROJECT, policy: { mode: 'days', value: '3' } },
        { projectId: PROJECT, policy: { mode: 'days', value: null } },
        { projectId: PROJECT, policy: { mode: 'all', value: null } },
        { projectId: PROJECT, policy: { mode: 'days', value: 3, extra: 1 } },
        { projectId: PROJECT, policy: { mode: 'days', value: 3 }, extra: 1 },
        ...badIds.map((projectId) => ({ projectId, policy: { mode: 'forever', value: null } })),
      ],
      retentionPreview: [{}, undefined, { projectId: PROJECT, extra: 1 }, ...badIds.map((projectId) => ({ projectId }))],
      purgeNow: [{}, undefined, { projectId: PROJECT, extra: 1 }, ...badIds.map((projectId) => ({ projectId }))],
      usage: [{}, undefined, { projectId: PROJECT, extra: 1 }, ...badIds.filter((id) => id !== null).map((projectId) => ({ projectId }))],
      purgeLog: [{}, undefined, { projectId: null, extra: 1 }, ...badIds.filter((id) => id !== null).map((projectId) => ({ projectId }))],
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
    await expect(call('setRetention')).resolves.toEqual({ status: 'ok' });
    expect(projects.setRetention).toHaveBeenCalledWith(PROJECT, 'versions', 3);
    await call('setRetention', { projectId: UNFILED_PROJECT_ID, policy: { mode: 'forever', value: null } });
    expect(projects.setRetention).toHaveBeenLastCalledWith(UNFILED_PROJECT_ID, 'forever', null);
    await expect(call('retentionPreview')).resolves.toMatchObject({ status: 'ok', counts: COUNTS });
    expect(projects.retentionPreview).toHaveBeenCalledWith(PROJECT);
    await expect(call('purgeNow')).resolves.toEqual({ status: 'purged', counts: COUNTS, bytes: 1_200, files: 1 });
    expect(projects.purgeNow).toHaveBeenCalledWith(PROJECT);
    await expect(call('usage')).resolves.toEqual({ status: 'ok', usage: USAGE });
    expect(projects.usage).toHaveBeenCalledWith(PROJECT);
    await call('usage', { projectId: null });
    expect(projects.usage).toHaveBeenLastCalledWith(null);
    await expect(call('purgeLog')).resolves.toEqual({ entries: [ENTRY] });
    expect(projects.purgeLog).toHaveBeenCalledWith(null);
    await expect(call('compact')).resolves.toEqual({ status: 'compacted', before: 81_920, after: 40_960 });
    expect(projects.compact).toHaveBeenCalledOnce();
  });

  test('projects-answers-are-checked', async () => {
    // An answer that does not fit its schema never reaches the chrome.
    const projects = fakeProjects();
    projects.list.mockResolvedValueOnce({ projects: [{ ...LIST.projects[0]!, name: '' }] });
    expect((await errorOf(procedure(ctxFor(projects), 'list')(undefined))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.runState.mockResolvedValueOnce({ ...STATE, state: 'bogus' } as unknown as RunState);
    expect((await errorOf(procedure(ctxFor(projects), 'runState')({ sinceVersion: 0 }))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.purgeNow.mockResolvedValueOnce({ status: 'purged', counts: { ...COUNTS, captures: -1 }, bytes: 1, files: 0 });
    expect((await errorOf(procedure(ctxFor(projects), 'purgeNow')({ projectId: PROJECT }))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.usage.mockResolvedValueOnce({ status: 'ok', usage: { ...USAGE, database: { bytes: 1.5, walBytes: 0 } } });
    expect((await errorOf(procedure(ctxFor(projects), 'usage')({ projectId: null }))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.purgeLog.mockResolvedValueOnce({ entries: Array.from({ length: PURGE_LOG_LIMIT + 1 }, () => ENTRY) });
    expect((await errorOf(procedure(ctxFor(projects), 'purgeLog')({ projectId: null }))).code).toBe('INTERNAL_SERVER_ERROR');
    projects.compact.mockResolvedValueOnce({ status: 'refused', reason: 'bogus' } as never);
    expect((await errorOf(procedure(ctxFor(projects), 'compact')(undefined))).code).toBe('INTERNAL_SERVER_ERROR');
  });
});
