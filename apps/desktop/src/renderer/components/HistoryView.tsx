import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { HistoryCursorAnswer, HistoryVisitAnswer } from '@app/ipc-contract';
import { HISTORY_EMPTY_MESSAGE, HISTORY_NO_MATCHES, HISTORY_QUERY_MAX_CHARS, HISTORY_TITLE } from '@app/specs/browser-polish.spec';
import { browserPolishPaletteSources } from '../browser-polish-palette';
import { appendPage, groupByDay, monogram, visitHost, visitLabel, visitTime } from '../history-view';
import { CloseIcon, OpenTabIcon, SearchIcon } from '../icons';
import { actions } from '../ipc';
import { registerPaletteActions } from '../palette/registry';
import { isolatedTooltip } from '../seo-view';

// The History view (spec `browser-polish.spec.ts`; acceptance `browser-polish.feature.md`, History
// view): a sheet that fills the page column while open (the page area below shrinks to nothing, so
// nothing is drawn over the tab's view). It lists `recent_visits` newest first, grouped by day, a page
// at a time, with search, open (here or in a new background tab), delete and "Clear all history"
// (main asks first). Every title and URL is React text, bidi-isolated: rendered inert, no links, no
// favicons. Styling is the bundled styles.css only (strict CSP).

// Browser polish's palette actions (find, reopen tab, history, search engine), once per module instance.
const unregisterPolishActions = registerPaletteActions(...browserPolishPaletteSources(actions));
import.meta.hot?.dispose(unregisterPolishActions);

/** How long typing settles before the search runs. */
const SEARCH_DEBOUNCE_MS = 150;

interface Listing {
  readonly query: string;
  readonly visits: readonly HistoryVisitAnswer[];
  readonly next: HistoryCursorAnswer | null;
  readonly loading: boolean;
}

function VisitRow({ visit, onOpen, onRemove }: { readonly visit: HistoryVisitAnswer; readonly onOpen: (visit: HistoryVisitAnswer, background: boolean) => void; readonly onRemove: (visit: HistoryVisitAnswer) => void }) {
  const label = visitLabel(visit);
  const host = visitHost(visit.url);
  const open = (event: MouseEvent<HTMLButtonElement>) => onOpen(visit, event.metaKey || event.ctrlKey || event.button === 1);
  return (
    <li className="history-row" data-testid="history-row" data-url={visit.url}>
      <span className="history-time">{visitTime(visit.lastVisitAt)}</span>
      <button
        type="button"
        className="history-open"
        data-testid="history-open"
        title={isolatedTooltip(visit.url)}
        onClick={open}
        onAuxClick={(event) => {
          if (event.button === 1) open(event);
        }}
      >
        <span className="history-monogram" aria-hidden="true">
          {monogram(visit.url)}
        </span>
        <bdi className="history-label" dir="auto">
          {label}
        </bdi>
        <bdi className="history-host" dir="auto">
          {host}
        </bdi>
      </button>
      <button type="button" className="history-action" data-testid="history-new-tab" aria-label={`Open ${label} in a new tab`} title="Open in a new tab" onClick={() => onOpen(visit, true)}>
        <OpenTabIcon />
      </button>
      <button type="button" className="history-action" data-testid="history-delete" aria-label={`Delete ${label} from history`} title="Delete from history" onClick={() => onRemove(visit)}>
        <CloseIcon />
      </button>
    </li>
  );
}

export function HistoryView({ onClose }: { readonly onClose: () => void }) {
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<Listing>({ query: '', visits: [], next: null, loading: true });
  /** Bumped by each new listing, so a slow answer for an old query never lands. */
  const generation = useRef(0);

  const load = useCallback((text: string) => {
    const mine = ++generation.current;
    setListing((current) => ({ ...current, loading: true }));
    void actions.historyList(text, null).then((page) => {
      if (generation.current === mine) setListing({ query: text, visits: page.visits, next: page.next, loading: false });
    });
  }, []);

  const more = () => {
    const { next, query: text } = listing;
    if (!next) return;
    const mine = generation.current;
    setListing((current) => ({ ...current, loading: true }));
    void actions.historyList(text, next).then((page) => {
      if (generation.current === mine) setListing((current) => ({ query: text, visits: appendPage(current.visits, page.visits), next: page.next, loading: false }));
    });
  };

  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => load(query), query === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, load]);

  const close = () => {
    onClose();
    void actions.focusPage();
  };
  const openVisit = (visit: HistoryVisitAnswer, background: boolean) => {
    if (background) {
      void actions.openBackgroundTab(visit.url);
      return;
    }
    onClose();
    void actions.navigate(visit.url);
  };
  const removeVisit = (visit: HistoryVisitAnswer) => {
    void actions.removeVisit(visit.url).then((removed) => {
      if (removed) setListing((current) => ({ ...current, visits: current.visits.filter((v) => v.url !== visit.url) }));
    });
  };
  const clearAll = () => {
    void actions.clearHistory().then((cleared) => {
      if (cleared) load(query);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
  };

  const days = groupByDay(listing.visits, Date.now());
  const empty = !listing.loading && listing.visits.length === 0;
  return (
    <section className="history-sheet" data-testid="history-view" aria-labelledby="history-title" onKeyDown={onKeyDown}>
      <div className="history">
        <header className="history-header">
          <h1 className="history-title" id="history-title">
            {HISTORY_TITLE}
          </h1>
          <label className="history-search">
            <SearchIcon />
            <input
              ref={search}
              className="history-search-input"
              data-testid="history-search"
              type="search"
              spellCheck={false}
              autoComplete="off"
              placeholder="Search history"
              aria-label="Search history"
              maxLength={HISTORY_QUERY_MAX_CHARS}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="button" className="history-clear" data-testid="history-clear-all" onClick={clearAll}>
            Clear all history
          </button>
          <button type="button" className="history-close" data-testid="history-close" aria-label="Close history" title="Close (Esc)" onClick={close}>
            <CloseIcon />
          </button>
        </header>
        <div className="history-list" data-testid="history-list" aria-busy={listing.loading}>
          {empty ? (
            <p className="history-empty" data-testid="history-empty">
              {listing.query.trim() === '' ? HISTORY_EMPTY_MESSAGE : HISTORY_NO_MATCHES}
            </p>
          ) : null}
          {days.map((day) => (
            <section key={day.key} className="history-day" aria-label={day.label}>
              <h2 className="history-day-label">{day.label}</h2>
              <ul className="history-rows">
                {day.visits.map((visit) => (
                  <VisitRow key={visit.url} visit={visit} onOpen={openVisit} onRemove={removeVisit} />
                ))}
              </ul>
            </section>
          ))}
          {listing.next ? (
            <button type="button" className="history-more" data-testid="history-more" disabled={listing.loading} onClick={more}>
              Show more
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
