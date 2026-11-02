// @vitest-environment jsdom
// Spec: specs/page-type.spec.ts (PAGE_TYPE_LABELS, PAGE_TYPE_SIGNAL_LABELS, PAGE_TYPE_CONFIDENCE_LABELS, PAGE_TYPE_COPY),
// specs/intent-classifier.spec.ts (IntentState, IntentAnswer)
// Acceptance: specs/page-type.feature.md (Overview "Page" card), specs/seo-sidebar.feature.md (Overview, "Page" card)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import type { IntentAnswer, IntentState } from '@app/specs/intent-classifier.spec';
import { PAGE_TYPE_CONFIDENCE_LABELS, PAGE_TYPE_COPY, PAGE_TYPE_LABELS, PAGE_TYPE_SIGNAL_LABELS } from '@app/specs/page-type.spec';
import { audit, PAGE } from './ai-readiness-fixtures';

const fake = vi.hoisted(() => ({
  target: '',
  intentState: 'ready' as IntentState,
  classify: [] as string[],
  answer: null as IntentAnswer | null,
  notes: [] as string[],
}));
vi.mock('../hooks/useSerp', () => ({
  serpActions: {
    classify: (query: string) => {
      fake.classify.push(query);
      return Promise.resolve(fake.answer);
    },
  },
  useIntentState: () => [fake.intentState, () => {}],
  useProbes: () => null,
}));
vi.mock('../ipc', () => ({
  actions: {},
  ipc: {
    content: {
      getNotes: {
        query: ({ url }: { url: string }) => {
          fake.notes.push(url);
          return Promise.resolve({ query: fake.target, variants: [], generation: 0 });
        },
      },
    },
  },
}));

const { Overview } = await import('../components/seo/Overview');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const TAB = { id: 1, url: PAGE, title: 'Green tea', loading: false, error: null, crashed: false } as TabState;
const READY: IntentAnswer = { state: 'ready', result: { label: 'commercial', confidence: 0.82, scores: { informational: 0.1, navigational: 0.02, commercial: 0.82, transactional: 0.06 }, model: 'fake' } };

beforeEach(() => {
  Object.assign(fake, { target: '', intentState: 'ready', classify: [], answer: READY, notes: [] });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const one = (selector: string) => host.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
async function show(changes: Parameters<typeof audit>[0] = {}) {
  await act(async () => root.render(createElement(Overview, { audit: audit(changes), tab: TAB, onOpenPanel: () => {} })));
  // The stored target answers, then the classifier.
  await act(async () => undefined);
}

describe('Overview "Page" card', () => {
  test('shows-type-and-signals', async () => {
    await show();
    const card = one('[data-testid="page-card"]')!;
    expect(card.querySelector('.seo-section-title')!.textContent).toBe(PAGE_TYPE_COPY.title);
    expect(one('[data-testid="page-type"]')!.textContent).toBe(PAGE_TYPE_LABELS.article);
    expect(one('[data-testid="page-type"]')!.dataset.type).toBe('article');
    const confidence = one('[data-testid="page-type-confidence"]')!;
    expect(confidence.dataset.confidence).toBe('high');
    expect(confidence.textContent).toBe(PAGE_TYPE_CONFIDENCE_LABELS.high);
    const signals = all('[data-testid="page-type-signal"]');
    expect(signals.map((s) => s.dataset.signal)).toEqual(['schema-type', 'og-type']);
    expect(signals[0]!.textContent).toContain(PAGE_TYPE_SIGNAL_LABELS['schema-type']);
    expect(signals[0]!.textContent).toContain('BlogPosting');
    expect(signals[1]!.textContent).toContain(PAGE_TYPE_SIGNAL_LABELS['og-type']);
    expect(one('[data-testid="page-type-note"]')).toBeNull();
    expect(card.textContent).toContain(PAGE_TYPE_COPY.note);

    // A conflict: frost says it is unsure, and which signal disagrees.
    await show({
      pageType: {
        type: 'product',
        confidence: 'unsure',
        signals: [
          { signal: 'schema-type', type: 'product', evidence: 'Product' },
          { signal: 'og-type', type: 'article', evidence: 'article' },
        ],
      },
    });
    expect(one('[data-testid="page-type"]')!.textContent).toBe(PAGE_TYPE_LABELS.product);
    expect(one('[data-testid="page-type-confidence"]')!.dataset.confidence).toBe('unsure');
    expect(one('[data-testid="page-type-note"]')!.textContent).toBe(PAGE_TYPE_COPY.conflict);
    expect(all('[data-testid="page-type-signal"]').map((s) => s.dataset.agrees)).toEqual(['true', 'false']);

    // No signal at all.
    await show({ pageType: { type: 'other', confidence: 'unsure', signals: [] } });
    expect(one('[data-testid="page-type"]')!.textContent).toBe(PAGE_TYPE_LABELS.other);
    expect(one('[data-testid="page-type-note"]')!.textContent).toBe(PAGE_TYPE_COPY.noSignals);
  });

  test('intent-only-with-target-and-enabled-intent', async () => {
    fake.target = '  green tea  ';
    fake.intentState = 'ready';
    await show();
    // The page's own notes, then the stored target query (as the query box sends it), once.
    expect(fake.notes).toContain(PAGE);
    expect(fake.classify).toEqual(['green tea']);
    const intent = one('[data-testid="page-intent"]')!;
    expect(intent.dataset.state).toBe('ready');
    expect(one('[data-testid="page-intent-label"]')!.textContent).toBe('Commercial');
    expect(intent.textContent).toContain('82%');
    expect(intent.textContent).toContain('green tea');
    expect(intent.textContent).toContain(PAGE_TYPE_COPY.intentLabel);
  });

  test('no-intent-otherwise', async () => {
    // No target query: nothing is classified, and the card says where to set one.
    fake.target = '';
    fake.intentState = 'ready';
    await show();
    expect(fake.classify).toEqual([]);
    expect(one('[data-testid="page-intent-label"]')).toBeNull();
    expect(one('[data-testid="page-intent"]')!.textContent).toContain(PAGE_TYPE_COPY.noTarget);
    act(() => root.unmount());

    // A target, but on-device intent is not ready: never classified (nothing downloads from here).
    for (const state of ['model-missing', 'downloading', 'unavailable'] as const) {
      root = createRoot(host);
      fake.target = 'green tea';
      fake.intentState = state;
      fake.classify = [];
      await show();
      expect(fake.classify, state).toEqual([]);
      expect(one('[data-testid="page-intent-label"]'), state).toBeNull();
      act(() => root.unmount());
    }
    root = createRoot(host);
    fake.intentState = 'model-missing';
    await show();
    expect(one('[data-testid="page-intent"]')!.textContent).toContain(PAGE_TYPE_COPY.intentOff);
  });
});
