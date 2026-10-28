/**
 * The Settings view (Phase 4 Task 9; acceptance `account-settings.feature.md`; review focus "Telemetry UI
 * matches behaviour"). Plain values with no Zod, so the chrome renderer can use them (its strict Trusted
 * Types CSP blocks Zod's eval probe). The Zod schemas of the `settingsView.*` procedure are in
 * `account-settings.schema.ts`; the account, telemetry and Search Console states the view shows are
 * main's (`account-state.schema.ts`, `telemetry-consent.schema.ts`, `gsc.spec.ts`).
 *
 * Clean-room: frost's own names and words.
 */
import type { FeatureFlag } from './entitlements-snapshot.spec';

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
 * open Settings in the focused app window (`settingsView.watch`'s counter goes up, the chrome is focused).
 */
export const SETTINGS_MENU = {
  id: 'settings',
  label: 'Settings…',
  accelerator: 'CmdOrCtrl+,',
} as const;

/** The palette's Settings actions (group `browser`): each opens the sheet on its section. */
export const SETTINGS_PALETTE_ACTIONS = [
  { id: 'settings.open', label: 'Settings', section: 'account', keywords: ['preferences', 'options', 'account', 'plan'] },
  { id: 'settings.sign-in', label: 'Sign in to frost', section: 'account', keywords: ['account', 'log in', 'login', 'sign out', 'plan', 'pro'] },
  { id: 'settings.search-console', label: 'Search Console settings', section: 'search-console', keywords: ['google', 'gsc', 'connect', 'disconnect'] },
  { id: 'settings.telemetry', label: 'Telemetry settings', section: 'telemetry', keywords: ['privacy', 'usage', 'crash', 'errors', 'reports', 'diagnostics'] },
] as const satisfies readonly { id: string; label: string; section: SettingsSectionId; keywords: readonly string[] }[];

/** At most this many `settingsView.watch` calls wait at once; one more answers the oldest early. */
export const MAX_PENDING_SETTINGS_WATCHES = 4;

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
  keychain: "This system has no keychain; you'll be signed out when frost quits",
} as const;

/** The telemetry section's fixed words. */
export const TELEMETRY_SETTINGS_TEXT = {
  intro: 'Both are off until you turn them on. Turning one off stops sending at once and drops anything not yet sent.',
  notConfigured: 'This build has no endpoint for this, so nothing is sent',
  runOnly: 'Saved for this run only',
} as const;

/** The Search Console section's fixed words. */
export const GSC_SETTINGS_TEXT = {
  unconfigured: "Search Console isn't configured in this build",
  needsPro: 'Search Console is part of Pro. Sign in with a Pro account to connect it.',
  readOnly: "frost asks Google for read-only access: it can read your Search Console data, never change it.",
  connecting: 'Finish connecting in your browser.',
  connected: 'Connected',
  keychain: 'This system has no keychain; Search Console will be disconnected when frost quits',
} as const;
