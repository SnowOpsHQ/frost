// Spec: specs/projects.spec.ts (PROJECT_REFUSAL_MESSAGES, RUN_REFUSAL_MESSAGES, RUN_STATE_LABELS), specs/render-profile.spec.ts
// (QUICK_RENDER_PROFILES), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/projects.feature.md (The sheet, with Phase 10 Task 7's star and sort, Settings, tags
// and Bulk add; Changes panel picker; Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { MAX_PROJECT_QUERIES, UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import {
  BULK_ADD_TEXT,
  BULK_LINE_OUTCOME_LABELS,
  BULK_SEARCH_LIMITS,
  DEFAULT_PROJECT_SORT,
  FAVORITE_TEXT,
  PROJECT_REFUSAL_MESSAGES,
  PROJECT_SETTINGS_TEXT,
  PROJECT_SORTS,
  PROJECT_SORT_LABELS,
  PROJECT_VIEWS,
  PROJECT_VIEW_LABELS,
  QUERY_FIELD_MAX_CHARS,
  RUN_REFUSAL_MESSAGES,
  RUN_STATE_LABELS,
  SITE_INPUT_MAX_CHARS,
  TAG_EDITOR_TEXT,
  type ProjectSummary,
  type RunState,
} from '@app/specs/projects.spec';
import { MAX_PROJECT_COMPETITORS, MAX_TAGS_PER_ENTRY, TAG_MAX_CHARS } from '@app/specs/workspace-db.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { RETENTION_REFUSAL_MESSAGES, RETENTION_RULE_NOTES, USAGE_NOTE, formatBytes, type RetentionUsage } from '@app/specs/retention.spec';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { projectsPaletteSources, retentionPaletteSources } from '../projects-palette';
import {
  EMPTY_QUERY_FORM,
  PROJECT_PROFILE_CHOICES,
  EMPTY_BULK_FORM,
  PROJECT_SORT_OPTIONS,
  TAGS_TEXT_MAX_CHARS,
  addCompetitorText,
  addPageText,
  bulkFromForm,
  bulkOutcomeRows,
  bulkResultText,
  bulkSummaryText,
  canAddLocale,
  changeCountText,
  competitorFromInput,
  competitorRoom,
  favoriteButton,
  favoriteText,
  listedProjects,
  projectSortOf,
  removeCompetitorText,
  setTagsText,
  settingsAvailable,
  siteFormChanged,
  siteFormOf,
  siteFromForm,
  siteText,
  tagEditorLabel,
  tagsFromText,
  tagsTextOf,
  compactText,
  previewText,
  purgeLogText,
  purgeNowText,
  UNSAVED_POLICY_PREVIEW,
  retentionFormChanged,
  retentionFormOf,
  retentionFromForm,
  retentionNote,
  usageRows,
  defaultCaptureProject,
  lastCaptureText,
  pageUrlFromInput,
  pickedProject,
  profileChoiceOf,
  profileOfChoice,
  queryFromForm,
  refusalText,
  runActive,
  runProgressText,
  startRunText,
} from '../projects-view';

const P1 = '01920000-0000-7000-8000-0000000000a1';
const P2 = '01920000-0000-7000-8000-0000000000a2';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 3, url: 'https://www.example.com/a#top', title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

const run = (changes: Partial<RunState>): RunState => ({ version: 2, runId: P1, projectId: P1, state: 'running', current: 1, total: 3, omitted: 0, screenshot: false, targets: [], ...changes });

describe('projects view', () => {
  test('projects-view-profile-choice', () => {
    expect(PROJECT_PROFILE_CHOICES.map((choice) => choice.id)).toEqual(['default', ...QUICK_RENDER_PROFILES.map((quick) => quick.id)]);
    expect(profileChoiceOf(null)).toBe('default');
    expect(profileChoiceOf(DEFAULT_RENDER_PROFILE)).toBe('default');
    for (const quick of QUICK_RENDER_PROFILES) {
      expect(profileChoiceOf(quick.profile)).toBe(quick.id);
      expect(profileOfChoice(quick.id)).toEqual(quick.profile);
    }
    expect(profileChoiceOf({ ...DEFAULT_RENDER_PROFILE, network: '4g' })).toBe('custom');
    expect(profileOfChoice('default')).toBeNull();
    expect(profileOfChoice('nope')).toBeUndefined();
  });

  test('projects-view-query-form', () => {
    expect(queryFromForm({ ...EMPTY_QUERY_FORM, query: '  green tea ', country: ' DE ', language: 'PT-BR', device: 'tablet' })).toEqual({
      search: { engine: 'google', query: 'green tea', country: 'de', language: 'pt-br', device: 'tablet' },
    });
    // Desktop unless chosen; no location.
    expect(EMPTY_QUERY_FORM).not.toHaveProperty('location');
    expect(queryFromForm({ ...EMPTY_QUERY_FORM, engine: 'bing', query: 'tea' })).toEqual({ search: { engine: 'bing', query: 'tea', country: null, language: null, device: 'desktop' } });
    for (const bad of [
      { query: '   ' },
      { query: 'x', engine: 'other' },
      { query: 'x', country: 'deu' },
      { query: 'x', country: 'd1' },
      { query: 'x', language: 'english!' },
      { query: 'x', language: 'a'.repeat(QUERY_FIELD_MAX_CHARS.language + 1) },
      { query: 'x', device: '' },
      { query: 'x', device: 'watch' },
    ]) {
      expect(queryFromForm({ ...EMPTY_QUERY_FORM, ...bad }), JSON.stringify(bad)).toHaveProperty('problem');
    }
  });

  test('projects-view-page-input', () => {
    expect(pageUrlFromInput(' https://example.com/a ')).toBe('https://example.com/a');
    expect(pageUrlFromInput('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(pageUrlFromInput('example.com/guide')).toBe('https://example.com/guide');
    // host:port is a host, not a scheme; loopback gets http:, as in the address bar.
    expect(pageUrlFromInput('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(pageUrlFromInput('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(pageUrlFromInput('example.com:8443/a')).toBe('https://example.com:8443/a');
    expect(pageUrlFromInput('localhost/x')).toBe('http://localhost/x');
    for (const bad of ['', '   ', 'javascript:alert(1)', 'file:///etc/passwd', 'app://frost/index.html', 'data:text/html,x', 'user@example.com/x', 'two words', 'example.com:0/x', 'mailto:x@example.com']) expect(pageUrlFromInput(bad), bad).toBeNull();
  });

  test('projects-view-wording', () => {
    expect(lastCaptureText(null)).toBe('Not captured yet');
    expect(lastCaptureText(Date.UTC(2026, 0, 2, 3, 4))).toMatch(/^Captured /);
    expect(changeCountText(null, false)).toBe('');
    expect(changeCountText(null, true)).toBe('First version');
    expect(changeCountText(0, true)).toBe('No changes');
    expect(changeCountText(1, true)).toBe('1 change');
    expect(changeCountText(4, true)).toBe('4 changes');
    expect(runActive('running')).toBe(true);
    expect(runActive('waiting-for-tab')).toBe(true);
    for (const ended of ['idle', 'done', 'cancelled', 'tab-closed', 'failed'] as const) expect(runActive(ended)).toBe(false);
    expect(runProgressText(run({ current: 2 }))).toBe(`${RUN_STATE_LABELS.running} 2 of 3`);
    expect(runProgressText(run({ state: 'waiting-for-tab', current: 1 }))).toBe(`${RUN_STATE_LABELS['waiting-for-tab']} 1 of 3`);
    const targets = [
      { kind: 'page' as const, label: 'a', outcome: 'captured' as const, changeCount: 0, screenshot: null },
      { kind: 'page' as const, label: 'b', outcome: 'timed-out' as const, changeCount: null, screenshot: null },
    ];
    expect(runProgressText(run({ state: 'done', total: 2, targets }))).toBe('Done: 1 of 2 captured');
    expect(runProgressText(run({ state: 'cancelled', total: 70, omitted: 4, targets }))).toBe('Cancelled: 1 of 70 captured (4 more not visited: a run visits at most 70)');
    expect(runProgressText(run({ state: 'idle' }))).toBe(RUN_STATE_LABELS.idle);
    expect(refusalText({ status: 'ok' })).toBeNull();
    const unfiled: { status: string; reason: string } = { status: 'refused', reason: 'unfiled' };
    expect(refusalText(unfiled)).toBe(PROJECT_REFUSAL_MESSAGES.unfiled);
    expect(refusalText(null)).toMatch(/went wrong/);
    expect(startRunText({ status: 'started', runId: P1 })).toBeNull();
    expect(startRunText({ status: 'refused', reason: 'busy' })).toBe(RUN_REFUSAL_MESSAGES.busy);
    expect(addPageText({ status: 'added', page: { id: P1, url: 'https://example.com/' } })).toBe('Page added.');
    expect(addPageText({ status: 'refused', reason: 'limit' })).toBe(PROJECT_REFUSAL_MESSAGES.limit);
  });

  test('projects-view-picked-project', () => {
    const list = [{ id: UNFILED_PROJECT_ID }, { id: P1 }, { id: P2 }];
    expect(pickedProject(list, P2, P1)).toBe(P2);
    expect(pickedProject(list, undefined, P1)).toBeUndefined();
    // The chosen project was deleted: the page's default, else Unfiled.
    expect(pickedProject([{ id: UNFILED_PROJECT_ID }, { id: P1 }], P2, P1)).toBe(P1);
    expect(pickedProject([{ id: UNFILED_PROJECT_ID }], P2, P1)).toBeUndefined();
  });

  test('projects-view-default-capture-project', () => {
    expect(defaultCaptureProject([])).toBeUndefined();
    expect(defaultCaptureProject([{ id: P2 }, { id: P1 }])).toBe(P2);
    expect(defaultCaptureProject([{ id: UNFILED_PROJECT_ID }, { id: P1 }])).toBe(P1);
    expect(defaultCaptureProject([{ id: UNFILED_PROJECT_ID }])).toBeUndefined();
  });

  test('projects-palette-actions', async () => {
    const api = { open: vi.fn(), lastProject: vi.fn((): string | undefined => undefined), startRun: vi.fn(async () => ({ status: 'started' as const, runId: P1 })) };
    const registry = createPaletteRegistry();
    registry.register(...projectsPaletteSources(api));
    const ctx = (active: TabState | undefined): PaletteContext => ({ state: null, tab: active, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } });
    const ids = (active: TabState | undefined) => registry.resolve(ctx(active)).map((action) => action.id);
    // Open projects, rankings and compare always; add this page with a web page; capture now once a project was opened.
    const always = ['projects.open', 'projects.open-rankings', 'projects.compare'];
    expect(ids(undefined)).toEqual(always);
    expect(ids(tab({ url: 'app://frost/newtab' }))).toEqual(always);
    expect(ids(tab())).toEqual([...always, 'projects.add-page']);
    const labels = registry.resolve(ctx(tab())).map((action) => action.label);
    expect(labels).toContain('Open rankings');
    expect(labels).toContain('Compare searches');
    const action = (id: string) => registry.resolve(ctx(tab())).find((a) => a.id === id)!;
    // Spec: projects.feature.md, Command palette — the last project opened, else the sheet's first.
    await action('projects.open-rankings').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith({ view: 'rankings' });
    await action('projects.compare').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith({ view: 'compare' });
    api.lastProject.mockReturnValue(P1);
    expect(ids(tab())).toEqual([...always, 'projects.add-page', 'projects.capture-now']);
    await action('projects.open-rankings').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith({ projectId: P1, view: 'rankings' });
    await action('projects.compare').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith({ projectId: P1, view: 'compare' });
    await action('projects.open').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith();
    await action('projects.add-page').run(ctx(tab()));
    expect(api.open).toHaveBeenLastCalledWith({ addUrl: 'https://www.example.com/a' });
    expect(await action('projects.capture-now').run(ctx(tab()))).toBe('Capturing the project…');
    expect(api.open).toHaveBeenLastCalledWith({ projectId: P1 });
    expect(api.startRun).toHaveBeenCalledWith(P1);
    api.startRun.mockResolvedValueOnce({ status: 'refused', reason: 'busy' } as never);
    expect(await action('projects.capture-now').run(ctx(tab()))).toBe(RUN_REFUSAL_MESSAGES.busy);
  });

  // spec: specs/projects.feature.md — The sheet (Star and sort); projects.spec.ts sortProjects, PROJECT_SORTS
  test('projects-view-favorites-and-sort', () => {
    const summary = (id: string, name: string, more: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name, unfiled: false, renderProfile: null, retention: { mode: 'forever', value: null }, favorite: false, site: null, createdAt: 1, lastCapturedAt: null, ...more });
    const P3 = '01920000-0000-7000-8000-0000000000a3';
    const unfiled = summary(UNFILED_PROJECT_ID, 'Unfiled', { unfiled: true, createdAt: 0 });
    const beta = summary(P1, 'beta', { createdAt: 30, lastCapturedAt: 100 });
    const alpha = summary(P2, 'Alpha', { createdAt: 10, lastCapturedAt: null });
    const gamma = summary(P3, 'Gamma', { favorite: true, createdAt: 20, lastCapturedAt: 50 });
    const list = [beta, alpha, gamma, unfiled];
    const order = (sort: string) => listedProjects(list, projectSortOf(sort)).map((project) => project.name);
    // The menu: every sort with its label; Name when the sheet opens; anything else is Name.
    expect(PROJECT_SORT_OPTIONS).toEqual(PROJECT_SORTS.map((value) => ({ value, label: PROJECT_SORT_LABELS[value] })));
    expect(DEFAULT_PROJECT_SORT).toBe('name');
    expect(projectSortOf('created')).toBe('created');
    expect(projectSortOf('last-captured')).toBe('last-captured');
    expect(projectSortOf('bogus')).toBe('name');
    expect(projectSortOf('__proto__')).toBe('name');
    // Unfiled first, then favorites, then the rest, each by the sort.
    expect(order('name')).toEqual(['Unfiled', 'Gamma', 'Alpha', 'beta']);
    expect(order('created')).toEqual(['Unfiled', 'Gamma', 'beta', 'Alpha']);
    expect(order('last-captured')).toEqual(['Unfiled', 'Gamma', 'beta', 'Alpha']);
    // View state only: the answer's order is left as it was.
    expect(list.map((project) => project.name)).toEqual(['beta', 'Alpha', 'Gamma', 'Unfiled']);
    // The star: a toggle with a fixed name and its state in aria-pressed; Unfiled has one too.
    expect(favoriteButton(beta)).toEqual({ pressed: false, next: true, label: 'Favorite beta' });
    expect(favoriteButton(gamma)).toEqual({ pressed: true, next: false, label: 'Favorite Gamma' });
    expect(favoriteButton(unfiled).label).toBe(FAVORITE_TEXT.label.replace('{name}', 'Unfiled'));
    // A `$&` in a name stays text.
    expect(favoriteButton(summary(P1, 'A $& B')).label).toBe('Favorite A $& B');
    expect(favoriteText({ status: 'ok' }, true)).toBe(FAVORITE_TEXT.added);
    expect(favoriteText({ status: 'ok' }, false)).toBe(FAVORITE_TEXT.removed);
    expect(favoriteText({ status: 'refused', reason: 'not-found' }, true)).toBe(PROJECT_REFUSAL_MESSAGES['not-found']);
    expect(favoriteText(null, true)).toMatch(/went wrong/);
  });

  // spec: specs/projects.feature.md — The sheet (Settings: site and competitors); plan Decision 7
  test('projects-view-settings-form', () => {
    expect(PROJECT_VIEWS).toEqual(['overview', 'rankings', 'compare', 'settings']);
    expect(PROJECT_VIEW_LABELS.settings).toBe('Settings');
    // The site form: subdomains on for a project with no site.
    expect(siteFormOf(null)).toEqual({ domain: '', subdomains: true });
    expect(siteFormOf({ domain: 'shop.com', subdomains: false })).toEqual({ domain: 'shop.com', subdomains: false });
    // Read as main reads it (normalizeSiteDomain): the host of an address, lowercase, IDN as punycode.
    expect(siteFromForm({ domain: ' https://WWW.Shop.com/path?q=1 ', subdomains: false })).toEqual({ site: { domain: 'www.shop.com', subdomains: false } });
    expect(siteFromForm({ domain: 'bücher.de', subdomains: true })).toEqual({ site: { domain: 'xn--bcher-kva.de', subdomains: true } });
    // Empty clears the site.
    expect(siteFromForm({ domain: '   ', subdomains: true })).toEqual({ site: { domain: null, subdomains: true } });
    for (const bad of ['localhost', '192.168.0.1', '[::1]', 'ftp://shop.com', 'me@shop.com', 'shop.example', 'two words.com', 'intranet', 'x'.repeat(SITE_INPUT_MAX_CHARS + 1)]) {
      expect(siteFromForm({ domain: bad, subdomains: true }), bad).toEqual({ problem: PROJECT_REFUSAL_MESSAGES['invalid-domain'] });
    }
    expect(siteFormChanged({ domain: 'shop.com', subdomains: true }, { domain: 'shop.com', subdomains: true })).toBe(false);
    expect(siteFormChanged({ domain: ' shop.com ', subdomains: true }, { domain: 'shop.com', subdomains: true })).toBe(false);
    expect(siteFormChanged({ domain: 'shop.com', subdomains: false }, { domain: 'shop.com', subdomains: true })).toBe(true);
    expect(siteFormChanged({ domain: 'other.com', subdomains: true }, { domain: 'shop.com', subdomains: true })).toBe(true);
    expect(siteFormChanged({ domain: '', subdomains: true }, null)).toBe(false);
    expect(siteFormChanged({ domain: 'shop.com', subdomains: true }, null)).toBe(true);
    expect(siteText({ status: 'ok', site: { domain: 'shop.com', subdomains: true } })).toBe(PROJECT_SETTINGS_TEXT.siteSaved);
    expect(siteText({ status: 'ok', site: null })).toBe(PROJECT_SETTINGS_TEXT.siteCleared);
    expect(siteText({ status: 'refused', reason: 'invalid-domain' })).toBe(PROJECT_REFUSAL_MESSAGES['invalid-domain']);
    expect(siteText({ status: 'refused', reason: 'unfiled' })).toBe(PROJECT_REFUSAL_MESSAGES.unfiled);
    expect(siteText(null)).toMatch(/went wrong/);
    // Unfiled has no site or competitors.
    expect(settingsAvailable({ unfiled: true })).toBe(false);
    expect(settingsAvailable({ unfiled: false })).toBe(true);
    // Competitors: read the same way, at most MAX_PROJECT_COMPETITORS.
    expect(competitorFromInput(' Rival.COM ')).toEqual({ domain: 'rival.com' });
    expect(competitorFromInput('https://shop.rival.com/x')).toEqual({ domain: 'shop.rival.com' });
    for (const bad of ['', '  ', 'localhost', '10.0.0.1', 'javascript:alert(1)']) expect(competitorFromInput(bad), bad).toEqual({ problem: PROJECT_REFUSAL_MESSAGES['invalid-domain'] });
    expect(MAX_PROJECT_COMPETITORS).toBe(10);
    expect(competitorRoom(0)).toEqual({ canAdd: true, text: `0 of ${MAX_PROJECT_COMPETITORS}` });
    expect(competitorRoom(3)).toEqual({ canAdd: true, text: `3 of ${MAX_PROJECT_COMPETITORS}` });
    expect(competitorRoom(MAX_PROJECT_COMPETITORS)).toEqual({ canAdd: false, text: `${MAX_PROJECT_COMPETITORS} of ${MAX_PROJECT_COMPETITORS}` });
    const rival = { id: P2, domain: 'rival.com' };
    expect(addCompetitorText({ status: 'added', competitor: rival }, [])).toBe(PROJECT_SETTINGS_TEXT.competitorAdded);
    // Another host of a competitor's domain answers that competitor.
    expect(addCompetitorText({ status: 'added', competitor: rival }, [rival])).toBe(PROJECT_SETTINGS_TEXT.competitorExists);
    expect(addCompetitorText({ status: 'refused', reason: 'limit' }, [])).toBe(PROJECT_REFUSAL_MESSAGES.limit);
    expect(addCompetitorText({ status: 'refused', reason: 'invalid-domain' }, [])).toBe(PROJECT_REFUSAL_MESSAGES['invalid-domain']);
    expect(addCompetitorText(null, [])).toMatch(/went wrong/);
    expect(removeCompetitorText({ status: 'ok' })).toBe(PROJECT_SETTINGS_TEXT.competitorRemoved);
    expect(removeCompetitorText({ status: 'refused', reason: 'not-found' })).toBe(PROJECT_REFUSAL_MESSAGES['not-found']);
  });

  // spec: specs/projects.feature.md — The sheet (Bulk add); Bulk add; projects.spec.ts BULK_SEARCH_LIMITS, splitBulkSearches
  test('projects-view-bulk-add-form', () => {
    expect(EMPTY_BULK_FORM).toEqual({ text: '', engine: 'google', locales: [{ country: '', language: '' }], devices: ['desktop'], tags: '' });
    const form = {
      text: 'green tea\nblack tea,  green  tea\n\n',
      engine: 'bing',
      locales: [{ country: ' DE ', language: 'de' }, { country: '', language: '' }, { country: 'de', language: 'DE' }],
      devices: ['tablet', 'desktop'],
      tags: 'Tea, drinks',
    };
    // Lines as main splits them; a pair given twice sent once; devices in SERP_DEVICES order; tags normalized.
    expect(bulkFromForm(form)).toEqual({
      input: { text: 'green tea\nblack tea', engine: 'bing', locales: [{ country: 'de', language: 'de' }, { country: null, language: null }], devices: ['desktop', 'tablet'], tags: ['drinks', 'tea'] },
      lines: 2,
      locales: 2,
      devices: 2,
      searches: 8,
    });
    expect(bulkFromForm({ ...EMPTY_BULK_FORM, text: 'tea' })).toEqual({ input: { text: 'tea', engine: 'google', locales: [{ country: null, language: null }], devices: ['desktop'], tags: [] }, lines: 1, locales: 1, devices: 1, searches: 1 });
    const many = Array.from({ length: BULK_SEARCH_LIMITS.maxLines + 1 }, (_, index) => `q${index}`).join('\n');
    const problems: [Partial<typeof form>, string][] = [
      [{ text: ' \n , ' }, 'Enter at least one query.'],
      [{ text: many }, `Enter at most ${BULK_SEARCH_LIMITS.maxLines} queries at once.`],
      [{ text: 'x'.repeat(BULK_SEARCH_LIMITS.maxTextChars + 1) }, `Enter at most ${BULK_SEARCH_LIMITS.maxLines} queries at once.`],
      [{ engine: 'other' }, 'Choose a search engine.'],
      [{ locales: [{ country: 'deu', language: '' }] }, 'A country is two letters, like “de”.'],
      [{ locales: [{ country: '', language: 'english!' }] }, 'A language is a code like “en” or “pt-br”.'],
      [{ locales: [{ country: '', language: 'a'.repeat(QUERY_FIELD_MAX_CHARS.language + 1) }] }, 'A language is a code like “en” or “pt-br”.'],
      [{ locales: [] }, 'Add a country and language (or leave both empty).'],
      [{ locales: Array.from({ length: BULK_SEARCH_LIMITS.maxLocales + 1 }, (_, index) => ({ country: String.fromCharCode(97 + index).repeat(2), language: '' })) }, `At most ${BULK_SEARCH_LIMITS.maxLocales} countries and languages.`],
      [{ devices: [] }, 'Choose at least one device.'],
      [{ devices: ['watch'] }, 'Choose at least one device.'],
      [{ tags: Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, index) => `t${index}`).join(',') }, PROJECT_REFUSAL_MESSAGES['invalid-tag']],
    ];
    for (const [change, problem] of problems) expect(bulkFromForm({ ...form, ...change }), JSON.stringify(change).slice(0, 80)).toEqual({ problem });
    // Locale rows: up to maxLocales.
    expect(BULK_SEARCH_LIMITS.maxLocales).toBe(5);
    expect(canAddLocale(EMPTY_BULK_FORM)).toBe(true);
    expect(canAddLocale({ ...EMPTY_BULK_FORM, locales: Array.from({ length: BULK_SEARCH_LIMITS.maxLocales }, () => ({ country: '', language: '' })) })).toBe(false);
    // The summary: what it makes, and the room left in the project.
    expect(bulkSummaryText({ lines: 2, locales: 2, devices: 2, searches: 8 }, MAX_PROJECT_QUERIES - 10)).toBe('2 queries × 2 locales × 2 devices: 8 searches. The project can hold 10 more.');
    expect(bulkSummaryText({ lines: 1, locales: 1, devices: 1, searches: 1 }, 0)).toBe(`1 query × 1 locale × 1 device: 1 search. The project can hold ${MAX_PROJECT_QUERIES} more.`);
    expect(bulkSummaryText({ lines: 1, locales: 1, devices: 1, searches: 1 }, MAX_PROJECT_QUERIES)).toBe('1 query × 1 locale × 1 device: 1 search. The project is full.');
    // The note: frost's own words, nothing sent.
    expect(BULK_ADD_TEXT.note).toContain('only saves searches');
    expect(BULK_ADD_TEXT.note).toContain('Nothing is sent to a search engine until you run Check rankings');
    // Per-line outcomes, in order, the query as text.
    const answer = {
      status: 'done' as const,
      lines: [
        { query: 'green tea', outcome: 'added' as const, added: 3 },
        { query: 'one', outcome: 'added' as const, added: 1 },
        { query: 'black tea', outcome: 'exists' as const, added: 0 },
        { query: '<b>x</b>', outcome: 'invalid' as const, added: 0 },
        { query: 'white tea', outcome: 'limit' as const, added: 1 },
        { query: 'oolong', outcome: 'limit' as const, added: 0 },
      ],
    };
    expect(bulkOutcomeRows(answer)).toEqual([
      { query: 'green tea', outcome: 'added', text: 'Added 3 searches' },
      { query: 'one', outcome: 'added', text: 'Added 1 search' },
      { query: 'black tea', outcome: 'exists', text: BULK_LINE_OUTCOME_LABELS.exists },
      { query: '<b>x</b>', outcome: 'invalid', text: BULK_LINE_OUTCOME_LABELS.invalid },
      { query: 'white tea', outcome: 'limit', text: `${BULK_LINE_OUTCOME_LABELS.limit} (1 search added first)` },
      { query: 'oolong', outcome: 'limit', text: BULK_LINE_OUTCOME_LABELS.limit },
    ]);
    expect(bulkOutcomeRows(null)).toEqual([]);
    expect(bulkOutcomeRows({ status: 'refused', reason: 'invalid-tag' })).toEqual([]);
    expect(bulkResultText(answer)).toBe('Added 5 searches from 6 lines.');
    expect(bulkResultText({ status: 'done', lines: [{ query: 'a', outcome: 'exists', added: 0 }] })).toBe('Added 0 searches from 1 line.');
    expect(bulkResultText({ status: 'refused', reason: 'limit' })).toBe(PROJECT_REFUSAL_MESSAGES.limit);
    expect(bulkResultText({ status: 'refused', reason: 'unfiled' })).toBe(PROJECT_REFUSAL_MESSAGES.unfiled);
    expect(bulkResultText(null)).toMatch(/went wrong/);
  });

  // spec: specs/projects.feature.md — The sheet (Tags); Tags; projects.spec.ts normalizeTags
  test('projects-view-tags', () => {
    expect(tagsFromText(' Tea,  Green   Tea ,tea, ')).toEqual({ tags: ['green tea', 'tea'] });
    expect(tagsFromText('')).toEqual({ tags: [] });
    expect(tagsFromText(' , ,')).toEqual({ tags: [] });
    // The cap counts tags after repeats are dropped: more typed parts than MAX_TAGS_PER_ENTRY can still fit.
    const repeated = [...Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => `t${index}`), 'T0', ' t1 '].join(',');
    expect(tagsFromText(repeated)).toEqual({ tags: Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => `t${index}`).sort() });
    expect(tagsFromText(Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => `t${index}`).join(', '))).toEqual({ tags: Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, index) => `t${index}`).sort() });
    for (const bad of [
      Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, index) => `t${index}`).join(','),
      'x'.repeat(TAG_MAX_CHARS + 1),
      'bad\u0007tag',
      'rtl‮tag',
      'x'.repeat(TAGS_TEXT_MAX_CHARS + 1),
    ]) {
      expect(tagsFromText(bad), bad.slice(0, 40)).toEqual({ problem: PROJECT_REFUSAL_MESSAGES['invalid-tag'] });
    }
    // The bound of the input holds MAX_TAGS_PER_ENTRY tags of the longest typed length, with separators.
    expect(TAGS_TEXT_MAX_CHARS).toBeGreaterThanOrEqual(MAX_TAGS_PER_ENTRY * TAG_MAX_CHARS);
    expect(tagsTextOf([])).toBe('');
    expect(tagsTextOf(['green tea', 'tea'])).toBe('green tea, tea');
    expect(tagsFromText(tagsTextOf(['green tea', 'tea']))).toEqual({ tags: ['green tea', 'tea'] });
    expect(tagEditorLabel('“tea” on Google')).toBe(TAG_EDITOR_TEXT.label.replace('{label}', '“tea” on Google'));
    expect(tagEditorLabel('$&')).toBe('Tags for $&');
    expect(setTagsText({ status: 'ok', tags: ['tea'] })).toBe(TAG_EDITOR_TEXT.saved);
    expect(setTagsText({ status: 'refused', reason: 'invalid-tag' })).toBe(PROJECT_REFUSAL_MESSAGES['invalid-tag']);
    expect(setTagsText({ status: 'refused', reason: 'limit' })).toBe(PROJECT_REFUSAL_MESSAGES.limit);
    expect(setTagsText(null)).toMatch(/went wrong/);
  });

  test('retention-view-policy-form', () => {
    expect(retentionFormOf({ mode: 'forever', value: null })).toEqual({ mode: 'forever', value: '' });
    expect(retentionFormOf({ mode: 'versions', value: 3 })).toEqual({ mode: 'versions', value: '3' });
    expect(retentionFromForm({ mode: 'forever', value: '12' })).toEqual({ policy: { mode: 'forever', value: null } });
    expect(retentionFromForm({ mode: 'versions', value: ' 1 ' })).toEqual({ policy: { mode: 'versions', value: 1 } });
    expect(retentionFromForm({ mode: 'days', value: '3650' })).toEqual({ policy: { mode: 'days', value: 3_650 } });
    for (const value of ['', '0', '1.5', '-2', 'ten', '1e2', '1001']) {
      expect(retentionFromForm({ mode: 'versions', value }), value).toEqual({ problem: 'Enter a whole number from 1 to 1,000.' });
    }
    expect(retentionFromForm({ mode: 'days', value: '3651' })).toEqual({ problem: 'Enter a whole number from 1 to 3,650.' });
    expect(retentionFromForm({ mode: 'bogus' as 'days', value: '3' })).toEqual({ problem: 'Choose what to keep.' });
    expect(retentionNote('days')).toBe(RETENTION_RULE_NOTES.days);
    // Purge now follows the saved policy: a form showing another one is unsaved.
    expect(retentionFormChanged({ mode: 'versions', value: '3' }, { mode: 'versions', value: 3 })).toBe(false);
    expect(retentionFormChanged({ mode: 'versions', value: ' 3 ' }, { mode: 'versions', value: 3 })).toBe(false);
    expect(retentionFormChanged({ mode: 'forever', value: '9' }, { mode: 'forever', value: null })).toBe(false);
    expect(retentionFormChanged({ mode: 'versions', value: '1' }, { mode: 'versions', value: 3 })).toBe(true);
    expect(retentionFormChanged({ mode: 'days', value: '3' }, { mode: 'versions', value: 3 })).toBe(true);
    expect(retentionFormChanged({ mode: 'versions', value: '10' }, { mode: 'forever', value: null })).toBe(true);
    expect(UNSAVED_POLICY_PREVIEW).toContain('Save the policy first');
    expect(RETENTION_RULE_NOTES.days).toContain('Each page always keeps its newest version.'.slice(0, -1));
  });

  test('retention-view-wording', () => {
    const counts = { captures: 2, versions: 2, diffs: 2, screenshots: 0 };
    expect(previewText({ status: 'ok', policy: { mode: 'versions', value: 1 }, counts, bytes: 1_234 })).toBe('Purging now would remove 2 captures, 2 versions, 2 diffs and 0 screenshots (≈ 1.2 kB).');
    expect(previewText({ status: 'ok', policy: { mode: 'versions', value: 1 }, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0 }, bytes: 0 })).toBe('Purging now would remove nothing.');
    expect(previewText({ status: 'ok', policy: { mode: 'forever', value: null }, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0 }, bytes: 0 })).toBe('Keep everything: purging removes nothing.');
    expect(previewText(null)).toBe('The preview could not be read.');
    expect(purgeNowText({ status: 'purged', counts, bytes: 1_234, files: 0 })).toBe('Purged 2 captures, 2 versions, 2 diffs and 0 screenshots (≈ 1.2 kB freed).');
    expect(purgeNowText({ status: 'empty' })).toBe('Nothing to purge.');
    expect(purgeNowText({ status: 'changed' })).toBe('The captures changed while you were asked, so nothing was deleted. Try again.');
    expect(purgeNowText({ status: 'refused', reason: 'declined' })).toBe(RETENTION_REFUSAL_MESSAGES.declined);
    expect(purgeNowText(null)).toBe('The purge could not be run. Try again.');
    expect(compactText({ status: 'compacted', before: 2_400_000, after: 300_000 })).toBe('Compacted the change database: 2.4 MB → 300.0 kB.');
    expect(compactText({ status: 'refused', reason: 'running' })).toBe(RETENTION_REFUSAL_MESSAGES.running);
    expect(compactText({ status: 'refused', reason: 'compact-failed' })).toBe(RETENTION_REFUSAL_MESSAGES['compact-failed']);
    expect(RETENTION_REFUSAL_MESSAGES['compact-failed']).not.toBe(RETENTION_REFUSAL_MESSAGES['store-failed']);
    expect(compactText(null)).toBe('The database could not be compacted. Try again.');
    const usage: RetentionUsage = { projectId: P1, captures: 3, versions: 3, sharedVersions: 1, snapshotBytes: 12_000, diffBytes: 800, readingBytes: 0, screenshots: 2, files: { count: 1, bytes: 1_500, missing: 1, shared: 1 }, database: { bytes: 2_000_000, walBytes: 400_000 } };
    expect(usageRows(usage)).toEqual([
      { id: 'captures', label: 'Captures', value: '3' },
      { id: 'versions', label: 'Versions', value: '3 (1 also in another project)' },
      { id: 'screenshots', label: 'Screenshots', value: '2' },
      { id: 'stored', label: 'Stored snapshots and diffs', value: '12.0 kB + 800 B' },
      { id: 'readings', label: 'Search readings', value: '0 B' },
      { id: 'files', label: 'Screenshot files', value: '1 file, 1.5 kB (1 also in another project) · 1 missing' },
      { id: 'database', label: 'Database file (all projects)', value: '2.4 MB' },
    ]);
    const plain = usageRows({ ...usage, sharedVersions: 0, files: { count: 2, bytes: 3_000, missing: 0, shared: 0 }, database: null });
    expect(plain.find((row) => row.id === 'versions')?.value).toBe('3');
    expect(plain.find((row) => row.id === 'files')?.value).toBe('2 files, 3.0 kB');
    expect(plain.find((row) => row.id === 'database')?.value).toBe('In memory this session');
    expect(USAGE_NOTE).toBe('Deleting frees space inside the database file; the file itself shrinks only after Compact.');
    const line = purgeLogText({ id: P2, reason: 'purge-now', projectId: P1, policy: { mode: 'versions', value: 1 }, counts, bytes: 1_234, createdAt: Date.UTC(2026, 9, 1, 12) });
    expect(line.reason).toBe('Purge now');
    expect(line.what).toBe('2 captures, 2 versions, 2 diffs and 0 screenshots · 1.2 kB');
    expect(line.when).toBe(new Date(Date.UTC(2026, 9, 1, 12)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  });

  // spec: specs/workspace-db.feature.md — usage-rows-show-readings; specs/retention.spec.ts (RetentionUsage.readingBytes)
  test('usage-rows-show-readings', () => {
    const usage: RetentionUsage = { projectId: P1, captures: 2, versions: 2, sharedVersions: 0, snapshotBytes: 4_000, diffBytes: 0, readingBytes: 48_500, screenshots: 0, files: { count: 0, bytes: 0, missing: 0, shared: 0 }, database: null };
    const rows = usageRows(usage);
    expect(rows.find((row) => row.id === 'readings')).toEqual({ id: 'readings', label: 'Search readings', value: formatBytes(48_500) });
    expect(formatBytes(48_500)).toBe('48.5 kB');
    // Right after the stored snapshots and diffs.
    expect(rows.map((row) => row.id)).toEqual(['captures', 'versions', 'screenshots', 'stored', 'readings', 'files', 'database']);
  });

  test('retention-palette-actions', async () => {
    const api = {
      open: vi.fn(),
      lastProject: vi.fn((): string | undefined => undefined),
      purgeNow: vi.fn(async () => ({ status: 'empty' as const })),
      compact: vi.fn(async () => ({ status: 'compacted' as const, before: 2_000, after: 1_000 })),
    };
    const registry = createPaletteRegistry();
    registry.register(...retentionPaletteSources(api));
    const ctx: PaletteContext = { state: null, tab: tab(), audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };
    const ids = () => registry.resolve(ctx).map((action) => action.id);
    // Compact always; purge once a project was opened (the last one).
    expect(ids()).toEqual(['projects.compact']);
    api.lastProject.mockReturnValue(P1);
    expect(ids().sort()).toEqual(['projects.compact', 'projects.purge-now']);
    const action = (id: string) => registry.resolve(ctx).find((a) => a.id === id)!;
    expect(action('projects.purge-now').label).toBe('Purge this project now');
    expect(action('projects.compact').label).toBe('Compact the change database');
    expect(await action('projects.purge-now').run(ctx)).toBe('Nothing to purge.');
    expect(api.open).toHaveBeenLastCalledWith({ projectId: P1 });
    expect(api.purgeNow).toHaveBeenCalledWith(P1);
    expect(await action('projects.compact').run(ctx)).toBe('Compacted the change database: 2.0 kB → 1.0 kB.');
  });
});
