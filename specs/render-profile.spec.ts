/**
 * Per-tab render profiles (Phase 2.5 Task 1; acceptance `render-profile.feature.md`). A profile
 * renders a tab's pages the way another device, user agent or network would: main drives the tab's
 * own `webContents.debugger` (CDP in-process, no remote-debugging port) with an allowlist of CDP
 * methods. Plain values and pure functions with no imports, so the chrome renderer can use them
 * without bundling Zod (strict Trusted Types); the Zod schemas are in `render-profile.schema.spec.ts`.
 *
 * Implemented by `apps/desktop/src/main/browser/render-profile*.ts` (main), the `browser.setRenderProfile`
 * / `browser.clearRenderProfile` procedures, `@app/db` (pins) and the chrome's render-profile bar,
 * frame, tab badge and status-bar chip.
 */

// ---- What a profile is -----------------------------------------------------------------------

/**
 * Device presets: the viewport (CSS pixels), device-scale factor, mobile flag (the page's
 * `<meta name="viewport">` applies, scrollbars overlay) and touch. `none` keeps the page area's own
 * size and the machine's display: no device emulation at all.
 */
export const DEVICE_PRESET_IDS = ['none', 'desktop', 'phone', 'tablet'] as const;
export type DevicePresetId = (typeof DEVICE_PRESET_IDS)[number];

export interface DevicePreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly touch: boolean;
}

/**
 * The emulated devices (frost's own choice of common sizes): a laptop-class desktop, a common
 * Android-class phone and a common tablet, in portrait. Touch reports `TOUCH_POINTS` points.
 */
export const DEVICE_PRESETS: Readonly<Record<Exclude<DevicePresetId, 'none'>, DevicePreset>> = {
  desktop: { label: 'Desktop', width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  phone: { label: 'Phone', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  tablet: { label: 'Tablet', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
};
export const TOUCH_POINTS = 5;

/**
 * User agents: `browser` is frost's own (no override). The others replace the `User-Agent` header
 * and `navigator.userAgent`, with matching client hints (`navigator.userAgentData`, `Sec-CH-UA-*`)
 * built from the same platform and mobile flag. `custom` is the user's text, sent as is (trimmed),
 * with no client hints (there is nothing to derive them from).
 */
export const USER_AGENT_IDS = ['browser', 'mobile', 'googlebot-smartphone', 'googlebot-desktop', 'bingbot', 'custom'] as const;
export type UserAgentId = (typeof USER_AGENT_IDS)[number];

/** The crawler user agents: each shows `CRAWLER_HONESTY_NOTE`. */
export const CRAWLER_USER_AGENTS = ['googlebot-smartphone', 'googlebot-desktop', 'bingbot'] as const satisfies readonly UserAgentId[];

/**
 * Longest custom user agent (characters); only printable ASCII (`CUSTOM_USER_AGENT_PATTERN`), so it
 * is always a valid header value. Longer or other text is rejected (`BAD_REQUEST`), never cut.
 */
export const MAX_CUSTOM_USER_AGENT_LENGTH = 256;
export const CUSTOM_USER_AGENT_PATTERN = /^[\x20-\x7e]*$/;

/**
 * Network conditions. Throughput in bytes per second, latency the added round-trip time in ms
 * (frost's own round numbers, close to the usual "slow 3G / fast 3G / 4G" profiles). `none` is no
 * throttling; `offline` fails every request.
 */
export const NETWORK_PRESET_IDS = ['none', 'offline', 'slow-3g', 'fast-3g', '4g'] as const;
export type NetworkPresetId = (typeof NETWORK_PRESET_IDS)[number];

export interface NetworkPreset {
  readonly label: string;
  readonly offline: boolean;
  readonly latencyMs: number;
  readonly downloadBytesPerSecond: number;
  readonly uploadBytesPerSecond: number;
  /** CDP's `connectionType` (what `navigator.connection` may report). */
  readonly connectionType: 'none' | 'cellular3g' | 'cellular4g';
}

export const NETWORK_PRESETS: Readonly<Record<Exclude<NetworkPresetId, 'none'>, NetworkPreset>> = {
  offline: { label: 'Offline', offline: true, latencyMs: 0, downloadBytesPerSecond: 0, uploadBytesPerSecond: 0, connectionType: 'none' },
  'slow-3g': { label: 'Slow 3G', offline: false, latencyMs: 2_000, downloadBytesPerSecond: 50_000, uploadBytesPerSecond: 50_000, connectionType: 'cellular3g' },
  'fast-3g': { label: 'Fast 3G', offline: false, latencyMs: 560, downloadBytesPerSecond: 180_000, uploadBytesPerSecond: 84_000, connectionType: 'cellular3g' },
  '4g': { label: '4G', offline: false, latencyMs: 170, downloadBytesPerSecond: 1_125_000, uploadBytesPerSecond: 187_500, connectionType: 'cellular4g' },
};

/**
 * A render profile: one device, one user agent, one network condition and two switches. The
 * all-default profile (`DEFAULT_RENDER_PROFILE`) is no profile: setting it clears the tab's.
 * `customUserAgent` is `''` unless `userAgent` is `custom`, when it is non-blank.
 */
export interface RenderProfile {
  readonly device: DevicePresetId;
  readonly userAgent: UserAgentId;
  readonly customUserAgent: string;
  readonly network: NetworkPresetId;
  readonly javascriptDisabled: boolean;
  readonly cacheDisabled: boolean;
}

export const DEFAULT_RENDER_PROFILE: RenderProfile = {
  device: 'none',
  userAgent: 'browser',
  customUserAgent: '',
  network: 'none',
  javascriptDisabled: false,
  cacheDisabled: false,
};

/** Ready-made profiles the chrome offers first (each one click). */
export const QUICK_RENDER_PROFILES = [
  { id: 'googlebot-smartphone', label: 'Googlebot smartphone', profile: { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'googlebot-smartphone' } },
  { id: 'googlebot-desktop', label: 'Googlebot desktop', profile: { ...DEFAULT_RENDER_PROFILE, device: 'desktop', userAgent: 'googlebot-desktop' } },
  { id: 'mobile-slow', label: 'Phone on slow 3G', profile: { ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile', network: 'slow-3g' } },
  { id: 'no-javascript', label: 'JavaScript off', profile: { ...DEFAULT_RENDER_PROFILE, javascriptDisabled: true } },
] as const satisfies readonly { id: string; label: string; profile: RenderProfile }[];

/** Whether `a` and `b` are the same profile. */
export function sameRenderProfile(a: RenderProfile, b: RenderProfile): boolean {
  return (
    a.device === b.device &&
    a.userAgent === b.userAgent &&
    a.customUserAgent === b.customUserAgent &&
    a.network === b.network &&
    a.javascriptDisabled === b.javascriptDisabled &&
    a.cacheDisabled === b.cacheDisabled
  );
}

/** Whether `profile` changes nothing (the default). */
export function isDefaultRenderProfile(profile: RenderProfile): boolean {
  return sameRenderProfile(profile, DEFAULT_RENDER_PROFILE);
}

// ---- User-agent strings and client hints -----------------------------------------------------

/**
 * The user-agent strings. `{version}` is the app's own Chromium version (`process.versions.chrome`),
 * `{major}` its major number: the crawlers' published strings carry the current evergreen version
 * in the same place. Every string is printable ASCII.
 */
export const USER_AGENT_TEMPLATES: Readonly<Record<Exclude<UserAgentId, 'browser' | 'custom'>, string>> = {
  mobile: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Mobile Safari/537.36',
  'googlebot-smartphone':
    'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'googlebot-desktop': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/{version} Safari/537.36',
  bingbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/{version} Safari/537.36',
};

/** The platform each overriding user agent claims, for its client hints and `navigator.platform`. */
export const USER_AGENT_PLATFORMS: Readonly<Record<Exclude<UserAgentId, 'browser' | 'custom'>, { readonly mobile: boolean; readonly platform: 'Android' | 'Linux'; readonly platformVersion: string; readonly navigatorPlatform: string }>> = {
  mobile: { mobile: true, platform: 'Android', platformVersion: '10.0.0', navigatorPlatform: 'Linux armv8l' },
  'googlebot-smartphone': { mobile: true, platform: 'Android', platformVersion: '6.0.1', navigatorPlatform: 'Linux armv8l' },
  'googlebot-desktop': { mobile: false, platform: 'Linux', platformVersion: '', navigatorPlatform: 'Linux x86_64' },
  bingbot: { mobile: false, platform: 'Linux', platformVersion: '', navigatorPlatform: 'Linux x86_64' },
};

/** The client-hints brand for the emulated engine (`Sec-CH-UA`, `navigator.userAgentData.brands`). */
export const CLIENT_HINTS_BRAND = 'Chromium' as const;

/**
 * The GREASE brand the engine itself adds to its client hints ("Not A Brand" with two separator
 * characters and a version picked from the major version), built the way Chromium builds it, so an
 * emulated brand list looks like the engine's own: separators from `GREASE_CHARACTERS` at
 * `major % 11` and `(major + 1) % 11`, version `GREASE_VERSIONS[major % 3]`, and the GREASE brand
 * first for an even major, second for an odd one (verified against Electron 45 / Chromium 156:
 * `Not:A-Brand` version `8`, then `Chromium`).
 */
export const GREASE_CHARACTERS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const;
export const GREASE_VERSIONS = ['8', '99', '24'] as const;

/** The brand list (`major` version, or the full one for `fullVersionList`) the engine reports for `major`. */
export function clientHintsBrands(major: number, version: string, greaseFullVersion = false): { readonly brand: string; readonly version: string }[] {
  const n = Number.isSafeInteger(major) && major >= 0 ? major : 0;
  const greaseVersion = GREASE_VERSIONS[n % GREASE_VERSIONS.length]!;
  const grease = {
    brand: `Not${GREASE_CHARACTERS[n % GREASE_CHARACTERS.length]}A${GREASE_CHARACTERS[(n + 1) % GREASE_CHARACTERS.length]}Brand`,
    version: greaseFullVersion ? `${greaseVersion}.0.0.0` : greaseVersion,
  };
  const engine = { brand: CLIENT_HINTS_BRAND, version };
  return n % 2 === 0 ? [grease, engine] : [engine, grease];
}

/**
 * `chromeVersion` as a dotted version (`140.0.7339.80`), else `0.0.0.0`: a malformed version never
 * reaches a header.
 */
export function normalChromeVersion(chromeVersion: string): string {
  return /^\d{1,4}(\.\d{1,6}){3}$/.test(chromeVersion) ? chromeVersion : '0.0.0.0';
}

/**
 * The `User-Agent` a profile sends, or `null` for frost's own (`browser`). A custom one is the
 * user's text, trimmed.
 */
export function profileUserAgent(profile: RenderProfile, chromeVersion: string): string | null {
  if (profile.userAgent === 'browser') return null;
  if (profile.userAgent === 'custom') return profile.customUserAgent.trim();
  const version = normalChromeVersion(chromeVersion);
  const major = version.split('.')[0]!;
  return USER_AGENT_TEMPLATES[profile.userAgent].replaceAll('{version}', version).replaceAll('{major}', major);
}

// ---- Applying a profile: the CDP allowlist ----------------------------------------------------

/**
 * The only CDP methods frost ever sends to a tab's debugger (Global Constraints: debugger use is
 * main-only, per tab, allowlisted). Enforced in one module (`render-profile-debugger.ts`), which
 * refuses anything else before it reaches the debugger. No domain that observes the page
 * (`Runtime`, `Debugger`, `DOM`, `Page`, `Log` …) is ever enabled: `Network.enable` only while
 * "cache off" needs it, with no buffers (`NETWORK_ENABLE_PARAMS`), and its events are never read.
 */
export const RENDER_PROFILE_CDP_METHODS = [
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setTouchEmulationEnabled',
  'Emulation.setScriptExecutionDisabled',
  'Network.setUserAgentOverride',
  'Network.emulateNetworkConditions',
  'Network.setCacheDisabled',
  'Network.enable',
  'Network.disable',
] as const;
export type RenderProfileCdpMethod = (typeof RENDER_PROFILE_CDP_METHODS)[number];

/** Whether `method` is on the allowlist (exact match; never a prefix or domain). */
export function isAllowedCdpMethod(method: unknown): method is RenderProfileCdpMethod {
  return typeof method === 'string' && (RENDER_PROFILE_CDP_METHODS as readonly string[]).includes(method);
}

/**
 * CDP methods frost sends only to manage a tab's child targets (cross-site iframes, which run in
 * their own renderer, and dedicated workers), never as part of a profile:
 * - `Target.setAutoAttach`, only with `TARGET_AUTO_ATTACH_PARAMS` (on the tab and on each child
 *   frame, so nested cross-site frames are reached too), so every new child is paused before it runs
 *   anything;
 * - `Runtime.runIfWaitingForDebugger`, only on a child session the tab announced
 *   (`Target.attachedToTarget`), once its profile commands have answered (or after
 *   `CHILD_RESUME_TIMEOUT_MS`). It resumes the child; it does not enable the Runtime domain.
 * The two `Target` events are the only protocol events frost reads.
 */
export const RENDER_PROFILE_SESSION_METHODS = ['Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger'] as const;
export type RenderProfileSessionMethod = (typeof RENDER_PROFILE_SESSION_METHODS)[number];
export const TARGET_AUTO_ATTACH_PARAMS = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } as const;

/**
 * A paused child is resumed at the latest this long after it was announced, even if its commands
 * have not all answered: a child can never hold up the tab. (Resuming before its commands answered
 * can leave it paused for good in Electron 45, so frost never resumes earlier than that.)
 */
export const CHILD_RESUME_TIMEOUT_MS = 1_000;

/**
 * The profile commands a child frame gets: all of them but the viewport (`Emulation.*DeviceMetrics*`
 * is refused on anything but the tab's top-level target; a cross-site frame keeps the size its
 * parent lays it out at). A dedicated worker gets only the user agent and the cache switch.
 */
export const TOP_LEVEL_ONLY_METHODS = ['Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride'] as const satisfies readonly RenderProfileCdpMethod[];
export const WORKER_METHODS = ['Network.setUserAgentOverride', 'Network.setCacheDisabled', 'Network.enable', 'Network.disable'] as const satisfies readonly RenderProfileCdpMethod[];
export const CHILD_FRAME_TYPES = ['iframe'] as const;
export const CHILD_WORKER_TYPES = ['worker'] as const;

/**
 * Whether frost may send `method` with `params` to a session: a profile method anywhere; a session
 * method only as described above (`child`: the session is an announced child).
 */
export function isAllowedCdpCommand(method: unknown, params: unknown, session: 'top' | 'child'): boolean {
  if (isAllowedCdpMethod(method)) return true;
  if (method === 'Target.setAutoAttach') {
    if (typeof params !== 'object' || params === null) return false;
    const entries = Object.entries(params);
    return entries.length === 3 && entries.every(([key, value]) => (TARGET_AUTO_ATTACH_PARAMS as Record<string, unknown>)[key] === value);
  }
  if (method === 'Runtime.runIfWaitingForDebugger') return session === 'child' && typeof params === 'object' && params !== null && Object.keys(params).length === 0;
  return false;
}

/**
 * `Network.enable` keeps nothing: request and response bodies are never buffered (Chromium needs the
 * Network domain enabled to bypass its cache, not to keep any of the traffic).
 */
export const NETWORK_ENABLE_PARAMS = { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 } as const;

/** The CDP protocol version frost attaches with. */
export const CDP_PROTOCOL_VERSION = '1.3' as const;

// ---- The page-area frame and the emulated viewport ---------------------------------------------

/**
 * While a tab has a profile, the page area shows a frame around its view: a header strip
 * (`header` px: the profile, "Reload to apply", Reset) and a border (`inset` px) on the other sides.
 * With a device preset the view is the device's width, scaled down (never up) to fit, centred, and as
 * tall as the device or the page area allows.
 */
export const RENDER_FRAME = { header: 30, inset: 4 } as const;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the tab's view goes inside the page area, and what the page is told its viewport is. */
export interface RenderFit {
  /** The view, relative to the page area's top-left corner (integers). */
  readonly view: Rect;
  /**
   * The emulated viewport (CSS px) and the scale it is drawn at, or `null` without a device preset
   * (the view's own size).
   */
  readonly emulation: { readonly width: number; readonly height: number; readonly scale: number } | null;
}

/**
 * The fit of `device` in a page area of `area` (`width` × `height`), inside the frame: the view keeps
 * the device's width in CSS px (`scale` = the largest ≤ 1 that fits it) and its height up to the
 * device's or the frame's. Without a device the view fills the frame. Never negative.
 */
export function fitRenderViewport(area: { readonly width: number; readonly height: number }, device: DevicePresetId): RenderFit {
  const innerWidth = Math.max(0, Math.floor(area.width) - 2 * RENDER_FRAME.inset);
  const innerHeight = Math.max(0, Math.floor(area.height) - RENDER_FRAME.header - RENDER_FRAME.inset);
  const inner: Rect = { x: RENDER_FRAME.inset, y: RENDER_FRAME.header, width: innerWidth, height: innerHeight };
  if (device === 'none') return { view: inner, emulation: null };
  const preset = DEVICE_PRESETS[device];
  const scale = Math.max(0.05, Math.min(1, innerWidth / preset.width));
  const height = Math.max(1, Math.min(preset.height, Math.floor(innerHeight / scale)));
  const width = Math.min(innerWidth, Math.round(preset.width * scale));
  const viewHeight = Math.min(innerHeight, Math.round(height * scale));
  return {
    view: { x: inner.x + Math.floor((innerWidth - width) / 2), y: inner.y, width, height: viewHeight },
    emulation: { width: preset.width, height, scale },
  };
}

// ---- What the chrome sees ----------------------------------------------------------------------

/**
 * Where a tab's profile comes from: set on the tab (`tab`), or this site's pin (`site`). See
 * `render-profile.feature.md`, Scope and lifetime.
 */
export const RENDER_PROFILE_SOURCES = ['tab', 'site'] as const;
export type RenderProfileSource = (typeof RENDER_PROFILE_SOURCES)[number];

/**
 * Whether the profile is in effect: `applying` (commands sent, not all answered), `active`, or
 * `failed` (the debugger could not be attached or refused a command; the page is shown unemulated
 * and the chrome says so).
 */
export const RENDER_PROFILE_STATUSES = ['applying', 'active', 'failed'] as const;
export type RenderProfileStatus = (typeof RENDER_PROFILE_STATUSES)[number];

/** A tab's render profile as `TabState.renderProfile` reports it (`null`: none). */
export interface TabRenderProfile {
  readonly profile: RenderProfile;
  readonly source: RenderProfileSource;
  /** This site's pin is this profile ("Pin to this site" is on). */
  readonly pinned: boolean;
  /** The page on screen loaded before (part of) the profile was in effect: "Reload to apply". */
  readonly needsReload: boolean;
  readonly status: RenderProfileStatus;
}

/**
 * The profile an audit ran under (`seo.getAudit`'s ready answer, `renderProfile`): `null` for none.
 * `partial`: it was set after the page loaded (the audit saw an unreloaded page).
 */
export interface AuditRenderProfile {
  readonly profile: RenderProfile;
  readonly partial: boolean;
}

/** Most sites with a pinned profile kept (`render_profile_pins`); pinning one more drops the oldest. */
export const MAX_RENDER_PROFILE_PINS = 200;

// ---- Wording (frost's own) ---------------------------------------------------------------------

export const USER_AGENT_LABELS: Readonly<Record<UserAgentId, string>> = {
  browser: 'frost (default)',
  mobile: 'Mobile browser',
  'googlebot-smartphone': 'Googlebot smartphone',
  'googlebot-desktop': 'Googlebot desktop',
  bingbot: 'Bingbot',
  custom: 'Custom…',
};

export const NETWORK_LABELS: Readonly<Record<NetworkPresetId, string>> = {
  none: 'No throttling',
  offline: NETWORK_PRESETS.offline.label,
  'slow-3g': NETWORK_PRESETS['slow-3g'].label,
  'fast-3g': NETWORK_PRESETS['fast-3g'].label,
  '4g': NETWORK_PRESETS['4g'].label,
};

export function deviceLabel(device: DevicePresetId): string {
  if (device === 'none') return 'Window size';
  const preset = DEVICE_PRESETS[device];
  return `${preset.label} ${preset.width}×${preset.height}`;
}

/** The profile in a few words (`Phone 412×915 · Googlebot smartphone · Slow 3G · JavaScript off`). */
export function renderProfileSummary(profile: RenderProfile): string {
  const parts: string[] = [];
  if (profile.device !== 'none') parts.push(deviceLabel(profile.device));
  if (profile.userAgent === 'custom') parts.push('Custom user agent');
  else if (profile.userAgent !== 'browser') parts.push(USER_AGENT_LABELS[profile.userAgent]);
  if (profile.network !== 'none') parts.push(NETWORK_LABELS[profile.network]);
  if (profile.javascriptDisabled) parts.push('JavaScript off');
  if (profile.cacheDisabled) parts.push('Cache off');
  return parts.length === 0 ? 'No overrides' : parts.join(' · ');
}

/** Whether the profile sends a crawler's user agent (`CRAWLER_HONESTY_NOTE` applies). */
export function isCrawlerProfile(profile: RenderProfile): boolean {
  return (CRAWLER_USER_AGENTS as readonly string[]).includes(profile.userAgent);
}

/** Shown wherever a crawler user agent is in effect (the frame, the bar and the audit's Overview). */
export const CRAWLER_HONESTY_NOTE =
  'A crawler user agent only changes what this tab says it is. Requests still come from your network and the page is rendered by frost, so the real crawler may get different responses and render the page differently.';

/** Shown while the page on screen predates the profile. */
export const RELOAD_TO_APPLY_LABEL = 'Reload to apply' as const;

/** Shown when the profile could not be applied. */
export const PROFILE_FAILED_NOTE = 'This profile could not be applied; the page is shown without it.' as const;

/** The lab-data caveat of page speed under a profile (the Speed panel's `LAB_DATA_NOTE` otherwise). */
export function profileLabDataNote(profile: RenderProfile): string {
  return `Lab data: one visit, measured in this tab on this machine under the render profile “${renderProfileSummary(profile)}” (device, user agent and network are emulated; CPU is not). Real visitors’ experience (field data) can be very different.`;
}
