// Spec: specs/command-palette.spec.ts (COPY_VALUE_KEYS, FEATURE_PANEL_JUMPS, OPEN_IN_TEMPLATES, SITE_FILES, PALETTE_DETAIL_MAX_CHARS),
// specs/seo-sidebar.spec.ts (SEO_PANELS, HIGHLIGHT_PANELS), specs/page-commands.spec.ts (PAGE_COMMANDS)
// Acceptance: specs/command-palette.feature.md (Built-in actions)
import { describe, expect, test, vi } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import {
  COPY_VALUE_KEYS,
  FEATURE_PANEL_JUMPS,
  OPEN_IN_CONSENT_MESSAGE,
  OPEN_IN_QUERY_NOTE,
  OPEN_IN_TEMPLATES,
  OPEN_TOOL_REFUSAL_MESSAGES,
  OPEN_TOOL_REFUSALS,
  openInLabel,
  PALETTE_DETAIL_MAX_CHARS,
  SITE_FILES,
  type OpenInTemplateId,
  type OpenToolResult,
} from '@app/specs/command-palette.spec';
import { SEO_PANELS } from '@app/specs/seo-sidebar.spec';
import { builtinPaletteSources, type PaletteApi } from '../builtins';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../registry';

const URL_A = 'https://www.example.com/a';

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 1, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null, ...changes };
}

function state(tabs: TabState[], activeTabId = tabs[0]?.id ?? null): BrowserState {
  return { version: 3, tabs, activeTabId, focusAddressBarSeq: 0, toggleSidebarSeq: 0, commandPalette: { seq: 0, returnFocus: 'chrome' }, notice: null };
}

/** The parts of an audit the built-ins read (a ready audit as `seo.getAudit` answers it). */
function audit(changes: { title?: string | null; description?: string | null; h1?: string | null; status?: number | null; blocks?: number; robots?: string | null } = {}): SeoAudit {
  const title = changes.title === undefined ? 'A well titled page' : changes.title;
  const description = changes.description === undefined ? 'What the page is about.' : changes.description;
  const h1 = changes.h1 === undefined ? 'Main heading' : changes.h1;
  const blocks = Array.from({ length: changes.blocks ?? 2 }, (_, index) => ({ index, text: '{"@type":"Thing"}', length: 17, status: 'valid', error: null, entities: [index], droppedKeys: 0, overLimit: false }));
  return {
    url: URL_A,
    takenAt: 1_760_000_000_000,
    page: {
      url: URL_A,
      title: title === null ? null : { text: title, length: title.length },
      description: description === null ? null : { text: description, length: description.length },
      canonical: URL_A,
      robots: changes.robots === undefined ? 'robots: index, follow' : changes.robots,
      headings: h1 === null ? [{ level: 2, text: 'Section' }] : [{ level: 1, text: h1 }],
    },
    indexability: { canonical: { html: URL_A, header: null, effective: URL_A, elsewhere: false, conflict: false }, http: changes.status === null ? null : { status: changes.status ?? 200 } },
    schema: { blocks, entities: blocks.map((b) => ({ key: b.index, block: b.index, types: [b.index === 0 ? 'Organization' : 'WebSite'], topLevel: true })) },
  } as unknown as SeoAudit;
}

const ready = (a: SeoAudit = audit()): SeoAuditResponse => ({ status: 'ready', url: a.url, audit: a });

function fakeApi() {
  return {
    newTab: vi.fn(async () => undefined),
    closeTab: vi.fn(async (_tabId: number) => undefined),
    activateTab: vi.fn(async (_tabId: number) => undefined),
    back: vi.fn(async () => undefined),
    forward: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    pageCommand: vi.fn(async (_command: string) => undefined),
    rerunAudit: vi.fn(async (_tabId: number) => undefined),
    runAccessibility: vi.fn(async (_tabId: number) => true),
    setHighlight: vi.fn(async (_tabId: number, _mode: string) => true),
    copyValue: vi.fn(async (_tabId: number, _audit: { url: string; takenAt: number }, _key: string) => true),
    copySchemaJson: vi.fn(async (_tabId: number, _audit: { url: string; takenAt: number }, _block: number) => true),
    openBackgroundTab: vi.fn(async (_url: string): Promise<number | null> => 9),
    openTool: vi.fn(async (_tool: OpenInTemplateId): Promise<OpenToolResult | null> => ({ status: 'opened', tabId: 9 })),
    clearBrowsingData: vi.fn(async () => undefined),
  } satisfies PaletteApi;
}

/** An in-memory consent store (the palette's is `consent.ts`, on localStorage). */
function fakeConsent(granted: readonly string[] = []) {
  const hosts = new Set(granted);
  return { has: vi.fn((host: string) => hosts.has(host)), grant: vi.fn((host: string) => void hosts.add(host)) };
}

function setup(context: Partial<PaletteContext> & { tabs?: TabState[]; granted?: readonly string[] } = {}) {
  const api = fakeApi();
  const consent = fakeConsent(context.granted ?? OPEN_IN_TEMPLATES.map((t) => new URL(t.origin).host));
  const registry = createPaletteRegistry();
  registry.register(...builtinPaletteSources(api, consent));
  const tabs = context.tabs ?? (context.tab ? [context.tab] : [tab()]);
  const active = context.tab ?? tabs[0];
  const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
  const ctx: PaletteContext = { state: state(tabs, active?.id ?? null), tab: active, audit: ready(), sidebarOpen: true, chrome, ...context };
  const ids = () => registry.resolve(ctx).map((a) => a.id);
  const get = (id: string): PaletteAction => {
    const found = registry.resolve(ctx).find((a) => a.id === id);
    if (!found) throw new Error(`${id} not available`);
    return found;
  };
  return { api, registry, ctx, ids, get, chrome, consent };
}

describe('built-in palette actions', () => {
  test('builtins-cover-the-plan', () => {
    const { ids, registry } = setup({ tabs: [tab({ canGoBack: true, canGoForward: true, loading: true, zoom: 1.5 }), tab({ id: 2 })], sidebarOpen: false });
    const expected = [
      // A panel in FEATURE_PANEL_JUMPS gets its jump from its feature (content-palette.ts).
      ...SEO_PANELS.filter((p) => !(FEATURE_PANEL_JUMPS as readonly string[]).includes(p.id)).map((p) => `panel.${p.id}`),
      'sidebar.show',
      'highlight.links',
      'highlight.headings',
      'highlight.sentences',
      'audit.rerun',
      'audit.accessibility',
      'tab.new',
      'tab.close',
      'tab.next',
      'tab.previous',
      'page.reload',
      'page.hard-reload',
      'page.stop',
      'page.back',
      'page.forward',
      'page.zoom-in',
      'page.zoom-out',
      'page.zoom-reset',
      'browser.clear-data',
      ...COPY_VALUE_KEYS.map((k) => `copy.${k}`),
      'copy.json-ld.0',
      'copy.json-ld.1',
      ...OPEN_IN_TEMPLATES.map((t) => `open-in.${t.id}`),
      ...SITE_FILES.map((f) => `open-in.${f.id}`),
    ];
    expect([...ids()].sort()).toEqual([...expected].sort());
    // Static ids are unique and well formed (the registry would have thrown otherwise).
    expect(new Set(registry.ids()).size).toBe(registry.ids().length);
    // Every action has frost's own label and a known group (checked by the registry), keywords where useful.
    for (const action of setup().registry.resolve(setup().ctx)) expect(action.label.trim(), action.id).not.toBe('');
  });

  test('availability-follows-state', () => {
    // A plain tab: no back / forward / stop / zoom reset, no next tab.
    const plain = setup().ids();
    for (const id of ['page.back', 'page.forward', 'page.stop', 'page.zoom-reset', 'tab.next', 'tab.previous', 'highlight.off', 'sidebar.show']) expect(plain, id).not.toContain(id);
    expect(plain).toContain('sidebar.hide');
    expect(setup({ tab: tab({ canGoBack: true }) }).ids()).toContain('page.back');
    expect(setup({ tab: tab({ canGoForward: true }) }).ids()).toContain('page.forward');
    expect(setup({ tab: tab({ loading: true }) }).ids()).toContain('page.stop');
    expect(setup({ tab: tab({ zoom: 0.9 }) }).ids()).toContain('page.zoom-reset');
    expect(setup({ tab: tab({ zoom: 5 }) }).ids()).not.toContain('page.zoom-in');
    expect(setup({ tab: tab({ zoom: 0.25 }) }).ids()).not.toContain('page.zoom-out');
    expect(setup({ tab: tab({ highlight: 'links' }) }).ids()).toEqual(expect.arrayContaining(['highlight.off', 'highlight.headings']));
    expect(setup({ tab: tab({ highlight: 'links' }) }).ids()).not.toContain('highlight.links');

    // An empty tab: tab commands, panels, the sidebar and Clear Browsing Data only.
    const empty = setup({ tab: tab({ url: '', title: '' }), audit: null }).ids();
    for (const id of empty) expect(id, id).toMatch(/^(panel\.|sidebar\.|tab\.|browser\.)/);
    expect(empty).toEqual(expect.arrayContaining(['tab.new', 'tab.close', 'browser.clear-data', 'panel.overview']));

    // A pending audit: page commands yes, audit-derived actions no.
    const pending = setup({ audit: { status: 'pending', url: URL_A } }).ids();
    expect(pending).toContain('page.reload');
    for (const id of pending) expect(id).not.toMatch(/^(copy\.|highlight\.|audit\.)/);
    // A retryable unavailable audit can be run again; a load error cannot.
    expect(setup({ audit: { status: 'unavailable', url: URL_A, reason: 'timeout' } }).ids()).toContain('audit.rerun');
    expect(setup({ tab: tab({ error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED', url: URL_A } as unknown as TabState['error'] }), audit: { status: 'unavailable', url: URL_A, reason: 'load-error' } }).ids()).not.toContain('audit.rerun');
    // A running accessibility check is not started twice.
    const running: SeoAuditResponse = { ...ready(), accessibilityRun: { status: 'running', startedAt: 1, finishedAt: null, reason: null } } as SeoAuditResponse;
    expect(setup({ audit: running }).ids()).not.toContain('audit.accessibility');
    // Open in: only a public web page; the site files for any web page.
    const local = setup({ tab: tab({ url: 'http://127.0.0.1:8080/x' }), audit: null }).ids();
    for (const t of OPEN_IN_TEMPLATES) expect(local).not.toContain(`open-in.${t.id}`);
    for (const f of SITE_FILES) expect(local).toContain(`open-in.${f.id}`);
    const app = setup({ tab: tab({ url: 'about:blank' }), audit: null }).ids();
    for (const id of app) expect(id).not.toMatch(/^open-in\./);
  });

  test('copy-actions-need-a-value', () => {
    const none = setup({ audit: ready(audit({ title: null, description: null, h1: null, status: null, robots: null, blocks: 0 })) }).ids();
    for (const key of ['title', 'meta-description', 'h1', 'status-code', 'robots-meta']) expect(none, key).not.toContain(`copy.${key}`);
    expect(none).toEqual(expect.arrayContaining(['copy.url', 'copy.canonical']));
    expect(none.filter((id) => id.startsWith('copy.json-ld.'))).toEqual([]);
    // The row previews the value as text, cut.
    const long = 'T'.repeat(PALETTE_DETAIL_MAX_CHARS * 2);
    const { get, ctx } = setup({ audit: ready(audit({ title: long })) });
    const detail = get('copy.title').detail!(ctx)!;
    expect([...detail].length).toBeLessThanOrEqual(PALETTE_DETAIL_MAX_CHARS);
    expect(detail.endsWith('…')).toBe(true);
    expect(get('copy.status-code').detail!(ctx)).toBe('200');
    // JSON-LD rows name the block's types.
    expect(get('copy.json-ld.0').detail!(ctx)).toContain('Organization');
    expect(get('copy.json-ld.1').label).toContain('2');
  });

  test('handlers-call-procedures', async () => {
    const { api, get, ctx } = setup({ tabs: [tab({ canGoBack: true, canGoForward: true, zoom: 2, loading: true }), tab({ id: 2 }), tab({ id: 3 })] });
    const shown = { url: URL_A, takenAt: 1_760_000_000_000 };
    expect(await get('copy.title').run(ctx)).toMatch(/title/i);
    expect(api.copyValue).toHaveBeenLastCalledWith(1, shown, 'title');
    for (const key of COPY_VALUE_KEYS) {
      await get(`copy.${key}`).run(ctx);
      expect(api.copyValue).toHaveBeenLastCalledWith(1, shown, key);
    }
    api.copyValue.mockResolvedValueOnce(false);
    expect(await get('copy.h1').run(ctx)).toMatch(/nothing/i);
    await get('copy.json-ld.1').run(ctx);
    expect(api.copySchemaJson).toHaveBeenLastCalledWith(1, shown, 1);
    for (const template of OPEN_IN_TEMPLATES) {
      expect(await get(`open-in.${template.id}`).run(ctx)).toMatch(/background tab/i);
      // Main builds the URL from the table and the tab: the chrome sends only the tool's id.
      expect(api.openTool).toHaveBeenLastCalledWith(template.id);
    }
    expect(api.openBackgroundTab).not.toHaveBeenCalled();
    await get('open-in.robots-txt').run(ctx);
    expect(api.openBackgroundTab).toHaveBeenLastCalledWith('https://www.example.com/robots.txt');
    api.openBackgroundTab.mockResolvedValueOnce(null);
    expect(await get('open-in.sitemap').run(ctx)).toMatch(/couldn/i);
    const page: [string, keyof PaletteApi, unknown[]][] = [
      ['page.reload', 'reload', []],
      ['page.stop', 'stop', []],
      ['page.back', 'back', []],
      ['page.forward', 'forward', []],
      ['page.hard-reload', 'pageCommand', ['hard-reload']],
      ['page.zoom-in', 'pageCommand', ['zoom-in']],
      ['page.zoom-out', 'pageCommand', ['zoom-out']],
      ['page.zoom-reset', 'pageCommand', ['zoom-reset']],
      ['tab.new', 'newTab', []],
      ['tab.close', 'closeTab', [1]],
      ['tab.next', 'activateTab', [2]],
      ['tab.previous', 'activateTab', [3]],
      ['audit.rerun', 'rerunAudit', [1]],
      ['browser.clear-data', 'clearBrowsingData', []],
    ];
    for (const [id, method, args] of page) {
      await get(id).run(ctx);
      expect(api[method], id).toHaveBeenLastCalledWith(...args);
    }
    expect(get('tab.new').focus).toBe('handler');
    expect(get('tab.close').focus).toBe('handler');
    expect(get('page.reload').focus ?? 'restore').toBe('restore');
    await get('audit.accessibility').run(ctx);
    expect(api.runAccessibility).toHaveBeenLastCalledWith(1);
    expect(ctx.chrome.openPanel).toHaveBeenLastCalledWith('compliance', { focus: false });
    // Panel jumps and the sidebar are the chrome's own.
    await get('panel.schema').run(ctx);
    expect(ctx.chrome.openPanel).toHaveBeenLastCalledWith('schema', { focus: true });
    expect(get('panel.schema').focus).toBe('handler');
    await get('sidebar.hide').run(ctx);
    expect(ctx.chrome.setSidebarOpen).toHaveBeenLastCalledWith(false);
  });

  test('highlight-opens-the-owning-panel', async () => {
    const { api, get, ctx, chrome } = setup();
    const calls: string[] = [];
    chrome.openPanel.mockImplementation((panel: string) => void calls.push(`panel ${panel}`));
    api.setHighlight.mockImplementation(async (_tabId: number, mode: string) => {
      calls.push(`highlight ${mode}`);
      return true;
    });
    await get('highlight.links').run(ctx);
    await get('highlight.headings').run(ctx);
    expect(calls).toEqual(['panel links', 'highlight links', 'panel on-page', 'highlight headings']);
    const on = setup({ tab: tab({ highlight: 'headings' }) });
    await on.get('highlight.off').run(on.ctx);
    expect(on.api.setHighlight).toHaveBeenLastCalledWith(1, 'off');
    on.api.setHighlight.mockResolvedValueOnce(false);
    expect(await on.get('highlight.links').run(on.ctx)).toMatch(/couldn/i);
  });

  test('highlight-sentences-action', async () => {
    const { api, get, ctx, chrome, ids } = setup();
    const action = get('highlight.sentences');
    expect(action.label).toBe('Highlight difficult sentences');
    expect(action.group).toBe('audit');
    // Opens the Content panel (its toggle owns the mode), then asks main.
    expect(await action.run(ctx)).toBeNull();
    expect(chrome.openPanel).toHaveBeenLastCalledWith('content', { focus: false });
    expect(api.setHighlight).toHaveBeenLastCalledWith(1, 'sentences');
    // Main says no (no difficult sentence): a status line.
    api.setHighlight.mockResolvedValueOnce(false);
    expect(await action.run(ctx)).toMatch(/couldn/i);
    expect(ids()).toContain('highlight.sentences');
    // Only with a ready audit, and not while it is already on.
    expect(setup({ audit: { status: 'pending', url: URL_A } }).ids()).not.toContain('highlight.sentences');
    expect(setup({ tab: tab({ highlight: 'sentences' }) }).ids()).not.toContain('highlight.sentences');
    expect(setup({ tab: tab({ highlight: 'sentences' }) }).ids()).toContain('highlight.off');
  });

  test('open-in-asks-once-per-host', () => {
    const rich = OPEN_IN_TEMPLATES.find((t) => t.id === 'rich-results')!;
    const host = new URL(rich.origin).host;
    const { get, ctx, consent } = setup({ granted: [] });
    const action = get('open-in.rich-results');
    // The label names the destination host.
    expect(action.label).toBe(openInLabel(rich));
    const step = action.confirm!(ctx)!;
    expect(step).not.toBeNull();
    expect(step.message).toBe(OPEN_IN_CONSENT_MESSAGE.replace('{host}', host));
    expect(step.note ?? null).toBeNull();
    step.accept();
    expect(consent.grant).toHaveBeenCalledExactlyOnceWith(host);
    expect(action.confirm!(ctx)).toBeNull();
    // Another host is still asked; the two page speed tools share one host, so one answer covers both.
    expect(get('open-in.html-validator').confirm!(ctx)).not.toBeNull();
    get('open-in.mobile-rendering').confirm!(ctx)!.accept();
    expect(get('open-in.page-speed').confirm!(ctx)).toBeNull();
    // A page URL with a query string: the step and the row both say it is sent too.
    const query = setup({ granted: [], tab: tab({ url: 'https://www.example.com/a?session=abc' }) });
    expect(query.get('open-in.archive').confirm!(query.ctx)!.note).toBe(OPEN_IN_QUERY_NOTE);
    expect(query.get('open-in.archive').detail!(query.ctx)).toMatch(/query string/i);
    expect(setup().get('open-in.archive').detail!(setup().ctx)).not.toMatch(/query string/i);
    // Site files go to the site itself: no question.
    expect(query.get('open-in.robots-txt').confirm).toBeUndefined();
  });

  test('open-in-calls-main-and-reports-refusals', async () => {
    const { api, get, ctx } = setup();
    for (const reason of OPEN_TOOL_REFUSALS) {
      api.openTool.mockResolvedValueOnce({ status: 'refused', reason });
      expect(await get('open-in.rich-results').run(ctx)).toBe(OPEN_TOOL_REFUSAL_MESSAGES[reason]);
    }
    // An IPC failure.
    api.openTool.mockResolvedValueOnce(null);
    expect(await get('open-in.rich-results').run(ctx)).toMatch(/couldn/i);
    expect(api.openTool.mock.calls.every(([tool]) => tool === 'rich-results')).toBe(true);
  });
});
