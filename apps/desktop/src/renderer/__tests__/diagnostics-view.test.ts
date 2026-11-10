// @vitest-environment jsdom
// Spec: specs/diagnostics.spec.ts (DIAGNOSTICS_TEXT), specs/whats-new.schema.ts (DiagnosticsReport: type only)
// Acceptance: specs/diagnostics.feature.md (Save… writes the reviewed report; Esc closes the sheet)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { DIAGNOSTICS_TEXT, type DiagnosticsResult } from '@app/specs/diagnostics.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const never = () => new Promise<never>(() => undefined);
let answerSave: (result: DiagnosticsResult) => void = () => undefined;
const saveDiagnostics = vi.fn(
  () =>
    new Promise<DiagnosticsResult>((resolve) => {
      answerSave = resolve;
    }),
);
vi.mock('../ipc', () => ({
  ipc: {
    help: {
      diagnostics: { mutate: async () => ({ reportId: '00000000-0000-4000-8000-000000000001', text: 'frost diagnostics' }) },
      saveDiagnostics: { mutate: () => saveDiagnostics() },
      watch: { query: never },
    },
    gsc: { watch: { query: never } },
    account: { watch: { query: never }, settingsWatch: { query: never } },
  },
  actions: { focusPage: async () => false, listProjects: async () => [] },
}));

const { DiagnosticsSheet } = await import('../components/DiagnosticsView');
const { requestHelpSheet } = await import('../help-palette');

const roots: Root[] = [];
const host = document.createElement('div');
document.body.append(host);
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const sheet = () => host.querySelector('[data-testid="diagnostics-view"]');
const saveButton = () => host.querySelector<HTMLButtonElement>('[data-testid="diagnostics-save"]')!;

test('diagnostics-save-keeps-focus-while-saving', async () => {
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(createElement(DiagnosticsSheet, { tab: { id: 1, documentSeq: 1 } as never, historySeq: undefined, onOpen: () => undefined })));
  act(() => void requestHelpSheet('diagnostics'));
  await act(async () => undefined);
  expect(sheet()).not.toBeNull();
  expect(saveButton().disabled).toBe(false);

  // Save… with the keyboard: the button stays focusable (never `disabled`, which would drop focus to
  // the body, out of the sheet's Esc), says it is busy, and a second press does not save again.
  saveButton().focus();
  act(() => saveButton().click());
  expect(saveButton().textContent).toBe(DIAGNOSTICS_TEXT.saving);
  expect(saveButton().disabled).toBe(false);
  expect(saveButton().getAttribute('aria-disabled')).toBe('true');
  expect(document.activeElement).toBe(saveButton());
  act(() => saveButton().click());
  expect(saveDiagnostics).toHaveBeenCalledOnce();

  await act(async () => answerSave('saved'));
  expect(saveButton().hasAttribute('aria-disabled')).toBe(false);
  expect(host.querySelector('[data-testid="diagnostics-note"]')!.textContent).toBe(DIAGNOSTICS_TEXT.notes.saved);
  expect(document.activeElement).toBe(saveButton());

  // Esc from where focus stayed closes the sheet.
  act(() => void saveButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(sheet()).toBeNull();
});
