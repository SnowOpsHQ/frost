import type { LocationNewTabResult, LocationWriteResult } from '@app/specs/location-profiles.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { LocationProfileInput, LocationProfilesView } from '@app/specs/location-profiles.schema';
import { ipc } from './ipc';

// Settings › Locations' and the palette's calls to main (Phase 12 Task 10b; `location-router.ts`,
// every one behind `enforceSender`). The read answers `null` on an IPC failure; writes answer
// `failed`. `create` / `update` are the only place a proxy sign-in crosses IPC (renderer → main); no
// answer carries one.

export const locationActions = {
  list: (): Promise<LocationProfilesView | null> => ipc.locations.list.query().catch(() => null),
  create: (input: LocationProfileInput): Promise<LocationWriteResult> => ipc.locations.create.mutate(input).catch(() => 'failed' as const),
  update: (id: string, profile: LocationProfileInput): Promise<LocationWriteResult> => ipc.locations.update.mutate({ id, profile }).catch(() => 'failed' as const),
  remove: (id: string): Promise<LocationWriteResult> => ipc.locations.remove.mutate({ id }).catch(() => 'failed' as const),
  newTab: (profileId: string): Promise<LocationNewTabResult> => ipc.locations.newTab.mutate({ profileId }).catch(() => 'failed' as const),
};
