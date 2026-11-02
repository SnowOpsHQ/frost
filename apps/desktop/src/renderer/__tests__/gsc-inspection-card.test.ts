// @vitest-environment jsdom
// Spec: specs/gsc-inspection.spec.ts (GSC_INSPECTION_COPY, GSC_OPEN_LINK_RESULTS), specs/gsc-inspection.schema.ts (GscInspectInput,
// GscOpenInspectionLinkInput: types only), specs/gsc.spec.ts (GscStatus)
// Acceptance: specs/gsc-inspection.feature.md (Card: only on a click, the link stays in main)
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { GscInspectionAnswer } from '@app/specs/gsc-inspection.schema';
import { GSC_INSPECTION_COPY } from '@app/specs/gsc-inspection.spec';
import type { GscStatus } from '@app/specs/gsc.spec';

const LINK = 'https://search.google.com/search-console/inspect?resource_id=https%3A%2F%2Fwww.example.com%2F&id=secret-ish';

/** The faked IPC: `gsc.watch` answers once per mount, `gsc.inspect` and `gsc.openInspectionLink` record and answer. */
const fake = vi.hoisted(() => ({
  generation: 0,
  gsc: null as unknown,
  calls: [] as { path: string; input: unknown }[],
  answer: null as unknown,
  openResult: 'opened' as string,
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
  const record = (path: string, answer: () => unknown) => (input: unknown) => (fake.calls.push({ path, input }), Promise.resolve(answer()));
  const recordQuery = (path: string) => (input: unknown) => (fake.calls.push({ path, input }), never());
  return {
    actions: {},
    ipc: {
      account: { watch: { query: never }, settingsWatch: { query: never } },
      gsc: {
        watch: { query: once(() => fake.gsc) },
        status: { query: recordQuery('gsc.status') },
        performance: { query: recordQuery('gsc.performance') },
        topQueries: { query: recordQuery('gsc.topQueries') },
        countries: { query: recordQuery('gsc.countries') },
        properties: { query: recordQuery('gsc.properties') },
        inspect: { mutate: record('gsc.inspect', () => fake.answer) },
        openInspectionLink: { mutate: record('gsc.openInspectionLink', () => fake.openResult) },
      },
    },
  };
});

const PAGE = 'https://www.example.com/a';
const gsc = (changes: Partial<GscStatus> = {}): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });
const OK: GscInspectionAnswer = {
  status: 'ok',
  property: { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' },
  url: PAGE,
  inspectedAt: new Date().toISOString(),
  index: {
    verdict: { value: 'PASS' },
    coverageState: 'Submitted and indexed',
    robotsTxtState: { value: 'ALLOWED' },
    indexingState: { value: 'INDEXING_ALLOWED' },
    pageFetchState: { value: 'SUCCESSFUL' },
    lastCrawlTime: '2026-10-30T14:05:00.000Z',
    crawledAs: { value: 'MOBILE' },
    googleCanonical: PAGE,
    userCanonical: PAGE,
  },
  richResults: { verdict: { value: 'PASS' }, types: [{ type: 'Breadcrumbs', items: [{ name: 'Trail', issues: [] }] }] },
  link: LINK,
};

let root: Root;
let host: HTMLDivElement;

/** Mounts both cards for `url` (fresh stores: a fresh module graph) and lets `gsc.watch` answer. */
async function mount(status: GscStatus, url = `${PAGE}#section`): Promise<void> {
  fake.gsc = status;
  fake.generation += 1;
  vi.resetModules();
  const { GscInspectionCard } = await import('../components/seo/GscInspectionCard');
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(GscInspectionCard, { kind: 'index', url, auditCanonical: PAGE }), createElement(GscInspectionCard, { kind: 'rich', url })));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="gsc-inspection"]')];
const button = (action: string) => host.querySelector<HTMLButtonElement>(`[data-testid="gsc-inspection-action"][data-action="${action}"]`);
const inspectCalls = () => fake.calls.filter((call) => call.path === 'gsc.inspect');

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fake.calls.length = 0;
  fake.answer = OK;
  fake.openResult = 'opened';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('Search Console inspection card', () => {
  test('inspect-only-on-click', async () => {
    // Unconfigured: hidden, nothing sent.
    await mount(gsc({ configured: false, connected: false }));
    expect(cards()).toEqual([]);
    expect(fake.calls).toEqual([]);

    // Not connected: Connect in Settings, nothing sent.
    await mount(gsc({ connected: false }));
    expect(cards().map((card) => card.dataset.state)).toEqual(['not-connected', 'not-connected']);
    expect(button('open-gsc-settings')?.textContent).toBe('Connect in Settings');
    expect(fake.calls).toEqual([]);

    // Connected: mounting both cards, and waiting, sends nothing.
    await mount(gsc());
    expect(cards().map((card) => card.dataset.state)).toEqual(['idle', 'idle']);
    expect(cards().map((card) => card.querySelector('h3')?.textContent)).toEqual([GSC_INSPECTION_COPY.titles.index, GSC_INSPECTION_COPY.titles.rich]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fake.calls).toEqual([]);

    // One click: one request for the page (without its fragment), and both cards show the answer.
    await click(button('inspect'));
    expect(inspectCalls()).toEqual([{ path: 'gsc.inspect', input: { url: PAGE } }]);
    expect(cards().map((card) => card.dataset.state)).toEqual(['ok', 'ok']);
    expect(host.querySelector('[data-testid="gsc-inspection-coverage"]')?.textContent).toBe('Submitted and indexed');
    expect(host.querySelector('[data-testid="gsc-inspection-rich-type"]')?.textContent).toBe('Breadcrumbs');
    expect(fake.calls.filter((call) => call.path !== 'gsc.inspect')).toEqual([]);
  }, 30_000);

  test('inspect-again-sends-fresh', async () => {
    await mount(gsc());
    await click(button('inspect'));
    expect(inspectCalls()).toEqual([{ path: 'gsc.inspect', input: { url: PAGE } }]);
    // Each card offers Inspect again; either asks once, past main's cache.
    const again = host.querySelectorAll<HTMLButtonElement>('[data-testid="gsc-inspection-action"][data-action="inspect-again"]');
    expect(again).toHaveLength(2);
    expect(again[0]!.textContent).toBe('Inspect again');
    await click(again[1]!);
    expect(inspectCalls()).toEqual([
      { path: 'gsc.inspect', input: { url: PAGE } },
      { path: 'gsc.inspect', input: { url: PAGE, fresh: true } },
    ]);
    // A failure offers Try again, which asks with the page only.
    fake.answer = { status: 'unavailable', reason: 'network' };
    await click(button('inspect-again'));
    expect(cards().map((card) => card.dataset.state)).toEqual(['network', 'network']);
    fake.answer = OK;
    await click(button('retry'));
    expect(inspectCalls().at(-1)).toEqual({ path: 'gsc.inspect', input: { url: PAGE } });
    expect(cards().map((card) => card.dataset.state)).toEqual(['ok', 'ok']);
  }, 30_000);

  test('open-in-search-console-uses-main', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await mount(gsc());
    // Before an answer there is nothing to open.
    expect(host.querySelector('[data-testid="gsc-inspection-open"]')).toBeNull();
    await click(button('inspect'));
    // The link never reaches the DOM: no href, no text, no attribute.
    expect(host.innerHTML).not.toContain('search.google.com');
    expect(host.querySelector('a, [href]')).toBeNull();
    const openButton = host.querySelector<HTMLButtonElement>('[data-testid="gsc-inspection-open"]');
    expect(openButton?.tagName).toBe('BUTTON');
    expect(openButton?.textContent).toBe(GSC_INSPECTION_COPY.text.openInSearchConsole);

    await click(openButton);
    // Main is asked with the page (never the link), and the chrome opens nothing itself.
    expect(fake.calls.filter((call) => call.path === 'gsc.openInspectionLink')).toEqual([{ path: 'gsc.openInspectionLink', input: { url: PAGE } }]);
    expect(JSON.stringify(fake.calls)).not.toContain('search.google.com');
    expect(open).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="gsc-inspection-flash"]')?.textContent).toBe(GSC_INSPECTION_COPY.openResults.opened);

    // Main's other answers are status lines too.
    fake.openResult = 'needs-gesture';
    await click(host.querySelector<HTMLButtonElement>('[data-testid="gsc-inspection-open"]'));
    expect(host.querySelector('[data-testid="gsc-inspection-flash"]')?.textContent).toBe(GSC_INSPECTION_COPY.openResults['needs-gesture']);

    // An answer without a link offers no Open.
    fake.answer = { ...OK, link: null };
    await click(button('inspect-again'));
    expect(host.querySelector('[data-testid="gsc-inspection-open"]')).toBeNull();
    open.mockRestore();
  }, 30_000);
});
