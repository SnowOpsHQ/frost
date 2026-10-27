// Spec: specs/devtools.spec.ts (DEVTOOLS_TABS, DEVTOOLS_TOGGLE_SHORTCUT), specs/command-palette.spec.ts (Registration API)
// Acceptance: specs/devtools.feature.md (devtools-palette-actions)
import { describe, expect, test, vi } from 'vitest';
import { DEVTOOLS_TABS, DEVTOOLS_TOGGLE_SHORTCUT } from '@app/specs/devtools.spec';
import { devtoolsPaletteSources, onDevtoolsRequest, requestDevtools, type DevtoolsRequest } from '../devtools-palette';
import { createPaletteRegistry, type PaletteAction, type PaletteContext } from '../palette/registry';

const ctx: PaletteContext = { state: null, tab: undefined, audit: null, sidebarOpen: false, chrome: { openPanel: vi.fn(), setSidebarOpen: vi.fn() } };

describe('devtools palette actions', () => {
  test('devtools-palette-actions', async () => {
    const request = vi.fn((_r: DevtoolsRequest) => undefined);
    const registry = createPaletteRegistry();
    registry.register(...devtoolsPaletteSources(request));
    const actions = registry.resolve(ctx);
    expect(actions.map((a) => a.id)).toEqual(['devtools.toggle', ...DEVTOOLS_TABS.map((t) => `devtools.show-${t.id}`)]);
    const toggle = actions[0] as PaletteAction;
    expect(toggle).toMatchObject({ label: 'Toggle SEO devtools', group: 'browser', shortcut: DEVTOOLS_TOGGLE_SHORTCUT });
    await toggle.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'toggle' });
    const consoleAction = actions.find((a) => a.id === 'devtools.show-console')!;
    expect(consoleAction.label).toBe('Show devtools: Console');
    expect(consoleAction.focus).toBe('handler');
    await consoleAction.run(ctx);
    expect(request).toHaveBeenLastCalledWith({ kind: 'show', tab: 'console' });
    // The default sends to every listening drawer.
    const heard = vi.fn();
    const stop = onDevtoolsRequest(heard);
    requestDevtools({ kind: 'show', tab: 'storage' });
    expect(heard).toHaveBeenCalledExactlyOnceWith({ kind: 'show', tab: 'storage' });
    stop();
    requestDevtools({ kind: 'toggle' });
    expect(heard).toHaveBeenCalledOnce();
  });
});
