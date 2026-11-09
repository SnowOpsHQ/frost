import { BrowserWindow } from 'electron';
import type { HelpService } from '@app/ipc-contract';
import { isAppVersion } from '@app/specs/help.spec';
import { openExternalIfAllowed } from '../security/gesture';
import { openHelpLink } from './links';
import type { HelpMenuCommands } from './menu';
import { loadReleaseNotes } from './release-notes';
import { createHelpRequests } from './requests';
import { createWhatsNew, type WhatsNewSettings } from './whats-new';

// Help in main (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`): the Help menu's commands
// and the `help.*` service. Nothing here touches the network or reads a file: the notes are bundled
// (`release-notes.ts`), the pages are fixed (`HELP_URLS`) and open only through
// `openExternalIfAllowed` on a gesture (a menu click; for the chrome, a live click or key in the
// sender's window, spent).

export interface HelpMainDeps {
  /** Electron's `app` (its version, and `will-quit` to answer waiting watches). */
  readonly app: { getVersion(): string; once(event: 'will-quit', listener: () => void): unknown };
  readonly settings: WhatsNewSettings;
  /** Whether app window `windowId` has a live, unspent activation (the account's `gestures.consume`). */
  readonly consumeGesture: (windowId: number) => boolean;
  readonly log: (message: string) => void;
}

export interface HelpMain {
  readonly service: HelpService;
  readonly menu: Required<HelpMenuCommands>;
}

export function createHelpMain(deps: HelpMainDeps): HelpMain {
  const version = deps.app.getVersion();
  if (!isAppVersion(version)) deps.log('help: the app version is not a version; What\u2019s New is off');
  const notes = loadReleaseNotes(undefined, deps.log);
  const whatsNew = createWhatsNew({ version, notes, settings: deps.settings, now: () => Date.now(), log: deps.log });
  const requests = createHelpRequests({
    chrome: (windowId) => {
      const win = windowId === undefined ? (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null) : BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) return null;
      return { windowId: win.id, focus: () => win.webContents.focus() };
    },
  });
  deps.app.once('will-quit', () => requests.dispose());
  const links = { notes, open: openExternalIfAllowed };
  return {
    service: {
      state: requests.state,
      watch: requests.watch,
      whatsNew: whatsNew.answer,
      takeWhatsNew: whatsNew.take,
      // The gesture is spent only once the request names something to open.
      openLink: (windowId, link) => openHelpLink(link, () => deps.consumeGesture(windowId), links),
    },
    menu: {
      showShortcuts: (windowId) => requests.show('shortcuts', windowId),
      showWhatsNew: (windowId) => requests.show('whats-new', windowId),
      // A menu click is a user gesture.
      openHelpLink: (link) => void openHelpLink({ link }, true, links),
    },
  };
}
