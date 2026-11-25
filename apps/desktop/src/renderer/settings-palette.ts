import type { AccountStatus } from '@app/specs/account-state.schema';
import { SETTINGS_PALETTE_ACTIONS, settingsSectionsShown, type SettingsOptionalSection, type SettingsSectionId } from '@app/specs/account-settings.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// The Settings view in the command palette (Phase 4 Task 9; acceptance `account-settings.feature.md`,
// Palette; `command-palette.spec.ts`, Registration API): "Settings", "Sign in to frost" (only while
// signed out), "Search Console settings" (only while its section is shown: not once main says Search
// Console is not configured) and "Telemetry settings", each opening the sheet on its section. The sheet moves focus itself (`focus: 'handler'`). Registered from `settings-view.tsx`;
// pure (the opener and the account's status are injected) so it is unit tested.

export interface SettingsPaletteApi {
  openSettings(section: SettingsSectionId): unknown;
  /** The account's status as main last answered (`null`: not yet). */
  accountStatus(): AccountStatus | null;
  /** Whether this build has a Search Console client, as main last answered (`null`: not yet). */
  gscConfigured(): boolean | null;
}

/** The sections main has said this build leaves out (`SETTINGS_OPTIONAL_SECTIONS`); none until it answered. */
export function leftOut(api: Pick<SettingsPaletteApi, 'accountStatus' | 'gscConfigured'>): Record<SettingsOptionalSection, boolean> {
  return { account: api.accountStatus() === 'unconfigured', 'search-console': api.gscConfigured() === false };
}

export function settingsPaletteSources(api: SettingsPaletteApi): PaletteSource[] {
  return SETTINGS_PALETTE_ACTIONS.map(
    (action): PaletteAction => ({
      id: action.id,
      label: action.label,
      group: 'browser',
      keywords: ['settings', ...action.keywords],
      focus: 'handler',
      ...(action.signedOutOnly ? { available: () => api.accountStatus() === 'signed-out' } : {}),
      ...(action.whileShown ? { available: () => settingsSectionsShown(leftOut(api)).includes(action.section) } : {}),
      run: () => {
        api.openSettings(action.section);
      },
    }),
  );
}

/**
 * The Settings actions read main's answers (`accountStatus`, `gscConfigured`) from outside the palette's
 * context: this starts watching `stores` (while the palette is open) and says when one changes, so an
 * open palette drops "Search Console settings" once main says there is none.
 */
export function watchSettingsAvailability(stores: readonly { subscribe(listener: () => void): () => void }[]): (invalidate: () => void) => () => void {
  return (invalidate) => {
    const stops = stores.map((store) => store.subscribe(invalidate));
    return () => stops.forEach((stop) => stop());
  };
}
