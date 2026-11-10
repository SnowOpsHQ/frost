import type { LocationNewTabResult, LocationWriteResult } from '@app/specs/location-profiles.spec';
import type { LocationProfileInput, LocationProfilesView } from '@app/specs/location-profiles.schema';

// Location profiles as the `locations.*` procedures see them (Phase 12 Task 10b; spec
// `location-profiles.schema.ts`; acceptance `location-profiles.feature.md`). Main implements it
// (`apps/desktop/src/main/location/profiles.ts`); this package only knows the interface. No member
// answers a proxy username or password: the renderer sends them (write-only) and learns
// `hasCredentials` only.

export interface LocationService {
  /** Every profile (no secret) and how well a sign-in would be protected here. */
  list(): Promise<LocationProfilesView>;
  /** Stores a new profile (and its sign-in, if given). */
  create(input: LocationProfileInput): Promise<LocationWriteResult>;
  /** Replaces a profile's values; its open tabs close. */
  update(id: string, input: LocationProfileInput): Promise<LocationWriteResult>;
  /** Removes a profile, its sign-in and its tabs. */
  remove(id: string): Promise<LocationWriteResult>;
  /** Opens a new tab in the profile's location (its proxy, its in-memory partition). */
  newTab(profileId: string): Promise<LocationNewTabResult>;
}
