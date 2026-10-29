// @vitest-environment jsdom
// Spec: specs/intent-classifier.spec.ts (IntentAnswer)
// Acceptance: specs/serp-panels.feature.md (Visibility panel view model, query-intent-answer-belongs-to-its-query)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { IntentAnswer } from '@app/specs/intent-classifier.spec';

const pending: Array<(answer: IntentAnswer) => void> = [];
vi.mock('../hooks/useSerp', () => ({
  serpActions: { classify: () => new Promise<IntentAnswer>((resolve) => pending.push(resolve)) },
  useIntentState: () => ['ready', () => {}],
  useProbes: () => null,
}));

const { QueryIntent } = await import('../components/seo/Visibility');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const ready = (label: 'informational' | 'transactional'): IntentAnswer => ({
  state: 'ready',
  result: {
    label,
    confidence: 0.9,
    scores: { informational: 0, navigational: 0, commercial: 0, transactional: 0, [label]: 0.9 },
    model: 'fake',
  },
});

const byTestId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

async function ask(query: string) {
  const input = byTestId('visibility-query-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    (byTestId('visibility-classify') as HTMLButtonElement).click();
  });
}

async function answer(index: number, value: IntentAnswer) {
  await act(async () => {
    pending[index]!(value);
  });
}

beforeEach(() => {
  pending.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(QueryIntent)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test('query-intent-answer-belongs-to-its-query', async () => {
  await ask('what is frost');
  await answer(0, ready('informational'));
  expect(byTestId('visibility-intent-result')?.getAttribute('data-state')).toBe('ready');
  expect(byTestId('visibility-intent-result')?.textContent).toContain('what is frost');

  // Another query: the first answer is gone at once, not shown beside the new query.
  await ask('buy frost boots');
  expect(byTestId('visibility-intent-result')).toBeNull();
  expect(host.textContent).not.toContain('what is frost');

  // A third query, then the second answers late: dropped.
  await ask('frost forecast');
  await answer(1, ready('transactional'));
  expect(byTestId('visibility-intent-result')).toBeNull();
  await answer(2, ready('informational'));
  expect(byTestId('visibility-intent-result')?.textContent).toContain('frost forecast');
});
