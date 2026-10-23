import {
  ALLOWED_EXTERNAL_SCHEMES,
  ALLOWED_MAILTO_PARAMS,
  APP_CSP,
  APP_HOST,
  APP_SCHEME,
  FORBIDDEN_EXTERNAL_URL_CHARS,
  GRANTED_PERMISSIONS,
  HOST_REQUIRED_EXTERNAL_SCHEMES,
  PACKAGED_FORBIDDEN_ARGV,
  PACKAGED_FORBIDDEN_SWITCHES,
  USER_ACTIVATION_INPUT_TYPES,
  USER_ACTIVATION_WINDOW_MS,
} from '@app/specs/security-policy.spec';

// Pure policy decisions for `specs/security-policy.spec.ts`; Electron wiring lives in `register.ts`.

function includes(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Parses `url` for `shell.openExternal`, or returns `null` if it is not an allowlisted external URL
 * (spec `ALLOWED_EXTERNAL_SCHEMES`). The string rules judge the string as received (the
 * `window.open` path has already been canonicalized by Chromium): whitespace/control characters and
 * backslashes are rejected rather than trimmed, `http(s)` must be literally `scheme://host` with no
 * credentials, and `mailto:` may only carry `ALLOWED_MAILTO_PARAMS`. Callers open the returned
 * `href`, never the raw input.
 */
export function parseExternalUrl(url: string): URL | null {
  if (typeof url !== 'string' || url === '' || FORBIDDEN_EXTERNAL_URL_CHARS.test(url)) return null;
  const parsed = tryParseUrl(url);
  if (!parsed || !includes(ALLOWED_EXTERNAL_SCHEMES, parsed.protocol)) return null;
  if (includes(HOST_REQUIRED_EXTERNAL_SCHEMES, parsed.protocol)) {
    const hierarchical = url.slice(0, parsed.protocol.length + 2).toLowerCase() === `${parsed.protocol}//`;
    if (!hierarchical || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return null;
  }
  if (parsed.protocol === 'mailto:') {
    for (const key of parsed.searchParams.keys()) {
      if (!includes(ALLOWED_MAILTO_PARAMS, key.toLowerCase())) return null;
    }
  }
  return parsed;
}

/** `allow` only for an allowlisted external URL opened on a real user gesture (spec, Review Focus). */
export function resolveExternalOpen(url: string, opts: { userGesture: boolean }): 'allow' | 'deny' {
  return opts.userGesture === true && parseExternalUrl(url) !== null ? 'allow' : 'deny';
}

/** Whether a trusted `input-event` type counts as user activation (spec `USER_ACTIVATION_INPUT_TYPES`). */
export function isActivationInput(type: string): boolean {
  return includes(USER_ACTIVATION_INPUT_TYPES, type);
}

/** Whether an activation at `lastActivationAt` is still live at `now` (spec `USER_ACTIVATION_WINDOW_MS`). */
export function hasTransientActivation(lastActivationAt: number | undefined, now: number): boolean {
  if (lastActivationAt === undefined) return false;
  const age = now - lastActivationAt;
  return age >= 0 && age <= USER_ACTIVATION_WINDOW_MS;
}

/** Whether `url` is on the app origin `app://app` (spec `APP_SCHEME`/`APP_HOST`). */
export function isAppUrl(url: string): boolean {
  const parsed = tryParseUrl(url);
  // Node's WHATWG URL treats `app:` as non-special (opaque origin, case-preserved host), so compare
  // scheme and host rather than `origin`; Chromium canonicalizes the registered standard scheme.
  return parsed !== null && parsed.protocol === `${APP_SCHEME}:` && parsed.host.toLowerCase() === APP_HOST;
}

/**
 * Whether the app frame may navigate in-window to `url`: the app origin only, plus the Vite
 * dev-server origin when `devServerUrl` is given (unpackaged `electron-forge start` only).
 */
export function isAllowedAppNavigation(url: string, opts: { devServerUrl?: string | undefined }): boolean {
  if (isAppUrl(url)) return true;
  if (!opts.devServerUrl) return false;
  const target = tryParseUrl(url);
  const devServer = tryParseUrl(opts.devServerUrl);
  return target !== null && devServer !== null && devServer.origin !== 'null' && target.origin === devServer.origin;
}

/** Deny-by-default permission policy (spec `GRANTED_PERMISSIONS`, empty in Phase 0). */
export function isPermissionGranted(permission: string): boolean {
  return includes(GRANTED_PERMISSIONS, permission);
}

/** The `Content-Security-Policy` value for `app://` responses (spec `APP_CSP`). */
export function appCspHeader(): string {
  return APP_CSP;
}

/** Returns `headers` with any existing CSP header (any letter case) replaced by the app CSP. */
export function withAppCsp(headers: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-security-policy') result[name] = value;
  }
  result['Content-Security-Policy'] = [appCspHeader()];
  return result;
}

/**
 * Why a packaged app must refuse to start, or `null` (spec `PACKAGED_FORBIDDEN_SWITCHES` /
 * `PACKAGED_FORBIDDEN_ARGV`). Unpackaged runs (dev, e2e) are never refused.
 */
export function remoteDebuggingRefusal(opts: {
  isPackaged: boolean;
  hasSwitch: (name: string) => boolean;
  argv: readonly string[];
}): string | null {
  if (!opts.isPackaged) return null;
  const name = PACKAGED_FORBIDDEN_SWITCHES.find((s) => opts.hasSwitch(s));
  const arg = opts.argv.slice(1).find((a) => PACKAGED_FORBIDDEN_ARGV.test(a));
  const offending = name ?? arg;
  return offending === undefined ? null : `remote debugging is disabled in packaged builds (${offending})`;
}
