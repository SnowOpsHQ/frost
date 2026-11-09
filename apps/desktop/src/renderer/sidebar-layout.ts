import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { AGENT_PANEL_RESIZE_LABEL, AGENT_PANEL_WIDTH, AGENT_PANEL_WIDTH_RANGE, AGENT_PANEL_WIDTH_STORAGE_KEY, AGENT_RAIL_WIDTH } from '@app/specs/agent-panel.spec';
import {
  ALWAYS_PINNED_PANELS,
  PAGE_MIN_WIDTH,
  SEO_PANELS,
  SIDEBAR_PANEL_WIDTH,
  SIDEBAR_PANEL_WIDTH_RANGE,
  SIDEBAR_PINS_STORAGE_KEY,
  SIDEBAR_RAIL_WIDTH,
  SIDEBAR_RESIZE_LABEL,
  SIDEBAR_WIDTH_STORAGE_KEY,
  type PanelStatus,
  type SeoPanelId,
} from '@app/specs/seo-sidebar.spec';

// The workspace row's resizable panes and the SEO rail's pins (Phase 11 Task 10, Decision 12; specs
// `seo-sidebar.spec.ts`, `agent-panel.spec.ts`; acceptance `seo-sidebar.feature.md`, Resize and pins).
// Both are chrome preferences in the chrome's own `localStorage` (`app://app`), every access in a
// try/catch. The pure functions come first; the hooks below hold one shared layout for the row, so
// each pane's width follows the other's and the window's (the agent pane gives way first). A pane's
// width reaches CSS as a custom property on its own element; the page area shrinks to match and
// `PageArea` reports its box to main, so the tab's view follows without anything else.

export type PaneId = 'sidebar' | 'agent';

export interface WidthRange {
  readonly min: number;
  readonly max: number;
  readonly keyboardStep: number;
}

export const PANE_RANGES: Readonly<Record<PaneId, WidthRange>> = { sidebar: SIDEBAR_PANEL_WIDTH_RANGE, agent: AGENT_PANEL_WIDTH_RANGE };
export const PANE_DEFAULTS: Readonly<Record<PaneId, number>> = { sidebar: SIDEBAR_PANEL_WIDTH, agent: AGENT_PANEL_WIDTH };
const STORAGE_KEYS: Readonly<Record<PaneId, string>> = { sidebar: SIDEBAR_WIDTH_STORAGE_KEY, agent: AGENT_PANEL_WIDTH_STORAGE_KEY };
/** The CSS custom property each pane's width is set as (on the pane's own element). */
const WIDTH_PROPERTIES: Readonly<Record<PaneId, string>> = { sidebar: '--seo-panel-width', agent: '--agent-panel-width' };
const RESIZE_LABELS: Readonly<Record<PaneId, string>> = { sidebar: SIDEBAR_RESIZE_LABEL, agent: AGENT_PANEL_RESIZE_LABEL };

/** The row's borders besides the panes' own boxes: the sidebar's right edge and the agent's left (`styles.css`, `agent.css`; border-box). */
const ROW_EDGES = 2;

/** `width` as a whole number in `[range.min, range.max]` (not a number: the minimum). */
export function clampWidth(width: number, range: Pick<WidthRange, 'min' | 'max'>): number {
  if (!Number.isFinite(width)) return range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(width)));
}

/** A stored width (decimal CSS px): clamped to the pane's range; missing or unreadable, the pane's default. */
export function widthFromStorage(value: string | null, pane: PaneId): number {
  if (value === null || !/^\d{1,5}$/.test(value.trim())) return PANE_DEFAULTS[pane];
  return clampWidth(Number(value.trim()), PANE_RANGES[pane]);
}

export interface PaneInput {
  readonly open: boolean;
  /** The width the user chose (in range). */
  readonly preferred: number;
}

export interface LayoutInput {
  /** The workspace row's width in CSS px; `0` before it was measured. */
  readonly workspace: number;
  readonly sidebar: PaneInput;
  readonly agent: PaneInput;
}

export interface PaneWidths {
  readonly sidebar: number;
  readonly agent: number;
}

/** What the row leaves the two open panes beside the page's minimum: the SEO rail, the collapsed agent's rail, the borders. */
export function roomForPanes(input: LayoutInput): number {
  return input.workspace - PAGE_MIN_WIDTH - SIDEBAR_RAIL_WIDTH - ROW_EDGES - (input.agent.open ? 0 : AGENT_RAIL_WIDTH);
}

/**
 * Each pane's width now (a closed pane: its chosen width, unused). In a row too narrow for both
 * chosen widths and the page's minimum, the agent pane gives way first down to its minimum, then the
 * sidebar down to its own; past that they keep their minimums and CSS narrows them as before (the page
 * area's `min-width` holds). Unmeasured (`workspace` 0): the chosen widths.
 */
export function paneWidths(input: LayoutInput): PaneWidths {
  let sidebar = clampWidth(input.sidebar.preferred, PANE_RANGES.sidebar);
  let agent = clampWidth(input.agent.preferred, PANE_RANGES.agent);
  if (input.workspace <= 0) return { sidebar, agent };
  let over = (input.sidebar.open ? sidebar : 0) + (input.agent.open ? agent : 0) - roomForPanes(input);
  if (over > 0 && input.agent.open) {
    const cut = Math.min(over, agent - PANE_RANGES.agent.min);
    agent -= cut;
    over -= cut;
  }
  if (over > 0 && input.sidebar.open) sidebar -= Math.min(over, sidebar - PANE_RANGES.sidebar.min);
  return { sidebar, agent };
}

/** The largest width `pane` may take now: its range's maximum, less what would push the page under its minimum beside the other pane as it is; never under the range's minimum. */
export function paneMax(pane: PaneId, input: LayoutInput): number {
  const range = PANE_RANGES[pane];
  if (input.workspace <= 0) return range.max;
  const widths = paneWidths(input);
  const other: PaneId = pane === 'sidebar' ? 'agent' : 'sidebar';
  const taken = input[other].open ? widths[other] : 0;
  return Math.max(range.min, Math.min(range.max, roomForPanes({ ...input, [pane]: { ...input[pane], open: true } }) - taken));
}

/** `requested` as `pane`'s new chosen width: in its range and under `paneMax`. */
export function resizeTo(pane: PaneId, requested: number, input: LayoutInput): number {
  return clampWidth(requested, { min: PANE_RANGES[pane].min, max: paneMax(pane, input) });
}

/**
 * The width a key on `pane`'s separator asks for, from `current` (`null`: not a resize key). The
 * separator moves with the arrow: the sidebar's sits on its right, so Right widens it; the agent's on
 * its left, so Left widens it. Up widens and Down narrows either; Home / End go to the minimum / `max`.
 */
export function keyboardResize(pane: PaneId, key: string, current: number, max: number): number | null {
  const range = PANE_RANGES[pane];
  const wider = pane === 'sidebar' ? 'ArrowRight' : 'ArrowLeft';
  const narrower = pane === 'sidebar' ? 'ArrowLeft' : 'ArrowRight';
  const bounds = { min: range.min, max: Math.max(range.min, max) };
  if (key === wider || key === 'ArrowUp') return clampWidth(current + range.keyboardStep, bounds);
  if (key === narrower || key === 'ArrowDown') return clampWidth(current - range.keyboardStep, bounds);
  if (key === 'Home') return bounds.min;
  if (key === 'End') return bounds.max;
  return null;
}

// ---- Pins ---------------------------------------------------------------------------------------

const PANEL_IDS: readonly SeoPanelId[] = SEO_PANELS.map((panel) => panel.id);

export function isAlwaysPinned(panel: SeoPanelId): boolean {
  return (ALWAYS_PINNED_PANELS as readonly SeoPanelId[]).includes(panel);
}

/** The stored unpinned panels (a JSON array of ids): unknown ids and always-pinned ones dropped; unreadable, none. */
export function unpinnedFromStorage(value: string | null): ReadonlySet<SeoPanelId> {
  if (value === null || value.length > 4_096) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(PANEL_IDS.filter((id) => parsed.includes(id) && !isAlwaysPinned(id)));
}

/** The unpinned panels as stored: their ids in `SEO_PANELS` order. */
export function unpinnedToStorage(unpinned: ReadonlySet<SeoPanelId>): string {
  return JSON.stringify(PANEL_IDS.filter((id) => unpinned.has(id)));
}

/** `unpinned` with `panel` pinned or unpinned in turn; an always-pinned panel never moves. */
export function togglePin(unpinned: ReadonlySet<SeoPanelId>, panel: SeoPanelId): ReadonlySet<SeoPanelId> {
  if (isAlwaysPinned(panel)) return unpinned;
  const next = new Set(unpinned);
  if (!next.delete(panel)) next.add(panel);
  return next;
}

/** The rail's panels, in `SEO_PANELS` order: the pinned ones, and `shown` (the open panel, if any) even when unpinned. */
export function railPanels(unpinned: ReadonlySet<SeoPanelId>, shown: SeoPanelId | null): SeoPanelId[] {
  return PANEL_IDS.filter((id) => !unpinned.has(id) || id === shown);
}

/** "More panels": the unpinned panels, in `SEO_PANELS` order. */
export function morePanels(unpinned: ReadonlySet<SeoPanelId>): SeoPanelId[] {
  return PANEL_IDS.filter((id) => unpinned.has(id));
}

const SEVERITY: Readonly<Record<PanelStatus, number>> = { pass: 0, warn: 1, error: 2 };

/** The worst status among `panels` (`error` over `warn` over `pass`), or `null` when none of them has one. */
export function worstStatus(statuses: Partial<Record<SeoPanelId, PanelStatus>>, panels: readonly SeoPanelId[]): PanelStatus | null {
  let worst: PanelStatus | null = null;
  for (const id of panels) {
    const status = statuses[id];
    if (status !== undefined && (worst === null || SEVERITY[status] > SEVERITY[worst])) worst = status;
  }
  return worst;
}

// ---- Storage ------------------------------------------------------------------------------------

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not kept this run.
  }
}

// ---- The row's shared layout --------------------------------------------------------------------

interface LayoutSnapshot {
  readonly input: LayoutInput;
  readonly widths: PaneWidths;
  readonly max: PaneWidths;
}

function snapshotOf(input: LayoutInput): LayoutSnapshot {
  return { input, widths: paneWidths(input), max: { sidebar: paneMax('sidebar', input), agent: paneMax('agent', input) } };
}

/** The row's layout: both panes' open state and chosen widths, and the row's width (shared by the two panes' hooks). */
export function createWorkspaceLayout(read: (key: string) => string | null = readStored, write: (key: string, value: string) => void = writeStored) {
  let snapshot: LayoutSnapshot | null = null;
  const listeners = new Set<() => void>();
  const current = (): LayoutSnapshot =>
    (snapshot ??= snapshotOf({
      workspace: 0,
      sidebar: { open: false, preferred: widthFromStorage(read(STORAGE_KEYS.sidebar), 'sidebar') },
      agent: { open: false, preferred: widthFromStorage(read(STORAGE_KEYS.agent), 'agent') },
    }));
  const update = (next: LayoutInput): void => {
    const was = current().input;
    if (next.workspace === was.workspace && (['sidebar', 'agent'] as const).every((p) => next[p].open === was[p].open && next[p].preferred === was[p].preferred)) return;
    snapshot = snapshotOf(next);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: current,
    setWorkspace(width: number): void {
      // Whole CSS px, rounded down: on a scaled display the row can measure a fraction over, and the page keeps its minimum.
      if (Number.isFinite(width) && width >= 0) update({ ...current().input, workspace: Math.floor(width) });
    },
    setOpen(pane: PaneId, open: boolean): void {
      const input = current().input;
      update({ ...input, [pane]: { ...input[pane], open } });
    },
    /** Sets `pane`'s chosen width (clamped as `resizeTo`); `persist` keeps it in storage. Answers the width set. */
    resize(pane: PaneId, requested: number, persist: boolean): number {
      const input = current().input;
      const width = resizeTo(pane, requested, input);
      update({ ...input, [pane]: { ...input[pane], preferred: width } });
      if (persist) write(STORAGE_KEYS[pane], String(width));
      return width;
    },
    /** Keeps `pane`'s chosen width in storage (the end of a drag). */
    persist(pane: PaneId): void {
      write(STORAGE_KEYS[pane], String(current().input[pane].preferred));
    },
  };
}
export type WorkspaceLayout = ReturnType<typeof createWorkspaceLayout>;

/** The one layout of this window's row. */
const workspaceLayout = createWorkspaceLayout();

/** What a pane's separator element takes (`role="separator"`, its value and its handlers). */
export interface SeparatorProps {
  readonly role: 'separator';
  readonly 'aria-orientation': 'vertical';
  readonly 'aria-label': string;
  readonly 'aria-valuenow': number;
  readonly 'aria-valuemin': number;
  readonly 'aria-valuemax': number;
  readonly tabIndex: 0;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
}

/**
 * A pane of the workspace row (`sidebar` or `agent`): reports whether it is open, watches the row's
 * width (the pane element's parent), sets its width on `element` as its CSS custom property, and
 * answers its separator's props. `layout` is for tests.
 */
export function usePaneLayout(pane: PaneId, open: boolean, element: RefObject<HTMLElement | null>, layout: WorkspaceLayout = workspaceLayout): { readonly width: number; readonly separator: SeparatorProps } {
  const snapshot = useSyncExternalStore(layout.subscribe, layout.snapshot);
  const width = snapshot.widths[pane];
  const max = snapshot.max[pane];
  useLayoutEffect(() => layout.setOpen(pane, open), [layout, pane, open]);
  useLayoutEffect(() => {
    const row = element.current?.parentElement;
    if (!row) return;
    const measure = () => layout.setWorkspace(row.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [layout, element]);
  useLayoutEffect(() => {
    element.current?.style.setProperty(WIDTH_PROPERTIES[pane], `${width}px`);
  }, [element, pane, width, open]);

  const drag = useRef<{ readonly pointer: number; readonly x: number; readonly width: number } | null>(null);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const { widths, max: limits } = layout.snapshot();
      const next = keyboardResize(pane, event.key, widths[pane], limits[pane]);
      if (next === null) return;
      event.preventDefault();
      layout.resize(pane, next, true);
    },
    [layout, pane],
  );
  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { pointer: event.pointerId, x: event.clientX, width: layout.snapshot().widths[pane] };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No capture (the pointer is gone): the drag still follows while over the separator.
      }
      event.currentTarget.focus();
    },
    [layout, pane],
  );
  /** Ends a drag under way (keeping the width it reached); nothing when none is. */
  const endDrag = useCallback(() => {
    if (drag.current === null) return;
    drag.current = null;
    layout.persist(pane);
  }, [layout, pane]);
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = drag.current;
      if (start === null || start.pointer !== event.pointerId) return;
      // The button is up (its release went elsewhere, e.g. over the tab's view): the drag is over.
      if ((event.buttons & 1) === 0) return endDrag();
      const dx = event.clientX - start.x;
      layout.resize(pane, pane === 'sidebar' ? start.width + dx : start.width - dx, false);
    },
    [layout, pane, endDrag],
  );
  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (drag.current !== null && drag.current.pointer === event.pointerId) endDrag();
    },
    [endDrag],
  );
  // The pane closing (its separator goes) or unmounting ends a drag too, so none is left stuck.
  useEffect(() => {
    if (!open) endDrag();
    return endDrag;
  }, [open, endDrag]);
  return {
    width,
    separator: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': RESIZE_LABELS[pane],
      'aria-valuenow': width,
      'aria-valuemin': PANE_RANGES[pane].min,
      'aria-valuemax': max,
      tabIndex: 0,
      onKeyDown,
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onLostPointerCapture: onPointerEnd,
    },
  };
}

/** The SEO rail's unpinned panels (persisted under `SIDEBAR_PINS_STORAGE_KEY`) and the pin toggle. */
export function useSidebarPins(): readonly [ReadonlySet<SeoPanelId>, (panel: SeoPanelId) => void] {
  const [unpinned, setUnpinned] = useState(() => unpinnedFromStorage(readStored(SIDEBAR_PINS_STORAGE_KEY)));
  const toggle = useCallback((panel: SeoPanelId) => {
    setUnpinned((was) => {
      const next = togglePin(was, panel);
      if (next !== was) writeStored(SIDEBAR_PINS_STORAGE_KEY, unpinnedToStorage(next));
      return next;
    });
  }, []);
  return [unpinned, toggle];
}
