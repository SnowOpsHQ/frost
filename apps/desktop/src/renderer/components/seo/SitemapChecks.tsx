import type { TabState } from '@app/specs/browser.spec';
import { SITEMAP_ERROR_LABELS, type HreflangRunState, type SitemapFileReport, type SitemapRunState } from '@app/specs/seo-checks.spec';
import { reciprocityText, reciprocityTone } from '../../checks-view';
import { checksActions } from '../../hooks/useChecks';
import { GlobeIcon, SitemapIcon, StopIcon } from '../../icons';
import { formatCount } from '../../seo-view';
import { ChecksNotice } from './LinkChecks';
import { PageText } from './parts';

// The Indexability panel's checks (acceptance `seo-checks.feature.md`, Panels): the Sitemaps card
// ("Check sitemaps": the files read, URLs listed, whether this page is one of them, `lastmod`
// problems and errors) and, in the hreflang card, "Check return links" with each alternate's
// outcome. Both on request only; both say the sites can see the requests. Every URL is text.

function fileState(file: SitemapFileReport): { label: string; tone: 'ok' | 'warn' | 'error' | 'muted' } {
  if (file.error !== null) return { label: SITEMAP_ERROR_LABELS[file.error], tone: 'error' };
  return { label: `${file.type === 'index' ? 'Index' : 'Sitemap'} · ${formatCount(file.entries)}`, tone: 'ok' };
}

function StartStop({ running, done, start, stop, label, testId }: { readonly running: boolean; readonly done: boolean; readonly start: () => void; readonly stop: () => void; readonly label: string; readonly testId: string }) {
  return running ? (
    <button type="button" className="seo-toggle" data-testid={`${testId}-stop`} onClick={stop}>
      <StopIcon />
      <span>Stop</span>
    </button>
  ) : (
    <button type="button" className="seo-toggle seo-checks-start" data-testid={`${testId}-start`} onClick={start}>
      <SitemapIcon />
      <span>{done ? 'Check again' : label}</span>
    </button>
  );
}

export function SitemapChecks({ tab, run }: { readonly tab: TabState; readonly run: SitemapRunState }) {
  const running = run.status === 'running';
  const checked = run.status !== 'idle';
  const listed = run.listed === null ? { label: 'Unknown', tone: 'muted' as const } : run.listed ? { label: 'Page is listed', tone: 'ok' as const } : { label: 'Page is not listed', tone: 'warn' as const };
  return (
    <section className="seo-section seo-index-card seo-checks" data-testid="seo-sitemap-checks" data-status={run.status}>
      <header className="seo-section-head">
        <h3 className="seo-section-title seo-index-title">
          <span className="seo-index-title-icon" aria-hidden="true">
            <SitemapIcon />
          </span>
          Sitemaps
        </h3>
        {checked && run.status !== 'running' ? (
          <span className="seo-pill" data-tone={listed.tone} data-testid="seo-sitemap-listed" data-listed={String(run.listed)}>
            {listed.label}
          </span>
        ) : null}
      </header>
      <ChecksNotice testId="seo-sitemap-checks-notice" />
      <div className="seo-panel-tools">
        <StartStop running={running} done={checked} start={() => void checksActions.checkSitemaps(tab.id)} stop={() => void checksActions.stop(tab.id, 'sitemaps')} label="Check sitemaps" testId="seo-sitemap-checks" />
      </div>
      {!checked ? (
        <p className="seo-empty-line">Reads the sitemaps robots.txt lists (or /sitemap.xml), follows sitemap indexes, and tells whether this page is listed.</p>
      ) : (
        <>
          <dl className="seo-rows">
            <div className="seo-row">
              <dt className="seo-row-label">Files read</dt>
              <dd className="seo-row-value" data-testid="seo-sitemap-files-count">
                {formatCount(run.files.length)}
                {run.source === 'fallback' ? ' (no Sitemap line: tried /sitemap.xml)' : ''}
              </dd>
            </div>
            <div className="seo-row">
              <dt className="seo-row-label">URLs listed</dt>
              <dd className="seo-row-value" data-testid="seo-sitemap-url-count">
                {formatCount(run.urlCount)}
              </dd>
            </div>
            <div className="seo-row">
              <dt className="seo-row-label">lastmod</dt>
              <dd className="seo-row-value" data-testid="seo-sitemap-lastmod">
                {run.lastmod.invalid + run.lastmod.future === 0 ? 'No problems' : `${formatCount(run.lastmod.invalid)} not valid, ${formatCount(run.lastmod.future)} in the future`}
              </dd>
            </div>
          </dl>
          {run.lastmod.samples.length > 0 ? (
            <ul className="seo-checks-samples" data-testid="seo-sitemap-lastmod-samples">
              {run.lastmod.samples.map((sample, index) => (
                <li key={index}>
                  <PageText value={sample} className="seo-mono" />
                </li>
              ))}
            </ul>
          ) : null}
          {run.files.length > 0 ? (
            <ul className="seo-sitemaps" data-testid="seo-sitemap-files">
              {run.files.map((file, index) => {
                const state = fileState(file);
                return (
                  <li key={index} className="seo-sitemap seo-checks-file" data-testid="seo-sitemap-file" data-type={file.type ?? ''} data-error={file.error ?? ''} data-depth={file.depth}>
                    <PageText value={file.url} className="seo-mono" />
                    <span className="seo-pill" data-tone={state.tone}>
                      {state.label}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {run.errors.filter((error) => !run.files.some((file) => file.url === error.url)).length > 0 ? (
            <ul className="seo-checks-samples" data-testid="seo-sitemap-errors">
              {run.errors
                .filter((error) => !run.files.some((file) => file.url === error.url))
                .map((error, index) => (
                  <li key={index} data-kind={error.kind}>
                    {SITEMAP_ERROR_LABELS[error.kind]}: <PageText value={error.url} className="seo-mono" />
                  </li>
                ))}
            </ul>
          ) : null}
          {running ? <p className="seo-checks-summary">Reading sitemaps…</p> : null}
        </>
      )}
    </section>
  );
}

export function HreflangChecks({ tab, run }: { readonly tab: TabState; readonly run: HreflangRunState }) {
  const running = run.status === 'running';
  const checked = run.status !== 'idle';
  return (
    <div className="seo-checks seo-hreflang-checks" data-testid="seo-hreflang-checks" data-status={run.status}>
      <p className="seo-row-label seo-index-sub">
        <GlobeIcon className="seo-inline-icon" /> Return links
      </p>
      <ChecksNotice testId="seo-hreflang-checks-notice" />
      <div className="seo-panel-tools">
        {running ? (
          <button type="button" className="seo-toggle" data-testid="seo-hreflang-checks-stop" onClick={() => void checksActions.stop(tab.id, 'hreflang')}>
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button type="button" className="seo-toggle seo-checks-start" data-testid="seo-hreflang-checks-start" onClick={() => void checksActions.checkHreflang(tab.id)}>
            <GlobeIcon />
            <span>{checked ? 'Check again' : 'Check return links'}</span>
          </button>
        )}
      </div>
      {checked && run.alternates.length === 0 && !running ? <p className="seo-empty-line">No alternate other than this page to check.</p> : null}
      {run.alternates.length > 0 ? (
        <ul className="seo-hreflang" data-testid="seo-hreflang-check-rows">
          {run.alternates.map((alternate, index) => (
            <li key={index} className="seo-hreflang-row" data-testid="seo-hreflang-check-row" data-status={alternate.status}>
              <bdi className="seo-tag seo-hreflang-code" title={alternate.lang}>
                {alternate.lang || '(empty)'}
              </bdi>
              <span className="seo-hreflang-body">
                <PageText value={alternate.url} className="seo-mono" />
                <span className="seo-hreflang-flags">
                  <span className="seo-flag-chip" data-tone={reciprocityTone(alternate.status)}>
                    {reciprocityText(alternate.status)}
                    {alternate.status === 'unreachable' && alternate.httpStatus !== null ? ` (${alternate.httpStatus})` : ''}
                  </span>
                  {alternate.returnLangs.length > 0 ? <PageText value={`as ${alternate.returnLangs.join(', ')}`} className="seo-flag seo-flag-plain" /> : null}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {run.over > 0 ? <p className="seo-note">and {formatCount(run.over)} more alternates, not checked.</p> : null}
    </div>
  );
}
