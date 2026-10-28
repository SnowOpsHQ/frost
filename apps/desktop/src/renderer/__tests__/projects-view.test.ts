// Spec: specs/projects.spec.ts (PROJECT_REFUSAL_MESSAGES, RUN_REFUSAL_MESSAGES, RUN_STATE_LABELS), specs/render-profile.spec.ts
// (QUICK_RENDER_PROFILES), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/projects.feature.md (The sheet; Changes panel picker; Command palette)
import { describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { UNFILED_PROJECT_ID } from '@app/specs/capture-db.spec';
import { PROJECT_REFUSAL_MESSAGES, RUN_REFUSAL_MESSAGES, RUN_STATE_LABELS, type RunState } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { createPaletteRegistry, type PaletteContext } from '../palette/registry';
import { projectsPaletteSources } from '../projects-palette';
import {
  EMPTY_QUERY_FORM,
  PROJECT_PROFILE_CHOICES,
  addPageText,
  changeCountText,
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
});
