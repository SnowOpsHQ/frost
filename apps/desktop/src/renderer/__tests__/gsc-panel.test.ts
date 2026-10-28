// @vitest-environment jsdom
// Spec: specs/gsc-panel.spec.ts (GSC_PANEL_COPY, GSC_READ_DEBOUNCE_MS), specs/gsc.spec.ts (GscStatus),
// specs/account-state.schema.ts (AccountState)
// Acceptance: specs/gsc-panel.feature.md (Panel)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountState } from '@app/specs/account-state.schema';
import type { TabState } from '@app/specs/browser.spec';
import { GSC_READ_DEBOUNCE_MS } from '@app/specs/gsc-panel.spec';
import type { GscStatus } from '@app/specs/gsc.spec';

/** What the faked `account.watch` and `gsc.watch` answer first (later polls wait forever), and the reads made. */
const fake = vi.hoisted(() => ({
  /** Each mount's fresh stores answer once per generation. */
  generation: 0,
  account: null as unknown,
  gsc: null as unknown,
  performance: [] as unknown[],
  topQueries: [] as unknown[],
}));
vi.mock('../ipc', () => {
  const never = () => new Promise<never>(() => undefined);
  const once = (value: () => unknown) => {
    let answered = -1;
    return () => {
      if (answered === fake.generation) return never();
      answered = fake.generation;
      return Promise.resolve(value());
    };
  };
  return {
    actions: {},
    ipc: {
      account: { watch: { query: once(() => fake.account) }, settingsWatch: { query: never } },
      gsc: {
        watch: { query: once(() => fake.gsc) },
        performance: { query: (input: unknown) => (fake.performance.push(input), never()) },
        topQueries: { query: (input: unknown) => (fake.topQueries.push(input), never()) },
      },
    },
  };
});

const URL_A = 'https://www.example.com/a';
const TAB = { id: 1, url: URL_A, title: 'A', loading: false, canGoBack: false, canGoForward: false, error: null, crashed: false, unresponsive: false, permissionPrompt: null, fullscreen: null, zoom: 1, auditVersion: 1, documentSeq: 1, highlight: 'off', renderProfile: null } as TabState;

const gsc = (changes: Partial<GscStatus>): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });
const none = { plan: 'free', features: [], status: 'none', expiresAtMs: null, graceEndsAtMs: null } as const;
const signedOut = { status: 'signed-out', user: null, entitlements: none, keychain: 'persistent', requestId: null, fingerprint: null, error: null, version: 1 } as unknown as AccountState;
const signedIn = (plan: 'free' | 'pro'): AccountState =>
  ({
    ...signedOut,
    status: 'signed-in',
    user: { email: 'dana@example.com', name: null },
    entitlements: { plan, features: plan === 'pro' ? ['ai-agent', 'search-console', 'sync'] : [], status: 'active', expiresAtMs: 1, graceEndsAtMs: 1 + 7 * 86_400_000 },
  }) as unknown as AccountState;

let root: Root;
let host: HTMLDivElement;

/** Mounts the panel with fresh stores (a fresh module graph) and lets the watches and the debounce pass. */
async function mount(account: AccountState, status: GscStatus): Promise<string | null> {
  fake.account = account;
  fake.gsc = status;
  fake.generation += 1;
  vi.resetModules();
  const { GscPanel } = await import('../components/seo/GscPanel');
  await act(async () => {
    root.render(createElement(GscPanel, { tab: TAB }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GSC_READ_DEBOUNCE_MS * 4);
  });
  return host.querySelector('[data-testid="gsc-panel"]')?.getAttribute('data-state') ?? null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fake.performance.length = 0;
  fake.topQueries.length = 0;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('GscPanel', () => {
  test('gsc-panel-not-entitled-reads-nothing', async () => {
    expect(await mount(signedOut, gsc({ entitled: false, connected: false }))).toBe('signed-out');
    expect(fake.performance).toEqual([]);
    expect(fake.topQueries).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);

    expect(await mount(signedIn('free'), gsc({ entitled: false, connected: false }))).toBe('needs-pro');
    expect(fake.performance).toEqual([]);
    expect(fake.topQueries).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);

    // Pro and connected: one read of each.
    expect(await mount(signedIn('pro'), gsc({}))).toBe('loading');
    expect(fake.performance).toEqual([{ url: URL_A, scope: 'page', days: 28 }]);
    expect(fake.topQueries).toEqual([{ url: URL_A, scope: 'page', days: 28 }]);
  });
});
