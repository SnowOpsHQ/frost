import { useEffect, useRef, useState } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import type { IntentAnswer } from '@app/specs/intent-classifier.spec';
import { PROBE_DISCLOSURE } from '@app/specs/visibility-probes.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import { serpActions, useIntentState, useProbes } from '../../hooks/useSerp';
import { RobotIcon, SearchIcon, StopIcon } from '../../icons';
import { intentChip } from '../../serp-view';
import { isolatedTooltip } from '../../seo-view';
import { CLASSIFY_QUERY_MAX, classifyQueryInput, forgetProbes, probeNotes, probeSummary, probeTable, type ProbeTable } from '../../visibility-view';
import { PageText, Section } from './parts';
import { EnableIntent } from './Serp';

// The Visibility panel (acceptance `serp-panels.feature.md`): "Run visibility probes" for the active
// tab's page, with the disclosure shown before it; while it runs, Stop; then a table with one column
// per agent and one row per fact, each cell marked where it differs from the browser; the notes on
// cut content, the AI crawlers' modelled directives and robots.txt as served to frost. A query box
// classifies any typed query on this device. It renders from `serp.watchProbes` alone, never waiting
// for the audit. Server-derived text (URLs, directives) is React text.

function ProbeResults({ table }: { readonly table: ProbeTable }) {
  return (
    <div className="serp-table-wrap visibility-table-wrap">
      <table className="serp-table visibility-table" data-testid="visibility-table">
        <caption className="visually-hidden">What each agent was told, compared with the browser</caption>
        <thead>
          <tr>
            <th scope="col">Fact</th>
            {table.columns.map((column) => (
              <th
                key={column.agent}
                scope="col"
                data-testid="visibility-agent"
                data-agent={column.agent}
                data-differs={column.differs}
                data-modelled={column.modelled}
                title={column.modelled ? 'Meta robots and X-Robots-Tag rows: frost’s model (see the note below)' : undefined}
              >
                {column.label}
                {column.modelled ? <span aria-hidden="true">*</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.fact} data-testid="visibility-fact" data-fact={row.fact}>
              <th scope="row">{row.label}</th>
              {row.cells.map((cell, index) => (
                <td
                  key={table.columns[index]!.agent}
                  data-testid="visibility-cell"
                  data-agent={table.columns[index]!.agent}
                  data-diff={cell.diff}
                  title={cell.title === undefined ? undefined : isolatedTooltip(cell.title)}
                >
                  {cell.mono ? <PageText value={cell.text} className="seo-mono" /> : cell.text}
                  {cell.diff ? <span className="visually-hidden"> (differs from the browser)</span> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ probes }: { readonly probes: ProbesState }) {
  const notes = probeNotes(probes);
  return (
    <>
      {notes.truncated ? (
        <p className="seo-note" data-testid="visibility-truncated-note">
          {notes.truncated}
        </p>
      ) : null}
      {notes.modelled ? (
        <p className="seo-note" data-testid="visibility-modelled-note">
          <span aria-hidden="true">* </span>
          {notes.modelled}
        </p>
      ) : null}
      {notes.robots.length > 0 ? (
        <div className="visibility-robots" data-testid="visibility-robots">
          <ul className="visibility-robots-list" aria-label="robots.txt files read">
            {notes.robots.map((file) => (
              <li key={file.url} className="visibility-robots-file">
                <PageText value={file.url} className="seo-mono" />
                <span className="seo-note">{file.readAt === null ? ' · reading…' : ` · read ${new Date(file.readAt).toLocaleTimeString()}`}</span>
              </li>
            ))}
          </ul>
          <p className="seo-note" data-testid="visibility-robots-note">
            {notes.robotsNote}
          </p>
        </div>
      ) : null}
    </>
  );
}

function Probes({ tab }: { readonly tab: TabState }) {
  const probes = useProbes(tab.id);
  // The tab whose run could not start (so the line resets with the tab).
  const [refusedTab, setRefusedTab] = useState<number | null>(null);
  const refused = refusedTab === tab.id;
  // Once no panel watches the tab's probes, the palette stops trusting what it last saw.
  useEffect(() => () => forgetProbes(tab.id), [tab.id]);
  const onWebPage = isWebUrl(tab.url) && tab.error === null && !tab.crashed;
  const running = probes?.status === 'running';
  const table = probes ? probeTable(probes) : null;
  return (
    <Section title="Visibility probes" testId="visibility-probes">
      <p className="seo-note visibility-disclosure" data-testid="visibility-disclosure">
        {PROBE_DISCLOSURE}
      </p>
      <div className="seo-panel-tools">
        {running ? (
          <button type="button" className="seo-toggle" data-testid="visibility-stop" onClick={() => void serpActions.stopProbes(tab.id)}>
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="seo-toggle"
            data-testid="visibility-run"
            disabled={!onWebPage}
            onClick={() => {
              const tabId = tab.id;
              setRefusedTab(null);
              void serpActions.runProbes(tabId).then((started) => {
                if (!started) setRefusedTab(tabId);
              });
            }}
          >
            <RobotIcon />
            <span>Run visibility probes</span>
          </button>
        )}
      </div>
      <p className="seo-checks-summary" data-testid="visibility-summary" data-status={probes?.status ?? 'idle'} aria-live="polite">
        {!onWebPage ? 'Probes run on web pages (http and https) only.' : refused ? 'The probes could not start on this tab.' : probes ? probeSummary(probes) : 'Not run'}
      </p>
      {table && probes ? (
        <>
          <ProbeResults table={table} />
          <Notes probes={probes} />
        </>
      ) : null}
    </Section>
  );
}

/** The query box: classifies any typed query on this device (`serp.classify`, local only). */
function QueryIntent() {
  const [value, setValue] = useState('');
  const [answer, setAnswer] = useState<IntentAnswer | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [intentState, refreshIntent] = useIntentState(asked);
  // Only the latest query's answer is shown: an earlier one that answers late is dropped.
  const seq = useRef(0);
  const chip = intentChip(answer);
  const classify = () => {
    const query = classifyQueryInput(value);
    if (query === null) return;
    const mine = ++seq.current;
    setAsked(query);
    void serpActions.classify(query).then((next) => {
      if (mine === seq.current) setAnswer(next ?? { state: 'unavailable' });
    });
  };
  return (
    <Section title="Query intent" testId="visibility-intent">
      <form
        className="visibility-query"
        onSubmit={(event) => {
          event.preventDefault();
          classify();
        }}
      >
        <label className="seo-search">
          <SearchIcon />
          <input
            type="search"
            className="seo-search-input"
            data-testid="visibility-query-input"
            placeholder="Type any search query"
            aria-label="Query to classify"
            value={value}
            maxLength={CLASSIFY_QUERY_MAX}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button type="submit" className="panel-button" data-testid="visibility-classify" disabled={classifyQueryInput(value) === null}>
          <span>Classify</span>
        </button>
      </form>
      {chip.kind === 'ready' ? (
        <p className="serp-intent" data-testid="visibility-intent-result" data-state="ready">
          <span className="serp-intent-chip" data-testid="visibility-intent-label" title={chip.definition}>
            {chip.label}
          </span>
          <span className="serp-intent-confidence">
            <span className="visually-hidden">Confidence </span>
            <span data-testid="visibility-intent-confidence">{chip.confidence}</span>
          </span>
          {asked ? <PageText value={asked} className="serp-intent-query" /> : null}
        </p>
      ) : chip.kind === 'state' ? (
        <div data-testid="visibility-intent-result" data-state={chip.state}>
          <p className="seo-note">{chip.message}</p>
          {chip.enable ? (
            <EnableIntent
              testId="visibility-enable-intent"
              onDone={() => {
                refreshIntent();
                classify();
              }}
            />
          ) : null}
        </div>
      ) : intentState === 'model-missing' ? (
        <EnableIntent testId="visibility-enable-intent" onDone={refreshIntent} />
      ) : (
        <p className="seo-note">Classified on this device; the query never leaves it.</p>
      )}
    </Section>
  );
}

export function Visibility({ tab }: { readonly tab: TabState }) {
  return (
    <div className="visibility" data-testid="visibility-panel">
      <Probes tab={tab} />
      <QueryIntent />
    </div>
  );
}
