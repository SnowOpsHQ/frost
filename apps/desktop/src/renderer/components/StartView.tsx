import { FrostMark } from '../icons';

// An empty tab's start view in the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP).

export function StartView() {
  return (
    <section className="start" data-testid="start-view" aria-label="New tab">
      <FrostMark className="start-mark" />
      <h1 className="start-wordmark">frost</h1>
      <p className="start-hint">Search or enter address</p>
    </section>
  );
}
