import { useEffect, useState } from 'react';
import type { HistoryVisitAnswer, JumpBackInAnswer } from '@app/ipc-contract';
import { ADDRESS_PROMPT, JUMP_BACK_IN_TITLE } from '@app/specs/browser-polish.spec';
import { monogram, visitHost, visitLabel } from '../history-view';
import { useAddressInput } from '../hooks/useAddressInput';
import { FrostMark, SearchIcon } from '../icons';
import { actions } from '../ipc';
import { isolatedTooltip } from '../seo-view';
import { SetupChecklist } from './SetupChecklist';

// An empty tab's start view in the browser chrome (`App.tsx`; spec `browser-chrome.feature.md`, Layout). Styling is the
// bundled styles.css only (strict CSP). "Jump back in" (spec `browser-polish.feature.md`, New-tab page):
// the most visited and recent pages from the local `recent_visits`, as frost-drawn tiles (a monogram,
// the title and the host as text; no favicon, nothing remote); a tile opens its page in this tab.
// Phase 11 Task 11 (`help.feature.md`): the setup checklist under it, from local state only.
// UI polish round 2 (`browser-polish.feature.md`, New-tab page): a search field under the wordmark, on the
// address bar's own path (`useAddressInput`); it never takes focus by itself (the address bar keeps the caret).

/** The start view's search field: the address bar's behaviour in a larger frame. Its tab is empty (url ''). */
function StartSearch({ tabId }: { readonly tabId: number | undefined }) {
  const { inputProps } = useAddressInput({ id: tabId, url: '', loading: false });
  return (
    <search className="start-search" data-testid="start-search">
      <label className="start-search-field">
        <SearchIcon className="start-search-icon" />
        <input {...inputProps} data-testid="start-search-input" className="start-search-input" aria-label={ADDRESS_PROMPT} placeholder={ADDRESS_PROMPT} />
      </label>
    </search>
  );
}

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
      <StartSearch tabId={tabId} />
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
      <SetupChecklist tabId={tabId} />
    </section>
  );
}
