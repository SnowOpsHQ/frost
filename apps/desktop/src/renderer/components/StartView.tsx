import { useEffect, useState } from 'react';
import type { HistoryVisitAnswer, JumpBackInAnswer } from '@app/ipc-contract';
import { JUMP_BACK_IN_TITLE } from '@app/specs/browser-polish.spec';
import { monogram, visitHost, visitLabel } from '../history-view';
import { FrostMark } from '../icons';
import { actions } from '../ipc';
import { isolatedTooltip } from '../seo-view';

// An empty tab's start view in the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP). "Jump back in" (spec `browser-polish.feature.md`, New-tab page):
// the most visited and recent pages from the local `recent_visits`, as frost-drawn tiles (a monogram,
// the title and the host as text; no favicon, nothing remote); a tile opens its page in this tab.

function Tile({ visit }: { readonly visit: HistoryVisitAnswer }) {
  return (
    <li>
      <button type="button" className="jump-tile" data-testid="jump-tile" data-url={visit.url} title={isolatedTooltip(visit.url)} onClick={() => void actions.navigate(visit.url)}>
        <span className="jump-monogram" aria-hidden="true">
          {monogram(visit.url)}
        </span>
        <bdi className="jump-label" dir="auto">
          {visitLabel(visit)}
        </bdi>
        <bdi className="jump-host" dir="auto">
          {visitHost(visit.url)}
        </bdi>
      </button>
    </li>
  );
}

export function StartView({ tabId }: { readonly tabId?: number | undefined }) {
  const [tiles, setTiles] = useState<JumpBackInAnswer | null>(null);
  // Read again for each empty tab shown.
  useEffect(() => {
    let live = true;
    void actions.jumpBackIn().then((answer) => {
      if (live) setTiles(answer);
    });
    return () => {
      live = false;
    };
  }, [tabId]);
  const visits = tiles ? [...tiles.mostVisited, ...tiles.recent] : [];
  return (
    <section className="start" data-testid="start-view" aria-label="New tab">
      <FrostMark className="start-mark" />
      <h1 className="start-wordmark">frost</h1>
      <p className="start-hint">Search or enter address</p>
      {visits.length > 0 ? (
        <section className="jump" data-testid="jump-back-in" aria-labelledby="jump-title">
          <h2 className="jump-title" id="jump-title">
            {JUMP_BACK_IN_TITLE}
          </h2>
          <ul className="jump-tiles">
            {visits.map((visit) => (
              <Tile key={visit.url} visit={visit} />
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
