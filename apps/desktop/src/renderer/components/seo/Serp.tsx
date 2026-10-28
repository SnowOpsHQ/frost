import { useEffect, useRef, useState } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { INTENT_ENABLE_MESSAGES, INTENT_ENABLE_PROMPT, type IntentState } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, type PackUpdateOutcome } from '@app/specs/serp-selector-pack.spec';
import type { PackStatus, SerpTabState } from '@app/specs/serp-service.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpReady } from '@app/specs/serp-snapshot.schema';
import { serpActions, useIntentState, useSerp } from '../../hooks/useSerp';
import { ReloadIcon } from '../../icons';
import { registerPaletteActions } from '../../palette/registry';
import { formatCount } from '../../seo-view';
import { serpPaletteSources } from '../../serp-palette';
import {
  compositionSegments,
  compositionSummary,
  forgetSerp,
  intentChip,
  knownIntent,
  knownSerp,
  ownershipNote,
  ownershipRows,
  ownershipTitle,
  packStatusText,
  packUpdateLine,
  resultRows,
  searchParamFacts,
  serpParams,
  serpStateView,
  type SerpStateView,
} from '../../serp-view';
import { knownProbes } from '../../visibility-view';
import { Flash, useFlash } from './actions';
import { PageText, Section } from './parts';
import { OutlineIcon, SerpIcon } from './serp-icons';

// The SERP panel (acceptance `serp-panels.feature.md`): the tab's search parameters, the query's
// intent, what the result page is made of, who owns it and its results, the outlines toggle, and
// the selector pack with "Check for selector updates"; or the page's state (not a result page,
// being read, couldn't read this layout, reading off). It renders from `serp.watch` alone, never
// waiting for the audit. Page-derived text (queries, titles, domains) is React text (`PageText`).

// The command palette's SERP and Visibility actions (`serp-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...serpPaletteSources({ ...serpActions, refreshIntent: serpActions.intentState, knownSerp, knownProbes, knownIntent }));
import.meta.hot?.dispose(unregisterPaletteActions);

/** The search parameters bar: always shown when the tab's page is a result page. */
function ParamsBar({ params }: { readonly params: SearchParams }) {
  return (
    <dl className="serp-params" data-testid="serp-params" aria-label="Search parameters">
      {searchParamFacts(params).map((fact) => (
        <div key={fact.key} className="serp-param" data-key={fact.key}>
          <dt className="serp-param-label">{fact.label}</dt>
          <dd className="serp-param-value" data-testid={`serp-param-${fact.key}`}>
            <PageText value={fact.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Enable on-device intent", with what it downloads stated before the click (`INTENT_ENABLE_PROMPT`):
 * the size, the host, the model and its licence.
 */
export function EnableIntent({ onDone, testId }: { readonly onDone: () => void; readonly testId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, flash] = useFlash();
  return (
    <div className="serp-enable" data-testid={testId}>
      <p className="seo-note serp-enable-prompt" data-testid={`${testId}-prompt`}>
        {INTENT_ENABLE_PROMPT}
      </p>
      <div className="seo-panel-tools">
        <button
          type="button"
          className="panel-button"
          data-testid={`${testId}-button`}
          data-busy={busy}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void serpActions.enableIntent().then((outcome) => {
              setBusy(false);
              flash(INTENT_ENABLE_MESSAGES[outcome ?? 'unreachable']);
              onDone();
            });
          }}
        >
          <span>{busy ? 'Downloading…' : 'Enable on-device intent'}</span>
        </button>
        <Flash message={message} testId={`${testId}-flash`} />
      </div>
    </div>
  );
}

/** The query's intent: its label and confidence, the classifier's state, or "Enable on-device intent". */
function IntentLine({ state, intentState, onEnabled }: { readonly state: SerpTabState; readonly intentState: IntentState | null; readonly onEnabled: () => void }) {
  const chip = intentChip(state.intent);
  if (chip.kind === 'ready') {
    return (
      <div className="serp-intent" data-testid="serp-intent" data-state="ready">
        <span className="seo-eyebrow">Intent</span>
        <span className="serp-intent-chip" data-testid="serp-intent-label" title={chip.definition}>
          {chip.label}
        </span>
        <span className="serp-intent-confidence">
          <span className="visually-hidden">Confidence </span>
          <span data-testid="serp-intent-confidence">{chip.confidence}</span>
        </span>
      </div>
    );
  }
  if (chip.kind === 'state') {
    return (
      <div className="serp-intent" data-testid="serp-intent" data-state={chip.state}>
        <span className="seo-eyebrow">Intent</span>
        <p className="seo-note serp-intent-message" data-testid="serp-intent-message">
          {chip.message}
        </p>
        {chip.enable ? <EnableIntent testId="serp-enable-intent" onDone={onEnabled} /> : null}
      </div>
    );
  }
  // A ready reading whose query is being classified (the model is there).
  if (state.serp.status === 'ready' && intentState === 'ready' && state.intent === null) {
    return (
      <div className="serp-intent" data-testid="serp-intent" data-state="classifying">
        <span className="seo-eyebrow">Intent</span>
        <span className="seo-note">Classifying…</span>
      </div>
    );
  }
  return null;
}

/** The composition: a stacked bar (an image with its text equivalent) and a count per type. */
function Composition({ snapshot }: { readonly snapshot: SerpReady }) {
  const segments = compositionSegments(snapshot.composition);
  const summary = compositionSummary(snapshot.composition);
  return (
    <Section title="Composition" badge={<span className="seo-badge">{formatCount(snapshot.results.length)}</span>} testId="serp-composition">
      <svg className="serp-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label={summary} data-testid="serp-composition-bar">
        <title>{summary}</title>
        {segments.map((segment) => (
          <rect key={segment.type} className="serp-bar-segment" data-type={segment.type} x={segment.x} y="0" width={segment.width} height="8" fill={segment.color} />
        ))}
      </svg>
      <ul className="serp-counts" aria-label="Results per type">
        {segments.map((segment) => (
          <li key={segment.type} className="serp-count" data-testid="serp-composition-count" data-type={segment.type} data-count={segment.count}>
            <svg className="serp-swatch" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
              <rect x="0" y="0" width="10" height="10" rx="2.5" fill={segment.color} />
            </svg>
            <span className="serp-count-label">{segment.label}</span>
            <span className="serp-count-value">{formatCount(segment.count)}</span>
          </li>
        ))}
      </ul>
      {snapshot.truncated ? <p className="seo-note">This page has more results than frost reads; the first ones are shown.</p> : null}
    </Section>
  );
}

/** Who owns the page's organic results: a table of domains. */
function Ownership({ snapshot }: { readonly snapshot: SerpReady }) {
  const rows = ownershipRows(snapshot.ownership);
  const note = ownershipNote(snapshot.ownership);
  return (
    <Section title={ownershipTitle(snapshot.ownership)} badge={<span className="seo-badge">{formatCount(rows.length)}</span>} testId="serp-ownership">
      {rows.length === 0 ? (
        <p className="seo-empty-line">No organic results with a link on this page.</p>
      ) : (
        <div className="serp-table-wrap">
          <table className="serp-table" data-testid="serp-ownership-table">
            <caption className="visually-hidden">Organic results per domain, ads not counted</caption>
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col" className="serp-num">
                  Results
                </th>
                <th scope="col" className="serp-num">
                  Share
                </th>
                <th scope="col">Positions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.domain} data-testid="serp-ownership-row" data-domain={row.domain}>
                  <th scope="row" className="serp-domain">
                    <PageText value={row.domain} />
                  </th>
                  <td className="serp-num" data-testid="serp-ownership-count">
                    {formatCount(row.count)}
                  </td>
                  <td className="serp-num" data-testid="serp-ownership-share">
                    {row.share}
                  </td>
                  <td data-testid="serp-ownership-positions">{row.positions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note ? (
        <p className="seo-note" data-testid="serp-ownership-note">
          {note}
        </p>
      ) : null}
    </Section>
  );
}

/** The results in page order. */
function Results({ snapshot }: { readonly snapshot: SerpReady }) {
  const rows = resultRows(snapshot);
  return (
    <Section title="Results" badge={<span className="seo-badge">{formatCount(rows.length)}</span>} testId="serp-results">
      <ol className="serp-results" aria-label="Results in page order">
        {rows.map((row) => (
          <li key={row.rank} className="serp-result" data-testid="serp-result" data-type={row.type} data-rank={row.rank}>
            <span className="serp-result-rank">
              <span className="visually-hidden">Rank </span>
              {row.rank}
            </span>
            <span className="serp-result-main">
              <span className="serp-result-type" data-type={row.type}>
                {row.typeLabel}
              </span>
              <PageText value={row.title} className="serp-result-title" />
              {row.domain === null ? <span className="seo-missing serp-result-domain">No link</span> : <PageText value={row.domain} className="serp-result-domain" testId="serp-result-domain" />}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** "Outline features on the page": draws each result's box in the tab (main's SERP world). */
function OutlineToggle({ tab, on, onToggle }: { readonly tab: TabState; readonly on: boolean; readonly onToggle: (on: boolean) => void }) {
  return (
    <div className="seo-panel-tools serp-tools">
      <button
        type="button"
        className="seo-toggle"
        data-testid="serp-outlines"
        aria-pressed={on}
        onClick={() => {
          onToggle(!on);
          void serpActions.setOutlines(tab.id, !on);
        }}
      >
        <OutlineIcon />
        <span>Outline features on the page</span>
      </button>
    </div>
  );
}

/** The selector pack in use and "Check for selector updates". */
function PackCard({ pack, testId = 'serp-pack' }: { readonly pack: PackStatus; readonly testId?: string }) {
  const [outcome, setOutcome] = useState<PackUpdateOutcome | null>(null);
  // The service's own record wins (it is what any other window or the palette saw too).
  const line = packUpdateLine(pack) ?? (outcome === null ? null : PACK_UPDATE_MESSAGES[outcome]);
  return (
    <Section title="Selectors" testId={testId}>
      <p className="serp-pack-status" data-testid="serp-pack-status" data-version={pack.version ?? ''} data-source={pack.source ?? ''}>
        {packStatusText(pack)}
      </p>
      <div className="seo-panel-tools">
        <button
          type="button"
          className="panel-button"
          data-testid="serp-pack-update"
          data-busy={pack.checking}
          disabled={pack.checking || pack.state === 'disabled'}
          onClick={() => void serpActions.checkPackUpdate().then((next) => setOutcome(next ?? 'unreachable'))}
        >
          <ReloadIcon />
          <span>Check for selector updates</span>
        </button>
      </div>
      <p className="seo-note" data-testid="serp-pack-outcome" role="status" aria-live="polite" data-outcome={pack.lastUpdate?.outcome ?? outcome ?? ''}>
        {line ?? 'Selectors are signed data. frost asks for an update only when you check.'}
      </p>
    </Section>
  );
}

/** A state that is not a reading: not a result page, being read, couldn't read, off. */
function StateCard({ view }: { readonly view: SerpStateView }) {
  return (
    <section className="seo-section serp-state" data-testid="serp-state" data-state={view.kind} data-reason={view.reason}>
      <div className="serp-state-head">
        <span className="serp-state-icon" aria-hidden="true">
          <SerpIcon />
        </span>
        <p className="serp-state-title" data-testid="serp-state-title">
          {view.title}
        </p>
      </div>
      {view.message ? (
        <p className="seo-note serp-state-message" data-testid="serp-state-message">
          {view.message}
        </p>
      ) : null}
      {view.offerUpdate ? <p className="seo-note">A selector update may read it: “Check for selector updates” below.</p> : null}
    </section>
  );
}

export function Serp({ tab }: { readonly tab: TabState }) {
  const state = useSerp(tab.id);
  const [intentState, refreshIntent] = useIntentState(state?.version ?? null);
  // Leaving the panel (another panel, a collapsed sidebar) turns the tab's outlines off, and the
  // palette stops trusting a state no panel watches any more.
  // `requested` covers a toggle whose answer the watch has not brought back yet (an extra off is a no-op).
  const outlinesOn = useRef(false);
  const requested = useRef(false);
  outlinesOn.current = state?.outlines === true;
  useEffect(
    () => () => {
      if (outlinesOn.current || requested.current) void serpActions.setOutlines(tab.id, false);
      requested.current = false;
      forgetSerp(tab.id);
    },
    [tab.id],
  );
  if (state === null) {
    return (
      <div className="serp" data-testid="serp-panel" data-state="loading" aria-busy="true">
        <StateCard view={{ kind: 'pending', title: 'Reading this tab…', message: null, offerUpdate: false }} />
      </div>
    );
  }
  const params = serpParams(state.serp);
  const view = serpStateView(state.serp);
  const ready = state.serp.status === 'ready' ? state.serp.snapshot : null;
  return (
    <div className="serp" data-testid="serp-panel" data-state={state.serp.status}>
      {params ? <ParamsBar params={params} /> : null}
      {params ? <IntentLine state={state} intentState={intentState} onEnabled={refreshIntent} /> : null}
      {ready ? (
        <>
          <OutlineToggle
            tab={tab}
            on={state.outlines}
            onToggle={(on) => {
              requested.current = on;
            }}
          />
          <Composition snapshot={ready} />
          <Ownership snapshot={ready} />
          <Results snapshot={ready} />
        </>
      ) : (
        <StateCard view={view} />
      )}
      <PackCard pack={state.pack} />
    </div>
  );
}
