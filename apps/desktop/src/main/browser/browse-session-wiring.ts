import type { Session } from 'electron';
import type { BrowseClassInstaller } from './browse-class';
import { hardenBrowseSession, type BrowseSessionHooks } from './guard';
import { observeMainFrames, observeRequests, type MainFrameObserver, type RequestObserver } from './web-request';

// Main's per-session wiring of a browse-class session (acceptance `browser-chrome.feature.md`,
// Session classification: every-browse-installer-runs-per-session), as one installer for
// `onBrowseClassSession` (`browse-class.ts`): the main-frame observers (the response recorder), the
// request observers (the devtools drawer's recorder), then `hardenBrowseSession` (permission
// handlers, device permissions denied, `file:` refused, every download cancelled with the notice).
// The order is Phase 11's on the browse session. The bounded fetchers (`netHop`, `netResolver`) are
// not here: they stay on the browse partition alone (Phase 12 Decision 11).

export interface BrowseSessionWiring {
  /** Phase 2's response recorder (`seo/responses.ts`). */
  readonly mainFrames: MainFrameObserver;
  /** The devtools drawer's network recorder. */
  readonly requests: RequestObserver;
  /** The download notice and the permission handlers (`hardenBrowseSession`). */
  readonly hooks: BrowseSessionHooks;
}

export function browseSessionInstaller(wiring: BrowseSessionWiring): BrowseClassInstaller {
  return (session: Session) => {
    observeMainFrames(session, wiring.mainFrames);
    observeRequests(session, wiring.requests);
    hardenBrowseSession(session, wiring.hooks);
  };
}
