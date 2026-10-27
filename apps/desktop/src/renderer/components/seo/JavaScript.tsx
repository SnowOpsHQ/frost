import { useState, type ReactNode } from 'react';
import type { JavascriptComparison, JsFieldDiff, JsListDiff, JsListItem, SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import { FETCH_DISCLOSURE } from '@app/specs/fetcher.spec';
import {
  JS_CRAWLER_NOTE,
  JS_FIELD_STATUS_LABELS,
  JS_PARTIAL_NOTE,
  JS_VERDICT_LABELS,
  JS_VERDICT_SUMMARIES,
  SERVED_RETRYABLE_REASONS,
  SERVED_UNAVAILABLE_MESSAGES,
  type JsFieldStatus,
  type ServedUnavailableReason,
} from '@app/specs/seo-javascript.spec';
import { OpenTabIcon, ReloadIcon } from '../../icons';
import { actions, ipc } from '../../ipc';
import { javascriptPaletteSources } from '../../javascript-palette';
import { registerPaletteActions } from '../../palette/registry';
import { formatCount, openableUrl } from '../../seo-view';
import { Flash, PanelIssues, useFlash } from './actions';
import { JavascriptIcon } from './javascript-icons';
import { FactRow, PageText, Section } from './parts';

// The JavaScript panel (acceptance `seo-javascript.feature.md`, Panel): the served HTML compared
// with the rendered page. Its state (pending, unavailable with the reason, identical, ready), the
// verdict with its measures, how the served HTML was fetched, the `javascript` issues, the per-field
// comparison, and what JavaScript added or removed (links, headings, structured data). Everything
// page- or server-derived is React text (`PageText`); URLs open only through "Open" buttons
// (`browser.openBackgroundTab`, http(s) only).

// The command palette's JavaScript actions (`javascript-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...javascriptPaletteSources({ refetchServed: (tabId) => ipc.javascript.refetchServed.mutate({ tabId }).catch(() => false) }));
import.meta.hot?.dispose(unregisterPaletteActions);

const CATEGORIES = ['javascript'] as const;
const RETRYABLE: ReadonlySet<ServedUnavailableReason> = new Set(SERVED_RETRYABLE_REASONS);
/** List entries shown before "Show more", and how many more each press shows. */
const FIRST_ROWS = 20;

const STATUS_TONE: Readonly<Record<JsFieldStatus, 'ok' | 'warn' | 'muted'>> = { same: 'ok', changed: 'warn', 'only-served': 'warn', 'only-rendered': 'warn' };

function Pill({ tone, children, testId }: { readonly tone: 'ok' | 'warn' | 'error' | 'muted'; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <span className="seo-pill" data-tone={tone} data-testid={testId}>
      {children}
    </span>
  );
}

function RefetchButton({ tab, flash }: { readonly tab: TabState; readonly flash: (message: string) => void }) {
  return (
    <button
      type="button"
      className="panel-button seo-js-refetch"
      data-testid="seo-js-refetch"
      onClick={() =>
        void ipc.javascript.refetchServed
          .mutate({ tabId: tab.id })
          .catch(() => false)
          .then((started) => flash(started ? 'Fetching the served HTML again' : 'Could not fetch again'))
      }
    >
      <ReloadIcon />
      <span>Fetch again</span>
    </button>
  );
}

/** The state card: pending, unavailable, identical or the verdict. */
function StateCard({ audit, tab, flash }: { readonly audit: SeoAudit; readonly tab: TabState; readonly flash: (message: string) => void }) {
  const report = audit.javascript;
  if (report.status === 'pending') {
    return (
      <section className="seo-verdict seo-js-state" data-verdict="pending" data-testid="seo-js-state" data-state="pending">
        <p className="seo-robots-pending">
          <span className="seo-robots-pending-dot" aria-hidden="true" />
          Fetching the page as the server sends it…
        </p>
      </section>
    );
  }
  if (report.status === 'unavailable') {
    const message = SERVED_UNAVAILABLE_MESSAGES[report.reason].replace('{status}', report.httpStatus === null ? '' : String(report.httpStatus));
    return (
      <section className="seo-verdict seo-js-state" data-verdict="unavailable" data-testid="seo-js-state" data-state="unavailable" data-reason={report.reason}>
        <span className="seo-eyebrow">Served HTML unavailable</span>
        <p className="seo-verdict-summary" data-testid="seo-js-unavailable-message">
          {message}
        </p>
        {report.finalUrl ? <FactRow label="Answered by" value={report.finalUrl} mono /> : null}
        {RETRYABLE.has(report.reason) ? <RefetchButton tab={tab} flash={flash} /> : null}
      </section>
    );
  }
  const { metrics } = report;
  const tone = report.verdict === 'independent' ? 'ok' : report.verdict === 'partly' ? 'warn' : 'error';
  return (
    <section className="seo-verdict seo-js-state" data-verdict={`js-${report.verdict}`} data-testid="seo-js-state" data-state={report.status} data-js-verdict={report.verdict}>
      <div className="seo-verdict-head">
        <span className="seo-verdict-icon" aria-hidden="true">
          <JavascriptIcon />
        </span>
        <span className="seo-verdict-text">
          <span className="seo-eyebrow">{report.status === 'identical' ? 'Identical' : 'Verdict'}</span>
          <span className="seo-verdict-label" data-testid="seo-js-verdict">
            {JS_VERDICT_LABELS[report.verdict]}
          </span>
        </span>
      </div>
      <p className="seo-verdict-summary">
        {report.status === 'identical' ? 'The served HTML and the rendered page read the same for every compared field.' : JS_VERDICT_SUMMARIES[report.verdict]}
      </p>
      <ul className="seo-signals" aria-label="Measures">
        <li className="seo-signal" data-tone={tone} data-testid="seo-js-signal-words">
          <span className="seo-signal-dot" aria-hidden="true" />
          <span className="seo-signal-label">Words</span>
          <span className="seo-signal-value">
            {formatCount(metrics.servedWords)} → {formatCount(metrics.renderedWords)}
          </span>
        </li>
        <li className="seo-signal" data-tone={metrics.linksAdded > 0 ? 'warn' : 'ok'} data-testid="seo-js-signal-links">
          <span className="seo-signal-dot" aria-hidden="true" />
          <span className="seo-signal-label">Links added</span>
          <span className="seo-signal-value">{formatCount(metrics.linksAdded)}</span>
        </li>
        <li className="seo-signal" data-tone={report.changed > 0 ? 'warn' : 'ok'} data-testid="seo-js-signal-fields">
          <span className="seo-signal-dot" aria-hidden="true" />
          <span className="seo-signal-label">Fields changed</span>
          <span className="seo-signal-value">{formatCount(report.changed)}</span>
        </li>
      </ul>
    </section>
  );
}

function FetchCard({ report, tab, flash }: { readonly report: JavascriptComparison; readonly tab: TabState; readonly flash: (message: string) => void }) {
  const { fetch } = report;
  return (
    <Section title="Served HTML" testId="seo-js-fetch">
      <dl className="seo-rows">
        <FactRow label="Fetched as" value={fetch.userAgent ?? 'frost’s own user agent'} testId="seo-js-user-agent" />
        <FactRow label="Status" value={String(fetch.status)} testId="seo-js-status" />
        <FactRow label="Answered by" value={fetch.finalUrl} mono />
        <FactRow label="Size" value={`${formatCount(fetch.bytes)} bytes${fetch.truncated ? ' (cut)' : ''}`} />
        <FactRow label="Redirects" value={formatCount(fetch.redirects)} />
        <FactRow label="Time" value={`${formatCount(Math.round(fetch.durationMs))} ms`} />
      </dl>
      {report.partial ? (
        <p className="seo-js-note" data-tone="warn" data-testid="seo-js-partial">
          {JS_PARTIAL_NOTE}
        </p>
      ) : null}
      <p className="seo-js-note" data-testid="seo-js-disclosure">
        {FETCH_DISCLOSURE}
      </p>
      <RefetchButton tab={tab} flash={flash} />
    </Section>
  );
}

function FieldRow({ field }: { readonly field: JsFieldDiff }) {
  return (
    <li className="seo-js-field" data-testid="seo-js-field" data-field={field.id} data-status={field.status}>
      <div className="seo-js-field-head">
        <span className="seo-js-field-label">{field.label}</span>
        <Pill tone={STATUS_TONE[field.status]}>{JS_FIELD_STATUS_LABELS[field.status]}</Pill>
      </div>
      {field.status === 'same' ? (
        field.served === null ? (
          <span className="seo-missing">Not set</span>
        ) : (
          <PageText value={field.served} className="seo-js-value" />
        )
      ) : (
        <dl className="seo-js-sides">
          <dt>Served</dt>
          <dd data-testid="seo-js-served-value">{field.served === null ? <span className="seo-missing">Not set</span> : <PageText value={field.served} lines={2} />}</dd>
          <dt>Rendered</dt>
          <dd data-testid="seo-js-rendered-value">{field.rendered === null ? <span className="seo-missing">Not set</span> : <PageText value={field.rendered} lines={2} />}</dd>
        </dl>
      )}
    </li>
  );
}

function ItemRow({ item, flash }: { readonly item: JsListItem; readonly flash: (message: string) => void }) {
  const openable = item.url !== null && openableUrl(item.url);
  return (
    <li className="seo-js-item" data-testid="seo-js-item">
      <span className="seo-js-item-text">
        <PageText value={item.label} />
        {item.detail !== '' ? <PageText value={item.detail} className="seo-js-item-detail" /> : null}
      </span>
      {item.count > 1 ? <Pill tone="muted">×{formatCount(item.count)}</Pill> : null}
      {openable ? (
        <button
          type="button"
          className="seo-action seo-js-open"
          aria-label="Open in a background tab"
          title="Open in a background tab"
          onClick={() => void actions.openBackgroundTab(item.url!).then((id) => flash(id === null ? 'Could not open a tab' : 'Opened in a background tab'))}
        >
          <OpenTabIcon />
        </button>
      ) : null}
    </li>
  );
}

function ItemList({ title, items, total, testId, flash }: { readonly title: string; readonly items: readonly JsListItem[]; readonly total: number; readonly testId: string; readonly flash: (message: string) => void }) {
  const [shown, setShown] = useState(FIRST_ROWS);
  if (total === 0) return null;
  return (
    <div className="seo-js-list" data-testid={testId} data-total={total}>
      <h4 className="seo-js-list-title">
        {title} <span className="seo-badge">{formatCount(total)}</span>
      </h4>
      <ul className="seo-js-items">
        {items.slice(0, shown).map((item) => (
          <ItemRow key={item.key} item={item} flash={flash} />
        ))}
      </ul>
      {items.length > shown ? (
        <button type="button" className="seo-action" onClick={() => setShown(shown + FIRST_ROWS)}>
          Show more
        </button>
      ) : null}
      {total > items.length ? <p className="seo-js-note">Showing the first {formatCount(items.length)}.</p> : null}
    </div>
  );
}

function ListCard({ title, diff, testId, flash }: { readonly title: string; readonly diff: JsListDiff; readonly testId: string; readonly flash: (message: string) => void }) {
  const same = diff.addedTotal === 0 && diff.removedTotal === 0;
  return (
    <Section title={title} testId={testId} badge={<span className="seo-js-counts">{`${formatCount(diff.served)} served · ${formatCount(diff.rendered)} rendered`}</span>}>
      {same ? (
        <p className="seo-empty-line seo-all-clear-line">The same in the served HTML and after JavaScript.</p>
      ) : (
        <>
          <ItemList title="Added by JavaScript" items={diff.added} total={diff.addedTotal} testId={`${testId}-added`} flash={flash} />
          <ItemList title="Only in served HTML" items={diff.removed} total={diff.removedTotal} testId={`${testId}-removed`} flash={flash} />
        </>
      )}
    </Section>
  );
}

export function JavaScript({ audit, tab }: { readonly audit: SeoAudit; readonly tab: TabState }) {
  const [message, flash] = useFlash();
  const report = audit.javascript;
  const comparison = report.status === 'ready' || report.status === 'identical' ? report : null;
  return (
    <div className="seo-js" data-testid="seo-javascript">
      <StateCard audit={audit} tab={tab} flash={flash} />
      <PanelIssues audit={audit} categories={CATEGORIES} clean="No JavaScript issues: what crawlers read first is what people see." testId="seo-js-issues" />
      {comparison ? (
        <>
          <Section title="Compared fields" testId="seo-js-fields" badge={comparison.changed > 0 ? <span className="seo-badge">{formatCount(comparison.changed)}</span> : undefined}>
            <ul className="seo-js-fields">
              {comparison.fields.map((field) => (
                <FieldRow key={field.id} field={field} />
              ))}
            </ul>
          </Section>
          <ListCard title="Links" diff={comparison.links} testId="seo-js-links" flash={flash} />
          <ListCard title="Headings" diff={comparison.headings} testId="seo-js-headings" flash={flash} />
          <ListCard title="Structured data" diff={comparison.structuredData} testId="seo-js-structured" flash={flash} />
          {comparison.noscript.count > 0 ? (
            <Section title="noscript" testId="seo-js-noscript">
              <p className="seo-js-note">
                {`The served HTML has ${formatCount(comparison.noscript.count)} <noscript> element${comparison.noscript.count === 1 ? '' : 's'} with ${formatCount(comparison.noscript.wordCount)} words and ${formatCount(comparison.noscript.linkCount)} links. Crawlers that do not run JavaScript may read them; the rendered page does not show them.`}
              </p>
            </Section>
          ) : null}
          <FetchCard report={comparison} tab={tab} flash={flash} />
        </>
      ) : null}
      <p className="seo-js-note" data-testid="seo-js-crawler-note">
        {JS_CRAWLER_NOTE}
      </p>
      <Flash message={message} testId="seo-js-flash" />
    </div>
  );
}
