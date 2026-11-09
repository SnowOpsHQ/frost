import {
  CUSTOM_USER_AGENT_PATTERN,
  DEFAULT_RENDER_PROFILE,
  GEOLOCATION_LIMITS,
  GEOLOCATION_PRESETS,
  hasGeolocationPrecision,
  isDefaultTabOverrides,
  tabOverridesSummary,
  fitRenderViewport,
  isCrawlerProfile,
  isDefaultRenderProfile,
  MAX_CUSTOM_USER_AGENT_LENGTH,
  PROFILE_FAILED_NOTE,
  RELOAD_TO_APPLY_LABEL,
  renderProfileSummary,
  type DevicePresetId,
  type NetworkPresetId,
  type Rect,
  type RenderProfile,
  type GeolocationOverride,
  type TabOverrides,
  type TabRenderProfile,
  type UserAgentId,
} from '@app/specs/render-profile.spec';

// What the chrome shows of a tab's render profile (spec `render-profile.feature.md`, Visible state):
// the tab badge, the status-bar chip, the page-area frame, and the editor bar's draft. Pure, so it
// is unit tested; the components only render it.

/** The badge's accessible text and tooltip. */
export function badgeLabel(state: TabRenderProfile): string {
  const where = state.source === 'site' ? ' (pinned to this site)' : '';
  return `Render profile: ${renderProfileSummary(state.profile)}${where}`;
}

/** The status-bar chip: the profile, then what it still needs. */
export function chipText(state: TabRenderProfile): string {
  const summary = renderProfileSummary(state.profile);
  if (state.status === 'failed') return `${summary} · not applied`;
  if (state.needsReload) return `${summary} · ${RELOAD_TO_APPLY_LABEL}`;
  return summary;
}

/** The frame's notes, in order: why it failed, and the crawler caveat. */
export function frameNotes(state: TabRenderProfile): { readonly failed: string | null; readonly crawler: boolean } {
  return { failed: state.status === 'failed' ? PROFILE_FAILED_NOTE : null, crawler: isCrawlerProfile(state.profile) };
}

/**
 * The outline the frame draws around the tab's view in a page area of `width` × `height`: the view's
 * rectangle (`fitRenderViewport`, as main lays it out) grown by one pixel; `null` without a device
 * (the view fills the frame).
 */
export function outlineRect(state: TabRenderProfile, width: number, height: number): Rect | null {
  if (state.profile.device === 'none') return null;
  const { view } = fitRenderViewport({ width, height }, state.profile.device);
  return { x: view.x - 1, y: view.y - 1, width: view.width + 2, height: view.height + 2 };
}

/** The editor bar's form: a profile being edited, and "Pin to this site". */
export interface ProfileDraft {
  readonly device: DevicePresetId;
  readonly userAgent: UserAgentId;
  readonly customUserAgent: string;
  readonly network: NetworkPresetId;
  readonly javascriptDisabled: boolean;
  readonly cacheDisabled: boolean;
  readonly pin: boolean;
}

/** The draft the bar opens with: the tab's profile (and whether it is this site's pin), else the defaults. */
export function draftOf(state: TabRenderProfile | null): ProfileDraft {
  const profile = state?.profile ?? DEFAULT_RENDER_PROFILE;
  return { ...profile, pin: state?.pinned === true };
}

/**
 * The profile a draft stands for, or why it is not one yet (a blank, over-long or non-ASCII custom
 * user agent: the procedure would refuse it). A custom user agent is sent trimmed; other user agents
 * carry no text.
 */
export function profileOfDraft(draft: ProfileDraft): { readonly ok: true; readonly profile: RenderProfile; readonly isDefault: boolean } | { readonly ok: false; readonly error: string } {
  let customUserAgent = '';
  if (draft.userAgent === 'custom') {
    customUserAgent = draft.customUserAgent.trim();
    if (customUserAgent === '') return { ok: false, error: 'Enter a user agent' };
    if (customUserAgent.length > MAX_CUSTOM_USER_AGENT_LENGTH) return { ok: false, error: `At most ${MAX_CUSTOM_USER_AGENT_LENGTH} characters` };
    if (!CUSTOM_USER_AGENT_PATTERN.test(customUserAgent)) return { ok: false, error: 'Use printable ASCII characters only' };
  }
  const profile: RenderProfile = {
    device: draft.device,
    userAgent: draft.userAgent,
    customUserAgent,
    network: draft.network,
    javascriptDisabled: draft.javascriptDisabled,
    cacheDisabled: draft.cacheDisabled,
  };
  return { ok: true, profile, isDefault: isDefaultRenderProfile(profile) };
}

// ---- Tab overrides (Phase 11 Task 6, `render-profile.feature.md`, Tab overrides: Visible state) ----

/** The status bar's overrides chip, or `null` when every override is off. */
export function overridesChipText(overrides: TabOverrides): string | null {
  return isDefaultTabOverrides(overrides) ? null : tabOverridesSummary(overrides);
}

/** The location menu's choice: off, a preset's id, or a custom location. */
export type GeolocationChoice = 'off' | 'custom' | (typeof GEOLOCATION_PRESETS)[number]['id'];

/** Which choice a tab's location is: a preset when it is exactly one, else custom. */
export function geolocationChoiceOf(geolocation: GeolocationOverride | null): GeolocationChoice {
  if (geolocation === null) return 'off';
  const preset = GEOLOCATION_PRESETS.find((p) => p.geolocation.latitude === geolocation.latitude && p.geolocation.longitude === geolocation.longitude && p.geolocation.accuracy === geolocation.accuracy);
  return preset ? preset.id : 'custom';
}

/** The custom location form: the three fields as typed. */
export interface GeolocationDraft {
  readonly latitude: string;
  readonly longitude: string;
  readonly accuracy: string;
}

export function geolocationDraftOf(geolocation: GeolocationOverride | null): GeolocationDraft {
  return geolocation ? { latitude: String(geolocation.latitude), longitude: String(geolocation.longitude), accuracy: String(geolocation.accuracy) } : { latitude: '', longitude: '', accuracy: '100' };
}

/**
 * The location a custom form stands for, or why not (main would refuse it: `GEOLOCATION_LIMITS`).
 * Never rounded or clamped: the user sees what is wrong.
 */
export function geolocationOfDraft(draft: GeolocationDraft): { readonly ok: true; readonly geolocation: GeolocationOverride } | { readonly ok: false; readonly error: string } {
  const number = (text: string): number => (/^\s*-?\d+(\.\d+)?\s*$/.test(text) ? Number(text) : Number.NaN);
  const latitude = number(draft.latitude);
  const longitude = number(draft.longitude);
  const accuracy = number(draft.accuracy);
  const { maxLatitude, maxLongitude, minAccuracy, maxAccuracy, decimals } = GEOLOCATION_LIMITS;
  if (!Number.isFinite(latitude) || Math.abs(latitude) > maxLatitude) return { ok: false, error: `Latitude: a number from −${maxLatitude} to ${maxLatitude}` };
  if (!Number.isFinite(longitude) || Math.abs(longitude) > maxLongitude) return { ok: false, error: `Longitude: a number from −${maxLongitude} to ${maxLongitude}` };
  if (!hasGeolocationPrecision(latitude) || !hasGeolocationPrecision(longitude)) return { ok: false, error: `At most ${decimals} decimals` };
  if (!Number.isInteger(accuracy) || accuracy < minAccuracy || accuracy > maxAccuracy) return { ok: false, error: `Accuracy: whole metres from ${minAccuracy} to ${maxAccuracy.toLocaleString('en-US')}` };
  return { ok: true, geolocation: { latitude, longitude, accuracy } };
}
