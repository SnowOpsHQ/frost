import { useMemo, useState } from 'react';
import { filterLinks, linkCounts, relFlags, type LinkFilter, type PageLink, type SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { LINK_REL_FILTERS, LINK_REL_FLAGS, LINK_TYPE_FILTERS, type LinkRelFilter, type LinkTypeFilter } from '@app/specs/seo-sidebar.spec';
import { CopyIcon, SearchIcon } from '../../icons';
import { actions } from '../../ipc';
import { formatCount, linkQuery } from '../../seo-view';
import { auditRef, Flash, HighlightToggle, PanelIssues, UrlActions, useFlash } from './actions';
import { PageText } from './parts';
// Phase 2.5 Task 7 (`seo-checks.feature.md`): the link check, its row status and "Broken only".
import type { LinkCheckResult } from '@app/specs/seo-checks.spec';
import { IDLE_LINK_RUN } from '@app/specs/seo-checks.spec';
import { checksFor, linkResultIndex } from '../../checks-view';
import { useChecks } from '../../hooks/useChecks';
import { LinkChecks, LinkStatusChip } from './LinkChecks';

// Links (acceptance `seo-panels.feature.md`, Links): the page's links (the snapshot's first
// `maxLinks`) with their type, rel flags and target; filters by type and rel and a text search;
// Copy as CSV (main formats the filtered rows and writes its own clipboard); the highlight toggle.
// Every href is text: a row opens its actions (open in a background tab through main, copy).

const TYPE_LABELS: Readonly<Record<LinkTypeFilter, string>> = { all: 'All', internal: 'Internal', external: 'External', other: 'Other' };
const REL_LABELS: Readonly<Record<LinkRelFilter, string>> = { all: 'Any rel', nofollow: 'nofollow', sponsored: 'sponsored', ugc: 'ugc', followed: 'Followed (none of them)' };
const KIND_TAG: Readonly<Record<PageLink['kind'], string>> = { internal: 'int', external: 'ext', other: 'other' };

function LinkRow({
  link,
  audit,
  open,
  onToggle,
  tabId,
  flash,
  result,
  checking,
}: {
  readonly result: LinkCheckResult | undefined;
  readonly checking: boolean;
  readonly link: PageLink;
  readonly audit: SeoAudit;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly tabId: number;
  readonly flash: (message: string) => void;
}) {
  const flags = relFlags(link);
  return (
    <li className="seo-table-row" data-testid="seo-link-row" data-kind={link.kind} data-rel={LINK_REL_FLAGS.filter((flag) => flags[flag]).join(' ')} data-open={open} data-status={result?.kind ?? ''}>
      <button type="button" className="seo-table-main" aria-expanded={open} onClick={onToggle}>
        <span className="seo-table-line">
          <span className="seo-kind" data-kind={link.kind}>
            {KIND_TAG[link.kind]}
          </span>
          {link.text === '' ? <span className="seo-missing seo-table-title">No anchor text</span> : <PageText value={link.text} className="seo-table-title" testId="seo-link-text" />}
          {LINK_REL_FLAGS.filter((flag) => flags[flag]).map((flag) => (
            <span key={flag} className="seo-flag" data-flag={flag}>
              {flag}
            </span>
          ))}
          {link.target !== null && link.target !== '' ? <PageText value={`target ${link.target}`} className="seo-flag seo-flag-plain" /> : null}
          <LinkStatusChip result={result} pending={checking} />
        </span>
        {link.href === '' ? <span className="seo-missing seo-table-sub">No usable URL</span> : <PageText value={link.href} className="seo-table-sub seo-mono" testId="seo-link-href" />}
      </button>
      {open ? <UrlActions tabId={tabId} audit={audit} url={link.href} flash={flash} /> : null}
    </li>
  );
}

export function Links({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [type, setType] = useState<LinkTypeFilter>('all');
  const [rel, setRel] = useState<LinkRelFilter>('all');
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [message, flash] = useFlash();
  const page = audit.page;
  const list = page.linkList;
  const filter: LinkFilter = { type, rel, query: linkQuery(query) };
  const counts = useMemo(() => linkCounts(list), [list]);
  const rows = useMemo(() => filterLinks(list, filter), [list, type, rel, filter.query]);
  const capped = page.links.total > list.length;
  const linkRun = checksFor(useChecks(tab.id), tab.id)?.links ?? IDLE_LINK_RUN;
  const resultOf = useMemo(() => linkResultIndex(linkRun), [linkRun]);
  const [brokenOnly, setBrokenOnly] = useState(false);
  const shown = brokenOnly ? rows.filter((link) => resultOf(link)?.kind === 'broken') : rows;
  return (
    <div className="seo-links" data-testid="seo-links">
      <PanelIssues audit={audit} categories={['links']} clean="No link issues found." />

      <section className="seo-section" data-testid="seo-links-section">
        <header className="seo-section-head">
          <h3 className="seo-section-title">Links</h3>
          <span className="seo-badge" data-testid="seo-links-total-count">
            {formatCount(page.links.total)}
          </span>
        </header>
        <div className="seo-stats seo-stats-3">
          <div className="seo-stat">
            <span className="seo-stat-value" data-testid="seo-links-count-internal">
              {formatCount(counts.internal)}
            </span>
            <span className="seo-stat-label">Internal</span>
          </div>
          <div className="seo-stat">
            <span className="seo-stat-value" data-testid="seo-links-count-external">
              {formatCount(counts.external)}
            </span>
            <span className="seo-stat-label">External</span>
          </div>
          <div className="seo-stat">
            <span className="seo-stat-value" data-testid="seo-links-count-other">
              {formatCount(counts.other)}
            </span>
            <span className="seo-stat-label">Other</span>
          </div>
        </div>
        <p className="seo-rel-counts" data-testid="seo-links-rel-counts">
          {LINK_REL_FLAGS.map((flag) => (
            <span key={flag} className="seo-rel-count">
              <span className="seo-flag" data-flag={flag}>
                {flag}
              </span>
              <span data-testid={`seo-links-count-${flag}`}>{formatCount(counts[flag])}</span>
            </span>
          ))}
        </p>
        {capped ? (
          <p className="seo-note" data-testid="seo-links-capped">
            Showing the first {formatCount(list.length)} of {formatCount(page.links.total)} links.
          </p>
        ) : null}
        <div className="seo-panel-tools">
          <HighlightToggle tab={tab} mode="links" label="Highlight on page" testId="seo-highlight-links" />
          <button
            type="button"
            className="seo-toggle"
            data-testid="seo-links-copy-csv"
            disabled={rows.length === 0}
            onClick={() => {
              void actions.copyLinksCsv(tab.id, auditRef(audit), filter).then((copied) => flash(copied === null ? 'Nothing to copy' : `Copied ${formatCount(copied)} ${copied === 1 ? 'link' : 'links'} as CSV`));
            }}
          >
            <CopyIcon />
            <span>Copy as CSV</span>
          </button>
        </div>
      </section>

      <LinkChecks
        tab={tab}
        run={linkRun}
        brokenOnly={brokenOnly}
        onBrokenOnly={(on) => {
          setBrokenOnly(on);
          setOpenRow(null);
        }}
      />

      <section className="seo-section seo-table-section">
        <div className="seo-filters">
          <label className="seo-search">
            <SearchIcon />
            <input
              type="search"
              className="seo-search-input"
              data-testid="seo-links-search"
              placeholder="Search URLs and anchor text"
              aria-label="Search links"
              value={query}
              spellCheck={false}
              onChange={(event) => {
                setQuery(linkQuery(event.target.value));
                setOpenRow(null);
              }}
            />
          </label>
          <div className="seo-segmented" role="group" aria-label="Link type">
            {LINK_TYPE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className="seo-segment"
                data-testid="seo-links-type"
                data-type={value}
                aria-pressed={type === value}
                onClick={() => {
                  setType(value);
                  setOpenRow(null);
                }}
              >
                {TYPE_LABELS[value]}
                <span className="seo-segment-count">{formatCount(value === 'all' ? counts.all : counts[value])}</span>
              </button>
            ))}
          </div>
          <select
            className="seo-select"
            data-testid="seo-links-rel"
            aria-label="Rel"
            value={rel}
            onChange={(event) => {
              setRel(event.target.value as LinkRelFilter);
              setOpenRow(null);
            }}
          >
            {LINK_REL_FILTERS.map((value) => (
              <option key={value} value={value}>
                {REL_LABELS[value]}
                {value === 'all' ? '' : ` (${formatCount(counts[value])})`}
              </option>
            ))}
          </select>
        </div>
        <p className="seo-table-count" data-testid="seo-links-shown" data-count={shown.length}>
          {shown.length === list.length ? `${formatCount(shown.length)} ${shown.length === 1 ? 'link' : 'links'}` : `${formatCount(shown.length)} of ${formatCount(list.length)} links match`}
        </p>
        {shown.length === 0 ? (
          <p className="seo-empty-line">{list.length === 0 ? 'This page has no links.' : 'No links match these filters.'}</p>
        ) : (
          <ul className="seo-table" data-testid="seo-links-table" aria-label="Links">
            {shown.map((link, index) => (
              <LinkRow key={index} link={link} audit={audit} open={openRow === index} onToggle={() => setOpenRow(openRow === index ? null : index)} tabId={tab.id} flash={flash} result={resultOf(link)} checking={linkRun.status === 'running'} />
            ))}
          </ul>
        )}
      </section>
      <Flash message={message} testId="seo-links-flash" />
    </div>
  );
}
