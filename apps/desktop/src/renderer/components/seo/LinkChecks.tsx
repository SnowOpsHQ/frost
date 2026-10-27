import type { TabState } from '@app/specs/browser.spec';
import { CHECKS_VISIBILITY_NOTICE, LINK_STATUS_KINDS, LINK_STATUS_LABELS, type LinkCheckResult, type LinkRunState } from '@app/specs/seo-checks.spec';
import { checksPaletteSources } from '../../checks-palette';
import { knownChecks, linkKindCounts, linkStatusText, linkTone, runSummary } from '../../checks-view';
import { checksActions } from '../../hooks/useChecks';
import { LinksIcon, StopIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { formatCount } from '../../seo-view';
import { HighlightToggle } from './actions';

// The Links panel's link check (acceptance `seo-checks.feature.md`, Panels): "Check links" (and Stop
// while it runs), its progress, a count per outcome, the "Broken only" filter and the broken-link
// highlight; the row status chip. Every check surface says the sites can see the requests.

// The command palette's check actions (`checks-palette.ts`), registered once at load.
const unregisterPaletteActions = registerPaletteActions(...checksPaletteSources({ ...checksActions, known: knownChecks }));
import.meta.hot?.dispose(unregisterPaletteActions);

/** The visibility notice every check surface shows. */
export function ChecksNotice({ testId }: { readonly testId: string }) {
  return (
    <p className="seo-note seo-checks-notice" data-testid={testId}>
      {CHECKS_VISIBILITY_NOTICE}
    </p>
  );
}

/** A link row's status chip (nothing until its result is in). */
export function LinkStatusChip({ result, pending }: { readonly result: LinkCheckResult | undefined; readonly pending: boolean }) {
  if (!result) return pending ? <span className="seo-flag-chip seo-link-status" data-testid="seo-link-status" data-status="pending" data-tone="muted">Checking…</span> : null;
  return (
    <span className="seo-flag-chip seo-link-status" data-testid="seo-link-status" data-status={result.kind} data-tone={linkTone(result.kind)} title={result.finalUrl === null ? undefined : `→ ${result.finalUrl}`}>
      {linkStatusText(result)}
    </span>
  );
}

export function LinkChecks({ tab, run, brokenOnly, onBrokenOnly }: { readonly tab: TabState; readonly run: LinkRunState; readonly brokenOnly: boolean; readonly onBrokenOnly: (on: boolean) => void }) {
  const running = run.status === 'running';
  const counts = linkKindCounts(run);
  const checked = run.status !== 'idle';
  return (
    <section className="seo-section seo-checks" data-testid="seo-link-checks" data-status={run.status}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">Link status</h3>
        {checked ? (
          <span className="seo-badge" data-testid="seo-link-checks-progress">
            {formatCount(run.settled)} / {formatCount(run.total)}
          </span>
        ) : null}
      </header>
      <ChecksNotice testId="seo-link-checks-notice" />
      <div className="seo-panel-tools">
        {running ? (
          <button type="button" className="seo-toggle" data-testid="seo-link-checks-stop" onClick={() => void checksActions.stop(tab.id, 'links')}>
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button type="button" className="seo-toggle seo-checks-start" data-testid="seo-link-checks-start" onClick={() => void checksActions.checkLinks(tab.id)}>
            <LinksIcon />
            <span>{checked ? 'Check again' : 'Check links'}</span>
          </button>
        )}
        {counts.broken > 0 ? <HighlightToggle tab={tab} mode="broken" label="Highlight broken" testId="seo-highlight-broken" /> : null}
        {checked ? (
          <button type="button" className="seo-toggle" data-testid="seo-links-broken-only" aria-pressed={brokenOnly} disabled={counts.broken === 0 && !brokenOnly} onClick={() => onBrokenOnly(!brokenOnly)}>
            <span>Broken only</span>
          </button>
        ) : null}
      </div>
      <p className="seo-checks-summary" data-testid="seo-link-checks-summary" aria-live="polite">
        {runSummary(run.status, run.settled, run.total)}
      </p>
      {checked ? (
        <ul className="seo-checks-counts" aria-label="Link status counts">
          {LINK_STATUS_KINDS.filter((kind) => counts[kind] > 0).map((kind) => (
            <li key={kind} className="seo-flag-chip" data-tone={linkTone(kind)} data-testid="seo-link-checks-count" data-kind={kind}>
              {LINK_STATUS_LABELS[kind]} <span className="seo-checks-count">{formatCount(counts[kind])}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
