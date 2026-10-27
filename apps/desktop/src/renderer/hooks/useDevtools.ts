import { useCallback, useEffect, useRef, useState } from 'react';
import { DEVTOOLS_REFRESH_MIN_MS, DEVTOOLS_STORAGE_KEYS, type DevtoolsTabId } from '@app/specs/devtools.spec';
import { devtoolsApi } from '../components/devtools/api';
import { onDevtoolsRequest } from '../devtools-palette';
import { heightFromStorage, openFromStorage, tabFromStorage } from '../devtools-view';
import { useSeqChange } from './useSeqChange';

// The SEO devtools drawer's state in the chrome (spec `devtools.spec.ts`; acceptance
// `devtools.feature.md`): open / height / tab, kept per window in the chrome's own `localStorage`;
// main's toggle requests (`devtoolsToggleSeq`) and the palette's; and the long-poll on the shown
// tab's devtools version that tells each Devtools tab to fetch again.

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted this run.
  }
}

export interface DevtoolsDrawerState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly height: number;
  readonly setHeight: (height: number) => void;
  readonly tab: DevtoolsTabId;
  readonly setTab: (tab: DevtoolsTabId) => void;
  /** Increases when the palette asked to show a tab (the drawer moves focus to it). */
  readonly focusSeq: number;
}

/** The drawer's open state, height and tab; toggled whenever `toggleSeq` changes (main's menu item and shortcut). */
export function useDevtoolsDrawer(toggleSeq: number | undefined): DevtoolsDrawerState {
  const [open, setOpen] = useState(() => openFromStorage(read(DEVTOOLS_STORAGE_KEYS.open)));
  const [height, setHeight] = useState(() => heightFromStorage(read(DEVTOOLS_STORAGE_KEYS.height)));
  const [tab, setTab] = useState<DevtoolsTabId>(() => tabFromStorage(read(DEVTOOLS_STORAGE_KEYS.tab)));
  const [focusSeq, setFocusSeq] = useState(0);
  useEffect(() => {
    write(DEVTOOLS_STORAGE_KEYS.open, open ? '1' : '0');
    // Main records in full only while some window's drawer is open (`NETWORK_LIMITS`).
    void devtoolsApi.setOpen(open);
  }, [open]);
  useEffect(() => write(DEVTOOLS_STORAGE_KEYS.height, String(height)), [height]);
  useEffect(() => write(DEVTOOLS_STORAGE_KEYS.tab, tab), [tab]);
  const toggle = useCallback(() => setOpen((was) => !was), []);
  useSeqChange(toggleSeq, toggle);
  useEffect(
    () =>
      onDevtoolsRequest((request) => {
        if (request.kind === 'toggle') {
          toggle();
          return;
        }
        setTab(request.tab);
        setOpen(true);
        setFocusSeq((seq) => seq + 1);
      }),
    [toggle],
  );
  return { open, setOpen, height, setHeight, tab, setTab, focusSeq };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The tab's devtools version while `active`: the `devtools.watch` long-poll, at most one new value
 * every `DEVTOOLS_REFRESH_MIN_MS` (so a busy page does not refetch the log on every request).
 */
export function useDevtoolsVersion(tabId: number | undefined, active: boolean): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active || tabId === undefined) return;
    let cancelled = false;
    let since = 0;
    let last = 0;
    void (async () => {
      while (!cancelled) {
        const next = await devtoolsApi.watch(tabId, since);
        if (cancelled) return;
        if (next === null) {
          await sleep(1_000);
          continue;
        }
        if (next === since) continue;
        const wait = last + DEVTOOLS_REFRESH_MIN_MS - Date.now();
        if (wait > 0) await sleep(wait);
        if (cancelled) return;
        since = next;
        last = Date.now();
        setVersion(next);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, active]);
  return version;
}

/** What `load` answers for the tab, fetched again whenever `version` or `key` changes; `null` until it answers (and after a tab change). */
export function useDevtoolsData<T>(load: (tabId: number) => Promise<T | null>, tabId: number | undefined, version: number, key = ''): T | null {
  const [data, setData] = useState<{ readonly tabId: number; readonly value: T } | null>(null);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (tabId === undefined) return;
    let live = true;
    void loader.current(tabId).then((value) => {
      if (live && value !== null) setData({ tabId, value });
    });
    return () => {
      live = false;
    };
  }, [tabId, version, key]);
  return data && data.tabId === tabId ? data.value : null;
}
