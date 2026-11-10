import { isLocationProxyScheme, LOCATION_SCHEME_LABELS, LOCATIONS_SETTINGS_TEXT as TEXT, schemeTakesCredentials, type LocationProxyScheme, type LocationWriteResult } from '@app/specs/location-profiles.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { LocationProfile, LocationProfileInput, LocationProfilesView } from '@app/specs/location-profiles.schema';

// Settings › Locations as a view model (Phase 12 Task 10b; acceptance `location-profiles.feature.md`).
// Pure: main's view (`locations.list`) becomes the rows; the form's fields become the input main
// checks again. A sign-in is never part of a row (main says `hasCredentials` only), and the form sends
// one only when both fields are filled and the scheme takes one.

export interface LocationRowView {
  readonly id: string;
  readonly label: string;
  /** "HTTP proxy.example.net:3128". */
  readonly proxy: string;
  /** "Sign-in saved" / "No sign-in"; `null` for SOCKS5 (it takes none). */
  readonly signIn: string | null;
  readonly profile: LocationProfile;
}

const hostPort = (profile: Pick<LocationProfile, 'host' | 'port'>): string => `${profile.host}:${profile.port}`;

export function locationRows(view: LocationProfilesView): LocationRowView[] {
  return view.profiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    proxy: `${LOCATION_SCHEME_LABELS[profile.scheme]} ${hostPort(profile)}`,
    signIn: schemeTakesCredentials(profile.scheme) ? (profile.hasCredentials ? TEXT.credentialsSet : TEXT.noCredentials) : null,
    profile,
  }));
}

/** The form's fields as typed (the port as text). */
export interface LocationFields {
  readonly label: string;
  readonly scheme: LocationProxyScheme | string;
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
}

/**
 * The input for main, or `null` when the fields cannot make one (no scheme, a port that is not a
 * whole number, one sign-in field without the other). Blank sign-in fields send none (on edit: keep
 * the saved one); a SOCKS5 proxy never sends one. Main normalises and checks the rest.
 */
export function locationInput(fields: LocationFields): LocationProfileInput | null {
  if (!isLocationProxyScheme(fields.scheme)) return null;
  const port = /^\d{1,5}$/.test(fields.port.trim()) ? Number(fields.port.trim()) : Number.NaN;
  if (!Number.isInteger(port)) return null;
  const base: LocationProfileInput = { label: fields.label, scheme: fields.scheme, host: fields.host, port };
  if (!schemeTakesCredentials(fields.scheme)) return base;
  const username = fields.username;
  const password = fields.password;
  if (username === '' && password === '') return base;
  if (username === '' || password === '') return null;
  return { ...base, username, password };
}

/** What Save or Remove says for main's answer (never a secret). */
export function locationWriteMessage(result: LocationWriteResult): string {
  return (TEXT.results as Readonly<Record<string, string>>)[result] ?? TEXT.results.failed;
}
