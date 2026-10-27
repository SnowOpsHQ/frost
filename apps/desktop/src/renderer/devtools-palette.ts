import { DEVTOOLS_TABS, type DevtoolsTabId } from '@app/specs/devtools.spec';
import type { PaletteSource } from './palette/registry';

// The SEO devtools drawer in the command palette (spec `devtools.feature.md`, Decisions; the
// registration API of `command-palette.spec.ts`): "Toggle SEO devtools" and one "Show devtools: …"
// per tab. The drawer owns its open state, so the actions only ask it (a request it listens for);
// registered from `components/devtools/DevtoolsDrawer.tsx`. Pure, so the actions are unit tested.

export type DevtoolsRequest = { readonly kind: 'toggle' } | { readonly kind: 'show'; readonly tab: DevtoolsTabId };

const listeners = new Set<(request: DevtoolsRequest) => void>();

/** Asks the drawer (every mounted one) to toggle, or to open on a tab. */
export function requestDevtools(request: DevtoolsRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Calls `listener` on each request; answers a function that stops. */
export function onDevtoolsRequest(listener: (request: DevtoolsRequest) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const KEYWORDS = ['devtools', 'developer', 'inspect', 'drawer', 'debug'];

/** The palette's devtools actions, sending `request`. */
export function devtoolsPaletteSources(request: (r: DevtoolsRequest) => void = requestDevtools): PaletteSource[] {
  return [
    {
      id: 'devtools.toggle',
      label: 'Toggle SEO devtools',
      group: 'browser',
      keywords: [...KEYWORDS, 'network', 'console', 'cookies', 'redirects'],
      icon: 'code',
      shortcut: 'Mod+Shift+D',
      run: () => request({ kind: 'toggle' }),
    },
    ...DEVTOOLS_TABS.map(
      (tab): PaletteSource => ({
        id: `devtools.show-${tab.id}`,
        label: `Show devtools: ${tab.label}`,
        group: 'browser',
        keywords: [...KEYWORDS, tab.label.toLowerCase()],
        icon: 'code',
        focus: 'handler',
        run: () => request({ kind: 'show', tab: tab.id }),
      }),
    ),
  ];
}
