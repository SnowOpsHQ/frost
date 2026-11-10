import { useCallback, useEffect, useRef, useState } from 'react';
import { LOCATION_LIMITS, LOCATION_PROXY_SCHEMES, LOCATION_SCHEME_LABELS, LOCATIONS_SETTINGS_TEXT as TEXT, schemeTakesCredentials, type LocationProxyScheme } from '@app/specs/location-profiles.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { LocationProfile, LocationProfilesView } from '@app/specs/location-profiles.schema';
import { createLocationsCache, locationPaletteSources } from './location-palette';
import { registerPaletteActions } from './palette/registry';
import { requestSettings } from './settings-open';
import { locationActions } from './settings-locations-actions';
import { locationInput, locationRows, locationWriteMessage, type LocationRowView } from './settings-locations-view';
import './settings-locations.css';

// The Settings view's Locations section (Phase 12 Task 10b; acceptance `location-profiles.feature.md`):
// one row per profile (its name, proxy and whether a sign-in is saved) with New tab, Edit and Remove
// (asked first), and a form to add or edit one. What is and is not proxied is said under the intro.
// Everything comes from main's view (`locations.list`), read again after every change. The username
// and password fields are never kept in state: Save reads them and empties them at once, before the
// call, so a sign-in is never rendered (the data sources' key rows' pattern). Main checks every value
// again and answers a fixed result.

// "New tab in location…" in the palette: main's list, read in the background (`location-palette.ts`).
const cache = createLocationsCache(async () => (await locationActions.list())?.profiles ?? null);
const unregisterPaletteActions = registerPaletteActions(...locationPaletteSources({ profiles: cache.current, refresh: cache.refresh, newTab: locationActions.newTab, openSettings: () => requestSettings('locations') }));
import.meta.hot?.dispose(unregisterPaletteActions);

type Editing = { readonly mode: 'new' } | { readonly mode: 'edit'; readonly profile: LocationProfile };

function LocationForm({ editing, protection, onDone, onCancel }: { readonly editing: Editing; readonly protection: LocationProfilesView['protection']; readonly onDone: (message: string) => void; readonly onCancel: () => void }) {
  const initial = editing.mode === 'edit' ? editing.profile : null;
  const [label, setLabel] = useState(initial?.label ?? '');
  const [scheme, setScheme] = useState<LocationProxyScheme>(initial?.scheme ?? 'http');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(initial ? String(initial.port) : '');
  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const takesCredentials = schemeTakesCredentials(scheme);
  const canStore = protection === 'os';

  const save = () => {
    if (busy) return;
    const fields = { label, scheme, host, port, username: username.current?.value ?? '', password: password.current?.value ?? '' };
    // Out of the DOM before the call: the typed sign-in is never left on the page.
    if (username.current) username.current.value = '';
    if (password.current) password.current.value = '';
    const input = locationInput(fields);
    if (input === null) return setMessage(TEXT.results.invalid);
    setBusy(true);
    setMessage(null);
    void (editing.mode === 'edit' ? locationActions.update(editing.profile.id, input) : locationActions.create(input)).then((result) => {
      setBusy(false);
      if (result === 'saved') onDone(locationWriteMessage(result));
      else setMessage(locationWriteMessage(result));
    });
  };

  return (
    <form
      className="settings-card settings-location-form"
      data-testid="location-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="settings-location-fields">
        <label className="settings-location-field">
          <span className="settings-muted">{TEXT.labelField}</span>
          <input className="settings-location-input" data-testid="location-label" value={label} maxLength={LOCATION_LIMITS.maxLabelChars} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="settings-location-field">
          <span className="settings-muted">{TEXT.schemeField}</span>
          <select className="settings-location-input" data-testid="location-scheme" value={scheme} onChange={(event) => setScheme(event.target.value as LocationProxyScheme)}>
            {LOCATION_PROXY_SCHEMES.map((value) => (
              <option key={value} value={value}>
                {LOCATION_SCHEME_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-location-field">
          <span className="settings-muted">{TEXT.hostField}</span>
          <input className="settings-location-input" data-testid="location-host" value={host} maxLength={LOCATION_LIMITS.maxHostChars} spellCheck={false} autoComplete="off" onChange={(event) => setHost(event.target.value)} />
        </label>
        <label className="settings-location-field settings-location-port">
          <span className="settings-muted">{TEXT.portField}</span>
          <input className="settings-location-input" data-testid="location-port" value={port} inputMode="numeric" maxLength={5} onChange={(event) => setPort(event.target.value)} />
        </label>
      </div>
      {takesCredentials ? (
        <div className="settings-location-fields">
          <label className="settings-location-field">
            <span className="settings-muted">{TEXT.usernameField}</span>
            <input ref={username} className="settings-location-input" data-testid="location-username" type="password" autoComplete="off" spellCheck={false} disabled={!canStore} maxLength={LOCATION_LIMITS.maxCredentialChars} placeholder={initial?.hasCredentials ? TEXT.replacePlaceholder : ''} />
          </label>
          <label className="settings-location-field">
            <span className="settings-muted">{TEXT.passwordField}</span>
            <input ref={password} className="settings-location-input" data-testid="location-password" type="password" autoComplete="off" spellCheck={false} disabled={!canStore} maxLength={LOCATION_LIMITS.maxCredentialChars} placeholder={initial?.hasCredentials ? TEXT.replacePlaceholder : ''} />
          </label>
        </div>
      ) : (
        <span className="settings-muted">{TEXT.socksNoCredentials}</span>
      )}
      {scheme === 'http' ? (
        <span className="settings-muted" data-testid="location-http-sign-in">
          {TEXT.httpSignIn}
        </span>
      ) : null}
      {takesCredentials && !canStore ? <span className="settings-muted">{TEXT.protection[protection === 'weak' ? 'weak' : 'unavailable']}</span> : null}
      {editing.mode === 'edit' ? <span className="settings-muted">{TEXT.editClosesTabs}</span> : null}
      <div className="settings-actions">
        <button type="button" className="settings-button" data-testid="location-cancel" onClick={onCancel}>
          {TEXT.cancel}
        </button>
        <button type="submit" className="settings-button settings-button-primary" data-testid="location-save" disabled={busy}>
          {TEXT.save}
        </button>
      </div>
      {message !== null ? (
        <p className="settings-muted" role="status" data-testid="location-message">
          {message}
        </p>
      ) : null}
    </form>
  );
}

function LocationRow({ row, onEdit, onChanged }: { readonly row: LocationRowView; readonly onEdit: () => void; readonly onChanged: (message: string) => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);
  const remove = () => {
    setAsking(false);
    setBusy(true);
    void locationActions.remove(row.id).then((result) => {
      setBusy(false);
      onChanged(locationWriteMessage(result));
    });
  };
  return (
    <li className="settings-toggle" data-testid="location-row" data-profile={row.id}>
      <div className="settings-toggle-text">
        <div className="settings-location-head">
          <span className="settings-toggle-label">{row.label}</span>
          {row.signIn !== null ? (
            <span className="settings-status" data-tone={row.profile.hasCredentials ? 'ok' : undefined}>
              {row.signIn}
            </span>
          ) : null}
        </div>
        <span className="settings-muted" data-testid="location-proxy">
          {row.proxy}
        </span>
        <div className="settings-actions">
          <button type="button" className="settings-button" data-testid="location-new-tab" disabled={busy} onClick={() => void locationActions.newTab(row.id)}>
            {TEXT.openTab}
          </button>
          <button type="button" className="settings-button" data-testid="location-edit" disabled={busy} onClick={onEdit}>
            {TEXT.edit}
          </button>
          <button ref={removeButton} type="button" className="settings-button" data-testid="location-remove" disabled={busy} onClick={() => setAsking(true)}>
            {TEXT.remove}
          </button>
        </div>
        {asking ? (
          <div className="settings-card settings-confirm" role="group">
            <p ref={question} className="settings-question" tabIndex={-1} data-testid="location-remove-question">
              {TEXT.removeQuestion(row.label)}
            </p>
            <div className="settings-actions settings-confirm-actions">
              <button
                type="button"
                className="settings-button"
                onClick={() => {
                  setAsking(false);
                  removeButton.current?.focus();
                }}
              >
                {TEXT.cancel}
              </button>
              <button type="button" className="settings-button settings-button-primary" data-testid="location-remove-confirm" onClick={remove}>
                {TEXT.removeConfirm}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function LocationsSettings() {
  const [view, setView] = useState<LocationProfilesView | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = (seq.current += 1);
    const found = await locationActions.list();
    // An older answer that arrives after a newer one is dropped.
    if (mine === seq.current) setView(found);
    cache.invalidate();
  }, []);
  useEffect(() => void reload(), [reload]);
  const changed = (text: string) => {
    setEditing(null);
    setMessage(text);
    void reload();
  };
  const rows = view ? locationRows(view) : [];
  const full = rows.length >= LOCATION_LIMITS.maxProfiles;
  return (
    <div className="settings-locations" data-testid="settings-locations-body">
      <p className="settings-muted">{TEXT.intro}</p>
      <p className="settings-muted" data-testid="location-not-proxied">
        {TEXT.notProxied}
      </p>
      <p className="settings-muted" data-testid="location-permissions">
        {TEXT.permissions}
      </p>
      {view === null ? null : rows.length === 0 ? <p className="settings-muted">{TEXT.empty}</p> : null}
      {rows.length > 0 ? (
        <ul className="settings-toggles">
          {rows.map((row) =>
            editing?.mode === 'edit' && editing.profile.id === row.id ? (
              <li key={row.id} className="settings-toggle">
                <LocationForm editing={editing} protection={view!.protection} onDone={changed} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <LocationRow key={row.id} row={row} onEdit={() => setEditing({ mode: 'edit', profile: row.profile })} onChanged={changed} />
            ),
          )}
        </ul>
      ) : null}
      {editing?.mode === 'new' && view ? <LocationForm editing={editing} protection={view.protection} onDone={changed} onCancel={() => setEditing(null)} /> : null}
      {editing === null ? (
        <div className="settings-actions">
          <button type="button" className="settings-button" data-testid="location-add" disabled={view === null || full} onClick={() => setEditing({ mode: 'new' })}>
            {TEXT.add}
          </button>
          {full ? <span className="settings-muted">{TEXT.limit}</span> : null}
        </div>
      ) : null}
      {message !== null ? (
        <p className="settings-muted" role="status" data-testid="locations-message">
          {message}
        </p>
      ) : null}
    </div>
  );
}
