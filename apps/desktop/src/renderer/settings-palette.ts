import { SETTINGS_PALETTE_ACTIONS, type SettingsSectionId } from '@app/specs/account-settings.spec';
import type { PaletteAction, PaletteSource } from './palette/registry';

// The Settings view in the command palette (Phase 4 Task 9; acceptance `account-settings.feature.md`,
// Palette; `command-palette.spec.ts`, Registration API): "Settings", "Sign in to frost", "Search
// Console settings" and "Telemetry settings", each opening the sheet on its section. The sheet moves
// focus itself (`focus: 'handler'`). Registered from `settings-view.tsx`; pure (the opener is
// injected) so it is unit tested.

export interface SettingsPaletteApi {
  openSettings(section: SettingsSectionId): unknown;
}

export function settingsPaletteSources(api: SettingsPaletteApi): PaletteSource[] {
  return SETTINGS_PALETTE_ACTIONS.map(
    (action): PaletteAction => ({
      id: action.id,
      label: action.label,
      group: 'browser',
      keywords: ['settings', ...action.keywords],
      focus: 'handler',
      run: () => {
        api.openSettings(action.section);
      },
    }),
  );
}
