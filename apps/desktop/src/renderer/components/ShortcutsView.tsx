import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import { KEYBOARD_SHORTCUTS, shortcutKeysFor, SHORTCUTS_TEXT, type HelpOpenResult, type HelpSheet, type KeyboardShortcut } from '@app/specs/help.spec';
// Type-only from the Zod specs (their schemas must stay out of this bundle: strict Trusted Types).
import type { HelpOpenLinkInput, HelpViewState } from '@app/specs/whats-new.schema';
import { helpPaletteSources, onHelpSheetRequest, requestHelpSheet } from '../help-palette';
import { CloseIcon } from '../icons';
import { actions, ipc } from '../ipc';
import { shortcutLabel } from '../palette/keys';
import { registerPaletteActions } from '../palette/registry';
import { askSettingsToClose, onSettingsOpened } from '../settings-open';
import { useSeqChange } from '../hooks/useSeqChange';
import { closeProjects, onProjectsOpened } from './changes/projects-sheet';
import { closeScreenshotEditor, onScreenshotEditorOpened } from '../screenshot-editor';
import { createWatchStore } from '../settings-store';
import { markSetupStep } from './SetupChecklist';
import '../help.css';

// The keyboard shortcuts screen (Phase 11 Task 11, SL-118; acceptance `help.feature.md`), and what the
// two Help sheets share. A sheet fills the page column while open (the page area below is laid out
// zero-high by `help.css`, so the tab's view never covers it). It opens from Help › Keyboard Shortcuts
// (Mod+/; main's `help.watch` counter), the palette and the setup checklist; it closes on Close, Esc,
// a page change, and another sheet opening (Help, Settings, History, Projects, the screenshot editor: one at a time). The table is `KEYBOARD_SHORTCUTS` as
// this platform shows it (⌘ on macOS, Ctrl elsewhere). Every string is frost's own.

const MAC = /\bMac/.test(navigator.userAgent);

/** Help's calls to main, each from the click or key that asked. */
export const helpActions = {
  openLink: (link: HelpOpenLinkInput): Promise<HelpOpenResult> => ipc.help.openLink.mutate(link).catch(() => 'unavailable' as const),
  whatsNew: () => ipc.help.whatsNew.query().catch(() => null),
  takeWhatsNew: () => ipc.help.takeWhatsNew.mutate().catch(() => false),
};

// The palette's Help actions, once per module instance.
const unregisterPaletteActions = registerPaletteActions(...helpPaletteSources({ openSheet: requestHelpSheet, openLink: (link) => helpActions.openLink({ link }) }));
import.meta.hot?.dispose(unregisterPaletteActions);

/** This window's Help menu requests: one `help.watch` for the chrome. */
const helpMenuStore = createWatchStore<HelpViewState>((since) => ipc.help.watch.query({ sinceSeq: since }), (value) => value.seq);

/** Where focus goes once a sheet is gone (if it was inside): the page, else the address bar. */
function focusAfterClose(): void {
  void actions.focusPage().then((onPage) => {
    if (!onPage && (document.activeElement === null || document.activeElement === document.body)) document.querySelector<HTMLElement>('[data-testid="address"]')?.focus();
  });
}

/** What a Help sheet needs from the App: the active tab, History's requests, and how to close History. */
export interface HelpSheetProps {
  readonly tab: Pick<TabState, 'id' | 'documentSeq' | 'loading'> | undefined;
  /** History's open requests (`BrowserState.historyViewSeq`): History opening closes the sheet. */
  readonly historySeq: number | undefined;
  /** Closes History (the sheet opening closes it: one sheet at a time). */
  readonly onOpen: () => void;
}

/**
 * Whether Help sheet `sheet` shows, `show` and `close`. One sheet at a time: opening it closes
 * Settings (unless a sign-in waits for its confirmation there; then it stays shut and `show` answers
 * `false`), Projects, the screenshot editor and History; it closes when the other Help sheet,
 * Settings, Projects, the screenshot editor or History opens, and when another tab shows or a new document commits in this one. It opens on a request for
 * it (the palette, the checklist, the menu's counter: its first value is history). `focusSeq` rises
 * with every request, so the sheet moves focus to its heading again.
 */
export function useHelpSheet(sheet: HelpSheet, { tab, historySeq, onOpen }: HelpSheetProps): { readonly open: boolean; readonly focusSeq: number; readonly show: () => boolean; readonly close: () => void } {
  const [state, setState] = useState({ open: false, focusSeq: 0 });
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;
  const close = useCallback(() => setState((was) => (was.open ? { ...was, open: false } : was)), []);
  const show = useCallback(() => {
    if (!askSettingsToClose()) return false;
    closeProjects();
    closeScreenshotEditor();
    latestOnOpen.current();
    setState((was) => ({ open: true, focusSeq: was.focusSeq + 1 }));
    return true;
  }, []);
  useEffect(
    () =>
      onHelpSheetRequest((asked) => {
        if (asked === sheet) show();
        else close();
      }),
    [sheet, show, close],
  );
  useEffect(() => onSettingsOpened(close), [close]);
  useEffect(() => onScreenshotEditorOpened(close), [close]);
  // Every open request, the first one included (a request counter's first value is not history here).
  useEffect(() => onProjectsOpened(close), [close]);
  const menu = useSyncExternalStore(helpMenuStore.subscribe, helpMenuStore.current);
  const seenMenu = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!menu) return;
    if (seenMenu.current !== undefined && menu.seq !== seenMenu.current) {
      if (menu.sheet === sheet) show();
      else close();
    }
    seenMenu.current = menu.seq;
  }, [menu, sheet, show, close]);
  useSeqChange(historySeq, close);
  // Another tab, or a new document in this one.
  const pageKey = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seenPage = useRef(pageKey);
  useEffect(() => {
    if (seenPage.current !== pageKey && seenPage.current !== '') close();
    seenPage.current = pageKey;
  }, [pageKey, close]);
  return { open: state.open, focusSeq: state.focusSeq, show, close };
}

/** A Help sheet's frame: heading, Close (and Esc), focus on open, focus back to the page on close. */
export function HelpSheetFrame({ testId, title, closeLabel, focusSeq, onClose, children }: { readonly testId: string; readonly title: string; readonly closeLabel: string; readonly focusSeq: number; readonly onClose: () => void; readonly children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  const titleId = `${testId}-title`;
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>(`#${titleId}`)?.focus();
  }, [focusSeq, titleId]);
  // Closed with focus inside: the sheet's nodes are gone, so focus fell to the body.
  useEffect(
    () => () => {
      if (document.activeElement === null || document.activeElement === document.body) focusAfterClose();
    },
    [],
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };
  return (
    <section ref={sheet} className="help-sheet" data-testid={testId} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="help">
        <header className="help-header">
          <h1 className="help-title" id={titleId} tabIndex={-1}>
            {title}
          </h1>
          <button type="button" className="help-close" data-testid={`${testId}-close`} aria-label={closeLabel} title={`${closeLabel} (Esc)`} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="help-body">{children}</div>
      </div>
    </section>
  );
}

/** One shortcut's keys as this platform shows them. */
function Keys({ shortcut }: { readonly shortcut: KeyboardShortcut }) {
  const keys = shortcutKeysFor(shortcut.keys, MAC).map((key) => shortcutLabel(key, MAC));
  if (shortcut.display === 'range' && keys.length > 1) {
    return (
      <span className="help-keys">
        <kbd className="help-kbd">{keys[0]}</kbd>
        <span className="help-or">–</span>
        <kbd className="help-kbd">{keys[keys.length - 1]}</kbd>
      </span>
    );
  }
  return (
    <span className="help-keys">
      {keys.map((key, i) => (
        <span key={key} className="help-key">
          {i > 0 ? <span className="help-or">{SHORTCUTS_TEXT.or}</span> : null}
          <kbd className="help-kbd">{key}</kbd>
        </span>
      ))}
    </span>
  );
}

/** The App slot: the keyboard shortcuts sheet while it is open. */
export function ShortcutsSheet(props: HelpSheetProps) {
  const { open, focusSeq, close } = useHelpSheet('shortcuts', props);
  // Opening it is the checklist's "Learn the keyboard shortcuts".
  useEffect(() => {
    if (open) markSetupStep('shortcuts');
  }, [open]);
  if (!open) return null;
  return (
    <HelpSheetFrame testId="shortcuts-view" title={SHORTCUTS_TEXT.title} closeLabel={SHORTCUTS_TEXT.close} focusSeq={focusSeq} onClose={close}>
      <p className="help-note">{SHORTCUTS_TEXT.note}</p>
      <div className="shortcuts-groups">
        {KEYBOARD_SHORTCUTS.map((group) => (
          <section key={group.id} className="shortcuts-group" data-testid="shortcuts-group" data-group={group.id} aria-labelledby={`shortcuts-${group.id}`}>
            <h2 className="shortcuts-group-title" id={`shortcuts-${group.id}`}>
              {group.label}
            </h2>
            <dl className="shortcuts-list">
              {group.shortcuts
                .filter((shortcut) => shortcutKeysFor(shortcut.keys, MAC).length > 0)
                .map((shortcut) => (
                  <div key={shortcut.id} className="shortcuts-row" data-testid="shortcut" data-shortcut={shortcut.id}>
                    <dt className="shortcuts-label">{shortcut.label}</dt>
                    <dd className="shortcuts-keys">
                      <Keys shortcut={shortcut} />
                    </dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
    </HelpSheetFrame>
  );
}
