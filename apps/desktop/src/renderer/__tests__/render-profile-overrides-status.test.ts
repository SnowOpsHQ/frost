// @vitest-environment jsdom
// Spec: specs/browser.spec.ts (TabState.overridesStatus), specs/render-profile.spec.ts (TAB_OVERRIDES_FAILED_NOTE,
// TAB_OVERRIDES_NOT_APPLIED)
// Acceptance: specs/render-profile.feature.md (Tab overrides: Visible state; whole-branch review)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TabState } from '@app/specs/browser.spec';
import { DEFAULT_TAB_OVERRIDES, TAB_OVERRIDES_FAILED_NOTE } from '@app/specs/render-profile.spec';

vi.mock('../ipc', () => ({ actions: { setTabOverrides: vi.fn(async () => true), setRenderProfile: vi.fn(async () => true), clearRenderProfile: vi.fn(async () => true), reload: vi.fn() } }));

const { RenderProfileBar, RenderProfileToggle, StatusOverridesChip } = await import('../components/RenderProfile');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tab(changes: Partial<TabState> = {}): TabState {
  return { id: 4, url: 'https://www.example.com/a', title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', highlightPhrase: null, renderProfile: null, tabOverrides: { ...DEFAULT_TAB_OVERRIDES, cookiesDisabled: true }, loadedUnderOverrides: true, overridesRevision: 1, overridesStatus: 'active', ...changes };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(element: ReturnType<typeof createElement>): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

const byTestId = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

describe('tab overrides status in the chrome', () => {
  test('overrides-failure-shown-in-bar-chip-and-toggle-without-a-profile', () => {
    const failed = tab({ overridesStatus: 'failed' });
    const chip = byTestId(render(createElement(StatusOverridesChip, { tab: failed })), 'status-tab-overrides')!;
    expect(chip.getAttribute('data-status')).toBe('failed');
    expect(chip.textContent).toBe('Cookies off · not applied');
    expect(chip.getAttribute('title')).toContain(TAB_OVERRIDES_FAILED_NOTE);
    act(() => root!.render(createElement(RenderProfileToggle, { tab: failed, open: false, onToggle: () => undefined })));
    const toggle = byTestId(host!, 'render-profile-toggle')!;
    expect(toggle.getAttribute('data-overrides-status')).toBe('failed');
    expect(toggle.getAttribute('aria-label')).toBe('Cookies off · not applied');
    act(() => root!.render(createElement(RenderProfileBar, { tab: failed, onClose: () => undefined })));
    expect(byTestId(host!, 'render-overrides-failed')?.textContent).toBe(TAB_OVERRIDES_FAILED_NOTE);
    // Applied (or still applying): no note, no suffix.
    act(() => root!.render(createElement(RenderProfileBar, { tab: tab({ overridesStatus: 'applying' }), onClose: () => undefined })));
    expect(byTestId(host!, 'render-overrides-failed')).toBeNull();
    act(() => root!.render(createElement(StatusOverridesChip, { tab: tab() })));
    expect(byTestId(host!, 'status-tab-overrides')?.textContent).toBe('Cookies off');
  });
});
