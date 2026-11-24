import { useId, useRef, useState } from 'react';
import type { SeoAudit } from '@app/seo-core';
import type { TabState } from '@app/specs/browser.spec';
import type { IntentAnswer } from '@app/specs/intent-classifier.spec';
import { PROBE_DISCLOSURE, type ProbeAgentId } from '@app/specs/visibility-probes.spec';
import type { ProbesState } from '@app/specs/visibility-probes.schema';
import { isWebUrl } from '@app/specs/web-url.spec';
import { serpActions, useIntentState, useProbes } from '../../hooks/useSerp';
import { RobotIcon, SearchIcon, StopIcon, WarningGlyph } from '../../icons';
import { intentChip } from '../../serp-view';
import { isolatedTooltip } from '../../seo-view';
import { CLASSIFY_QUERY_MAX, classifyQueryInput, probeComparison, probeNotes, probeSummary, probeTable, type ProbeCell, type ProbeColumn, type ProbeTable } from '../../visibility-view';
import { AiReadiness } from './AiReadiness';
import { PageText, Section } from './parts';
import { EnableIntent } from './Serp';

// The Visibility panel (acceptance `serp-panels.feature.md`): "Run visibility probes" for the active
// tab's page, with the disclosure shown before it; while it runs, Stop; then a chip per crawler (those
// that differ marked) and a table comparing the chosen one with the browser, one row per fact, each cell
// marked where it differs from the browser (UI polish round 2: the eight-column table scrolled); the notes on
// cut content, the AI crawlers' modelled directives and robots.txt as served to frost. A query box
// classifies any typed query on this device. It renders from `serp.watchProbes` alone, never waiting
// for the audit. Server-derived text (URLs, directives) is React text. Phase 9 Task 8 mounts the
// AI-readiness section at the top (`ai-readiness.feature.md`, AI readiness views): it reads the tab's
// ready audit when there is one (pending until then) and the same probe run as the table.

/** A column's header: the agent's label, with `*` where its directives are frost's model. */
function AgentHeader({ column }: { readonly column: ProbeColumn }) {
  return (
    <th
      scope="col"
      data-testid="visibility-column"
      data-agent={column.agent}
      data-differs={column.differs}
      data-modelled={column.modelled}
      title={column.modelled ? 'Meta robots and X-Robots-Tag rows: frost’s model (see the note below)' : undefined}
    >
      {column.label}
      {column.modelled ? <span aria-hidden="true">*</span> : null}
    </th>
  );
}

function ProbeCellView({ agent, cell }: { readonly agent: ProbeAgentId; readonly cell: ProbeCell }) {
  return (
    <td data-testid="visibility-cell" data-agent={agent} data-diff={cell.diff} title={cell.title === undefined ? undefined : isolatedTooltip(cell.title)}>
      {cell.mono ? <PageText value={cell.text} className="seo-mono" /> : cell.text}
      {cell.diff ? <span className="visually-hidden"> (differs from the browser)</span> : null}
    </td>
  );
}

/**
 * The run compared one crawler at a time (`serp-panels.feature.md`, Decisions: the probes compare one agent
 * with the browser at a time): a chip per crawler, marked with how many facts differ, and a three-column
 * table (Fact, the browser, the chosen crawler) that fits the panel at every width.
 */
function ProbeResults({ table }: { readonly table: ProbeTable }) {
  // `null`: the comparison's own choice (the first crawler that differs).
  const [chosen, setChosen] = useState<ProbeAgentId | null>(null);
  const tableId = useId();
  const comparison = probeComparison(table, chosen);
  if (comparison === null) return null;
  const { baseline, column } = comparison;
  return (
    <>
      <div className="seo-chips visibility-agents" role="group" aria-label="Compare with the browser">
        {comparison.choices.map((choice) => (
          <button
            key={choice.agent}
            type="button"
            className="seo-chip-button"
            data-testid="visibility-agent"
            data-agent={choice.agent}
            data-differs={choice.differences > 0}
            data-differences={choice.differences}
            data-modelled={choice.modelled}
            aria-pressed={choice.agent === column.agent}
            aria-controls={tableId}
            onClick={() => setChosen(choice.agent)}
          >
            <span>{choice.label}</span>
            {choice.differences > 0 ? (
              <span className="visibility-agent-differs">
                <WarningGlyph />
                <span aria-hidden="true">{choice.differences}</span>
                <span className="visually-hidden">
                  , differs from the browser in {choice.differences} {choice.differences === 1 ? 'fact' : 'facts'}
                </span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <table className="serp-table visibility-table" id={tableId} data-testid="visibility-table" data-agent={column.agent}>
        <caption className="visually-hidden">{`${column.label} compared with the browser`}</caption>
        <thead>
          <tr>
            <th scope="col">Fact</th>
            <AgentHeader column={baseline} />
            <AgentHeader column={column} />
          </tr>
        </thead>
        <tbody>
          {comparison.rows.map((row) => (
            <tr key={row.fact} data-testid="visibility-fact" data-fact={row.fact}>
              <th scope="row">{row.label}</th>
              <ProbeCellView agent={baseline.agent} cell={row.baseline} />
              <ProbeCellView agent={column.agent} cell={row.cell} />
            </tr>
          ))}
        </tbody>
      </table>
    </>
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

function Probes({ tab, probes }: { readonly tab: TabState; readonly probes: ProbesState | null }) {
  // The tab whose run could not start (so the line resets with the tab).
  const [refusedTab, setRefusedTab] = useState<number | null>(null);
  const refused = refusedTab === tab.id;
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
          <ProbeResults key={tab.id} table={table} />
          <Notes probes={probes} />
        </>
      ) : null}
    </Section>
  );
}

/** The query box: classifies any typed query on this device (`serp.classify`, local only). */
export function QueryIntent() {
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
    // The shown answer always belongs to `asked`: the previous query's never shows beside this one.
    setAnswer(null);
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

/** `audit`: the tab's ready audit as the sidebar shows it (`null`: none yet). */
export function Visibility({ tab, audit }: { readonly tab: TabState; readonly audit: SeoAudit | null }) {
  const probes = useProbes(tab.id);
  return (
    <div className="visibility" data-testid="visibility-panel">
      <AiReadiness audit={audit} probes={probes} />
      <Probes tab={tab} probes={probes} />
      <QueryIntent />
    </div>
  );
}
