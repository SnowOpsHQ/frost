// @vitest-environment jsdom
// Spec: specs/seo-sidebar.spec.ts (SIDEBAR_PANEL_WIDTH_RANGE, SIDEBAR_WIDTH_STORAGE_KEY, SIDEBAR_PINS_STORAGE_KEY,
// ALWAYS_PINNED_PANELS, PAGE_MIN_WIDTH, SIDEBAR_RAIL_WIDTH), specs/agent-panel.spec.ts (AGENT_PANEL_WIDTH_RANGE,
// AGENT_PANEL_WIDTH_STORAGE_KEY, shrink order)
// Acceptance: specs/seo-sidebar.feature.md (Resize and pins), specs/agent-panel.feature.md (Resize)
import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test } from 'vitest';
import { AGENT_PANEL_WIDTH, AGENT_PANEL_WIDTH_RANGE, AGENT_PANEL_WIDTH_STORAGE_KEY, AGENT_RAIL_WIDTH } from '@app/specs/agent-panel.spec';
import { ALWAYS_PINNED_PANELS, PAGE_MIN_WIDTH, SEO_PANELS, SIDEBAR_PANEL_WIDTH, SIDEBAR_PANEL_WIDTH_RANGE, SIDEBAR_RAIL_WIDTH, SIDEBAR_WIDTH_STORAGE_KEY, type SeoPanelId } from '@app/specs/seo-sidebar.spec';
import {
  createWorkspaceLayout,
  keyboardResize,
  morePanels,
  paneMax,
  paneWidths,
  railPanels,
  resizeTo,
  roomForPanes,
  togglePin,
  unpinnedFromStorage,
  unpinnedToStorage,
  widthFromStorage,
  worstStatus,
  usePaneLayout,
  type LayoutInput,
  type SeparatorProps,
} from '../sidebar-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = SIDEBAR_PANEL_WIDTH_RANGE;
const A = AGENT_PANEL_WIDTH_RANGE;
/** The row's fixed parts beside the page's minimum with the agent open (the SEO rail and two borders). */
const FIXED_OPEN = PAGE_MIN_WIDTH + SIDEBAR_RAIL_WIDTH + 2;

const layout = (workspace: number, sidebar: [boolean, number], agent: [boolean, number]): LayoutInput => ({
  workspace,
  sidebar: { open: sidebar[0], preferred: sidebar[1] },
  agent: { open: agent[0], preferred: agent[1] },
});

describe('resizable panes', () => {
  test('width-clamped-to-page-min', () => {
    // The defaults are in range.
    expect(SIDEBAR_PANEL_WIDTH).toBeGreaterThanOrEqual(S.min);
    expect(SIDEBAR_PANEL_WIDTH).toBeLessThanOrEqual(S.max);
    expect(AGENT_PANEL_WIDTH).toBeGreaterThanOrEqual(A.min);
    expect(AGENT_PANEL_WIDTH).toBeLessThanOrEqual(A.max);
    // Stored widths: in range as they are, out of range clamped, unreadable the default.
    expect(widthFromStorage('420', 'sidebar')).toBe(420);
    expect(widthFromStorage('10', 'sidebar')).toBe(S.min);
    expect(widthFromStorage('99999', 'agent')).toBe(A.max);
    for (const bad of [null, '', 'wide', '-5', '3e2', '400px', '1.5']) {
      expect(widthFromStorage(bad, 'sidebar'), String(bad)).toBe(SIDEBAR_PANEL_WIDTH);
      expect(widthFromStorage(bad, 'agent'), String(bad)).toBe(AGENT_PANEL_WIDTH);
    }
    // A wide row: the range's maximum is the limit.
    const wide = layout(2_000, [true, 360], [false, 380]);
    expect(resizeTo('sidebar', 5_000, wide)).toBe(S.max);
    expect(resizeTo('sidebar', 10, wide)).toBe(S.min);
    expect(resizeTo('sidebar', 451.6, wide)).toBe(452);
    expect(resizeTo('sidebar', Number.NaN, wide)).toBe(S.min);
    // A middling row with the agent open at 400: the sidebar may only take what leaves the page its minimum.
    const row = FIXED_OPEN + 400 + 450;
    const both = layout(row, [true, 360], [true, 400]);
    expect(paneMax('sidebar', both)).toBe(450);
    expect(resizeTo('sidebar', 520, both)).toBe(450);
    expect(paneWidths({ ...both, sidebar: { open: true, preferred: 450 } })).toEqual({ sidebar: 450, agent: 400 });
    // The page keeps its minimum: the panes and fixed parts never take more than the row.
    const set = resizeTo('sidebar', 520, both);
    expect(FIXED_OPEN + set + 400).toBeLessThanOrEqual(row);
    // The agent beside the open sidebar, and with the agent's own rail gone while it is open.
    expect(paneMax('agent', both)).toBe(row - FIXED_OPEN - 360);
    // Never under the range's minimum, however narrow the row.
    expect(paneMax('sidebar', layout(500, [true, 360], [true, 400]))).toBe(S.min);
    expect(paneMax('agent', layout(500, [true, 360], [true, 400]))).toBe(A.min);
    // The collapsed agent's rail counts against the room.
    expect(roomForPanes(layout(1_000, [true, 360], [false, 380]))).toBe(1_000 - PAGE_MIN_WIDTH - SIDEBAR_RAIL_WIDTH - 2 - AGENT_RAIL_WIDTH);
    // Unmeasured: the chosen widths, any maximum.
    expect(paneWidths(layout(0, [true, 500], [true, 600]))).toEqual({ sidebar: 500, agent: 600 });
    expect(paneMax('sidebar', layout(0, [true, 500], [true, 600]))).toBe(S.max);
  });

  test('narrow-window-shrinks-agent-pane-first', () => {
    // Room for both as chosen: nothing gives way.
    expect(paneWidths(layout(FIXED_OPEN + 400 + 480, [true, 400], [true, 480]))).toEqual({ sidebar: 400, agent: 480 });
    // 100 px short: the agent pane alone gives way.
    expect(paneWidths(layout(FIXED_OPEN + 400 + 380, [true, 400], [true, 480]))).toEqual({ sidebar: 400, agent: 380 });
    // Short by more than the agent can give: it stops at its minimum, then the sidebar gives way.
    expect(paneWidths(layout(FIXED_OPEN + 350 + A.min, [true, 400], [true, 480]))).toEqual({ sidebar: 350, agent: A.min });
    // Short by more than both can give: both at their minimums (CSS narrows them past that, as before).
    expect(paneWidths(layout(600, [true, 400], [true, 480]))).toEqual({ sidebar: S.min, agent: A.min });
    // The agent closed: its rail is in the row; only the sidebar gives way.
    expect(paneWidths(layout(FIXED_OPEN + AGENT_RAIL_WIDTH + 330, [true, 400], [false, 480]))).toEqual({ sidebar: 330, agent: 480 });
    // The sidebar closed: only the agent gives way.
    expect(paneWidths(layout(FIXED_OPEN + 350, [false, 400], [true, 480]))).toEqual({ sidebar: 400, agent: 350 });
    // The chosen widths are kept: widening the window gives them back.
    const store: Record<string, string> = { [SIDEBAR_WIDTH_STORAGE_KEY]: '400', [AGENT_PANEL_WIDTH_STORAGE_KEY]: '480' };
    const row = createWorkspaceLayout(
      (key) => store[key] ?? null,
      (key, value) => {
        store[key] = value;
      },
    );
    row.setOpen('sidebar', true);
    row.setOpen('agent', true);
    row.setWorkspace(FIXED_OPEN + 400 + 380);
    expect(row.snapshot().widths).toEqual({ sidebar: 400, agent: 380 });
    row.setWorkspace(2_000);
    expect(row.snapshot().widths).toEqual({ sidebar: 400, agent: 480 });
    expect(store[AGENT_PANEL_WIDTH_STORAGE_KEY]).toBe('480');
    // A resize is kept only when asked (a drag keeps its end).
    row.resize('agent', 500, false);
    expect(store[AGENT_PANEL_WIDTH_STORAGE_KEY]).toBe('480');
    row.persist('agent');
    expect(store[AGENT_PANEL_WIDTH_STORAGE_KEY]).toBe('500');
    expect(row.resize('sidebar', 9_000, true)).toBe(S.max);
    expect(store[SIDEBAR_WIDTH_STORAGE_KEY]).toBe(String(S.max));
  });

  test('keyboard-resize-steps', () => {
    // The sidebar's separator is on its right: Right / Up widen, Left / Down narrow.
    expect(keyboardResize('sidebar', 'ArrowRight', 360, S.max)).toBe(360 + S.keyboardStep);
    expect(keyboardResize('sidebar', 'ArrowUp', 360, S.max)).toBe(360 + S.keyboardStep);
    expect(keyboardResize('sidebar', 'ArrowLeft', 360, S.max)).toBe(360 - S.keyboardStep);
    expect(keyboardResize('sidebar', 'ArrowDown', 360, S.max)).toBe(360 - S.keyboardStep);
    // The agent's is on its left: Left widens it.
    expect(keyboardResize('agent', 'ArrowLeft', 380, A.max)).toBe(380 + A.keyboardStep);
    expect(keyboardResize('agent', 'ArrowRight', 380, A.max)).toBe(380 - A.keyboardStep);
    expect(keyboardResize('agent', 'ArrowUp', 380, A.max)).toBe(380 + A.keyboardStep);
    // Home / End: the ends, the window's limit as the top end.
    expect(keyboardResize('sidebar', 'Home', 400, S.max)).toBe(S.min);
    expect(keyboardResize('sidebar', 'End', 400, 450)).toBe(450);
    // Never past the range or the window's limit.
    expect(keyboardResize('sidebar', 'ArrowRight', 440, 450)).toBe(450);
    expect(keyboardResize('sidebar', 'ArrowLeft', S.min + 5, S.max)).toBe(S.min);
    expect(keyboardResize('agent', 'End', 400, 10)).toBe(A.min);
    // Other keys are not taken.
    for (const key of ['Enter', ' ', 'Tab', 'a', 'PageUp']) expect(keyboardResize('sidebar', key, 360, S.max)).toBeNull();
  });
});

describe('separator drag', () => {
  test('stuck-drag-ends', () => {
    const store: Record<string, string> = {};
    const row = createWorkspaceLayout(
      (key) => store[key] ?? null,
      (key, value) => {
        store[key] = value;
      },
    );
    row.setWorkspace(2_000);
    let separator: SeparatorProps | null = null;
    function Pane({ open }: { open: boolean }) {
      const ref = useRef<HTMLElement>(null);
      separator = usePaneLayout('sidebar', open, ref, row).separator;
      return createElement('aside', { ref });
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    const show = (open: boolean) => act(() => root.render(createElement(Pane, { open })));
    const width = () => row.snapshot().input.sidebar.preferred;
    const target = { setPointerCapture() {}, focus() {} };
    const pointer = (clientX: number, buttons = 1, button = 0) => ({ pointerId: 1, clientX, buttons, button, currentTarget: target, preventDefault() {} }) as never;
    const down = (x: number) => act(() => separator!.onPointerDown(pointer(x)));
    const move = (x: number, buttons = 1) => act(() => separator!.onPointerMove(pointer(x, buttons)));
    show(true);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH);

    // A move with the button up (its release went elsewhere) ends the drag, keeping its width.
    down(100);
    move(140);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 40);
    move(200, 0);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 40);
    expect(store[SIDEBAR_WIDTH_STORAGE_KEY]).toBe(String(SIDEBAR_PANEL_WIDTH + 40));
    move(220);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 40);

    // Losing the pointer capture ends it.
    down(100);
    move(90);
    act(() => separator!.onLostPointerCapture(pointer(90)));
    move(60);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 30);
    expect(store[SIDEBAR_WIDTH_STORAGE_KEY]).toBe(String(SIDEBAR_PANEL_WIDTH + 30));

    // The pane closing mid-drag ends it; reopened, a stray move changes nothing.
    down(100);
    move(110);
    show(false);
    expect(store[SIDEBAR_WIDTH_STORAGE_KEY]).toBe(String(SIDEBAR_PANEL_WIDTH + 40));
    show(true);
    move(300);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 40);

    // Unmounting mid-drag ends it too; only the main button starts one.
    down(100);
    move(80);
    act(() => root.unmount());
    expect(store[SIDEBAR_WIDTH_STORAGE_KEY]).toBe(String(SIDEBAR_PANEL_WIDTH + 20));
    const again = createRoot(document.createElement('div'));
    act(() => again.render(createElement(Pane, { open: true })));
    act(() => separator!.onPointerDown(pointer(100, 2, 2)));
    move(300, 2);
    expect(width()).toBe(SIDEBAR_PANEL_WIDTH + 20);
    act(() => again.unmount());
  });
});

describe('rail pins', () => {
  const ids = SEO_PANELS.map((p) => p.id);

  test('pins-persist-overview-stays', () => {
    expect(ALWAYS_PINNED_PANELS).toContain('overview');
    // Nothing stored, or unreadable: every panel pinned.
    for (const bad of [null, '', '{', '"links"', '{"links":1}', '[1,2]', 'x'.repeat(5_000)]) expect(unpinnedFromStorage(bad).size, String(bad)).toBe(0);
    // A round trip, in rail order; unknown ids and Overview dropped.
    const unpinned = unpinnedFromStorage(JSON.stringify(['schema', 'links', 'overview', 'nope', 'links']));
    expect([...unpinned].sort()).toEqual(['links', 'schema']);
    expect(unpinnedToStorage(unpinned)).toBe(JSON.stringify(['links', 'schema']));
    expect(unpinnedFromStorage(unpinnedToStorage(unpinned))).toEqual(unpinned);
    // Toggling moves a panel in and out; Overview never moves.
    const once = togglePin(new Set(), 'links');
    expect([...once]).toEqual(['links']);
    expect(togglePin(once, 'links').size).toBe(0);
    const same = new Set<SeoPanelId>(['images']);
    expect(togglePin(same, 'overview')).toBe(same);
    // The rail keeps every pinned panel in order.
    expect(railPanels(unpinned, null)).toEqual(ids.filter((id) => id !== 'links' && id !== 'schema'));
    expect(railPanels(new Set(), null)).toEqual(ids);
    expect(morePanels(unpinned)).toEqual(['links', 'schema']);
    expect(morePanels(new Set())).toEqual([]);
  });

  test('more-shows-worst-status', () => {
    expect(worstStatus({ links: 'pass', images: 'warn', schema: 'error' }, ['links', 'images'])).toBe('warn');
    expect(worstStatus({ links: 'pass', images: 'warn', schema: 'error' }, ['links', 'images', 'schema'])).toBe('error');
    expect(worstStatus({ links: 'pass', images: 'warn' }, ['links'])).toBe('pass');
    // Panels without a status (no rules, or no audit) give no dot.
    expect(worstStatus({ links: 'error' }, ['serp', 'changes'])).toBeNull();
    expect(worstStatus({}, ['links'])).toBeNull();
    expect(worstStatus({ links: 'error' }, [])).toBeNull();
    // An unpinned panel's error shows even when a pinned one passes.
    expect(worstStatus({ overview: 'pass', schema: 'error' }, morePanels(new Set<SeoPanelId>(['schema'])))).toBe('error');
  });

  test('jump-to-unpinned-panel-shows-it', () => {
    const unpinned = new Set<SeoPanelId>(['links', 'inspector']);
    // Open: in its place on the rail (still in More).
    const shown = railPanels(unpinned, 'links');
    expect(shown).toContain('links');
    expect(shown.indexOf('links')).toBe(ids.filter((id) => id !== 'inspector').indexOf('links'));
    expect(shown).not.toContain('inspector');
    expect(morePanels(unpinned)).toContain('links');
    // Another panel opens, or the sidebar collapses (nothing shown): gone from the rail again.
    expect(railPanels(unpinned, 'overview')).not.toContain('links');
    expect(railPanels(unpinned, null)).not.toContain('links');
  });
});
