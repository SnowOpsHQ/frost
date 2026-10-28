// Spec: specs/projects.spec.ts (PROJECT_REFUSAL_MESSAGES, RUN_REFUSAL_MESSAGES, RUN_STATE_LABELS), specs/render-profile.spec.ts
// (QUICK_RENDER_PROFILES), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/projects.feature.md (The sheet; Changes panel picker; Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { PROJECT_REFUSAL_MESSAGES, RUN_REFUSAL_MESSAGES, RUN_STATE_LABELS, type RunState } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { RETENTION_REFUSAL_MESSAGES, RETENTION_RULE_NOTES, USAGE_NOTE, type RetentionUsage } from '@app/specs/retention.spec';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { projectsPaletteSources, retentionPaletteSources } from '../projects-palette';
import {
  EMPTY_QUERY_FORM,
  PROJECT_PROFILE_CHOICES,
  addPageText,
  changeCountText,
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
    expect(queryFromForm({ ...EMPTY_QUERY_FORM, query: '  green tea ', country: ' DE ', language: 'PT-BR', location: '  Berlin ', device: 'mobile' })).toEqual({
      params: { engine: 'google', query: 'green tea', country: 'de', language: 'pt-br', location: 'Berlin', device: 'mobile' },
    });
    expect(queryFromForm({ ...EMPTY_QUERY_FORM, engine: 'bing', query: 'tea' })).toEqual({ params: { engine: 'bing', query: 'tea', country: null, language: null, location: null, device: null } });
    for (const bad of [{ query: '   ' }, { query: 'x', engine: 'other' }, { query: 'x', country: 'deu' }, { query: 'x', country: 'd1' }, { query: 'x', language: 'english!' }]) {
      expect(queryFromForm({ ...EMPTY_QUERY_FORM, ...bad })).toHaveProperty('problem');
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
    // Open projects always; add this page with a web page; capture now once a project was opened.
    expect(ids(undefined)).toEqual(['projects.open']);
    expect(ids(tab({ url: 'app://frost/newtab' }))).toEqual(['projects.open']);
    expect(ids(tab())).toEqual(['projects.open', 'projects.add-page']);
    api.lastProject.mockReturnValue(P1);
    expect(ids(tab())).toEqual(['projects.open', 'projects.add-page', 'projects.capture-now']);
    const action = (id: string) => registry.resolve(ctx(tab())).find((a) => a.id === id)!;
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
    const usage: RetentionUsage = { projectId: P1, captures: 3, versions: 3, sharedVersions: 1, snapshotBytes: 12_000, diffBytes: 800, screenshots: 2, files: { count: 1, bytes: 1_500, missing: 1, shared: 1 }, database: { bytes: 2_000_000, walBytes: 400_000 } };
    expect(usageRows(usage)).toEqual([
      { id: 'captures', label: 'Captures', value: '3' },
      { id: 'versions', label: 'Versions', value: '3 (1 also in another project)' },
      { id: 'screenshots', label: 'Screenshots', value: '2' },
      { id: 'stored', label: 'Stored snapshots and diffs', value: '12.0 kB + 800 B' },
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
