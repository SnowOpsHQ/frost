import type { ReactNode } from 'react';
import { GSC_INSPECTION_COPY, type GscCanonicalMatch, type GscInspectionAction, type GscInspectionCardKind } from '@app/specs/gsc-inspection.spec';
import { gscInspectPaletteSources } from '../../gsc-palette';
import { gscInspectionView, type GscCanonicalRow, type GscCodeView, type GscInspectionView, type GscRichView, type GscIndexView } from '../../gsc-inspection-view';
import { gscInspectPaletteApi, useGscInspection } from '../../hooks/useGscInspection';
import { OpenTabIcon, ReloadIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { isolatedTooltip } from '../../seo-view';
import { requestSettings } from '../../settings-open';
import { Flash, useFlash } from './actions';
import { PageText } from './parts';
import '../../gsc-inspection.css';

// Google's URL Inspection of the page (Phase 9 Task 4; spec `gsc-inspection.spec.ts`; acceptance
// `gsc-inspection.feature.md`, Card): Indexability's "Google's view" (index status, last crawl, and
// Google's canonical next to the page's own) and Schema's "Detected by Google" (rich results and their
// issues). Both read one shared entry per page (`useGscInspection`). Mounting sends nothing: Google is
// asked only on "Inspect in Search Console" / "Inspect again". Every string from Google is React text
// in a `<bdi dir="auto">` (`unicode-bidi: isolate`, no `style=`), never markup and never a link; the
// Search Console link stays in main ("Open in Search Console" names the page). Hidden when this build
// has no Search Console client; Connect / Reconnect open Settings. Nothing here feeds a rule or score.

// The command palette's "Inspect this page in Search Console" (`gsc-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...gscInspectPaletteSources(gscInspectPaletteApi));
import.meta.hot?.dispose(unregisterPaletteActions);

type Tone = 'ok' | 'warn' | 'error' | 'muted';

const VERDICT_TONE: Readonly<Record<string, Tone>> = { Passed: 'ok', Failed: 'error', Excluded: 'muted' };
const MATCH_TONE: Readonly<Record<GscCanonicalMatch, Tone>> = { same: 'ok', 'google-differs': 'warn', 'user-missing': 'muted' };

/** Text from Google: inert, bidi-isolated, the full value as an isolated tooltip. */
function GoogleText({ value, className, testId }: { readonly value: string; readonly className?: string; readonly testId?: string }) {
  return (
    <bdi className={`seo-page-text gsc-inspect-text${className ? ` ${className}` : ''}`} dir="auto" title={isolatedTooltip(value)} data-google-text="" data-testid={testId}>
      {value}
    </bdi>
  );
}

/** A code's label (frost's words), or "Not recognised" with Google's raw code beside it as inert text. */
function CodeValue({ code, testId }: { readonly code: GscCodeView; readonly testId?: string }) {
  if (code.known) return <span data-testid={testId}>{code.label}</span>;
  return (
    <span className="gsc-inspect-unknown" data-testid={testId} data-unknown="true">
      {code.label}
      {code.code !== null ? (
        <>
          {' '}
          <GoogleText value={code.code} className="seo-mono" />
        </>
      ) : null}
    </span>
  );
}

function Row({ label, children, testId }: { readonly label: string; readonly children: ReactNode; readonly testId?: string }) {
  return (
    <div className="seo-row" data-testid={testId}>
      <dt className="seo-row-label">{label}</dt>
      <dd className="seo-row-value">{children}</dd>
    </div>
  );
}

const NotReported = () => (
  <span className="seo-missing" data-missing="true">
    {GSC_INSPECTION_COPY.text.notReported}
  </span>
);

function Pill({ tone, children, testId, match }: { readonly tone: Tone; readonly children: ReactNode; readonly testId?: string; readonly match?: string }) {
  return (
    <span className="seo-pill" data-tone={tone} data-testid={testId} data-match={match}>
      {children}
    </span>
  );
}

/** A canonical next to Google's: the URL (inert text) and how it compares. */
function CanonicalValue({ row, fromGoogle, testId }: { readonly row: GscCanonicalRow; readonly fromGoogle: boolean; readonly testId: string }) {
  return (
    <span className="gsc-inspect-canonical">
      {row.url === null || row.url === '' ? <NotReported /> : fromGoogle ? <GoogleText value={row.url} className="seo-mono" testId={testId} /> : <PageText value={row.url} className="seo-mono" testId={testId} />}
      {row.match !== null && row.matchLabel !== null ? (
        <Pill tone={MATCH_TONE[row.match]} testId={`${testId}-match`} match={row.match}>
          {row.matchLabel}
        </Pill>
      ) : null}
    </span>
  );
}

function IndexBody({ index }: { readonly index: GscIndexView }) {
  const labels = GSC_INSPECTION_COPY.labels;
  const differs = index.userCanonical.match === 'google-differs' || index.auditCanonical?.match === 'google-differs';
  return (
    <div className="gsc-inspect-body" data-testid="gsc-inspection-index">
      <dl className="seo-rows">
        <Row label={labels.verdict}>
          <CodeValue code={index.verdict} testId="gsc-inspection-verdict" />
        </Row>
        <Row label={labels.coverage}>{index.coverage === null ? <NotReported /> : <GoogleText value={index.coverage} testId="gsc-inspection-coverage" />}</Row>
        <Row label={labels.indexing}>
          <CodeValue code={index.indexing} testId="gsc-inspection-indexing" />
        </Row>
        <Row label={labels.robotsTxt}>
          <CodeValue code={index.robotsTxt} testId="gsc-inspection-robots" />
        </Row>
        <Row label={labels.pageFetch}>
          <CodeValue code={index.pageFetch} testId="gsc-inspection-fetch" />
        </Row>
        <Row label={labels.lastCrawl}>
          <span data-testid="gsc-inspection-last-crawl">{index.lastCrawl}</span>
        </Row>
        <Row label={labels.crawledAs}>{index.crawledAs === null ? <NotReported /> : <CodeValue code={index.crawledAs} testId="gsc-inspection-crawled-as" />}</Row>
      </dl>
      <dl className="seo-rows gsc-inspect-canonicals" data-testid="gsc-inspection-canonicals">
        <Row label={labels.googleCanonical}>{index.googleCanonical === null ? <NotReported /> : <GoogleText value={index.googleCanonical} className="seo-mono" testId="gsc-inspection-google-canonical" />}</Row>
        <Row label={labels.userCanonical}>
          <CanonicalValue row={index.userCanonical} fromGoogle testId="gsc-inspection-user-canonical" />
        </Row>
        {index.auditCanonical !== null ? (
          <Row label={labels.auditCanonical}>
            <CanonicalValue row={index.auditCanonical} fromGoogle={false} testId="gsc-inspection-audit-canonical" />
          </Row>
        ) : null}
      </dl>
      {differs ? (
        <p className="seo-note" data-testid="gsc-inspection-canonical-fact">
          {GSC_INSPECTION_COPY.text.canonicalFact}
        </p>
      ) : null}
    </div>
  );
}

function RichBody({ rich }: { readonly rich: GscRichView }) {
  if (rich.verdict === null) {
    return (
      <p className="seo-empty-line" data-testid="gsc-inspection-rich-none">
        {GSC_INSPECTION_COPY.text.noRichResults}
      </p>
    );
  }
  return (
    <div className="gsc-inspect-body" data-testid="gsc-inspection-rich">
      <dl className="seo-rows">
        <Row label={GSC_INSPECTION_COPY.labels.richVerdict}>
          <CodeValue code={rich.verdict} testId="gsc-inspection-rich-verdict" />
        </Row>
      </dl>
      <ul className="gsc-inspect-types">
        {rich.types.map((type, i) => (
          <li key={i} className="gsc-inspect-type" data-testid="gsc-inspection-rich-row">
            <h4 className="gsc-inspect-type-name">
              <GoogleText value={type.type} testId="gsc-inspection-rich-type" />
            </h4>
            <ul className="gsc-inspect-items">
              {type.items.map((item, j) => (
                <li key={j} className="gsc-inspect-item" data-testid="gsc-inspection-rich-item" data-issues={item.issueCount}>
                  {item.name === null ? <span className="seo-missing">{GSC_INSPECTION_COPY.text.unnamedItem}</span> : <GoogleText value={item.name} className="gsc-inspect-item-name" testId="gsc-inspection-rich-item-name" />}
                  {item.issueCount === 0 ? (
                    <span className="gsc-inspect-none">{GSC_INSPECTION_COPY.text.noIssues}</span>
                  ) : (
                    item.groups.map((group) => (
                      <div key={group.severity} className="gsc-inspect-group" data-testid="gsc-inspection-issue-group" data-severity={group.severity}>
                        <span className="gsc-inspect-group-label">
                          {group.label} ({group.issues.length})
                        </span>
                        <ul className="gsc-inspect-issues">
                          {group.issues.map((issue, k) => (
                            <li key={k} className="gsc-inspect-issue" data-testid="gsc-inspection-issue">
                              <GoogleText value={issue.message} className="seo-clamp-3" />
                              {issue.code ? (
                                <>
                                  {' '}
                                  <GoogleText value={issue.code} className="seo-mono" />
                                </>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The answer's part a card shows: the index status (Indexability) or the rich results (Schema). */
export function GscInspectionBody({ kind, view }: { readonly kind: GscInspectionCardKind; readonly view: GscInspectionView }) {
  if (kind === 'index') return view.index ? <IndexBody index={view.index} /> : null;
  return view.rich ? <RichBody rich={view.rich} /> : null;
}

function verdictOf(kind: GscInspectionCardKind, view: GscInspectionView): GscCodeView | null {
  return kind === 'index' ? (view.index?.verdict ?? null) : (view.rich?.verdict ?? null);
}

/** "Google's view" (`index`) or "Detected by Google" (`rich`) for `url`; `auditCanonical`: the canonical frost read (Indexability). */
export function GscInspectionCard({ kind, url, auditCanonical }: { readonly kind: GscInspectionCardKind; readonly url: string; readonly auditCanonical?: string | null }) {
  const { status, entry, inspect, openLink } = useGscInspection(url);
  const [message, flash] = useFlash();
  const view = gscInspectionView({ gsc: status, url, entry, now: Date.now(), ...(kind === 'index' ? { auditCanonical: auditCanonical ?? null } : {}) });
  if (view === null) return null;
  const verdict = verdictOf(kind, view);
  const act = (action: GscInspectionAction) => {
    if (action === 'open-gsc-settings') requestSettings('search-console');
    else inspect(action === 'inspect-again');
  };
  const { action, actionLabel } = view.copy;
  return (
    <section className="seo-section gsc-inspect" data-testid="gsc-inspection" data-kind={kind} data-state={view.state} data-pending={view.pending} aria-busy={view.state === 'inspecting'}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">{GSC_INSPECTION_COPY.titles[kind]}</h3>
        {verdict?.known ? (
          <Pill tone={VERDICT_TONE[verdict.label] ?? 'muted'} testId="gsc-inspection-verdict-pill">
            {verdict.label}
          </Pill>
        ) : null}
      </header>
      <p className="gsc-inspect-message" data-testid="gsc-inspection-message">
        {view.copy.message}
      </p>
      <GscInspectionBody kind={kind} view={view} />
      {view.inspected ? (
        <p className="seo-note gsc-inspect-when" data-testid="gsc-inspection-when">
          {view.inspected}
        </p>
      ) : null}
      {action !== null || view.canOpen ? (
        <div className="seo-panel-tools gsc-inspect-tools">
          {action !== null && actionLabel !== null ? (
            <button type="button" className={action === 'inspect' ? 'panel-button panel-button-primary' : 'seo-toggle'} data-testid="gsc-inspection-action" data-action={action} onClick={() => act(action)}>
              {action === 'retry' || action === 'inspect-again' ? <ReloadIcon /> : null}
              <span>{actionLabel}</span>
            </button>
          ) : null}
          {view.canOpen ? (
            <button type="button" className="seo-toggle" data-testid="gsc-inspection-open" onClick={() => void openLink().then((result) => flash(GSC_INSPECTION_COPY.openResults[result]))}>
              <OpenTabIcon />
              <span>{GSC_INSPECTION_COPY.text.openInSearchConsole}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      <Flash message={message} testId="gsc-inspection-flash" />
    </section>
  );
}
