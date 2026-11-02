import { GSC_TARGETS_COPY } from '@app/specs/gsc-targets.spec';
import { suggestionsView, targetPagesView, type GscSuggestionsView, type GscTargetPagesView } from '../../content-gsc-view';
import { useContentGscTargets } from '../../hooks/useContentGscTargets';
import type { ContentNotesApi } from '../../hooks/useContentNotes';
import { PageText } from './parts';
import '../../gsc-targets.css';

// Search Console targets under the Content panel's target query (Phase 9 Task 5; spec `gsc-targets.spec.ts`;
// acceptance `seo-content.feature.md`, "Search Console targets"): the page's top queries, each with "Use
// as target", and for the target query the property's pages Google showed for it, this page marked.
// Renders nothing (the panel is as before) unless Search Console is configured and connected. Facts
// only: no rule, score, tone or colour depends on them, and another page leading looks the same as this
// one leading. Queries and page URLs from Google are inert, bidi-isolated text (`PageText`), never links.

function Suggestions({ view, loaded, onUse }: { readonly view: GscSuggestionsView; readonly loaded: boolean; readonly onUse: (query: string) => void }) {
  return (
    <div className="gsc-targets-part" data-testid="gsc-target-suggestions" data-state={view.state}>
      <h4 className="gsc-targets-title">{GSC_TARGETS_COPY.suggestionsTitle}</h4>
      {view.state === 'list' ? (
        <>
          <ul className="gsc-targets-list">
            {view.items.map((item) => (
              <li key={item.query} className="gsc-targets-row" data-testid="gsc-target-suggestion" data-target={item.isTarget}>
                <PageText value={item.query} className="gsc-targets-text" testId="gsc-target-suggestion-query" />
                <span className="gsc-targets-metric">{item.clicks} clicks</span>
                {item.isTarget ? (
                  <span className="gsc-targets-current" data-testid="gsc-target-current">
                    {GSC_TARGETS_COPY.currentTarget}
                  </span>
                ) : (
                  <button type="button" className="seo-chip-button gsc-targets-use" data-testid="gsc-target-use" aria-label={item.label} disabled={!loaded} onClick={() => onUse(item.target)}>
                    {GSC_TARGETS_COPY.useAsTarget}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="seo-note" data-testid="gsc-target-suggestions-note">
            {view.note}
          </p>
        </>
      ) : (
        <p className="seo-empty-line" data-testid="gsc-target-suggestions-message">
          {view.message}
        </p>
      )}
    </div>
  );
}

function TargetPages({ view }: { readonly view: GscTargetPagesView }) {
  return (
    <div className="gsc-targets-part" data-testid="gsc-target-pages" data-state={view.state}>
      <h4 className="gsc-targets-title">{GSC_TARGETS_COPY.pagesTitle}</h4>
      {view.state === 'list' ? (
        <>
          <ol className="gsc-targets-list">
            {view.items.map((item) => (
              <li key={item.rank} className="gsc-targets-row" data-testid="gsc-target-page" data-this-page={item.thisPage}>
                <span className="gsc-targets-rank">{item.rank}</span>
                <PageText value={item.page} className="gsc-targets-text seo-mono" testId="gsc-target-page-url" />
                {item.thisPage ? (
                  <span className="gsc-targets-current" data-testid="gsc-target-this-page">
                    {GSC_TARGETS_COPY.thisPage}
                  </span>
                ) : null}
                <span className="gsc-targets-metric">{item.clicks} clicks</span>
              </li>
            ))}
          </ol>
          <p className="seo-note" data-testid="gsc-target-pages-summary">
            {view.summary}
          </p>
          {view.cap !== null ? (
            <p className="seo-note" data-testid="gsc-target-pages-cap">
              {view.cap}
            </p>
          ) : null}
          <p className="seo-note" data-testid="gsc-target-pages-facts">
            {view.facts}
          </p>
        </>
      ) : (
        <p className="seo-empty-line" data-testid="gsc-target-pages-message">
          {view.message}
        </p>
      )}
    </div>
  );
}

/** `url`: the page the notes are for (`audit.url`); `notes`: the panel's notes for it (`useContentNotes`). */
export function ContentGscTargets({ url, notes }: { readonly url: string; readonly notes: ContentNotesApi }) {
  const reads = useContentGscTargets(url, notes.query);
  if (!reads.shown) return null;
  const suggestions = suggestionsView(reads.suggestions, notes.query, url, reads.rangePhrase);
  const pages = reads.checking ? targetPagesView(reads.pages, url, reads.rangePhrase) : null;
  if (suggestions === null && pages === null) return null;
  // "Use as target": the field shows it, and it is saved at once with the notes' generation.
  const use = (query: string) => {
    notes.setQuery(query);
    void notes.flush();
  };
  return (
    <div className="gsc-targets" data-testid="gsc-targets">
      {suggestions !== null ? <Suggestions view={suggestions} loaded={notes.loaded} onUse={use} /> : null}
      {pages !== null ? <TargetPages view={pages} /> : null}
    </div>
  );
}
