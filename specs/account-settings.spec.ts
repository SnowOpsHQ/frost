/**
 * The Settings view (Phase 4 Task 9; acceptance `account-settings.feature.md`; review focus "Telemetry UI
 * matches behaviour"). Plain values with no Zod, so the chrome renderer can use them (its strict Trusted
 * Types CSP blocks Zod's eval probe). The Zod schemas of the `account.settingsWatch` procedure are in
 * `account-settings.schema.ts`; the account, telemetry and Search Console states the view shows are
 * main's (`account-state.schema.ts`, `telemetry-consent.schema.ts`, `gsc.spec.ts`).
 *
 * Clean-room: frost's own names and words.
 */
import type { FeatureFlag } from './entitlements-snapshot.spec';
import type { ScrubRuleId, SpanAttributeKey } from './telemetry-privacy.spec';

/** The sheet's heading. */
export const SETTINGS_TITLE = 'Settings' as const;

/** The sections, in order (each a heading in the sheet and an entry of its section list). */
export const SETTINGS_SECTIONS = [
  { id: 'account', label: 'Account' },
  { id: 'search-console', label: 'Search Console' },
  { id: 'telemetry', label: 'Telemetry' },
] as const satisfies readonly { id: string; label: string }[];
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

/**
 * The menu item (macOS: the app menu, after About; elsewhere: the end of Edit). Its click asks main to
 * open Settings in the window the menu acted on (else the focused app window): that window's
 * `account.settingsWatch` counter goes up and its chrome is focused.
 */
export const SETTINGS_MENU = {
  id: 'settings',
  label: 'Settings…',
  accelerator: 'CmdOrCtrl+,',
} as const;

/** The palette's Settings actions (group `browser`): each opens the sheet on its section; `signedOutOnly` is offered only while signed out. */
export const SETTINGS_PALETTE_ACTIONS = [
  { id: 'settings.open', label: 'Settings', section: 'account', signedOutOnly: false, keywords: ['preferences', 'options', 'account', 'plan'] },
  { id: 'settings.sign-in', label: 'Sign in to frost', section: 'account', signedOutOnly: true, keywords: ['account', 'log in', 'login', 'plan', 'pro'] },
  { id: 'settings.search-console', label: 'Search Console settings', section: 'search-console', signedOutOnly: false, keywords: ['google', 'gsc', 'connect', 'disconnect'] },
  { id: 'settings.telemetry', label: 'Telemetry settings', section: 'telemetry', signedOutOnly: false, keywords: ['privacy', 'usage', 'crash', 'errors', 'reports', 'diagnostics'] },
] as const satisfies readonly { id: string; label: string; section: SettingsSectionId; signedOutOnly: boolean; keywords: readonly string[] }[];

/** At most this many `account.settingsWatch` calls wait at once; one more answers the oldest early. */
export const MAX_PENDING_SETTINGS_WATCHES = 4;

/**
 * The in-app confirmation's button takes no activation (click, Enter, Space) until it has been on
 * screen this long, counted again whenever the window regains focus or becomes visible: a click or key
 * meant for the Sign in button before it (or for another window) never confirms a sign-in.
 */
export const SETTINGS_CONFIRM_ARM_MS = 1_000;

/** A failed read of main's state (a watch, `telemetry.state`) is tried again after this, doubling up to `maxMs`. */
export const SETTINGS_RETRY = { initialMs: 1_000, maxMs: 30_000 } as const;

/** The retry delay after `failures` failures in a row (1, 2, … ): `initialMs`, doubling, capped at `maxMs`. */
export function settingsRetryDelay(failures: number): number {
  return Math.min(SETTINGS_RETRY.maxMs, SETTINGS_RETRY.initialMs * 2 ** Math.max(0, Math.min(failures - 1, 30)));
}

/** The plan's features in plain words (every `FEATURE_FLAGS` value; the server decides which plan has which). */
export const FEATURE_LABELS: Readonly<Record<FeatureFlag, string>> = Object.freeze({
  'ai-agent': 'AI agent',
  'search-console': 'Search Console performance data',
  sync: 'Sync between devices',
});

/** The account section's fixed words. */
export const ACCOUNT_SETTINGS_TEXT = {
  unconfigured: "Accounts aren't configured in this build",
  signedOut: 'Sign in to see your plan and use Pro features such as Search Console.',
  awaitingBrowser: 'Finish signing in in your browser.',
  fingerprintHint: 'Your browser should show the same code',
  confirmQuestion: (email: string) => `Sign in to frost as ${email}?`,
  confirmHint: 'Check that this code matches the one your browser showed. Sign in only if you started this.',
  /** The confirmation's button (never the words of the Sign in button it replaces). */
  confirmLabel: 'Confirm sign-in',
  /** Close or Esc while a confirmation waits cancels the sign-in (the close button says so). */
  closeCancels: 'Cancel sign-in and close',
  keychain: "This system has no keychain; you'll be signed out when frost quits",
} as const;

/**
 * What each span attribute a usage report may carry is, in plain words: every key of
 * `SPAN_ATTRIBUTE_ALLOWLIST` (`telemetry-privacy.spec.ts`), and only those (a key added or removed
 * there fails the type check here and the copy's test).
 */
export const SPAN_ATTRIBUTE_WORDS: Readonly<Record<SpanAttributeKey, string>> = Object.freeze({
  duration_ms: 'how long an operation took (such as starting up)',
  rule_count: 'how many SEO rules ran',
  outcome: 'whether it worked',
  panel: 'which SEO panel was used',
  platform: 'your operating system',
  'app.version': "frost's version",
  command: 'which command was run',
  cached: 'whether an answer came from a cache',
});

/**
 * What each scrub rule removes from an error report, in plain words: every `SCRUB_RULE_IDS` value
 * (`telemetry-privacy.spec.ts`). Rules that remove the same kind of thing share their words.
 */
export const SCRUB_RULE_WORDS: Readonly<Record<ScrubRuleId, string>> = Object.freeze({
  'auth-header': 'tokens and keys',
  'secret-assignment': 'tokens and keys',
  jwt: 'tokens and keys',
  url: 'URLs',
  email: 'email addresses',
  'home-path': 'file paths',
  'abs-path': 'file paths',
  host: 'host names',
  uuid: 'IDs',
  ipv4: 'IP addresses',
  ipv6: 'IP addresses',
  'query-string': 'URLs',
  'hex-token': 'tokens and keys',
  'base64-token': 'tokens and keys',
});

/** `items` as an English list ("a, b and c"), each once, in order. */
export function wordList(items: readonly string[]): string {
  const once = [...new Set(items)];
  return once.length <= 1 ? (once[0] ?? '') : `${once.slice(0, -1).join(', ')} and ${once.at(-1)}`;
}

/** The telemetry section's fixed words. */
export const TELEMETRY_SETTINGS_TEXT = {
  intro: 'Both are off until you turn them on. Turning one off stops sending at once and drops anything not yet sent.',
  notConfigured: 'This build has no endpoint for this, so nothing is sent',
  runOnly: 'Saved for this run only',
  loading: 'Loading…',
  failed: "frost couldn't read the telemetry settings. Trying again…",
  /** Like any request, a report reaches the server from this computer's network address. */
  ipAddress: 'The server that receives a report sees your IP address, as with any request.',
} as const;

/** The Search Console section's fixed words. */
export const GSC_SETTINGS_TEXT = {
  unconfigured: "Search Console isn't configured in this build",
  needsPro: 'Search Console is part of Pro. Sign in with a Pro account to connect it.',
  readOnly: "frost asks Google for read-only access: it can read your Search Console data, never change it.",
  connecting: 'Finish connecting in your browser.',
  connected: 'Connected',
  /** Shown only while a connection (or a connect) exists. */
  keychain: 'This system has no keychain; Search Console will be disconnected when frost quits',
} as const;
