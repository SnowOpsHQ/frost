import type { TabState } from '@app/specs/browser.spec';
import { FULLSCREEN_NOTICE_TEXT } from '@app/specs/permissions.spec';
import { hostOf } from '../security';

// The fullscreen notice of the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

/**
 * The fullscreen notice (`permissions.feature.md`, HTML fullscreen): while the active tab's page has
 * just entered fullscreen, a frost-owned banner across the top of the window, above the page's
 * view, names the page's host and how to leave.
 */
export function FullscreenNotice({ tab }: { readonly tab: TabState }) {
  return (
    <div className="fullscreen-notice" role="status" data-testid="fullscreen-notice">
      <span className="fullscreen-notice-text">
        <strong>{hostOf(tab.url) || tab.url}</strong> {FULLSCREEN_NOTICE_TEXT}
      </span>
    </div>
  );
}
