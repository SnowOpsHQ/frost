// Spec: specs/projects.schema.ts (the projects.* inputs and answers, Phase 10's workspace procedures), specs/projects.spec.ts
// (BULK_SEARCH_LIMITS, SITE_INPUT_MAX_CHARS, TAG_INPUT_MAX_CHARS), specs/workspace-db.spec.ts (MAX_TAGS_PER_ENTRY), specs/ipc-sender.spec.ts
// Acceptance: specs/projects.feature.md (Router)
import { TRPCError } from '@trpc/server';
import { describe, expect, test, vi } from 'vitest';
import { MAX_STORED_URL_LENGTH } from '@app/specs/browser-session-db.spec';
import { MAX_RETENTION_DAYS, MAX_RETENTION_VERSIONS, PROJECT_NAME_MAX_CHARS, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { BULK_SEARCH_LIMITS, SITE_INPUT_MAX_CHARS, TAG_INPUT_MAX_CHARS, type BulkSearchesInput, type SavedSearchInput } from '@app/specs/projects.spec';
import { MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY } from '@app/specs/workspace-db.spec';
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
const LIST: ProjectsAnswer = { projects: [{ id: UNFILED_PROJECT_ID, name: 'Unfiled', unfiled: true, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 0, lastCapturedAt: null }] };
const BULK: BulkSearchesInput = { text: 'green tea\nblack tea', engine: 'google', locales: [{ country: 'de', language: 'de' }, { country: null, language: null }], devices: ['desktop', 'mobile'], tags: ['Brand'] };
const STATE: RunState = { version: 3, runId: ITEM, projectId: PROJECT, state: 'running', current: 1, total: 1, omitted: 0, screenshot: false, targets: [{ kind: 'page', label: PAGE, outcome: 'running', changeCount: null, screenshot: null }] };

const COUNTS = { captures: 2, versions: 2, diffs: 1, screenshots: 1 };
const USAGE: RetentionUsage = { projectId: PROJECT, captures: 1, versions: 1, sharedVersions: 0, snapshotBytes: 900, diffBytes: 0, readingBytes: 0, screenshots: 1, files: { count: 1, bytes: 300, missing: 0, shared: 0 }, database: { bytes: 40_960, walBytes: 0 } };
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
    setFavorite: vi.fn(async () => ({ status: 'ok' as const })),
    setSite: vi.fn(async () => ({ status: 'ok' as const, site: { domain: 'tea-shop.com', subdomains: true } })),
    addCompetitor: vi.fn(async () => ({ status: 'added' as const, competitor: { id: ITEM, domain: 'rival-tea.com' } })),
    removeCompetitor: vi.fn(async () => ({ status: 'ok' as const })),
    setTags: vi.fn(async () => ({ status: 'ok' as const, tags: ['brand'] })),
    addSearches: vi.fn(async () => ({ status: 'done' as const, lines: [{ query: 'green tea', outcome: 'added' as const, added: 4 }] })),
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
  setFavorite: { projectId: PROJECT, favorite: true },
  setSite: { projectId: PROJECT, domain: 'https://Tea-Shop.com/guides', subdomains: false },
  addCompetitor: { projectId: PROJECT, domain: 'rival-tea.com' },
  removeCompetitor: { projectId: PROJECT, competitorId: ITEM },
  setTags: { projectId: PROJECT, entryKind: 'search', entryId: ITEM, tags: ['Brand', 'top 10'] },
  addSearches: { projectId: PROJECT, searches: BULK },
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
      startRun: [
        { projectId: PROJECT },
        { projectId: PROJECT, screenshot: 'yes' },
        { projectId: PROJECT, screenshot: true, extra: 1 },
        { projectId: PROJECT, screenshot: true, scope: 'pages' },
        { projectId: PROJECT, screenshot: true, scope: null },
        ...badIds.map((projectId) => ({ projectId, screenshot: false })),
      ],
      setFavorite: [{ projectId: PROJECT }, { projectId: PROJECT, favorite: 'yes' }, { projectId: PROJECT, favorite: true, extra: 1 }, ...badIds.map((projectId) => ({ projectId, favorite: true }))],
      setSite: [
        { projectId: PROJECT, domain: 'tea-shop.com' },
        { projectId: PROJECT, subdomains: true },
        { projectId: PROJECT, domain: 'tea-shop.com', subdomains: 'yes' },
        { projectId: PROJECT, domain: 'tea-shop.com', subdomains: true, extra: 1 },
        ...['', '   ', 'x'.repeat(SITE_INPUT_MAX_CHARS + 1), 'tea\nshop.com', 'tea‮shop.com', 5].map((domain) => ({ projectId: PROJECT, domain, subdomains: true })),
        ...badIds.map((projectId) => ({ projectId, domain: 'tea-shop.com', subdomains: true })),
      ],
      addCompetitor: [
        { projectId: PROJECT },
        { projectId: PROJECT, domain: null },
        { projectId: PROJECT, domain: 'rival-tea.com', extra: 1 },
        ...['', '   ', 'x'.repeat(SITE_INPUT_MAX_CHARS + 1), 'rival\u0000.com', 5].map((domain) => ({ projectId: PROJECT, domain })),
        ...badIds.map((projectId) => ({ projectId, domain: 'rival-tea.com' })),
      ],
      removeCompetitor: [{ projectId: PROJECT }, { projectId: PROJECT, competitorId: ITEM, extra: 1 }, ...badIds.map((competitorId) => ({ projectId: PROJECT, competitorId }))],
      setTags: [
        { projectId: PROJECT, entryKind: 'page', entryId: ITEM },
        { projectId: PROJECT, entryKind: 'query', entryId: ITEM, tags: [] },
        { projectId: PROJECT, entryKind: 'page', entryId: ITEM, tags: [], extra: 1 },
        { projectId: PROJECT, entryKind: 'page', entryId: ITEM, tags: 'brand' },
        { projectId: PROJECT, entryKind: 'page', entryId: ITEM, tags: Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, n) => `t${n}`) },
        ...['', 'x'.repeat(TAG_INPUT_MAX_CHARS + 1), 'a\nb', 'a⁦b', 5, null].map((tag) => ({ projectId: PROJECT, entryKind: 'page', entryId: ITEM, tags: [tag] })),
        ...badIds.map((entryId) => ({ projectId: PROJECT, entryKind: 'page', entryId, tags: [] })),
        ...badIds.map((projectId) => ({ projectId, entryKind: 'page', entryId: ITEM, tags: [] })),
      ],
      addSearches: [
        { projectId: PROJECT },
        { projectId: PROJECT, searches: BULK, extra: 1 },
        { projectId: PROJECT, searches: { ...BULK, extra: 1 } },
        ...[
          { ...BULK, text: '' },
          { ...BULK, text: ' \n , ' },
          { ...BULK, text: 'x'.repeat(BULK_SEARCH_LIMITS.maxTextChars + 1) },
          { ...BULK, text: Array.from({ length: BULK_SEARCH_LIMITS.maxLines + 1 }, (_, n) => `tea ${n}`).join('\n') },
          { ...BULK, engine: 'other' },
          { ...BULK, locales: [] },
          { ...BULK, locales: Array.from({ length: BULK_SEARCH_LIMITS.maxLocales + 1 }, (_, n) => ({ country: `a${String.fromCharCode(97 + n)}`, language: null })) },
          { ...BULK, locales: [{ country: 'de', language: 'de' }, { country: 'de', language: 'de' }] },
          { ...BULK, locales: [{ country: 'DE', language: null }] },
          { ...BULK, locales: [{ country: 'de' }] },
          { ...BULK, locales: [{ country: 'de', language: 'de', location: 'Berlin' }] },
          { ...BULK, devices: [] },
          { ...BULK, devices: ['desktop', 'desktop'] },
          { ...BULK, devices: ['watch'] },
          { ...BULK, tags: Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, n) => `t${n}`) },
          { ...BULK, tags: ['a\u0000b'] },
          { text: 'green tea', engine: 'google' },
        ].map((searches) => ({ projectId: PROJECT, searches })),
        ...badIds.map((projectId) => ({ projectId, searches: BULK })),
      ],
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
    // No scope: `all` (Phase 10, `RUN_SCOPES`).
    expect(projects.startRun).toHaveBeenCalledWith(PROJECT, true, 'all');
    await call('startRun', { projectId: PROJECT, screenshot: false, scope: 'searches' });
    expect(projects.startRun).toHaveBeenLastCalledWith(PROJECT, false, 'searches');
    await expect(call('setFavorite')).resolves.toEqual({ status: 'ok' });
    expect(projects.setFavorite).toHaveBeenCalledWith(PROJECT, true);
    // Domains and tags reach main as typed: main normalizes them.
    await expect(call('setSite')).resolves.toEqual({ status: 'ok', site: { domain: 'tea-shop.com', subdomains: true } });
    expect(projects.setSite).toHaveBeenCalledWith(PROJECT, 'https://Tea-Shop.com/guides', false);
    await call('setSite', { projectId: PROJECT, domain: null, subdomains: true });
    expect(projects.setSite).toHaveBeenLastCalledWith(PROJECT, null, true);
    await expect(call('addCompetitor')).resolves.toMatchObject({ status: 'added' });
    expect(projects.addCompetitor).toHaveBeenCalledWith(PROJECT, 'rival-tea.com');
    await call('removeCompetitor');
    expect(projects.removeCompetitor).toHaveBeenCalledWith(PROJECT, ITEM);
    await expect(call('setTags')).resolves.toEqual({ status: 'ok', tags: ['brand'] });
    expect(projects.setTags).toHaveBeenCalledWith(PROJECT, 'search', ITEM, ['Brand', 'top 10']);
    await expect(call('addSearches')).resolves.toMatchObject({ status: 'done' });
    expect(projects.addSearches).toHaveBeenCalledWith(PROJECT, BULK);
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
    // Phase 10's workspace answers.
    const wrong: [string, keyof ReturnType<typeof fakeProjects>, unknown][] = [
      ['list', 'list', { projects: [{ ...LIST.projects[0]!, favorite: 'yes' }] }],
      ['list', 'list', { projects: [{ ...LIST.projects[0]!, site: { domain: 'Tea-Shop.com', subdomains: true } }] }],
      ['list', 'list', { projects: [{ ...LIST.projects[0]!, lastCapturedAt: -1 }] }],
      ['get', 'get', { project: LIST.projects[0]!, pages: [{ id: ITEM, url: PAGE, lastCapturedAt: null, changeCount: null, tags: ['ok', 'x'.repeat(40)] }], queries: [], competitors: [] }],
      ['get', 'get', { project: LIST.projects[0]!, pages: [], queries: [], competitors: Array.from({ length: MAX_PROJECT_COMPETITORS + 1 }, () => ({ id: ITEM, domain: 'rival-tea.com' })) }],
      ['get', 'get', { project: LIST.projects[0]!, pages: [], queries: [] }],
      ['setFavorite', 'setFavorite', { status: 'ok', favorite: true }],
      ['setSite', 'setSite', { status: 'ok', site: { domain: 'tea shop.com', subdomains: true } }],
      ['setSite', 'setSite', { status: 'refused', reason: 'bogus' }],
      ['addCompetitor', 'addCompetitor', { status: 'added', competitor: { id: 'x', domain: 'rival-tea.com' } }],
      ['removeCompetitor', 'removeCompetitor', { status: 'removed' }],
      ['setTags', 'setTags', { status: 'ok', tags: Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, n) => `t${n}`) }],
      ['addSearches', 'addSearches', { status: 'done', lines: [{ query: 'tea', outcome: 'skipped', added: 0 }] }],
      ['addSearches', 'addSearches', { status: 'done', lines: [{ query: 'tea', outcome: 'added', added: -1 }] }],
      ['addSearches', 'addSearches', { status: 'done', lines: Array.from({ length: BULK_SEARCH_LIMITS.maxLines + 1 }, () => ({ query: 'tea', outcome: 'added', added: 1 })) }],
    ];
    for (const [name, method, answer] of wrong) {
      const fake = fakeProjects();
      (fake[method] as unknown as { mockResolvedValueOnce: (value: unknown) => void }).mockResolvedValueOnce(answer);
      expect((await errorOf(procedure(ctxFor(fake), name)(VALID_INPUT[name]))).code, `${name} ${JSON.stringify(answer).slice(0, 80)}`).toBe('INTERNAL_SERVER_ERROR');
    }
  });
});
