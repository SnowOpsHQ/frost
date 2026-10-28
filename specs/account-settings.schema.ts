/**
 * The `settingsView.*` procedure (Phase 4 Task 9; acceptance `account-settings.feature.md`, Main and
 * Router). Main-only (Zod): the chrome imports the plain values of `account-settings.spec.ts` and this
 * module's types only.
 *
 * The menu's "Settings…" is main's, so main tells the chrome to open the sheet with a counter the chrome
 * long-polls (`settingsView.watch`): each rise is one request. The counter is Settings' own, outside
 * `BrowserState`.
 */
import { z } from 'zod';

export * from './account-settings.spec';

/** `settingsView.watch`: the state once `seq` exceeds `sinceSeq` (`-1`: at once). Strict. */
export const SettingsViewWatchInputSchema = z.strictObject({ sinceSeq: z.int().min(-1).max(Number.MAX_SAFE_INTEGER) });
export type SettingsViewWatchInput = z.infer<typeof SettingsViewWatchInputSchema>;

/** `settingsView.watch`'s answer: the count of open requests so far. Strict: nothing else is forwarded. */
export const SettingsViewStateSchema = z.strictObject({ seq: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type SettingsViewState = z.infer<typeof SettingsViewStateSchema>;
