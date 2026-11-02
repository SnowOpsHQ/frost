// @vitest-environment jsdom
// Spec: specs/ai-readiness.spec.ts (AI_READINESS_COPY, AI_ASSISTANTS, AI_STANCE_NOTES, LLMS_TXT_OUTCOME_MESSAGES,
// LLMS_TXT_FINDING_MESSAGES, aiScoreBasis), specs/ai-readiness.schema.ts (LlmsTxtState: type only),
// specs/visibility-probes.schema.ts (ProbesState: type only)
// Acceptance: specs/ai-readiness.feature.md (AI readiness views), specs/seo-sidebar.feature.md (Overview, AI-readiness tile)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { AI_ASSISTANTS, AI_READINESS_COPY as COPY, AI_STANCE_NOTES, LLMS_TXT_FINDING_MESSAGES, LLMS_TXT_OUTCOME_MESSAGES } from '@app/specs/ai-readiness.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { audit, bots, llms, PAGE, probes } from './ai-readiness-fixtures';

const fake = vi.hoisted(() => ({ probes: null as ProbesState | null }));
vi.mock('../hooks/useSerp', () => ({
  serpActions: { classify: vi.fn(() => new Promise(() => undefined)) },
  useIntentState: () => ['model-missing', () => {}],
  useProbes: () => fake.probes,
}));
vi.mock('../ipc', () => ({
  actions: {},
  ipc: { content: { getNotes: { query: () => Promise.resolve({ query: '', variants: [], generation: 0 }) } } },
}));

const { AiReadiness } = await import('../components/seo/AiReadiness');
const { Overview } = await import('../components/seo/Overview');
const { aiReadinessView, aiTileView } = await import('../ai-readiness-view');
const { aiReadinessPaletteSources } = await import('../ai-readiness-palette');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  fake.probes = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: ReturnType<typeof createElement>) => act(async () => root.render(node));
const all = (selector: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLElement>(selector)];
const one = (selector: string, within: ParentNode = host) => within.querySelector<HTMLElement>(selector);
const check = (id: string) => one(`[data-testid="ai-check"][data-check="${id}"]`)!;
const crawler = (token: string) => one(`[data-testid="ai-crawler"][data-token="${token}"]`)!;
const assistant = (id: string) => one(`[data-testid="ai-assistant"][data-assistant="${id}"]`)!;

const TAB = { id: 1, url: PAGE, title: 'Green tea', loading: false, error: null, crashed: false } as TabState;

describe('AI readiness views', () => {
  test('assistants-rows-and-roles', async () => {
    await render(createElement(AiReadiness, { audit: audit({ bots: bots({ gptbot: 'disallowed' }, { applebot: 'googlebot' }) }), probes: null }));
    // One list item per assistant, in order (a list, not a table: the panel is narrow).
    const items = all('[data-testid="ai-assistant"]');
    expect(items.map((item) => item.dataset.assistant)).toEqual(AI_ASSISTANTS.map((a) => a.id));
    expect(items.every((item) => item.tagName === 'LI')).toBe(true);
    expect(one('[data-testid="ai-assistants"] table')).toBeNull();
    for (const a of AI_ASSISTANTS) expect(all('[data-testid="ai-crawler"]', assistant(a.id)).map((c) => c.dataset.token)).toEqual([...a.tokens]);
    // Each token with its role and verdict.
    expect(one('[data-testid="ai-crawler-role"]', crawler('OAI-SearchBot'))!.textContent).toBe(COPY.roles['ai-search']);
    expect(one('[data-testid="ai-crawler-role"]', crawler('ChatGPT-User'))!.textContent).toBe(COPY.roles['live-fetch']);
    expect(one('[data-testid="ai-crawler-role"]', crawler('GPTBot'))!.textContent).toBe(COPY.roles.training);
    expect(crawler('GPTBot').dataset.verdict).toBe('disallowed');
    expect(crawler('GPTBot').textContent).toContain(COPY.verdicts.disallowed);
    expect(crawler('OAI-SearchBot').dataset.verdict).toBe('allowed');
    // A blocked crawler names the rule's path, the site's text, as inert bidi-isolated text; an allowed one names none.
    const rule = one('[data-testid="ai-crawler-rule"]', crawler('GPTBot'))!;
    expect([rule.tagName, rule.getAttribute('dir'), rule.textContent]).toEqual(['BDI', 'auto', '/blog/']);
    expect(crawler('GPTBot').textContent).toContain(COPY.disallowRule);
    expect(one('[data-testid="ai-crawler-rule"]', crawler('OAI-SearchBot'))).toBeNull();
    // Googlebot and Bingbot: search crawlers, read from the Indexability verdicts.
    expect(one('[data-testid="ai-crawler-role"]', crawler('Googlebot'))!.textContent).toBe(COPY.searchRole);
    expect(crawler('Googlebot').dataset.verdict).toBe('allowed');
    expect(crawler('Bingbot').dataset.verdict).toBe('disallowed');
    expect(one('[data-testid="ai-crawler-rule"]', crawler('Bingbot'))!.textContent).toBe('/blog/');
    // Applebot judged by Googlebot's group says so (Apple's documented fallback).
    expect(crawler('Applebot').textContent).toContain(COPY.vias.googlebot);
    expect(crawler('Applebot-Extended').textContent).not.toContain(COPY.vias.googlebot);
    // The `*` fallback is every crawler's rule: not said on each row.
    expect(COPY.vias['*']).toBeNull();
  });

  test('frost-model-labelled', async () => {
    await render(createElement(AiReadiness, { audit: audit(), probes: null }));
    for (const a of AI_ASSISTANTS) {
      const label = one('[data-testid="ai-frost-model"]', assistant(a.id));
      if (a.source === 'frost-model') {
        expect(label?.textContent, a.id).toContain(COPY.frostModel);
        expect(assistant(a.id).textContent).toContain(COPY.frostModelNote);
      } else expect(label, a.id).toBeNull();
    }
    expect(AI_ASSISTANTS.filter((a) => a.source === 'frost-model').map((a) => a.id)).toEqual(['copilot', 'google-ai']);
  });

  test('may-ignore-note-on-live-fetch', async () => {
    await render(createElement(AiReadiness, { audit: audit(), probes: null }));
    expect(check('live-fetch-agents').textContent).toContain(COPY.mayIgnoreNote);
    for (const token of ['ChatGPT-User', 'Perplexity-User']) expect(crawler(token).textContent, token).toContain(AI_STANCE_NOTES['may-ignore']);
    // Claude-User's operator says it follows robots.txt: no such note.
    expect(crawler('Claude-User').textContent).not.toContain(AI_STANCE_NOTES['may-ignore']);
    for (const token of ['Google-Extended', 'Applebot-Extended']) expect(crawler(token).textContent, token).toContain(AI_STANCE_NOTES['control-token']);
    expect(check('training-opt-outs').textContent).toContain(COPY.controlTokenNote);
  });

  test('training-opt-out-neutral', async () => {
    const blocked = bots({ gptbot: 'disallowed', claudebot: 'disallowed', ccbot: 'disallowed', bytespider: 'disallowed', 'meta-externalagent': 'disallowed', 'google-extended': 'disallowed', 'applebot-extended': 'disallowed' });
    for (const verdicts of [blocked, bots()]) {
      await render(createElement(AiReadiness, { audit: audit({ bots: verdicts }), probes: null }));
      const training = check('training-opt-outs');
      expect(training.dataset.status).toBe('info');
      expect(training.dataset.scored).toBe('false');
      const status = one('[data-testid="ai-check-status"]', training)!;
      expect(status.dataset.status).toBe('info');
      expect(status.textContent).toBe(COPY.statuses.info);
      for (const mark of [COPY.statuses.pass, COPY.statuses.fail, COPY.statuses.warn]) expect(status.textContent).not.toContain(mark);
      expect(training.textContent).toContain(COPY.trainingNeutral);
      expect(training.textContent).toContain(COPY.unscored);
      // A scored check has no such mark.
      expect(check('ai-search-crawlers').dataset.scored).toBe('true');
      expect(check('ai-search-crawlers').textContent).not.toContain(COPY.unscored);
    }
    // Blocking training moves no score.
    expect(aiReadinessView(audit({ bots: blocked }), null).ring).toEqual(aiReadinessView(audit(), null).ring);
  });

  test('score-ring-states', async () => {
    const ring = () => one('[data-testid="ai-readiness-ring"]')!;
    // No audit yet: pending, no number.
    await render(createElement(AiReadiness, { audit: null, probes: null }));
    expect(ring().dataset.state).toBe('pending');
    expect(one('[data-testid="ai-readiness-score"]')!.textContent).toBe(COPY.pendingValue);
    expect(one('[data-testid="ai-readiness-basis"]')!.textContent).toBe(COPY.pendingBasis);
    // A static check not judged yet (the served comparison pending): still pending.
    await render(createElement(AiReadiness, { audit: audit({ javascript: { status: 'pending' } }), probes: null }));
    expect(ring().dataset.state).toBe('pending');
    // Before a probe run: partial, 3 of 4, and the hint to run the probes.
    await render(createElement(AiReadiness, { audit: audit(), probes: null }));
    expect(ring().dataset.state).toBe('partial');
    expect(one('[data-testid="ai-readiness-score"]')!.textContent).toBe('100');
    expect(one('[data-testid="ai-readiness-basis"]')!.textContent).toBe('Based on 3 of 4 checks');
    expect(one('[data-testid="ai-readiness-hint"]')!.textContent).toBe(COPY.partialHint);
    // A run still going counts nothing yet.
    await render(createElement(AiReadiness, { audit: audit(), probes: probes(null, { status: 'running' }) }));
    expect(ring().dataset.state).toBe('partial');
    // After a finished run for the page: full, 4 of 4.
    await render(createElement(AiReadiness, { audit: audit(), probes: probes() }));
    expect(ring().dataset.state).toBe('full');
    expect(one('[data-testid="ai-readiness-basis"]')!.textContent).toBe('Based on 4 of 4 checks');
    expect(one('[data-testid="ai-readiness-hint"]')).toBeNull();
    // The arc is an SVG attribute, never a style.
    expect(host.querySelector('[style]')).toBeNull();
    expect(aiTileView(null, null).state).toBe('pending');
  });

  test('llms-txt-findings-inert', async () => {
    const title = '<a href="https://evil.example/">Click</a> <img src=x onerror=alert(1)> ‮evil';
    await render(createElement(AiReadiness, { audit: audit(), probes: probes(llms({ outcome: 'malformed', findings: ['no-links', 'links-not-markdown'], title })) }));
    const card = check('llms-txt');
    expect(card.dataset.status).toBe('warn');
    expect(card.textContent).toContain(LLMS_TXT_OUTCOME_MESSAGES.malformed);
    for (const finding of ['no-links', 'links-not-markdown'] as const) expect(card.textContent).toContain(LLMS_TXT_FINDING_MESSAGES[finding]);
    // The file's title: one inert, bidi-isolated text node, never markup and never a link.
    const shown = one('[data-testid="ai-llms-title"]', card)!;
    expect(shown.tagName).toBe('BDI');
    expect(shown.getAttribute('dir')).toBe('auto');
    expect(shown.textContent).toBe(title);
    expect(shown.childNodes).toHaveLength(1);
    expect(shown.firstChild!.nodeType).toBe(Node.TEXT_NODE);
    expect(all('a, img', host)).toEqual([]);
    expect(card.textContent).toContain(COPY.checks['llms-txt'].explanation);
    // No run yet: the check says it comes with a probe run.
    await render(createElement(AiReadiness, { audit: audit(), probes: null }));
    expect(check('llms-txt').dataset.status).toBe('not-checked');
    expect(check('llms-txt').textContent).toContain(COPY.notRun);
    expect(one('[data-testid="ai-llms-title"]')).toBeNull();
  });

  test('overview-tile-links-to-visibility', async () => {
    const onOpenPanel = vi.fn();
    fake.probes = probes();
    await render(createElement(Overview, { audit: audit(), tab: TAB, onOpenPanel }));
    const tile = one('[data-testid="ai-readiness-tile"]')!;
    const expected = aiTileView(audit(), probes());
    expect(expected.state).toBe('full');
    expect(one('[data-testid="ai-readiness-score"]', tile)!.textContent).toBe(expected.value);
    expect(one('[data-testid="ai-readiness-basis"]', tile)!.textContent).toBe(expected.basis);
    // The health score keeps its own test ids; the tile's are its own.
    expect(all('[data-testid="seo-score"]')).toHaveLength(1);
    expect(tile.contains(one('[data-testid="seo-score"]'))).toBe(false);
    const open = one('[data-testid="ai-readiness-open"]', tile) as HTMLButtonElement;
    expect(open.tagName).toBe('BUTTON');
    expect(open.textContent).toBe(COPY.openLabel);
    await act(async () => open.click());
    expect(onOpenPanel).toHaveBeenCalledWith('visibility');
    // Without a run the tile is partial, like the panel.
    fake.probes = null;
    await render(createElement(Overview, { audit: audit(), tab: TAB, onOpenPanel }));
    expect(one('[data-testid="ai-readiness-tile"] [data-testid="ai-readiness-basis"]')!.textContent).toBe('Based on 3 of 4 checks');
    // The palette's "Open AI readiness" opens the same panel.
    const [action] = aiReadinessPaletteSources();
    const chrome = { openPanel: vi.fn(), setSidebarOpen: vi.fn() };
    expect(typeof action === 'function' ? null : action!.label).toBe(COPY.openLabel);
    if (typeof action !== 'function') await action!.run({ state: null, tab: TAB, audit: null, sidebarOpen: false, chrome });
    expect(chrome.openPanel).toHaveBeenCalledWith('visibility', { focus: true });
  });
});
