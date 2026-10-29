import { useEffect, useReducer, useRef, type KeyboardEvent } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import type { AccountState, AccountStatus } from '@app/specs/account-state.schema';
import { ACCOUNT_SETTINGS_TEXT, SETTINGS_SECTIONS, SETTINGS_TITLE, type SettingsSectionId } from '@app/specs/account-settings.spec';
import { CloseIcon } from './icons';
import { actions } from './ipc';
import { registerPaletteActions } from './palette/registry';
import { AccountSettings } from './settings-account';
import { GscSettings } from './settings-gsc';
import { accountStore, settingsActions, useAccountState, useSettingsMenuSeq } from './settings-hooks';
import { closeCancelsSignIn, holdsSheet, isMenuRequest, onSettingsRequest, opensForConfirmation, requestSettings, SETTINGS_CLOSED, settingsReducer } from './settings-open';
import { settingsPaletteSources } from './settings-palette';
import { TelemetrySettings } from './settings-telemetry';
import './settings.css';

// The Settings view (Phase 4 Task 9; acceptance `account-settings.feature.md`): a sheet that fills the
// page column while open (the page area below is laid out zero-high by `settings.css`, so the tab's
// view never covers it), with the Account, Search Console and Telemetry sections. Opened by the
// palette (`settings-palette.ts`), the menu's Settings… (main's `account.settingsWatch` counter), and a
// sign-in that waits for its confirmation; closed by Close, Esc, History opening, another tab or a new
// document. While a confirmation waits, History and page changes leave it open and Close / Esc cancel
// the sign-in first, so a waiting confirmation is never hidden. When it closes and focus was inside it,
// focus goes to the page (else the address bar). Every value comes from main; every change is a procedure.

/** Where focus goes once the sheet is gone (if it was inside): the page, else the address bar. */
function focusAfterClose(): void {
  void actions.focusPage().then((onPage) => {
    if (!onPage && (document.activeElement === null || document.activeElement === document.body)) document.querySelector<HTMLElement>('[data-testid="address"]')?.focus();
  });
}

// The palette's Settings actions, once per module instance.
const unregisterPaletteActions = registerPaletteActions(...settingsPaletteSources({ openSettings: requestSettings, accountStatus: () => accountStore.current()?.status ?? null }));
import.meta.hot?.dispose(unregisterPaletteActions);

const headingId = (section: SettingsSectionId) => `settings-section-${section}`;

function SettingsView({ section, focusSeq, account, closeLabel, onClose, onSection }: {
  readonly section: SettingsSectionId;
  readonly focusSeq: number;
  readonly account: AccountState | null;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly onSection: (section: SettingsSectionId) => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  // Each request moves focus to its section's heading (and scrolls it into view).
  useEffect(() => {
    const heading = sheet.current?.querySelector<HTMLElement>(`#${headingId(section)}`);
    // On Account with a confirmation waiting, its question takes focus (it is what to answer).
    const question = section === 'account' ? sheet.current?.querySelector<HTMLElement>('#account-question') : null;
    (question ?? heading)?.focus();
    heading?.scrollIntoView({ block: 'start' });
  }, [section, focusSeq]);
  // Closed for any reason with focus inside: the sheet's nodes are gone, so focus fell to the body.
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
    <section ref={sheet} className="settings-sheet" data-testid="settings-view" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
      <div className="settings">
        <header className="settings-header">
          <h1 className="settings-title" id="settings-title">
            {SETTINGS_TITLE}
          </h1>
          <button type="button" className="settings-close" data-testid="settings-close" aria-label={closeLabel} title={`${closeLabel} (Esc)`} onClick={onClose}>
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
  const holding = holdsSheet(status);
  // History opening closes Settings; while a confirmation waits, History is closed instead.
  const seenHistory = useRef(historySeq);
  useEffect(() => {
    if (historySeq !== undefined && seenHistory.current !== undefined && historySeq !== seenHistory.current) {
      if (holding && state.open) latestOnOpen.current();
      dispatch({ type: 'history-opened', holding });
    }
    seenHistory.current = historySeq;
    // Only a new History request counts (`holding` and `open` are read as they are then).
  }, [historySeq]);
  // Another tab, or a new document in this one.
  const pageKey = tab ? `${tab.id} ${tab.documentSeq}` : '';
  const seenPage = useRef(pageKey);
  useEffect(() => {
    if (seenPage.current !== pageKey && seenPage.current !== '') dispatch({ type: 'page-changed', holding });
    seenPage.current = pageKey;
  }, [pageKey, holding]);

  if (!state.open) return null;
  const cancels = closeCancelsSignIn(status);
  const close = () => {
    // A waiting confirmation is never hidden: closing cancels the sign-in (main revokes its token).
    if (cancels && account?.requestId) void settingsActions.cancelSignIn(account.requestId);
    dispatch({ type: 'close' });
  };
  return (
    <SettingsView
      section={state.section}
      focusSeq={state.focusSeq}
      account={account}
      closeLabel={cancels ? ACCOUNT_SETTINGS_TEXT.closeCancels : 'Close settings'}
      onClose={close}
      onSection={(section) => dispatch({ type: 'request', section })}
    />
  );
}
