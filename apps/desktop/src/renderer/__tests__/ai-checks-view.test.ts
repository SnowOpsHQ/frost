// @vitest-environment jsdom
// Spec: specs/ai-checks.spec.ts (AI_CHECKS_COPY, AI_CHECK_UNAVAILABLE, AI_CHECK_MODES), specs/ai-checks.schema.ts
// (AiChecksState, AiCheckResult: types only), specs/seo-content.spec.ts (TARGET_QUERY_MAX_CHARS), specs/page-type.spec.ts
// (PAGE_TYPE_LABELS), specs/account-settings.spec.ts (SETTINGS_SECTIONS: `ai-checks`), specs/agent-panel.spec.ts
// (AGENT_ROUTE_LABELS, AGENT_MODEL_LABELS)
// Acceptance: specs/ai-checks.feature.md (UI)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AiCheckResult, AiChecksState, AiCheckView } from '@app/specs/ai-checks.schema';
import { AI_CHECK_UNAVAILABLE, AI_CHECKS_COPY as COPY } from '@app/specs/ai-checks.spec';
import { AGENT_MODEL_LABELS, AGENT_ROUTE_LABELS } from '@app/specs/agent-panel.spec';
import type { AgentState } from '@app/specs/agent-session.spec';
import type { TabState } from '@app/specs/browser.spec';
import { PAGE_TYPE_LABELS } from '@app/specs/page-type.spec';
import { TARGET_QUERY_MAX_CHARS } from '@app/specs/seo-content.spec';
import { audit, PAGE } from './ai-readiness-fixtures';
import { state as agentState, setup as agentSetup } from './agent-fixtures';

/** The faked IPC: `aiChecks.watch` answers main's state once it is newer than asked; the calls are recorded. */
const fake = vi.hoisted(() => ({
  state: null as unknown,
  waiters: [] as { since: number; resolve: (state: unknown) => void }[],
  agent: null as unknown,
  calls: [] as { path: string; input: unknown }[],
  setModeAnswer: (mode: string): Promise<unknown> => Promise.resolve(mode),
  checkNowAnswer: true,
  notes: { query: '', generation: 0 },
}));
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const record = (path: string, answer: (input: unknown) => unknown) => (input?: unknown) => (fake.calls.push({ path, input }), Promise.resolve(answer(input)));
  return {
    actions: {},
    ipc: {
      aiChecks: {
        watch: {
          query: (input: { tabId: number; sinceVersion: number }) => {
            const current = fake.state as AiChecksState;
            if (current !== null && current.version > input.sinceVersion) return Promise.resolve(current);
            return new Promise((resolve) => fake.waiters.push({ since: input.sinceVersion, resolve }));
          },
        },
        state: { query: never },
        setMode: { mutate: (input: { mode: string }) => (fake.calls.push({ path: 'aiChecks.setMode', input }), fake.setModeAnswer(input.mode)) },
        checkNow: { mutate: record('aiChecks.checkNow', () => fake.checkNowAnswer) },
      },
      agent: {
        watch: {
          query: (input: { sinceVersion: number }) => {
            const current = fake.agent as AgentState | null;
            return current !== null && current.version > input.sinceVersion ? Promise.resolve(current) : never();
          },
        },
      },
      content: {
        getNotes: { query: record('content.getNotes', () => ({ query: fake.notes.query, variants: [], generation: fake.notes.generation })) },
        setTarget: { mutate: record('content.setTarget', () => true) },
        saveVariant: { mutate: record('content.saveVariant', () => true) },
        deleteVariant: { mutate: record('content.deleteVariant', () => true) },
      },
    },
  };
});

const { AiChecksCard, AiChecksQuality } = await import('../components/seo/AiChecksCard');
const { AiChecksSettings } = await import('../settings-ai-checks');
const { useContentNotes } = await import('../hooks/useContentNotes');
const { onSettingsRequest } = await import('../settings-open');
const { onAgentPanelRequest } = await import('../agent-palette');
const { aiChecksPaletteSources } = await import('../ai-checks-palette');
const { rememberAiChecks, forgetAiChecks } = await import('../ai-checks-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = { id: 4, url: PAGE, title: 'Green tea', loading: false, error: null, crashed: false } as TabState;
const MODEL = { route: 'byok-anthropic', modelId: 'anthropic/claude-sonnet-5-5' } as const;

function result(output: Partial<AiCheckResult['output']> = {}, changes: Partial<AiCheckResult> = {}): AiCheckResult {
  return {
    url: PAGE,
    inputHash: 'a'.repeat(64),
    modelId: MODEL.modelId,
    checkedAt: Date.UTC(2026, 10, 2, 15, 30),
    output: { pageType: 'article', intent: 'informational', quality: 'adequate', qualityReason: 'It explains brewing well but is thin on varieties.', suggestedTarget: 'how to brew green tea', ...output },
    ...changes,
  };
}

let version = 0;
function aiState(check: AiCheckView, changes: Partial<AiChecksState> = {}): AiChecksState {
  version += 1;
  return { version, tabId: TAB.id, mode: 'on-request', model: MODEL, url: PAGE, check, ...changes };
}

/** Main answers a new state: every waiting watch resolves. */
async function push(next: AiChecksState): Promise<void> {
  fake.state = next;
  await act(async () => {
    for (const waiter of fake.waiters.splice(0)) waiter.resolve(next);
    await Promise.resolve();
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await act(async () => undefined);
}

let root: Root;
let host: HTMLDivElement;

const one = (selector: string) => host.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const byTest = (id: string) => one(`[data-testid="${id}"]`);
const callsTo = (path: string) => fake.calls.filter((call) => call.path === path).map((call) => call.input);

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
  await settle();
}

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => root.render(element));
  await settle();
}

const showCard = (changes: Parameters<typeof audit>[0] = {}) => render(createElement(AiChecksCard, { audit: audit(changes), tab: TAB }));

/** The Content panel's row with the page's own notes, as `Content.tsx` mounts it. */
function QualityHarness({ url }: { readonly url: string }) {
  const notes = useContentNotes(url, 0);
  return createElement('div', null, createElement('output', { 'data-testid': 'field' }, notes.query), createElement(AiChecksQuality, { url, tab: TAB, notes }));
}

beforeEach(() => {
  Object.assign(fake, { state: null, waiters: [], agent: null, calls: [], setModeAnswer: (mode: string) => Promise.resolve(mode), checkNowAnswer: true, notes: { query: '', generation: 0 } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AI checks: Settings', () => {
  test('settings-mode-change-opens-consent', async () => {
    fake.agent = agentState({ setup: agentSetup({ route: 'byok-anthropic', modelId: 'anthropic/claude-opus-5-5', ready: true }) });
    fake.state = aiState({ status: 'unavailable', reason: 'off' }, { mode: 'off' });
    // The dialog is main's: the answer waits until the user answers it there.
    let answer: (mode: string) => void = () => undefined;
    fake.setModeAnswer = () => new Promise((resolve) => (answer = resolve));
    await render(createElement(AiChecksSettings, { tabId: TAB.id }));
    const section = byTest('ai-checks-section')!;
    const modes = () => all('[data-testid="ai-checks-mode"]');
    expect(modes().map((m) => m.dataset.mode)).toEqual(['off', 'on-request', 'automatic']);
    expect(modes().map((m) => m.textContent)).toEqual([
      expect.stringContaining(COPY.settings.modes.off.label),
      expect.stringContaining(COPY.settings.modes['on-request'].label),
      expect.stringContaining(COPY.settings.modes.automatic.label),
    ]);
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    // The cost note names the agent settings' route and model (from `agent.watch`, never a key).
    const cost = byTest('ai-checks-settings-cost')!.textContent!;
    expect(cost).toContain(AGENT_MODEL_LABELS['anthropic/claude-opus-5-5']);
    expect(cost).toContain(AGENT_ROUTE_LABELS['byok-anthropic']);
    expect(section.textContent).toContain(COPY.settings.consentNote);

    // Choosing a mode asks main once; nothing changes on screen until main answered.
    await click(modes()[2]);
    expect(callsTo('aiChecks.setMode')).toEqual([{ mode: 'automatic' }]);
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(modes().every((m) => m.getAttribute('aria-disabled') === 'true')).toBe(true);
    await click(modes()[1]);
    expect(callsTo('aiChecks.setMode')).toHaveLength(1);
    // Cancelled in main's dialog: still off, and it says so.
    await act(async () => answer('off'));
    await settle();
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(modes().some((m) => m.getAttribute('aria-disabled') === 'true')).toBe(false);
    expect(byTest('ai-checks-settings-note')!.textContent).toBe(COPY.settings.stayedOff);

    // Confirmed there: main's answer is the mode shown, and then its state.
    await click(modes()[1]);
    expect(callsTo('aiChecks.setMode')).toEqual([{ mode: 'automatic' }, { mode: 'on-request' }]);
    await act(async () => answer('on-request'));
    await settle();
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(byTest('ai-checks-settings-note')).toBeNull();
    await push(aiState({ status: 'idle' }, { mode: 'on-request' }));
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    // Choosing the mode in effect asks nothing.
    await click(modes()[1]);
    expect(callsTo('aiChecks.setMode')).toHaveLength(2);
    // A failed call says so; the mode stays main's.
    fake.setModeAnswer = () => Promise.reject(new Error('ipc'));
    await click(modes()[0]);
    expect(modes().map((m) => m.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(byTest('ai-checks-settings-note')!.textContent).toBe(COPY.settings.failed);

    // The agent's model settings are one click away.
    const requests: unknown[] = [];
    const stop = onAgentPanelRequest((request) => requests.push(request));
    await click(byTest('ai-checks-agent-settings'));
    stop();
    expect(requests).toEqual([{ kind: 'settings' }]);
  });
});

describe('AI checks: the Overview card and the Quality row', () => {
  test('card-states', async () => {
    const settingsRequests: string[] = [];
    const agentRequests: unknown[] = [];
    const stops = [onSettingsRequest((section) => settingsRequests.push(section)), onAgentPanelRequest((request) => agentRequests.push(request))];
    try {
      // Off: one line, inviting to Settings, nothing else.
      fake.state = aiState({ status: 'unavailable', reason: 'off' }, { mode: 'off' });
      await showCard();
      const card = () => byTest('ai-checks-card')!;
      expect(card().dataset.state).toBe('off');
      expect(byTest('ai-checks-off')!.textContent).toContain(COPY.offLine);
      expect(card().querySelectorAll('p, li, dl, h3').length).toBe(1);
      expect(byTest('ai-checks-check')).toBeNull();
      expect(byTest('ai-judgment-label')).toBeNull();
      await click(byTest('ai-checks-open-settings'));
      expect(settingsRequests).toEqual(['ai-checks']);

      // No model: the way to the agent's settings.
      await push(aiState({ status: 'unavailable', reason: 'no-model' }, { model: { route: 'gateway', modelId: 'openai/gpt-5' } }));
      expect(card().dataset.state).toBe('unavailable');
      expect(card().dataset.reason).toBe('no-model');
      expect(byTest('ai-checks-set-up-model')!.textContent).toBe(COPY.setUpModel);
      await click(byTest('ai-checks-set-up-model'));
      expect(agentRequests).toEqual([{ kind: 'settings' }]);

      // Idle: "Check this page", with the cost note.
      await push(aiState({ status: 'idle' }));
      expect(card().dataset.state).toBe('idle');
      expect(byTest('ai-checks-message')!.textContent).toBe(COPY.idle);
      expect(byTest('ai-checks-cost')!.textContent).toBe(COPY.cost.replace('{model}', AGENT_MODEL_LABELS[MODEL.modelId]).replace('{route}', AGENT_ROUTE_LABELS[MODEL.route]));
      expect(byTest('ai-checks-check')!.textContent).toBe(COPY.checkNow);
      await click(byTest('ai-checks-check'));
      expect(callsTo('aiChecks.checkNow')).toEqual([{ tabId: TAB.id }]);

      // Queued, then checking.
      await push(aiState({ status: 'queued' }));
      expect(card().dataset.state).toBe('queued');
      expect(byTest('ai-checks-message')!.textContent).toBe(COPY.queued);
      expect(byTest('ai-checks-check')).toBeNull();
      await push(aiState({ status: 'checking' }));
      expect(card().dataset.state).toBe('checking');
      expect(byTest('ai-checks-message')!.textContent).toBe(COPY.checking);
      expect(byTest('ai-checks-check')).toBeNull();

      // A result, with "Check again" (past the cached answer).
      await push(aiState({ status: 'ready', result: result(), cached: true }));
      expect(card().dataset.state).toBe('ready');
      expect(byTest('ai-judgment-label')!.textContent).toBe(COPY.label);
      expect(byTest('ai-page-type')!.textContent).toBe(PAGE_TYPE_LABELS.article);
      expect(byTest('ai-intent')!.textContent).toBe('Informational');
      expect(byTest('ai-quality')!.textContent).toBe(COPY.qualities.adequate);
      expect(byTest('ai-quality-reason')!.textContent).toBe('It explains brewing well but is thin on varieties.');
      expect(byTest('ai-suggested-target')!.textContent).toBe('how to brew green tea');
      expect(byTest('ai-checked-by')!.textContent).toContain(AGENT_MODEL_LABELS[MODEL.modelId]);
      expect(byTest('ai-cached')!.textContent).toBe(COPY.cached);
      expect(byTest('ai-checks-check')!.textContent).toBe(COPY.checkAgain);
      await click(byTest('ai-checks-check'));
      expect(callsTo('aiChecks.checkNow')).toEqual([{ tabId: TAB.id }, { tabId: TAB.id, again: true }]);
      // The model could not tell: said, not guessed.
      await push(aiState({ status: 'ready', result: result({ pageType: null, intent: null, quality: null, suggestedTarget: null }), cached: false }));
      expect(byTest('ai-intent')!.textContent).toBe(COPY.couldNotTell);
      expect(byTest('ai-quality')!.textContent).toBe(COPY.couldNotTell);
      expect(byTest('ai-suggested-target')).toBeNull();
      expect(byTest('ai-cached')).toBeNull();

      // Each unavailable reason has its own words.
      for (const reason of AI_CHECK_UNAVAILABLE.filter((r) => r !== 'off' && r !== 'no-model')) {
        await push(aiState({ status: 'unavailable', reason }));
        expect(card().dataset.reason, reason).toBe(reason);
        expect(byTest('ai-checks-message')!.textContent, reason).toBe(COPY.reasons[reason]);
        expect(byTest('ai-judgment-label'), reason).toBeNull();
      }
      expect(COPY.reasons['not-anonymous']).toContain('Nothing was sent');
      // A failed check can be asked again; one that clears by itself or is skipped by the guard can't.
      await push(aiState({ status: 'unavailable', reason: 'network' }));
      expect(byTest('ai-checks-check')!.textContent).toBe(COPY.checkAgain);
      for (const reason of ['not-anonymous', 'not-public', 'served-pending', 'busy-chat'] as const) {
        await push(aiState({ status: 'unavailable', reason }));
        expect(byTest('ai-checks-check'), reason).toBeNull();
      }

      // Turning off while a check is queued: main stops it, and the card is its one line again.
      await push(aiState({ status: 'queued' }));
      expect(card().dataset.state).toBe('queued');
      await push(aiState({ status: 'unavailable', reason: 'off' }, { mode: 'off' }));
      expect(card().dataset.state).toBe('off');
      expect(byTest('ai-checks-message')).toBeNull();
      expect(card().querySelectorAll('p, li, dl, h3').length).toBe(1);
      // A ready answer left from before is not shown while off either.
      await push(aiState({ status: 'ready', result: result(), cached: true }, { mode: 'off' }));
      expect(card().dataset.state).toBe('off');
      expect(byTest('ai-judgment-label')).toBeNull();
      expect(byTest('ai-quality-reason')).toBeNull();
    } finally {
      for (const stop of stops) stop();
    }
  });

  // Phase 9 Task 12 (found end to end): a ChatGPT plan model is named as the account lists it, as the
  // Settings section's cost note names it, never by its raw id.
  test('chatgpt-plan-model-named-from-the-account-list', async () => {
    const plan = { route: 'chatgpt', modelId: 'chatgpt/gpt-e2e' } as const;
    fake.agent = agentState({ setup: agentSetup({ route: 'chatgpt', modelId: plan.modelId, chatgpt: { account: { state: 'signed-in', acknowledged: true }, models: [{ id: plan.modelId, label: 'GPT E2E' }] } as never }) });
    fake.state = aiState({ status: 'idle' }, { model: plan });
    await showCard();
    expect(byTest('ai-checks-cost')!.textContent).toBe(COPY.cost.replace('{model}', 'GPT E2E').replace('{route}', AGENT_ROUTE_LABELS.chatgpt));
    await push(aiState({ status: 'ready', result: result({}, { modelId: plan.modelId }), cached: false }, { model: plan }));
    expect(byTest('ai-checked-by')!.textContent).toContain('Checked by GPT E2E on');
    expect(host.textContent).not.toContain('chatgpt/gpt-e2e');
  });

  test('labelled-ai-judgment', async () => {
    const reason = 'It explains brewing well but is thin on varieties.';
    // No model text in any state but `ready`.
    for (const check of [{ status: 'idle' }, { status: 'queued' }, { status: 'checking' }, ...AI_CHECK_UNAVAILABLE.map((r) => ({ status: 'unavailable', reason: r }))] as AiCheckView[]) {
      fake.state = aiState(check);
      await showCard();
      expect(byTest('ai-judgment-label'), JSON.stringify(check)).toBeNull();
      expect(host.textContent).not.toContain(reason);
      await render(createElement(QualityHarness, { url: PAGE }));
      expect(byTest('ai-judgment-label'), JSON.stringify(check)).toBeNull();
    }
    // Ready: everything the model wrote sits inside the labelled block, below the label.
    fake.state = aiState({ status: 'ready', result: result(), cached: false });
    for (const view of [() => showCard(), () => render(createElement(QualityHarness, { url: PAGE }))]) {
      await view();
      const block = byTest('ai-judgment')!;
      const label = block.querySelector('[data-testid="ai-judgment-label"]')!;
      expect(label.textContent).toBe(COPY.label);
      expect(block.firstElementChild).toBe(label);
      for (const id of ['ai-quality', 'ai-quality-reason', 'ai-suggested-target']) {
        const node = byTest(id)!;
        expect(block.contains(node), id).toBe(true);
      }
      expect(all('[data-testid="ai-judgment"]')).toHaveLength(1);
    }
    // The card's other answers too.
    await showCard();
    for (const id of ['ai-page-type', 'ai-intent', 'ai-checked-by']) expect(byTest('ai-judgment')!.contains(byTest(id)), id).toBe(true);
  });

  test('model-text-inert', async () => {
    const evil = '<a href="javascript:alert(1)">click</a><img src=x onerror=alert(1)><b style="color:red">‮bold</b>';
    const target = '<script>alert(1)</script> https://evil.example/?q=1';
    fake.state = aiState({ status: 'ready', result: result({ qualityReason: evil, suggestedTarget: target }), cached: false });
    for (const view of [() => showCard(), () => render(createElement(QualityHarness, { url: PAGE }))]) {
      await view();
      const block = byTest('ai-judgment')!;
      for (const [id, value] of [
        ['ai-quality-reason', evil],
        ['ai-suggested-target', target],
      ] as const) {
        const node = byTest(id)!;
        expect(node.tagName, id).toBe('BDI');
        expect(node.getAttribute('dir'), id).toBe('auto');
        expect(node.textContent, id).toBe(value);
        expect(node.children, id).toHaveLength(0);
      }
      // No element, link, `href` or `style` from the model's text.
      expect(block.querySelectorAll('a, img, script, b, [href], [style], [onerror], [src]')).toHaveLength(0);
      expect(host.querySelectorAll('a, [href], [style]')).toHaveLength(0);
    }
  });

  test('suggested-target-use-as-target', async () => {
    const long = `green tea ${'x'.repeat(TARGET_QUERY_MAX_CHARS + 40)}`;
    fake.notes = { query: '', generation: 5 };
    fake.state = aiState({ status: 'ready', result: result({ suggestedTarget: long }), cached: false });
    await render(createElement(QualityHarness, { url: `${PAGE}#comments` }));
    // Shown, not saved: nothing is written until the click.
    expect(callsTo('content.getNotes')).toEqual([{ url: `${PAGE}#comments` }]);
    expect(callsTo('content.setTarget')).toEqual([]);
    expect(byTest('field')!.textContent).toBe('');
    const use = byTest('ai-use-as-target')!;
    expect(use.textContent).toBe(COPY.useAsTarget);
    expect(use.getAttribute('aria-label')).toBe(COPY.useAsTargetLabel.replace('{query}', long.slice(0, TARGET_QUERY_MAX_CHARS)));
    await click(use);
    const saved = long.slice(0, TARGET_QUERY_MAX_CHARS);
    expect(callsTo('content.setTarget')).toEqual([{ url: `${PAGE}#comments`, query: saved, generation: 5 }]);
    expect(byTest('field')!.textContent).toBe(saved);
    // Now the target: marked, no button.
    expect(byTest('ai-use-as-target')).toBeNull();
    expect(byTest('ai-target-current')!.textContent).toBe(COPY.currentTarget);

    // An answer for another page (the tab moved on) is never offered as this page's target.
    fake.calls.length = 0;
    fake.notes = { query: '', generation: 5 };
    await push(aiState({ status: 'ready', result: result({ suggestedTarget: 'sencha' }, { url: 'https://www.example.com/other' }), cached: false }, { url: 'https://www.example.com/other' }));
    act(() => root.unmount());
    root = createRoot(host);
    await render(createElement(QualityHarness, { url: PAGE }));
    expect(byTest('ai-use-as-target')).toBeNull();
    expect(byTest('ai-judgment')).toBeNull();
    expect(callsTo('content.setTarget')).toEqual([]);

    // The Overview card shows it only as text.
    await push(aiState({ status: 'ready', result: result(), cached: false }));
    await showCard();
    expect(byTest('ai-suggested-target')!.textContent).toBe('how to brew green tea');
    expect(byTest('ai-use-as-target')).toBeNull();
  });

  test('heuristic-and-ai-page-type-both-shown-when-they-differ', async () => {
    // They agree (the fixture's on-device type is an article): only one type.
    fake.state = aiState({ status: 'ready', result: result({ pageType: 'article' }), cached: false });
    await showCard();
    expect(byTest('ai-page-type')!.textContent).toBe(PAGE_TYPE_LABELS.article);
    expect(byTest('ai-page-type-heuristic')).toBeNull();
    // They differ: both, the on-device one named as such.
    await push(aiState({ status: 'ready', result: result({ pageType: 'product' }), cached: false }));
    expect(byTest('ai-page-type')!.textContent).toBe(PAGE_TYPE_LABELS.product);
    expect(byTest('ai-page-type-heuristic')!.textContent).toBe(COPY.heuristicPageType.replace('{type}', PAGE_TYPE_LABELS.article));
    // The model could not tell: the on-device type is still there beside it.
    await push(aiState({ status: 'ready', result: result({ pageType: null }), cached: false }));
    expect(byTest('ai-page-type')!.textContent).toBe(COPY.couldNotTell);
    expect(byTest('ai-page-type-heuristic')!.textContent).toBe(COPY.heuristicPageType.replace('{type}', PAGE_TYPE_LABELS.article));
    // Another on-device type that now matches the AI's.
    await showCard({ pageType: { type: 'product', confidence: 'high', signals: [{ signal: 'schema-type', type: 'product', evidence: 'Product' }] } });
    await push(aiState({ status: 'ready', result: result({ pageType: 'product' }), cached: false }));
    expect(byTest('ai-page-type-heuristic')).toBeNull();
  });

  test('palette-check-and-change-mode', async () => {
    const checks: number[] = [];
    const opened: string[] = [];
    const sources = aiChecksPaletteSources({
      checkNow: async (tabId) => (checks.push(tabId), true),
      openSettings: (section) => void opened.push(section),
    });
    const actions = sources.flatMap((source) => (typeof source === 'function' ? [] : [source]));
    const check = actions.find((a) => a.id === 'ai-checks.check-page')!;
    const mode = actions.find((a) => a.id === 'ai-checks.mode')!;
    expect(check.label).toBe(COPY.palette.check);
    expect(mode.label).toBe(COPY.palette.mode);
    const openPanel = vi.fn();
    const ctx = (tab: TabState | undefined) => ({ state: null, tab, audit: null, sidebarOpen: false, chrome: { openPanel, setSidebarOpen: vi.fn() } });
    // Unknown mode: offered (main decides). Known off: not offered. Not a web page: not offered.
    forgetAiChecks(TAB.id);
    expect(check.available!(ctx(TAB))).toBe(true);
    rememberAiChecks(aiState({ status: 'unavailable', reason: 'off' }, { mode: 'off' }));
    expect(check.available!(ctx(TAB))).toBe(false);
    rememberAiChecks(aiState({ status: 'idle' }, { mode: 'on-request' }));
    expect(check.available!(ctx(TAB))).toBe(true);
    expect(check.available!(ctx({ ...TAB, url: 'about:blank' }))).toBe(false);
    expect(check.available!(ctx(undefined))).toBe(false);
    await check.run(ctx(TAB));
    expect(checks).toEqual([TAB.id]);
    expect(openPanel).toHaveBeenCalledWith('overview', { focus: false });
    // "AI checks: change mode…" opens the Settings section (main's dialog guards turning them on).
    expect(mode.available?.(ctx(TAB)) ?? true).toBe(true);
    await mode.run(ctx(TAB));
    expect(opened).toEqual(['ai-checks']);
    forgetAiChecks(TAB.id);
  });
});
