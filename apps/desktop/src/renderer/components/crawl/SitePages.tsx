import { useEffect, useState } from 'react';
// Type-only from the Zod spec (its schemas must stay out of this bundle: strict Trusted Types).
import type { CrawlPageFilter, CrawlPagesAnswer } from '@app/specs/site-crawl.schema';
import {
  CRAWL_INDEXABLE_FILTERS,
  CRAWL_LIMITS,
  CRAWL_PAGE_FILTER_LABELS,
  CRAWL_PAGE_SORT_LABELS,
  CRAWL_PAGE_SORTS,
  CRAWL_REFUSAL_TEXT,
  CRAWL_RULE_IDS,
  CRAWL_STATUS_CLASSES,
  CRAWL_VIEW_TEXT,
  type CrawlIndexableFilter,
  type CrawlPageSort,
  type CrawlStatusClass,
} from '@app/specs/site-crawl.spec';
import { CRAWL_PAGE_COLUMNS, DEFAULT_PAGES_QUERY, csvAnswerText, findingTitle, openTargetOf, pageFlagsText, pagesQueryWith, pagingOf, robotsText, type CrawlPagesQuery } from '../../crawl-view';
import { crawlActions } from './crawl-actions';

// The crawl sheet's Pages view (Phase 12 Task 7, SL-096; acceptance `site-crawl.feature.md`, Pages and
// Site structure: Pages): one run's pages, a page at a time (`crawl.pages`, at most
// `CRAWL_PAGES_LIMITS.maxPageSize` rows), filtered and sorted in main's SQL; never a full list here. The
// score column is `CRAWL_SCORE_LABEL`; a page whose links were cut or that looks client-rendered is marked;
// each page opens in the active tab through the address bar's path ("Open in tab"). Export CSV asks main
// to write the filtered pages where the user picks. Page text is React text in a `<bdi>`; links are not
// clickable (only "Open in tab" opens one).

const STATUS_LABELS: Readonly<Record<CrawlStatusClass, string>> = { '2xx': '2xx', '3xx': '3xx', '4xx': '4xx', '5xx': '5xx', none: 'No answer' };
const INDEXABLE_LABELS: Readonly<Record<CrawlIndexableFilter, string>> = { yes: 'Yes', no: 'No', unknown: 'Not judged' };
const ANY = '';

const yesNo = (value: boolean | null): string => (value === null ? '—' : value ? 'Yes' : 'No');
const numberOr = (value: number | null): string => (value === null ? '—' : String(value));

export function SitePages({ runId, refreshKey, onOpenUrl }: { readonly runId: string; readonly refreshKey: string; readonly onOpenUrl: (url: string) => void }) {
  const [query, setQuery] = useState<CrawlPagesQuery>(DEFAULT_PAGES_QUERY);
  const [answer, setAnswer] = useState<CrawlPagesAnswer | null | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // Another run starts from the first page, unfiltered.
  useEffect(() => setQuery(DEFAULT_PAGES_QUERY), [runId]);
  useEffect(() => {
    let live = true;
    void crawlActions.pages({ runId, ...query }).then((next) => {
      if (live) setAnswer(next);
    });
    return () => {
      live = false;
    };
  }, [runId, query, refreshKey]);

  const filter = (change: { readonly [K in keyof CrawlPageFilter]?: CrawlPageFilter[K] | undefined }) => setQuery((was) => pagesQueryWith(was, { filter: change }));
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    setNote(null);
    const result = await crawlActions.exportCsv({ runId, filter: query.filter, sort: query.sort, direction: query.direction });
    setExporting(false);
    setNote(csvAnswerText(result));
  };
  const total = answer !== null && answer !== 'loading' && answer.status === 'ok' ? answer.total : 0;
  const paging = pagingOf(query, total);

  return (
    <section className="crawl-pages" aria-label={CRAWL_VIEW_TEXT.pagesTab}>
      <div className="crawl-toolbar" role="group" aria-label="Filter and sort pages">
        <label className="crawl-field">
          <span>{CRAWL_PAGE_FILTER_LABELS.status}</span>
          <select className="crawl-select" data-testid="crawl-filter-status" value={query.filter.status ?? ANY} onChange={(event) => filter({ status: (event.target.value || undefined) as CrawlStatusClass | undefined })}>
            <option value={ANY}>Any</option>
            {CRAWL_STATUS_CLASSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-field">
          <span>{CRAWL_PAGE_FILTER_LABELS.indexable}</span>
          <select className="crawl-select" data-testid="crawl-filter-indexable" value={query.filter.indexable ?? ANY} onChange={(event) => filter({ indexable: (event.target.value || undefined) as CrawlIndexableFilter | undefined })}>
            <option value={ANY}>Any</option>
            {CRAWL_INDEXABLE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {INDEXABLE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-field">
          <span>{CRAWL_PAGE_FILTER_LABELS.finding}</span>
          <select className="crawl-select crawl-select-wide" data-testid="crawl-filter-finding" value={query.filter.finding ?? ANY} onChange={(event) => filter({ finding: (event.target.value || undefined) as CrawlPageFilter['finding'] })}>
            <option value={ANY}>Any</option>
            {CRAWL_RULE_IDS.map((id) => (
              <option key={id} value={id}>
                {findingTitle(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-field">
          <span>{CRAWL_PAGE_FILTER_LABELS.depth}</span>
          <select className="crawl-select" data-testid="crawl-filter-depth" value={query.filter.depth === undefined ? ANY : String(query.filter.depth)} onChange={(event) => filter({ depth: event.target.value === ANY ? undefined : Number(event.target.value) })}>
            <option value={ANY}>Any</option>
            {Array.from({ length: CRAWL_LIMITS.maxDepth + 1 }, (_, depth) => (
              <option key={depth} value={String(depth)}>
                {depth}
              </option>
            ))}
          </select>
        </label>
        <label className="crawl-check">
          <input type="checkbox" data-testid="crawl-filter-links-cut" checked={query.filter.linksCut === true} onChange={(event) => filter({ linksCut: event.target.checked ? true : undefined })} />
          <span>{CRAWL_PAGE_FILTER_LABELS.linksCut}</span>
        </label>
        <label className="crawl-field">
          <span>Sort</span>
          <select className="crawl-select" data-testid="crawl-sort" value={query.sort} onChange={(event) => setQuery((was) => pagesQueryWith(was, { sort: event.target.value as CrawlPageSort }))}>
            {CRAWL_PAGE_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {CRAWL_PAGE_SORT_LABELS[sort]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="panel-button" data-testid="crawl-sort-direction" aria-label={query.direction === 'asc' ? 'Ascending; sort descending' : 'Descending; sort ascending'} onClick={() => setQuery((was) => pagesQueryWith(was, { direction: was.direction === 'asc' ? 'desc' : 'asc' }))}>
          <span>{query.direction === 'asc' ? 'Ascending' : 'Descending'}</span>
        </button>
        <span className="crawl-gap" />
        <button type="button" className="panel-button" data-testid="crawl-export" aria-disabled={exporting || undefined} onClick={() => void exportCsv()}>
          <span>{CRAWL_VIEW_TEXT.exportCsv}</span>
        </button>
      </div>
      <p className="crawl-note" role="status" data-testid="crawl-pages-note">
        {note}
      </p>
      {answer === 'loading' ? <p className="crawl-note">Loading pages…</p> : null}
      {answer === null ? <p className="crawl-note">{CRAWL_REFUSAL_TEXT['store-failed']}</p> : null}
      {answer !== null && answer !== 'loading' && answer.status === 'refused' ? <p className="crawl-note">{CRAWL_REFUSAL_TEXT[answer.reason]}</p> : null}
      {answer !== null && answer !== 'loading' && answer.status === 'ok' ? (
        <>
          <div className="crawl-table-wrap" data-testid="crawl-pages">
            <table className="crawl-table">
              <thead>
                <tr>
                  {CRAWL_PAGE_COLUMNS.map((column) => (
                    <th key={column.id} scope="col">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {answer.rows.map((row) => {
                  const target = openTargetOf(row);
                  const flags = pageFlagsText(row);
                  return (
                    <tr key={row.url} data-testid="crawl-page">
                      <th scope="row" className="crawl-url-cell">
                        <bdi className="crawl-url" dir="auto" title={row.url}>
                          {row.url}
                        </bdi>
                        {row.title !== null ? (
                          <bdi className="crawl-page-title" dir="auto" title={row.title}>
                            {row.title}
                          </bdi>
                        ) : null}
                        {target !== null ? (
                          <button type="button" className="crawl-link-button" data-testid="crawl-open-in-tab" onClick={() => onOpenUrl(target)}>
                            {CRAWL_VIEW_TEXT.openInTab}
                          </button>
                        ) : null}
                      </th>
                      <td title={row.outcome}>{row.status === null ? row.outcome : row.status}</td>
                      <td>{yesNo(row.indexable)}</td>
                      <td>{row.depth}</td>
                      <td>{row.inlinks}</td>
                      <td>{numberOr(row.wordCount)}</td>
                      <td data-testid="crawl-page-robots">{robotsText(row)}</td>
                      <td>{numberOr(row.score)}</td>
                      <td title={row.findings.map((finding) => findingTitle(finding.id)).join('\n')}>{row.findings.length}</td>
                      <td data-testid="crawl-page-flags">{flags.join('; ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="crawl-paging">
            <button type="button" className="panel-button" data-testid="crawl-prev" disabled={paging.prev === null} onClick={() => paging.prev !== null && setQuery((was) => pagesQueryWith(was, { offset: paging.prev! }))}>
              <span>Previous</span>
            </button>
            <span className="crawl-note" data-testid="crawl-range">
              {paging.text}
            </span>
            <button type="button" className="panel-button" data-testid="crawl-next" disabled={paging.next === null} onClick={() => paging.next !== null && setQuery((was) => pagesQueryWith(was, { offset: paging.next! }))}>
              <span>Next</span>
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
