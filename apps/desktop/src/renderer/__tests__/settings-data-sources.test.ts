// @vitest-environment jsdom
// Spec: specs/data-sources.spec.ts (DATA_SOURCES_SETTINGS_TEXT, DATA_SPEND_NOTE, LEGAL_GATE_NOTE, DATA_PROVIDER_LABELS,
// DATA_SERP_PROVIDERS, DATA_AI_SEARCH_PROVIDERS), specs/data-sources.schema.ts (DataSourcesView, DataUsageView,
// DataSerpProviderView, DATA_SET_KEY_RESULTS, DATA_SET_SERP_PROVIDER_RESULTS), specs/account-settings.spec.ts
// (SETTINGS_SECTIONS: `data-sources`)
// Acceptance: specs/data-sources.feature.md (Settings › Data sources: settings-data-sources-rows, -key-entry,
// -clear-asks-first, -weak-protection, -gated, -serp-choice, -partial-dataforseo) · plan docs/plans/phase-12-big-bets.md, Decision 4, Task 2,
// "As built" (legal gates: the renderer reads `available` from main's views)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SETTINGS_SECTIONS } from '@app/specs/account-settings.spec';
import { DATA_PROVIDER_LABELS, DATA_PROVIDERS, DATA_SOURCES_SETTINGS_TEXT as TEXT, DATA_SPEND_NOTE, LEGAL_GATE_NOTE, type DataProvider, type DataSerpProvider } from '@app/specs/data-sources.spec';
import { DATA_SET_KEY_RESULTS, DATA_SET_SERP_PROVIDER_RESULTS, type DataSerpProviderView, type DataSourcesSetKeyInput, type DataSourcesView, type DataUsageView } from '@app/specs/data-sources.schema';
import { dataSourcesSection, saveMessage, setKeyInput, setKeyMessage, setSerpProviderMessage } from '../settings-data-sources-view';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = 'serpapi-0123456789abcdefSECRETKEY';
const PASSWORD = 'dfs-0123456789abcdefSECRETPASS';

const view = (protection: DataSourcesView['protection'], rows: Partial<Record<DataProvider, Partial<{ hasKey: boolean; partial: boolean; available: boolean }>>> = {}): DataSourcesView => ({
  protection,
  providers: Object.fromEntries(DATA_PROVIDERS.map((p) => [p, { hasKey: false, partial: false, available: false, ...rows[p] }])) as DataSourcesView['providers'],
});
const usage = (counts: Partial<Record<DataProvider, [number, number]>> = {}): DataUsageView => ({
  thisMonth: '2026-11',
  lastMonth: '2026-10',
  providers: Object.fromEntries(DATA_PROVIDERS.map((p) => [p, { thisMonth: counts[p]?.[0] ?? 0, lastMonth: counts[p]?.[1] ?? 0 }])) as DataUsageView['providers'],
});
const NO_SERP: DataSerpProviderView = { provider: null, choices: [] };

describe('settings data sources view', () => {
  test('settings-data-sources-rows', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toContain('data-sources');
    const section = dataSourcesSection(view('os', { serpapi: { hasKey: true } }), usage({ serpapi: [3, 41] }), NO_SERP);
    // Two groups, text labels only, in order.
    expect(section.groups.map((g) => [g.label, g.rows.map((r) => r.label)])).toEqual([
      [TEXT.groups.serp, ['SerpApi', 'DataForSEO', 'Serper']],
      [TEXT.groups['ai-search'], ['Perplexity', 'OpenAI web search']],
    ]);
    const rows = section.groups.flatMap((g) => g.rows);
    expect(rows.map((r) => r.label)).toEqual(DATA_PROVIDERS.map((p) => DATA_PROVIDER_LABELS[p]));
    // Key set / not set, and this month's and last month's counts.
    expect(rows.map((r) => r.keyState)).toEqual([TEXT.keySet, TEXT.noKey, TEXT.noKey, TEXT.noKey, TEXT.noKey]);
    expect(rows[0]!.usage).toBe(TEXT.usage(3, 41));
    expect(rows[1]!.usage).toBe(TEXT.usage(0, 0));
    // The cost note, and OpenAI web search's own key.
    expect(section.spendNote).toBe(DATA_SPEND_NOTE);
    expect(rows.find((r) => r.provider === 'openai-search')!.notes).toContain(TEXT.openAiSeparateKey);
    // DataForSEO has a login and a password; the rest one key.
    expect(rows.find((r) => r.provider === 'dataforseo')!.fields.map((f) => f.id)).toEqual(['login', 'password']);
    expect(rows.find((r) => r.provider === 'serper')!.fields.map((f) => f.id)).toEqual(['key']);
  });

  test('settings-data-sources-gated', () => {
    // As shipped: every gate closed. Each row is disabled with the legal note; Clear only where a key is set.
    const section = dataSourcesSection(view('os', { perplexity: { hasKey: true } }), usage(), NO_SERP);
    for (const row of section.groups.flatMap((g) => g.rows)) {
      expect(row.disabled, row.provider).toBe(true);
      expect(row.reason, row.provider).toBe(LEGAL_GATE_NOTE);
      expect(row.canClear, row.provider).toBe(row.provider === 'perplexity');
    }
    // A gate opened by injection (main's view): that row is live, the rest stay gated.
    const opened = dataSourcesSection(view('os', { serper: { available: true } }), usage(), NO_SERP);
    const rows = opened.groups.flatMap((g) => g.rows);
    expect(rows.filter((r) => !r.disabled).map((r) => r.provider)).toEqual(['serper']);
    expect(rows.find((r) => r.provider === 'serper')!.reason).toBeNull();
  });

  test('settings-data-sources-weak-protection', () => {
    for (const protection of ['weak', 'unavailable'] as const) {
      const section = dataSourcesSection(view(protection, { serpapi: { available: true }, perplexity: { available: true } }), usage(), NO_SERP);
      for (const row of section.groups.flatMap((g) => g.rows)) {
        expect(row.disabled, row.provider).toBe(true);
        // An open row says why the keychain stops it; a gated one keeps the legal note.
        expect(row.reason, row.provider).toBe(row.provider === 'serpapi' || row.provider === 'perplexity' ? TEXT.protection[protection] : LEGAL_GATE_NOTE);
      }
    }
  });

  test('settings-data-sources-serp-choice-view', () => {
    // Main's choices only, labelled; the stored one selected.
    const status = view('os', { serpapi: { available: true, hasKey: true }, dataforseo: { available: true, hasKey: true } });
    expect(dataSourcesSection(status, usage(), { provider: 'dataforseo', choices: ['serpapi', 'dataforseo'] }).serp).toEqual({
      options: [
        { value: 'serpapi', label: 'SerpApi' },
        { value: 'dataforseo', label: 'DataForSEO' },
      ],
      value: 'dataforseo',
      disabled: false,
      placeholder: null,
      note: null,
    });
    // None stored yet: a placeholder. No choices at all: disabled, and why.
    expect(dataSourcesSection(status, usage(), { provider: null, choices: ['serpapi'] }).serp).toMatchObject({ value: '', placeholder: TEXT.serpProviderPlaceholder, disabled: false });
    expect(dataSourcesSection(status, usage(), NO_SERP).serp).toMatchObject({ options: [], value: '', disabled: true, note: TEXT.serpProviderNone });
  });

  test('settings-data-sources-partial-view', () => {
    // A DataForSEO half: still "No key", but Clear is offered and the row says why — even while gated.
    for (const available of [true, false]) {
      const rows = dataSourcesSection(view('os', { dataforseo: { partial: true, available } }), usage(), NO_SERP).groups.flatMap((g) => g.rows);
      const dfs = rows.find((r) => r.provider === 'dataforseo')!;
      expect(dfs).toMatchObject({ hasKey: false, partial: true, keyState: TEXT.noKey, canClear: true });
      expect(dfs.notes).toContain(TEXT.partial);
    }
    // After a half is stored and the row still has no key: ask for the other half.
    expect(saveMessage({ provider: 'dataforseo', login: 'owner@frost.example' }, 'stored', false)).toBe(TEXT.savedAddOther.password);
    expect(saveMessage({ provider: 'dataforseo', password: PASSWORD }, 'stored', false)).toBe(TEXT.savedAddOther.login);
    expect(saveMessage({ provider: 'dataforseo', password: PASSWORD }, 'stored', true)).toBe(TEXT.setKeyResults.stored);
    expect(saveMessage({ provider: 'dataforseo', password: PASSWORD }, 'invalid', false)).toBe(TEXT.setKeyResults.invalid);
    expect(saveMessage({ provider: 'serpapi', key: KEY }, 'stored', false)).toBe(TEXT.setKeyResults.stored);
  });

  test('settings-data-sources-inputs-and-messages', () => {
    // Trimmed-empty fields send nothing; DataForSEO sends what was pasted.
    expect(setKeyInput('serpapi', { key: '   ' })).toBeNull();
    expect(setKeyInput('serpapi', { key: KEY })).toEqual({ provider: 'serpapi', key: KEY });
    expect(setKeyInput('dataforseo', { login: '', password: PASSWORD })).toEqual({ provider: 'dataforseo', password: PASSWORD });
    expect(setKeyInput('dataforseo', { login: 'owner@frost.example', password: '' })).toEqual({ provider: 'dataforseo', login: 'owner@frost.example' });
    expect(setKeyInput('dataforseo', {})).toBeNull();
    for (const result of DATA_SET_KEY_RESULTS) expect(setKeyMessage(result)).toBe(TEXT.setKeyResults[result]);
    expect(setKeyMessage('unavailable')).toBe(LEGAL_GATE_NOTE);
    for (const result of DATA_SET_SERP_PROVIDER_RESULTS) expect(setSerpProviderMessage(result)).toBe(result === 'stored' ? null : TEXT.setSerpProviderResults[result]);
  });
});

// ---- The component, against main's views (injected) ---------------------------------------------

const main = {
  /** When set, the next status read waits for this (to answer after a newer read). */
  holdNextRead: null as Promise<void> | null,
  status: view('os') as DataSourcesView,
  usage: usage() as DataUsageView,
  serp: NO_SERP as DataSerpProviderView,
  setKeyAnswer: 'stored' as (typeof DATA_SET_KEY_RESULTS)[number],
  readFails: 0,
};
const setKeyCalls: DataSourcesSetKeyInput[] = [];
const clearCalls: DataProvider[] = [];
const serpCalls: DataSerpProvider[] = [];
vi.mock('../settings-data-sources-actions', () => ({
  dataSourcesActions: {
    status: async () => {
      const snapshot = structuredClone(main.status);
      const hold = main.holdNextRead;
      main.holdNextRead = null;
      if (hold !== null) {
        await hold;
        return snapshot;
      }
      if (main.readFails > 0) {
        main.readFails -= 1;
        return null;
      }
      return structuredClone(main.status);
    },
    usage: async () => structuredClone(main.usage),
    serpProvider: async () => structuredClone(main.serp),
    setKey: async (input: DataSourcesSetKeyInput) => {
      setKeyCalls.push(input);
      if (main.setKeyAnswer === 'stored' && input.provider !== 'dataforseo') main.status.providers[input.provider].hasKey = true;
      if (main.setKeyAnswer === 'stored' && input.provider === 'dataforseo') {
        const row = main.status.providers.dataforseo;
        // One half alone is `partial`; both (or the second half) make a key.
        if (input.login !== undefined && input.password !== undefined) Object.assign(row, { hasKey: true, partial: false });
        else Object.assign(row, row.partial ? { hasKey: true, partial: false } : { hasKey: false, partial: true });
      }
      return main.setKeyAnswer;
    },
    clearKey: async (provider: DataProvider) => {
      clearCalls.push(provider);
      Object.assign(main.status.providers[provider], { hasKey: false, partial: false });
      return true;
    },
    setSerpProvider: async (provider: DataSerpProvider) => {
      serpCalls.push(provider);
      main.serp = { ...main.serp, provider };
      return 'stored';
    },
  },
}));

const { DataSourcesSettings } = await import('../settings-data-sources');

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  main.status = view('os');
  main.usage = usage();
  main.serp = NO_SERP;
  main.setKeyAnswer = 'stored';
  main.readFails = 0;
  main.holdNextRead = null;
  setKeyCalls.length = 0;
  clearCalls.length = 0;
  serpCalls.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const row = (provider: DataProvider) => host.querySelector<HTMLElement>(`[data-testid="data-source"][data-provider="${provider}"]`)!;
const inside = <T extends HTMLElement>(provider: DataProvider, testId: string) => row(provider).querySelector<T>(`[data-testid="${testId}"]`)!;
const render = () => act(async () => root.render(createElement(DataSourcesSettings)));
const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
};

describe('settings data sources section', () => {
  test('settings-data-sources-shows-main-views', async () => {
    main.status = view('os', { serpapi: { hasKey: true } });
    main.usage = usage({ serpapi: [3, 41] });
    await render();
    expect(host.querySelectorAll('[data-testid="data-source"]')).toHaveLength(DATA_PROVIDERS.length);
    expect(inside('serpapi', 'data-source-key-state').textContent).toBe(TEXT.keySet);
    expect(inside('serper', 'data-source-key-state').textContent).toBe(TEXT.noKey);
    expect(inside('serpapi', 'data-source-usage').textContent).toBe(TEXT.usage(3, 41));
    expect(host.querySelector('[data-testid="data-sources-spend-note"]')!.textContent).toBe(DATA_SPEND_NOTE);
    expect(row('openai-search').textContent).toContain(TEXT.openAiSeparateKey);
    // Accessible names: each field names its provider and field; Save and Clear name the provider.
    const nameOf = (element: Element) => (element.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)!.textContent).join(' ');
    expect(nameOf(inside('serpapi', 'data-source-input'))).toBe(`SerpApi ${TEXT.keyLabel}`);
    expect([...row('dataforseo').querySelectorAll('[data-testid="data-source-input"]')].map(nameOf)).toEqual([`DataForSEO ${TEXT.loginLabel}`, `DataForSEO ${TEXT.passwordLabel}`]);
    expect(inside('serpapi', 'data-source-save').getAttribute('aria-label')).toBe('Save SerpApi key');
    expect(inside('perplexity', 'data-source-clear').getAttribute('aria-label')).toBe('Clear Perplexity key');
    // Text labels only: no image or icon in any row.
    expect(host.querySelectorAll('[data-testid="data-source"] img, [data-testid="data-source"] svg')).toHaveLength(0);
  });

  test('settings-data-sources-gated-disabled-with-note', async () => {
    // As shipped: every gate closed (main says `available: false`); Perplexity somehow has a key.
    main.status = view('os', { perplexity: { hasKey: true } });
    await render();
    for (const provider of DATA_PROVIDERS) {
      for (const input of row(provider).querySelectorAll<HTMLInputElement>('input')) expect(input.disabled, provider).toBe(true);
      expect(inside(provider, 'data-source-save').getAttribute('aria-disabled'), provider).toBe('true');
      expect(inside(provider, 'data-source-reason').textContent, provider).toBe(LEGAL_GATE_NOTE);
      expect(inside(provider, 'data-source-clear').getAttribute('aria-disabled'), provider).toBe(provider === 'perplexity' ? null : 'true');
    }
    // Save on a gated row sends nothing.
    act(() => inside('serpapi', 'data-source-save').click());
    expect(setKeyCalls).toEqual([]);
    // Clear on a gated row without a key is disabled (styled by `.settings-button[aria-disabled='true']`,
    // as on an open row): pressing it asks nothing and clears nothing.
    expect(inside('serpapi', 'data-source-clear').className).toBe('settings-button');
    act(() => inside('serpapi', 'data-source-clear').click());
    expect(row('serpapi').querySelector('[data-testid="data-source-clear-question"]')).toBeNull();
    expect(clearCalls).toEqual([]);
  });

  test('settings-data-sources-weak-explains-and-disables', async () => {
    main.status = view('weak', { serpapi: { available: true } });
    await render();
    const input = inside<HTMLInputElement>('serpapi', 'data-source-input');
    expect(input.disabled).toBe(true);
    expect(inside('serpapi', 'data-source-save').getAttribute('aria-disabled')).toBe('true');
    expect(inside('serpapi', 'data-source-reason').textContent).toBe(TEXT.protection.weak);
    expect(input.getAttribute('aria-describedby')).toContain(inside('serpapi', 'data-source-reason').id);
  });

  test('settings-data-sources-key-entry-never-renders-the-key', async () => {
    // A gate opened by injection works end to end.
    main.status = view('os', { serpapi: { available: true }, dataforseo: { available: true } });
    await render();
    const input = inside<HTMLInputElement>('serpapi', 'data-source-input');
    expect(input.type).toBe('password');
    expect(input.disabled).toBe(false);
    type(input, KEY);
    await act(async () => inside('serpapi', 'data-source-save').click());
    expect(setKeyCalls).toEqual([{ provider: 'serpapi', key: KEY }]);
    // Cleared on save; main's view read again; the key nowhere on the page.
    expect(input.value).toBe('');
    expect(inside('serpapi', 'data-source-key-state').textContent).toBe(TEXT.keySet);
    expect(inside('serpapi', 'data-source-message').textContent).toBe(TEXT.setKeyResults.stored);
    expect(host.innerHTML).not.toContain(KEY);
    expect(host.innerHTML).not.toContain('SECRET');
    // DataForSEO: a login and a password field, each sent as pasted.
    const [login, password] = row('dataforseo').querySelectorAll<HTMLInputElement>('[data-testid="data-source-input"]');
    expect([login!.dataset['field'], password!.dataset['field']]).toEqual(['login', 'password']);
    expect(password!.type).toBe('password');
    type(password!, PASSWORD);
    await act(async () => inside('dataforseo', 'data-source-save').click());
    expect(setKeyCalls[1]).toEqual({ provider: 'dataforseo', password: PASSWORD });
    expect(password!.value).toBe('');
    expect(host.innerHTML).not.toContain(PASSWORD);
    // An empty Save asks for a key and sends nothing; a refusal is said, never the key.
    await act(async () => inside('serpapi', 'data-source-save').click());
    expect(setKeyCalls).toHaveLength(2);
    expect(inside('serpapi', 'data-source-message').textContent).toBe(TEXT.pasteFirst);
    main.setKeyAnswer = 'invalid';
    type(input, 'not a key');
    await act(async () => inside('serpapi', 'data-source-save').click());
    expect(inside('serpapi', 'data-source-message').textContent).toBe(TEXT.setKeyResults.invalid);
    expect(host.innerHTML).not.toContain('not a key');
  });

  test('settings-data-sources-clear-asks-first', async () => {
    main.status = view('os', { serper: { available: true, hasKey: true } });
    await render();
    act(() => inside('serper', 'data-source-clear').click());
    // Asks first: nothing cleared yet; the question takes focus.
    expect(clearCalls).toEqual([]);
    const question = inside('serper', 'data-source-clear-question');
    expect(question.textContent).toBe(TEXT.clearQuestion('Serper'));
    expect(question.className).toBe('settings-question');
    expect(question.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(question);
    // Cancel leaves it set, and focus goes back to Clear.
    act(() => inside('serper', 'data-source-clear-cancel').click());
    expect(row('serper').querySelector('[data-testid="data-source-clear-question"]')).toBeNull();
    expect(clearCalls).toEqual([]);
    expect(document.activeElement).toBe(inside('serper', 'data-source-clear'));
    // Remove key clears it; focus is back on Clear once it is done.
    act(() => inside('serper', 'data-source-clear').click());
    await act(async () => inside('serper', 'data-source-clear-confirm').click());
    expect(clearCalls).toEqual(['serper']);
    expect(document.activeElement).toBe(inside('serper', 'data-source-clear'));
    expect(inside('serper', 'data-source-key-state').textContent).toBe(TEXT.noKey);
    expect(inside('serper', 'data-source-message').textContent).toBe(TEXT.cleared);
  });

  test('settings-data-sources-partial-dataforseo', async () => {
    main.status = view('os', { dataforseo: { available: true } });
    await render();
    // The login only: stored, but the row has no key yet, so it asks for the password.
    const [login] = row('dataforseo').querySelectorAll<HTMLInputElement>('[data-testid="data-source-input"]');
    type(login!, 'owner@frost.example');
    await act(async () => inside('dataforseo', 'data-source-save').click());
    expect(setKeyCalls).toEqual([{ provider: 'dataforseo', login: 'owner@frost.example' }]);
    expect(inside('dataforseo', 'data-source-message').textContent).toBe(TEXT.savedAddOther.password);
    expect(inside('dataforseo', 'data-source-key-state').textContent).toBe(TEXT.noKey);
    expect(row('dataforseo').textContent).toContain(TEXT.partial);
    expect(host.innerHTML).not.toContain('owner@frost.example');
    // Clear is offered for the half, asks first, and clears it.
    expect(inside('dataforseo', 'data-source-clear').getAttribute('aria-disabled')).toBeNull();
    act(() => inside('dataforseo', 'data-source-clear').click());
    await act(async () => inside('dataforseo', 'data-source-clear-confirm').click());
    expect(clearCalls).toEqual(['dataforseo']);
    expect(row('dataforseo').textContent).not.toContain(TEXT.partial);
    expect(inside('dataforseo', 'data-source-clear').getAttribute('aria-disabled')).toBe('true');
  });

  test('settings-data-sources-drops-older-reads', async () => {
    main.status = view('os', { serpapi: { available: true }, serper: { available: true, hasKey: true } });
    await render();
    // Read A (after a SerpApi save) answers late, with the view as it was then (Serper set)…
    let release!: () => void;
    main.holdNextRead = new Promise<void>((resolve) => (release = resolve));
    type(inside<HTMLInputElement>('serpapi', 'data-source-input'), KEY);
    act(() => inside('serpapi', 'data-source-save').click());
    await act(async () => undefined);
    // …while read B (after clearing Serper) answers first, with Serper cleared.
    act(() => inside('serper', 'data-source-clear').click());
    await act(async () => inside('serper', 'data-source-clear-confirm').click());
    expect(inside('serper', 'data-source-key-state').textContent).toBe(TEXT.noKey);
    // A's older answer is dropped: Serper stays cleared.
    await act(async () => release());
    expect(inside('serper', 'data-source-key-state').textContent).toBe(TEXT.noKey);
    expect(inside('serpapi', 'data-source-key-state').textContent).toBe(TEXT.keySet);
  });

  test('settings-data-sources-serp-choice', async () => {
    main.status = view('os', { serpapi: { available: true, hasKey: true }, serper: { available: true, hasKey: true } });
    main.serp = { provider: null, choices: ['serpapi', 'serper'] };
    await render();
    const select = host.querySelector<HTMLSelectElement>('[data-testid="data-sources-serp-provider"]')!;
    // Main's choices only (after the placeholder).
    expect([...select.options].map((o) => o.value)).toEqual(['', 'serpapi', 'serper']);
    expect(select.value).toBe('');
    select.value = 'serper';
    await act(async () => select.dispatchEvent(new Event('change', { bubbles: true })));
    expect(serpCalls).toEqual(['serper']);
    expect(host.querySelector<HTMLSelectElement>('[data-testid="data-sources-serp-provider"]')!.value).toBe('serper');
  });

  test('settings-data-sources-read-failed', async () => {
    main.readFails = 1;
    await render();
    expect(host.querySelector('[data-testid="data-sources-read-failed"]')!.textContent).toBe(TEXT.readFailed);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="data-sources-retry"]')!.click());
    expect(host.querySelectorAll('[data-testid="data-source"]')).toHaveLength(DATA_PROVIDERS.length);
  });
});
