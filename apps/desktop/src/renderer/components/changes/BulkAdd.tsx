import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BULK_ADD_TEXT, BULK_SEARCH_LIMITS, QUERY_FIELD_MAX_CHARS } from '@app/specs/projects.spec';
import { SERP_DEVICE_LABELS, SERP_DEVICES } from '@app/specs/serp.spec';
import { CloseIcon, PlusIcon } from '../../icons';
import { projectsActions } from '../../ipc';
import { EMPTY_BULK_FORM, QUERY_ENGINES, TAGS_TEXT_MAX_CHARS, bulkFromForm, bulkOutcomeRows, bulkResultText, bulkSummaryText, canAddLocale, type BulkForm, type BulkOutcomeRow } from '../../projects-view';

// The Bulk add dialog (Phase 10 Task 7; acceptance `projects.feature.md`, The sheet; plan Decision 8):
// queries one per line or comma-separated, one engine, up to `BULK_SEARCH_LIMITS.maxLocales`
// country/language pairs, any of the devices, and tags for what it adds; then each line's outcome.
// It saves searches only (`projects.addSearches` builds and reads each URL locally): nothing is sent to
// a search engine. Shown in place of the query form, inside the sheet; Esc or Close closes it. Queries
// come back as React text in a `<bdi>`; no inline styles (strict CSP).

export function BulkAdd({
  projectId,
  savedSearches,
  onClose,
  onChanged,
  say,
}: {
  readonly projectId: string;
  /** How many saved searches the project holds (the room left is shown). */
  readonly savedSearches: number;
  readonly onClose: () => void;
  /** Reads the project again. */
  readonly onChanged: () => void;
  readonly say: (text: string) => void;
}) {
  const id = useId();
  const [form, setForm] = useState<BulkForm>(EMPTY_BULK_FORM);
  const [sending, setSending] = useState(false);
  const [outcomes, setOutcomes] = useState<BulkOutcomeRow[]>([]);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    text.current?.focus();
  }, []);

  const parsed = bulkFromForm(form);
  const summary = 'problem' in parsed ? null : bulkSummaryText(parsed, savedSearches);
  const setLocale = (index: number, key: 'country' | 'language', value: string) =>
    setForm((current) => ({ ...current, locales: current.locales.map((locale, at) => (at === index ? { ...locale, [key]: value } : locale)) }));
  const setDevice = (device: string, on: boolean) =>
    setForm((current) => ({ ...current, devices: on ? [...current.devices.filter((other) => other !== device), device] : current.devices.filter((other) => other !== device) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ('problem' in parsed) return say(parsed.problem);
    setSending(true);
    try {
      const answer = await projectsActions.addSearches(projectId, parsed.input);
      say(bulkResultText(answer));
      setOutcomes(bulkOutcomeRows(answer));
      if (answer?.status === 'done' && answer.lines.some((line) => line.added > 0)) setForm((current) => ({ ...current, text: '' }));
      onChanged();
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    // Esc closes the dialog here, not the sheet.
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section className="projects-bulk" role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} data-testid="projects-bulk" onKeyDown={onKeyDown}>
      <div className="projects-bulk-head">
        <h4 className="projects-bulk-title" id={`${id}-title`}>
          {BULK_ADD_TEXT.title}
        </h4>
        <button type="button" className="projects-icon-button" data-testid="projects-bulk-close" aria-label="Close bulk add" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <p className="projects-note" id={`${id}-note`} data-testid="projects-bulk-note">
        {BULK_ADD_TEXT.note}
      </p>
      <form className="projects-bulk-form" onSubmit={(event) => void submit(event)}>
        <label className="projects-field projects-bulk-text">
          <span>{BULK_ADD_TEXT.textLabel}</span>
          <textarea
            ref={text}
            className="projects-input projects-textarea"
            data-testid="projects-bulk-text"
            rows={5}
            spellCheck={false}
            autoComplete="off"
            maxLength={BULK_SEARCH_LIMITS.maxTextChars}
            value={form.text}
            onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))}
          />
        </label>
        <label className="projects-field">
          <span>Engine</span>
          <select className="projects-select" data-testid="projects-bulk-engine" value={form.engine} onChange={(event) => setForm((current) => ({ ...current, engine: event.target.value }))}>
            {QUERY_ENGINES.map((engine) => (
              <option key={engine.id} value={engine.id}>
                {engine.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="projects-bulk-group" data-testid="projects-bulk-locales">
          <legend>Countries and languages (up to {BULK_SEARCH_LIMITS.maxLocales})</legend>
          {form.locales.map((locale, index) => (
            <div key={index} className="projects-bulk-locale" data-testid="projects-bulk-locale" data-index={index}>
              <label className="projects-field projects-field-short">
                <span>Country</span>
                <input className="projects-input" data-testid="projects-bulk-country" type="text" spellCheck={false} autoComplete="off" placeholder="de" maxLength={2} aria-label={`Country ${index + 1}`} value={locale.country} onChange={(event) => setLocale(index, 'country', event.target.value)} />
              </label>
              <label className="projects-field projects-field-short">
                <span>Language</span>
                <input
                  className="projects-input"
                  data-testid="projects-bulk-language"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="en"
                  maxLength={QUERY_FIELD_MAX_CHARS.language}
                  aria-label={`Language ${index + 1}`}
                  value={locale.language}
                  onChange={(event) => setLocale(index, 'language', event.target.value)}
                />
              </label>
              {form.locales.length > 1 ? (
                <button
                  type="button"
                  className="projects-icon-button"
                  data-testid="projects-bulk-locale-remove"
                  aria-label={`Remove country and language ${index + 1}`}
                  title="Remove"
                  onClick={() => setForm((current) => ({ ...current, locales: current.locales.filter((_, at) => at !== index) }))}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>
          ))}
          <button
            type="button"
            className="projects-small-button"
            data-testid="projects-bulk-locale-add"
            disabled={!canAddLocale(form)}
            onClick={() => setForm((current) => (canAddLocale(current) ? { ...current, locales: [...current.locales, { country: '', language: '' }] } : current))}
          >
            <PlusIcon />
            <span>Add a locale</span>
          </button>
        </fieldset>
        <fieldset className="projects-bulk-group" data-testid="projects-bulk-devices">
          <legend>Devices</legend>
          {SERP_DEVICES.map((device) => (
            <label key={device} className="projects-check">
              <input type="checkbox" data-testid={`projects-bulk-device-${device}`} checked={form.devices.includes(device)} onChange={(event) => setDevice(device, event.target.checked)} />
              <span>{SERP_DEVICE_LABELS[device]}</span>
            </label>
          ))}
        </fieldset>
        <label className="projects-field projects-field-wide">
          <span>Tags for these searches (comma-separated)</span>
          <input className="projects-input" data-testid="projects-bulk-tags" type="text" spellCheck={false} autoComplete="off" maxLength={TAGS_TEXT_MAX_CHARS} value={form.tags} onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))} />
        </label>
        <p className="projects-note" data-testid="projects-bulk-summary">
          {summary ?? ('problem' in parsed && form.text.trim() !== '' ? parsed.problem : '')}
        </p>
        <button type="submit" className="panel-button panel-button-primary" data-testid="projects-bulk-submit" disabled={sending}>
          <span>{sending ? 'Adding…' : 'Add searches'}</span>
        </button>
      </form>
      {outcomes.length > 0 ? (
        <ol className="projects-bulk-outcomes" data-testid="projects-bulk-outcomes" aria-label="What each line did">
          {outcomes.map((row, index) => (
            <li key={index} className="projects-bulk-outcome" data-testid="projects-bulk-outcome" data-outcome={row.outcome}>
              <bdi className="projects-entry-label" dir="auto">
                {row.query}
              </bdi>
              <span className="projects-bulk-outcome-text">{row.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
