import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { TabState } from '@app/specs/browser.spec';
import {
  COOKIES_OFF_HINT,
  CRAWLER_HONESTY_NOTE,
  CRAWLER_USER_AGENTS,
  CSS_OFF_BADGE,
  CSS_OFF_HINT,
  DEFAULT_TAB_OVERRIDES,
  GEOLOCATION_HINT,
  GEOLOCATION_LIMITS,
  GEOLOCATION_PRESETS,
  isDefaultTabOverrides,
  TAB_OVERRIDE_LABELS,
  DEVICE_PRESET_IDS,
  deviceLabel,
  MAX_CUSTOM_USER_AGENT_LENGTH,
  NETWORK_LABELS,
  NETWORK_PRESET_IDS,
  QUICK_RENDER_PROFILES,
  RELOAD_TO_APPLY_LABEL,
  renderProfileSummary,
  USER_AGENT_IDS,
  USER_AGENT_LABELS,
  type DevicePresetId,
  type NetworkPresetId,
  type TabOverrides,
  type TabRenderProfile,
  type UserAgentId,
} from '@app/specs/render-profile.spec';
import { isWebUrl } from '@app/specs/web-url.spec';
import { actions } from '../ipc';
import { registerPaletteActions } from '../palette/registry';
import { renderProfilePaletteSources } from '../render-profile-palette';
import {
  badgeLabel,
  chipText,
  draftOf,
  frameNotes,
  geolocationChoiceOf,
  geolocationDraftOf,
  geolocationOfDraft,
  outlineRect,
  overridesChipText,
  overridesFailedNote,
  profileOfDraft,
  type GeolocationChoice,
  type GeolocationDraft,
  type ProfileDraft,
} from '../render-profile-view';

// The chrome's side of per-tab render profiles (spec `render-profile.feature.md`, Visible state): the
// toolbar toggle, the editor bar (under the chrome row, so the page area makes room for it: nothing is
// drawn over the tab's view), the tab badge, the status-bar chip and the page-area frame. Every value
// comes from the tab's state; every change goes through `browser.setRenderProfile` /
// `browser.clearRenderProfile`. Styling is the bundled styles.css only (strict CSP: SVG attributes,
// never `style=`).

// The command palette's render-profile actions (`render-profile-palette.ts`), once per module instance.
const unregisterPaletteActions = registerPaletteActions(...renderProfilePaletteSources(actions));
import.meta.hot?.dispose(unregisterPaletteActions);

function Glyph({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** A phone in front of a screen: "render as another device" (frost's own). */
export function RenderProfileIcon({ className }: { readonly className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="2.8" y="4.2" width="14.5" height="10.6" rx="1.6" />
      <path d="M7 18.8h5.5" />
      <rect x="14.6" y="9.2" width="6.6" height="11.2" rx="1.5" />
      <path d="M17.4 18h1" />
    </Glyph>
  );
}

/** The toolbar's toggle for the editor bar; marked while the tab has a profile. */
export function RenderProfileToggle({ tab, open, onToggle }: { readonly tab: TabState | undefined; readonly open: boolean; readonly onToggle: () => void }) {
  const state = tab?.renderProfile ?? null;
  // Tab overrides (Phase 11 Task 6) mark the toggle too: they are edited in the same bar.
  const overrides = tab ? overridesChipText(tab.tabOverrides, tab.overridesStatus) : null;
  const label = [state ? badgeLabel(state) : null, overrides].filter((part) => part !== null).join(' · ');
  return (
    <button
      type="button"
      className="tool render-toggle"
      data-testid="render-profile-toggle"
      data-active={state !== null || overrides !== null}
      data-overrides={overrides !== null}
      data-overrides-status={tab?.overridesStatus ?? 'active'}
      aria-pressed={open}
      aria-label={label !== '' ? label : 'Render profile'}
      title={label !== '' ? `${label} — edit` : 'Render as another device, user agent or network'}
      onClick={onToggle}
    >
      <RenderProfileIcon />
    </button>
  );
}

/** The tab strip's badge on a profiled tab (its accessible name says which profile). */
export function TabProfileBadge({ state }: { readonly state: TabRenderProfile }) {
  const label = badgeLabel(state);
  return (
    <span className="tab-profile" data-testid="tab-render-profile" data-needs-reload={state.needsReload} data-status={state.status} title={label}>
      <RenderProfileIcon className="tab-profile-icon" />
      <span className="visually-hidden">, {label}</span>
    </span>
  );
}

/** The status bar's chip: the profile, "Reload to apply", or that it was not applied. */
export function StatusProfileChip({ state }: { readonly state: TabRenderProfile }) {
  return (
    <span className="status-render-profile" data-testid="status-render-profile" data-needs-reload={state.needsReload} data-status={state.status} title={badgeLabel(state)}>
      <RenderProfileIcon className="status-render-profile-icon" />
      <span>{chipText(state)}</span>
    </span>
  );
}

/** The status bar's chip for a tab's overrides (Phase 11 Task 6): absent while every override is off. */
export function StatusOverridesChip({ tab }: { readonly tab: TabState }) {
  const text = overridesChipText(tab.tabOverrides, tab.overridesStatus);
  if (text === null) return null;
  const failed = overridesFailedNote(tab.tabOverrides, tab.overridesStatus);
  return (
    <span
      className="status-render-profile status-tab-overrides"
      data-testid="status-tab-overrides"
      data-loaded-under-overrides={tab.loadedUnderOverrides}
      data-status={tab.overridesStatus}
      title={failed ? `This tab only: ${text}. ${failed}` : `This tab only: ${text}`}
    >
      <RenderProfileIcon className="status-render-profile-icon" />
      <span>{text}</span>
    </span>
  );
}

/** The page-area frame of a profiled tab (absent in fullscreen and without a profile). */
export function RenderProfileFrame({ tab, onEdit }: { readonly tab: TabState | undefined; readonly onEdit: () => void }) {
  const state = tab?.renderProfile ?? null;
  if (!tab || !state || tab.fullscreen !== null) return null;
  return <Frame tab={tab} state={state} onEdit={onEdit} />;
}

function Frame({ tab, state, onEdit }: { readonly tab: TabState; readonly state: TabRenderProfile; readonly onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const { width, height } = el.getBoundingClientRect();
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const outline = outlineRect(state, size.width, size.height);
  const notes = frameNotes(state);
  const page = tab.url !== '' && tab.error === null && !tab.crashed;
  return (
    <div ref={ref} className="render-frame" data-testid="render-frame" data-status={state.status} data-source={state.source} data-device={state.profile.device}>
      <svg className="render-frame-art" width={size.width} height={size.height} aria-hidden="true" focusable="false">
        {outline ? <rect className="render-frame-device" x={outline.x} y={outline.y} width={Math.max(0, outline.width)} height={Math.max(0, outline.height)} rx="3" /> : null}
      </svg>
      <div className="render-frame-header" role="group" aria-label="Render profile">
        <RenderProfileIcon className="render-frame-icon" />
        <span className="render-frame-summary" data-testid="render-frame-summary" title={badgeLabel(state)}>
          {renderProfileSummary(state.profile)}
        </span>
        {state.source === 'site' ? <span className="render-frame-tag">Pinned to this site</span> : null}
        {notes.crawler ? (
          <span className="render-frame-tag render-frame-caveat" data-testid="render-frame-crawler-note" title={CRAWLER_HONESTY_NOTE}>
            Not the real crawler
            <span className="visually-hidden">: {CRAWLER_HONESTY_NOTE}</span>
          </span>
        ) : null}
        {notes.failed ? (
          <span className="render-frame-tag render-frame-failed" data-testid="render-frame-failed" role="status">
            {notes.failed}
          </span>
        ) : null}
        <span className="render-frame-spacer" />
        {state.needsReload && page && state.status !== 'failed' ? (
          <button type="button" className="render-frame-button render-frame-primary" data-testid="render-frame-reload" onClick={() => void actions.reload()}>
            {RELOAD_TO_APPLY_LABEL}
          </button>
        ) : null}
        <button type="button" className="render-frame-button" data-testid="render-frame-edit" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="render-frame-button" data-testid="render-frame-reset" title="Back to frost’s defaults for this tab (and unpin this site)" onClick={() => void actions.clearRenderProfile(tab.id)}>
          Reset
        </button>
      </div>
    </div>
  );
}

/** The editor bar under the chrome row: quick profiles, the form, Apply / Reset, and the crawler caveat. */
export function RenderProfileBar({ tab, onClose }: { readonly tab: TabState | undefined; readonly onClose: () => void }) {
  const state = tab?.renderProfile ?? null;
  const [draft, setDraft] = useState<ProfileDraft>(() => draftOf(state));
  // Another tab, or the profile changed from elsewhere: start from what is in effect.
  const seed = `${tab?.id ?? ''}\u0000${state ? JSON.stringify(state.profile) : ''}\u0000${state?.pinned === true}`;
  useEffect(() => setDraft(draftOf(state)), [seed]);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  const result = profileOfDraft(draft);
  const site = tab !== undefined && isWebUrl(tab.url);
  const crawler = (CRAWLER_USER_AGENTS as readonly string[]).includes(draft.userAgent);
  const update = (patch: Partial<ProfileDraft>): void => setDraft((old) => ({ ...old, ...patch }));
  const apply = (): void => {
    if (!tab || !result.ok) return;
    if (result.isDefault) void actions.clearRenderProfile(tab.id);
    // "Pin to this site": ticked pins; unticked by the user unpins; never touched, the site's pin stays.
    else void actions.setRenderProfile(tab.id, result.profile, draft.pin && site ? true : state?.pinned === true ? false : undefined);
  };
  return (
    <section
      className="render-bar"
      data-testid="render-profile-bar"
      aria-label="Render profile"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="render-bar-row">
        <span className="render-bar-title">Render as</span>
        {QUICK_RENDER_PROFILES.map((quick, index) => (
          <button
            key={quick.id}
            ref={index === 0 ? first : undefined}
            type="button"
            className="render-chip"
            data-testid={`render-quick-${quick.id}`}
            disabled={!tab}
            onClick={() => {
              // The tab's own profile; the site's pin, if any, stays (`render-profile.feature.md`).
              if (tab) void actions.setRenderProfile(tab.id, quick.profile);
            }}
          >
            {quick.label}
          </button>
        ))}
        <span className="render-frame-spacer" />
        <button type="button" className="tool render-bar-close" data-testid="render-profile-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Glyph>
            <path d="M6 6l12 12M18 6L6 18" />
          </Glyph>
        </button>
      </div>
      <form
        className="render-bar-row render-bar-form"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="render-field">
          <span>Device</span>
          <select data-testid="render-device" value={draft.device} onChange={(event) => update({ device: event.target.value as DevicePresetId })}>
            {DEVICE_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {deviceLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="render-field">
          <span>User agent</span>
          <select data-testid="render-user-agent" value={draft.userAgent} onChange={(event) => update({ userAgent: event.target.value as UserAgentId })}>
            {USER_AGENT_IDS.map((id) => (
              <option key={id} value={id}>
                {USER_AGENT_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        {draft.userAgent === 'custom' ? (
          <input
            className="render-custom-ua"
            data-testid="render-custom-ua"
            aria-label="Custom user agent"
            placeholder="User-Agent header"
            spellCheck={false}
            maxLength={MAX_CUSTOM_USER_AGENT_LENGTH}
            value={draft.customUserAgent}
            onChange={(event) => update({ customUserAgent: event.target.value })}
          />
        ) : null}
        <label className="render-field">
          <span>Network</span>
          <select data-testid="render-network" value={draft.network} onChange={(event) => update({ network: event.target.value as NetworkPresetId })}>
            {NETWORK_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {NETWORK_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="render-check">
          <input type="checkbox" data-testid="render-js-off" checked={draft.javascriptDisabled} onChange={(event) => update({ javascriptDisabled: event.target.checked })} />
          <span>JavaScript off</span>
        </label>
        <label className="render-check">
          <input type="checkbox" data-testid="render-cache-off" checked={draft.cacheDisabled} onChange={(event) => update({ cacheDisabled: event.target.checked })} />
          <span>Cache off</span>
        </label>
        <label className="render-check" title={site ? 'Use this profile whenever a tab opens this site (stored on this computer)' : 'Open a web page to pin a profile to its site'}>
          <input type="checkbox" data-testid="render-pin" disabled={!site} checked={draft.pin && site} onChange={(event) => update({ pin: event.target.checked })} />
          <span>Pin to this site</span>
        </label>
        <span className="render-frame-spacer" />
        {!result.ok ? (
          <span className="render-bar-error" role="alert" data-testid="render-error">
            {result.error}
          </span>
        ) : null}
        <button type="submit" className="render-frame-button render-frame-primary" data-testid="render-apply" disabled={!tab || !result.ok}>
          Apply
        </button>
        <button type="button" className="render-frame-button" data-testid="render-reset" disabled={!tab || state === null} onClick={() => tab && void actions.clearRenderProfile(tab.id)}>
          Reset
        </button>
      </form>
      {crawler ? (
        <p className="render-bar-note" data-testid="render-crawler-note">
          {CRAWLER_HONESTY_NOTE}
        </p>
      ) : null}
      {tab ? <TabOverridesRow tab={tab} /> : null}
    </section>
  );
}

/**
 * The editor bar's tab overrides (Phase 11 Task 6, `render-profile.feature.md`, Tab overrides): CSS
 * off, cookies off and a browser location for this tab only, each applied at once through
 * `tabOverrides.set` (never part of the profile above, never pinned).
 */
function TabOverridesRow({ tab }: { readonly tab: TabState }) {
  // What the user last chose, shown at once; main's state replaces it when it comes back (or changes).
  const [overrides, setLocal] = useState<TabOverrides>(tab.tabOverrides);
  const shown = `${tab.id}\u0000${JSON.stringify(tab.tabOverrides)}`;
  useEffect(() => setLocal(tab.tabOverrides), [shown]);
  const [choice, setChoice] = useState<GeolocationChoice>(() => geolocationChoiceOf(overrides.geolocation));
  const [geo, setGeo] = useState<GeolocationDraft>(() => geolocationDraftOf(overrides.geolocation));
  // Another tab, or the location changed from elsewhere: start from what is in effect.
  const seed = `${tab.id}\u0000${JSON.stringify(overrides.geolocation)}`;
  useEffect(() => {
    setChoice(geolocationChoiceOf(overrides.geolocation));
    setGeo(geolocationDraftOf(overrides.geolocation));
  }, [seed]);
  const send = (next: TabOverrides): void => {
    setLocal(next);
    void actions.setTabOverrides(tab.id, next);
  };
  const custom = geolocationOfDraft(geo);
  // Main's state, not the local choice: whether what main put into effect failed.
  const failedNote = overridesFailedNote(tab.tabOverrides, tab.overridesStatus);
  const choose = (next: GeolocationChoice): void => {
    setChoice(next);
    if (next === 'custom') return;
    const preset = GEOLOCATION_PRESETS.find((p) => p.id === next);
    send({ ...overrides, geolocation: preset ? { ...preset.geolocation } : null });
  };
  return (
    <div className="render-bar-row render-bar-form" role="group" aria-label="This tab only" data-testid="render-tab-overrides">
      <span className="render-bar-title">This tab only</span>
      <label className="render-check" title={CSS_OFF_HINT}>
        <input type="checkbox" data-testid="render-css-off" checked={overrides.cssDisabled} onChange={(event) => send({ ...overrides, cssDisabled: event.target.checked })} />
        <span>{TAB_OVERRIDE_LABELS.cssDisabled}</span>
      </label>
      <label className="render-check" title={COOKIES_OFF_HINT}>
        <input type="checkbox" data-testid="render-cookies-off" checked={overrides.cookiesDisabled} onChange={(event) => send({ ...overrides, cookiesDisabled: event.target.checked })} />
        <span>{TAB_OVERRIDE_LABELS.cookiesDisabled}</span>
      </label>
      <label className="render-field" title={GEOLOCATION_HINT}>
        <span>{TAB_OVERRIDE_LABELS.geolocation}</span>
        <select data-testid="render-geolocation" value={choice} onChange={(event) => choose(event.target.value as GeolocationChoice)}>
          <option value="off">Your own</option>
          {GEOLOCATION_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {choice === 'custom' ? (
        <form
          className="render-geo-custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (custom.ok) send({ ...overrides, geolocation: custom.geolocation });
          }}
        >
          <input className="render-custom-ua render-geo-field" data-testid="render-geo-latitude" aria-label="Latitude" placeholder="Latitude" inputMode="decimal" value={geo.latitude} onChange={(event) => setGeo({ ...geo, latitude: event.target.value })} />
          <input className="render-custom-ua render-geo-field" data-testid="render-geo-longitude" aria-label="Longitude" placeholder="Longitude" inputMode="decimal" value={geo.longitude} onChange={(event) => setGeo({ ...geo, longitude: event.target.value })} />
          <input
            className="render-custom-ua render-geo-field"
            data-testid="render-geo-accuracy"
            aria-label={`Accuracy in metres (${GEOLOCATION_LIMITS.minAccuracy}–${GEOLOCATION_LIMITS.maxAccuracy})`}
            placeholder="Accuracy (m)"
            inputMode="numeric"
            value={geo.accuracy}
            onChange={(event) => setGeo({ ...geo, accuracy: event.target.value })}
          />
          {!custom.ok ? (
            <span className="render-bar-error" role="alert" data-testid="render-geo-error">
              {custom.error}
            </span>
          ) : null}
          <button type="submit" className="render-frame-button render-frame-primary" data-testid="render-geo-apply" disabled={!custom.ok}>
            Set
          </button>
        </form>
      ) : null}
      <span className="render-frame-spacer" />
      <button type="button" className="render-frame-button" data-testid="render-overrides-reset" disabled={isDefaultTabOverrides(overrides)} onClick={() => send(DEFAULT_TAB_OVERRIDES)}>
        Back to normal
      </button>
      {overrides.cssDisabled ? (
        <span className="render-frame-tag" data-testid="render-css-off-badge" title={CSS_OFF_HINT}>
          {CSS_OFF_BADGE}
        </span>
      ) : null}
      {overrides.cookiesDisabled ? (
        <p className="render-bar-note" data-testid="render-cookies-off-note">
          {COOKIES_OFF_HINT}
        </p>
      ) : null}
      {failedNote ? (
        <p className="render-bar-note render-overrides-failed" data-testid="render-overrides-failed" role="status">
          {failedNote}
        </p>
      ) : null}
    </div>
  );
}
