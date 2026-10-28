import { useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import type { AccountState, AccountStatus } from '@app/specs/account-state.schema';
import { SETTINGS_SECTIONS, SETTINGS_TITLE, type SettingsSectionId } from '@app/specs/account-settings.spec';
import { CloseIcon } from './icons';
import { actions } from './ipc';
import { registerPaletteActions } from './palette/registry';
import { AccountSettings } from './settings-account';
import { GscSettings } from './settings-gsc';
import { useAccountState, useSettingsMenuSeq } from './settings-hooks';
import { holdsSheet, isMenuRequest, onSettingsRequest, opensForConfirmation, requestSettings, SETTINGS_CLOSED, settingsReducer } from './settings-open';
import { settingsPaletteSources } from './settings-palette';
import { TelemetrySettings } from './settings-telemetry';
import './settings.css';

// The Settings view (Phase 4 Task 9; acceptance `account-settings.feature.md`): a sheet that fills the
// page column while open (the page area below is laid out zero-high by `settings.css`, so the tab's
// view never covers it), with the Account, Search Console and Telemetry sections. Opened by the
// palette (`settings-palette.ts`), the menu's Settings… (main's `settingsView.watch` counter), and a
// sign-in that waits for its confirmation; closed by Close, Esc, History opening, another tab or a new
// document (not while a confirmation waits). Every value comes from main; every change is a procedure.

// The palette's Settings actions, once per module instance.
const unregisterPaletteActions = registerPaletteActions(...settingsPaletteSources({ openSettings: requestSettings }));
import.meta.hot?.dispose(unregisterPaletteActions);

const headingId = (section: SettingsSectionId) => `settings-section-${section}`;

function SettingsView({ section, focusSeq, account, onClose, onSection }: {
  readonly section: SettingsSectionId;
  readonly focusSeq: number;
  readonly account: AccountState | null;
  readonly onClose: () => void;
  readonly onSection: (section: SettingsSectionId) => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  // Each request moves focus to its section's heading (and scrolls it into view).
  useEffect(() => {
    const heading = sheet.current?.querySelector<HTMLElement>(`#${headingId(section)}`);
    heading?.focus();
    heading?.scrollIntoView({ block: 'start' });
  }, [section, focusSeq]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  };
  return (
    <section ref={sheet} className="settings-sheet" data-testid="settings-view" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
      <div className="settings">
        <header className="settings-header">
          <h1 className="settings-title" id="settings-title">
            {SETTINGS_TITLE}
          </h1>
          <button type="button" className="settings-close" data-testid="settings-close" aria-label="Close settings" title="Close (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((entry) => (
              <button key={entry.id} type="button" className="settings-nav-item" data-testid={`settings-nav-${entry.id}`} aria-current={entry.id === section ? 'true' : undefined} onClick={() => onSection(entry.id)}>
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="settings-content" data-testid="settings-content">
            {SETTINGS_SECTIONS.map((entry) => (
              <section key={entry.id} className="settings-section" aria-labelledby={headingId(entry.id)} data-testid={`settings-${entry.id}`}>
                <h2 className="settings-section-title" id={headingId(entry.id)} tabIndex={-1}>
                  {entry.label}
                </h2>
                {entry.id === 'account' ? <AccountSettings state={account} /> : null}
                {entry.id === 'search-console' ? <GscSettings onGoToAccount={() => onSection('account')} /> : null}
                {entry.id === 'telemetry' ? <TelemetrySettings /> : null}
              </section>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The App slot: holds whether Settings shows. `historySeq` (History's open requests) closes it;
 * opening it calls `onOpen` (App closes History), so at most one of the two shows.
 */
export function SettingsSlot({ tab, historySeq, onOpen }: { readonly tab: Pick<TabState, 'id' | 'documentSeq'> | undefined; readonly historySeq: number | undefined; readonly onOpen: () => void }) {
  const [state, dispatch] = useReducer(settingsReducer, SETTINGS_CLOSED);
  const account = useAccountState();
  const status: AccountStatus | null = account?.status ?? null;
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;
  const open = (section: SettingsSectionId) => {
    latestOnOpen.current();
    dispatch({ type: 'request', section });
  };
  const openRef = useRef(open);
  openRef.current = open;

  // The palette's requests.
  useEffect(() => onSettingsRequest((section) => openRef.current(section)), []);
  // The menu's (main's counter; its first value is history).
  const menuSeq = useSettingsMenuSeq();
  const seenMenu = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (menuSeq === undefined) return;
    if (isMenuRequest(seenMenu.current, menuSeq)) openRef.current('account');
    seenMenu.current = menuSeq;
  }, [menuSeq]);
  // A sign-in that now waits for its confirmation.
  const lastStatus = useRef<AccountStatus | null>(null);
  useEffect(() => {
    if (opensForConfirmation(lastStatus.current, status)) openRef.current('account');
    lastStatus.current = status;
  }, [status]);
  // History opening closes Settings.
  const seenHistory = useRef(historySeq);
  useEffect(() => {
    if (historySeq !== undefined && seenHistory.current !== undefined && historySeq !== seenHistory.current) dispatch({ type: 'history-opened' });
    seenHistory.current = historySeq;
  }, [historySeq]);
  // Another tab, or a new document in this one.
  const pageKey = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seenPage = useRef(pageKey);
  const holding = holdsSheet(status);
  useEffect(() => {
    if (seenPage.current !== pageKey && seenPage.current !== '') dispatch({ type: 'page-changed', holding });
    seenPage.current = pageKey;
  }, [pageKey, holding]);

  if (!state.open) return null;
  const close = () => {
    dispatch({ type: 'close' });
    void actions.focusPage();
  };
  return <SettingsView section={state.section} focusSeq={state.focusSeq} account={account} onClose={close} onSection={(section) => dispatch({ type: 'request', section })} />;
}
