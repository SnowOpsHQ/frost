import { useMemo, useState } from 'react';
import { CONSOLE_LEVELS, type ConsoleLevel } from '@app/specs/devtools.spec';
import { shortName } from '../../devtools-view';
import { useDevtoolsData } from '../../hooks/useDevtools';
import { ErrorGlyph, InfoGlyph, WarningGlyph } from '../../icons';
import { devtoolsApi } from './api';
import type { DevtoolsPanelProps } from './DevtoolsDrawer';

// The Console tab (spec `devtools.feature.md`, Console): the tab's console messages for its current
// document, deduplicated with a count, capped by main. Every message is inert text (a text node,
// never markup); nothing can be typed or run here.

const LEVEL_LABELS: Readonly<Record<ConsoleLevel, string>> = { debug: 'Debug', info: 'Info', warning: 'Warning', error: 'Error' };

function LevelGlyph({ level }: { readonly level: ConsoleLevel }) {
  if (level === 'error') return <ErrorGlyph />;
  if (level === 'warning') return <WarningGlyph />;
  return <InfoGlyph />;
}

export function ConsolePanel({ tab, version }: DevtoolsPanelProps) {
  const log = useDevtoolsData(devtoolsApi.console, tab.id, version);
  const [level, setLevel] = useState<ConsoleLevel | 'all'>('all');
  const entries = log?.status === 'ready' ? log.entries : [];
  const shown = useMemo(() => (level === 'all' ? entries : entries.filter((e) => e.level === level)), [entries, level]);
  return (
    <div className="devtools-console" data-testid="devtools-console">
      <div className="devtools-toolbar">
        <label className="devtools-field">
          <span className="visually-hidden">Level</span>
          <select data-testid="devtools-console-level" value={level} onChange={(e) => setLevel(e.currentTarget.value as ConsoleLevel | 'all')}>
            <option value="all">All levels</option>
            {CONSOLE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        <span className="devtools-count" aria-live="polite">
          {log?.status === 'ready' ? `${log.total} messages, ${entries.length} distinct` : ''}
          {log?.status === 'ready' && log.dropped > 0 ? ` (${log.dropped} more not kept)` : ''}
        </span>
      </div>
      {shown.length === 0 ? <p className="devtools-empty">No console messages on this page.</p> : null}
      <ol className="devtools-console-list">
        {shown.map((entry) => (
          <li key={entry.key} className={`devtools-console-row devtools-level-${entry.level}`} data-testid="devtools-console-row" data-level={entry.level}>
            <span className="devtools-level" aria-label={LEVEL_LABELS[entry.level]}>
              <LevelGlyph level={entry.level} />
            </span>
            <span className="devtools-console-message" data-testid="devtools-console-message">
              {entry.message}
              {entry.truncated ? <span className="devtools-muted"> (cut)</span> : null}
            </span>
            {entry.count > 1 ? (
              <span className="devtools-console-count" data-testid="devtools-console-count" aria-label={`${entry.count} times`}>
                ×{entry.count}
              </span>
            ) : null}
            <span className="devtools-console-source" title={entry.source}>
              <bdi>{entry.source === '' ? '' : `${shortName(entry.source)}:${entry.line}`}</bdi>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
