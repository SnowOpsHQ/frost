import { useCallback, useEffect, useRef, useState } from 'react';
import { DATA_SOURCES_SETTINGS_TEXT as TEXT, isDataSerpProvider } from '@app/specs/data-sources.spec';
import type { DataSerpProviderView, DataSourcesView, DataUsageView } from '@app/specs/data-sources.schema';
import { dataSourcesActions } from './settings-data-sources-actions';
import { dataSourcesSection, saveMessage, setKeyInput, setSerpProviderMessage, type DataSourceField, type DataSourceRowView } from './settings-data-sources-view';
import './settings-data-sources.css';

// The Settings view's Data sources section (Phase 12 Task 2; acceptance `data-sources.feature.md`,
// Settings › Data sources): one card per provider, grouped "Search results" and "AI search", each a
// text label only, with whether a key is set, a password field (DataForSEO: login and password) and
// Save, Clear (asked first), and this month's and last month's request counts; the cost note; and
// which vendor "Check via API" uses. Everything comes from main's views (`dataSources.status`,
// `.usage`, `.serpProvider`), read again after every change: a row is live only when main says its
// legal gate is open and keys are protected, and the select lists main's choices only. A key field is
// never kept in state: Save reads it and empties it at once, before the call, so a key is never
// rendered (the agent's key rows' pattern, `AgentSettings.tsx`). Clear asks first, in the account
// confirmation's way (`settings-account.tsx`): the question takes focus when it opens, and focus goes
// back to Clear after Cancel or once the clear is done. Reads are sequenced: an older answer that
// arrives after a newer one is dropped.

interface Views {
  readonly status: DataSourcesView;
  readonly usage: DataUsageView;
  readonly serp: DataSerpProviderView;
}

/** The Clear question (focused when it appears), Cancel, then Remove key. */
function ClearQuestion({ row, onCancel, onConfirm }: { readonly row: DataSourceRowView; readonly onCancel: () => void; readonly onConfirm: () => void }) {
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => question.current?.focus(), []);
  const id = `data-source-${row.provider}-question`;
  return (
    <div className="settings-card settings-confirm" role="group" aria-labelledby={id}>
      <p ref={question} className="settings-question" id={id} data-testid="data-source-clear-question" tabIndex={-1}>
        {TEXT.clearQuestion(row.label)}
      </p>
      <div className="settings-actions settings-confirm-actions">
        <button type="button" className="settings-button" data-testid="data-source-clear-cancel" onClick={onCancel}>
          {TEXT.cancel}
        </button>
        <button type="button" className="settings-button settings-button-primary" data-testid="data-source-clear-confirm" onClick={onConfirm}>
          {TEXT.clearConfirm}
        </button>
      </div>
    </div>
  );
}

function DataSourceRow({ row, onChanged }: { readonly row: DataSourceRowView; readonly onChanged: () => Promise<DataSourcesView | null> }) {
  const fields = useRef<Partial<Record<DataSourceField, HTMLInputElement | null>>>({});
  const clearButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const id = (part: string) => `data-source-${row.provider}-${part}`;
  const described = [row.reason !== null ? id('reason') : null, ...row.notes.map((_, index) => id(`note-${index}`))].filter((value) => value !== null).join(' ') || undefined;

  const save = () => {
    if (busy || row.disabled) return;
    const values: Partial<Record<DataSourceField, string>> = {};
    for (const field of row.fields) {
      const input = fields.current[field.id];
      if (!input) continue;
      values[field.id] = input.value;
      // Out of the DOM before the call: the typed key is never left on the page.
      input.value = '';
    }
    const input = setKeyInput(row.provider, values);
    if (input === null) return setMessage(TEXT.pasteFirst);
    setBusy(true);
    setMessage(null);
    void dataSourcesActions.setKey(input).then(async (result) => {
      const status = await onChanged();
      setBusy(false);
      setMessage(saveMessage(input, result, status?.providers[row.provider].hasKey ?? row.hasKey));
    });
  };
  const clear = () => {
    if (busy) return;
    setAsking(false);
    setBusy(true);
    setMessage(null);
    void dataSourcesActions.clearKey(row.provider).then(async (cleared) => {
      await onChanged();
      setBusy(false);
      setMessage(cleared ? TEXT.cleared : TEXT.clearFailed);
      clearButton.current?.focus();
    });
  };
  const cancel = () => {
    setAsking(false);
    clearButton.current?.focus();
  };

  return (
    <li className="settings-toggle" data-testid="data-source" data-provider={row.provider} data-has-key={row.hasKey} data-disabled={row.disabled}>
      <div className="settings-toggle-text">
        <div className="settings-data-source-head">
          <span className="settings-toggle-label" id={id('label')}>
            {row.label}
          </span>
          <span className="settings-status" data-testid="data-source-key-state" data-tone={row.hasKey ? 'ok' : undefined}>
            {row.keyState}
          </span>
        </div>
        {row.reason !== null ? (
          <span className="settings-muted" id={id('reason')} data-testid="data-source-reason">
            {row.reason}
          </span>
        ) : null}
        {row.notes.map((note, index) => (
          <span key={note} className="settings-muted" id={id(`note-${index}`)} data-testid="data-source-note">
            {note}
          </span>
        ))}
        <div className="settings-data-source-fields">
          {row.fields.map((field) => (
            <div key={field.id} className="settings-data-source-field">
              <span className="settings-muted" id={id(`field-${field.id}`)}>
                {field.label}
              </span>
              <input
                ref={(element) => {
                  fields.current[field.id] = element;
                }}
                className="settings-data-source-input"
                data-testid="data-source-input"
                data-field={field.id}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={row.disabled}
                placeholder={row.hasKey ? TEXT.replacePlaceholder : TEXT.keyPlaceholder}
                aria-labelledby={`${id('label')} ${id(`field-${field.id}`)}`}
                aria-describedby={described}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    save();
                  }
                }}
              />
            </div>
          ))}
          <div className="settings-actions">
            <button
              type="button"
              className="settings-button settings-button-primary"
              data-testid="data-source-save"
              aria-label={TEXT.saveName(row.label)}
              aria-describedby={described}
              aria-disabled={busy || row.disabled ? 'true' : undefined}
              onClick={save}
            >
              {TEXT.save}
            </button>
            <button
              ref={clearButton}
              type="button"
              className="settings-button"
              data-testid="data-source-clear"
              aria-label={TEXT.clearName(row.label)}
              aria-disabled={busy || !row.canClear ? 'true' : undefined}
              onClick={() => {
                if (!busy && row.canClear) setAsking(true);
              }}
            >
              {TEXT.clear}
            </button>
          </div>
        </div>
        {asking ? <ClearQuestion row={row} onCancel={cancel} onConfirm={clear} /> : null}
        <span className="settings-muted">
          <span className="visually-hidden">{`${TEXT.usageLabel}: `}</span>
          <span data-testid="data-source-usage">{row.usage}</span>
        </span>
        {message !== null ? (
          <span className="settings-note" role="status" data-testid="data-source-message">
            {message}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function DataSourcesSettings() {
  const [views, setViews] = useState<Views | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [serpBusy, setSerpBusy] = useState(false);
  const [serpNote, setSerpNote] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const seq = useRef(0);
  /**
   * Main's three views, read again; answers the keys' view (`null`: failed or overtaken). Only the
   * newest read is applied: an older one that answers late is dropped. A failed read keeps what is
   * shown (or, first time, says so).
   */
  const read = useCallback(async (): Promise<DataSourcesView | null> => {
    const mine = (seq.current += 1);
    const [status, usage, serp] = await Promise.all([dataSourcesActions.status(), dataSourcesActions.usage(), dataSourcesActions.serpProvider()]);
    if (!live.current || mine !== seq.current) return null;
    if (status === null || usage === null || serp === null) {
      setReadFailed(true);
      return null;
    }
    setReadFailed(false);
    setViews({ status, usage, serp });
    return status;
  }, []);
  useEffect(() => {
    void read();
  }, [read]);

  if (views === null) {
    if (!readFailed) return <p className="settings-muted">{TEXT.loading}</p>;
    return (
      <div className="settings-data-sources" data-testid="data-sources-section" data-state="read-failed">
        <p className="settings-muted" role="status" data-testid="data-sources-read-failed">
          {TEXT.readFailed}
        </p>
        <div className="settings-actions">
          <button type="button" className="settings-button" data-testid="data-sources-retry" onClick={() => void read()}>
            {TEXT.retry}
          </button>
        </div>
      </div>
    );
  }

  const section = dataSourcesSection(views.status, views.usage, views.serp);
  const chooseSerp = (value: string) => {
    if (serpBusy || !isDataSerpProvider(value)) return;
    setSerpBusy(true);
    setSerpNote(null);
    void dataSourcesActions.setSerpProvider(value).then(async (result) => {
      await read();
      setSerpBusy(false);
      setSerpNote(setSerpProviderMessage(result));
    });
  };

  return (
    <div className="settings-data-sources" data-testid="data-sources-section">
      <p className="settings-text">{section.intro}</p>
      <p className="settings-text" data-testid="data-sources-spend-note">
        {section.spendNote}
      </p>
      {section.groups.map((group) => (
        <div key={group.purpose} data-testid="data-sources-group" data-purpose={group.purpose}>
          <h3 className="settings-data-sources-group" id={`data-sources-group-${group.purpose}`}>
            {group.label}
          </h3>
          <ul className="settings-toggles" aria-labelledby={`data-sources-group-${group.purpose}`}>
            {group.rows.map((row) => (
              <DataSourceRow key={row.provider} row={row} onChanged={read} />
            ))}
          </ul>
        </div>
      ))}
      <p className="settings-muted">{TEXT.usageNote}</p>
      <label className="settings-data-sources-group" htmlFor="data-sources-serp-provider">
        {TEXT.serpProviderLabel}
      </label>
      <div className="settings-actions">
        <select
          id="data-sources-serp-provider"
          className="settings-data-source-select"
          data-testid="data-sources-serp-provider"
          value={section.serp.value}
          disabled={section.serp.disabled || serpBusy}
          aria-describedby={section.serp.note !== null ? 'data-sources-serp-note' : undefined}
          onChange={(event) => chooseSerp(event.target.value)}
        >
          {section.serp.placeholder !== null || section.serp.options.length === 0 ? (
            <option value="" disabled>
              {section.serp.placeholder ?? TEXT.serpProviderPlaceholder}
            </option>
          ) : null}
          {section.serp.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {section.serp.note !== null ? (
        <p className="settings-muted" id="data-sources-serp-note" data-testid="data-sources-serp-note">
          {section.serp.note}
        </p>
      ) : null}
      {serpNote !== null ? (
        <p className="settings-note" role="status" data-testid="data-sources-serp-message">
          {serpNote}
        </p>
      ) : null}
    </div>
  );
}
