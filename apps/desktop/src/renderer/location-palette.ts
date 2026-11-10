import { LOCATION_PALETTE, type LocationNewTabResult } from '@app/specs/location-profiles.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { LocationProfile } from '@app/specs/location-profiles.schema';
import type { PaletteAction, PaletteSource } from './palette/registry';

// "New tab in location…" in the command palette (Phase 12 Task 10b; acceptance
// `location-profiles.feature.md`): one action per profile main last listed, each asking main to open
// a tab on that profile's partition (main prepares the proxy first), and "Manage locations", which
// opens Settings › Locations. Registered from `settings-locations.tsx`; pure (main's list, read in the
// background, and the calls are injected) so it is unit tested.

export interface LocationPaletteApi {
  /** The profiles main last listed (`null`: not read yet, or the read failed). */
  profiles(): readonly Pick<LocationProfile, 'id' | 'label'>[] | null;
  /** Reads main's list again, in the background (throttled). */
  refresh(): void;
  newTab(profileId: string): Promise<LocationNewTabResult>;
  openSettings(): void;
}

const KEYWORDS = ['location', 'proxy', 'country', 'city', 'region', 'tab', 'serp', 'local'];

export function locationPaletteSources(api: LocationPaletteApi): PaletteSource[] {
  return [
    () => {
      api.refresh();
      const profiles = api.profiles() ?? [];
      return profiles.map(
        (profile): PaletteAction => ({
          id: `location.new-tab.${profile.id}`,
          label: LOCATION_PALETTE.label(profile.label),
          group: 'tabs',
          keywords: [...KEYWORDS, LOCATION_PALETTE.group],
          icon: 'tab-new',
          focus: 'handler',
          run: async () => {
            const result = await api.newTab(profile.id);
            return result === 'opened' ? null : 'The location tab could not be opened.';
          },
        }),
      );
    },
    {
      id: 'location.settings',
      label: LOCATION_PALETTE.manage,
      group: 'browser',
      keywords: ['settings', ...KEYWORDS],
      focus: 'handler',
      run: () => {
        api.openSettings();
      },
    },
  ];
}

/** The least time between two reads of main's list by the palette. */
export const LOCATIONS_REFRESH_MS = 5_000;

/** Main's profiles as last read through `read` (a failed read keeps none). */
export function createLocationsCache(read: () => Promise<readonly Pick<LocationProfile, 'id' | 'label'>[] | null>, now: () => number = Date.now) {
  let profiles: readonly Pick<LocationProfile, 'id' | 'label'>[] | null = null;
  let lastRead = Number.NEGATIVE_INFINITY;
  let reading = false;
  return {
    current: () => profiles,
    /** Forces the next `refresh` to read (after a change in Settings). */
    invalidate() {
      lastRead = Number.NEGATIVE_INFINITY;
    },
    refresh() {
      const at = now();
      if (reading || at - lastRead < LOCATIONS_REFRESH_MS) return;
      reading = true;
      lastRead = at;
      void Promise.resolve()
        .then(read)
        .then(
          (found) => {
            profiles = found;
          },
          () => {
            profiles = null;
          },
        )
        .finally(() => {
          reading = false;
        });
    },
  };
}
