import { TRPCError } from '@trpc/server';
import { IPC_INTERNAL_ERROR_CODE } from '@app/specs/ipc-transport.spec';
import { LOCATION_NEW_TAB_RESULTS, LOCATION_WRITE_RESULTS, type LocationNewTabResult, type LocationWriteResult } from '@app/specs/location-profiles.spec';
import { LocationIdInputSchema, LocationNewTabInputSchema, LocationProfileInputSchema, LocationProfilesViewSchema, LocationUpdateInputSchema } from '@app/specs/location-profiles.schema';
import type { LocationService } from './location-service';
import { enforceSender, middleware, publicProcedure, router } from './trpc';

// Settings › Locations and "New tab in location…" ↔ main (Phase 12 Task 10b; spec
// `location-profiles.schema.ts`; acceptance `location-profiles.feature.md`). Every procedure starts
// `publicProcedure.use(enforceSender)`. `create` / `update` inputs are the only place a proxy
// username or password crosses IPC (renderer → main); no answer carries one: `list` is checked
// against a strict schema (`hasCredentials` only) and each result against its fixed set.

const requireLocations = middleware(({ ctx, next }) => {
  const locations = ctx.services?.locations;
  if (!locations) throw new TRPCError({ code: IPC_INTERNAL_ERROR_CODE, message: 'locations service unavailable' });
  return next({ ctx: { ...ctx, locations } });
});

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T => ((values as readonly unknown[]).includes(value) ? (value as T) : fallback);

/**
 * - `list`: `LocationProfilesView` (protection; per profile its label, scheme, host, port and `hasCredentials`).
 * - `create` (`LocationProfileInput`): `LOCATION_WRITE_RESULTS`.
 * - `update` (`{ id, profile }`): `LOCATION_WRITE_RESULTS` (the profile's tabs close).
 * - `remove` (`{ id }`): `LOCATION_WRITE_RESULTS`.
 * - `newTab` (`{ profileId }`): `LOCATION_NEW_TAB_RESULTS`.
 */
export const locationRouter = router({
  list: publicProcedure
    .use(enforceSender)
    .use(requireLocations)
    .output(LocationProfilesViewSchema)
    .query(({ ctx }) => ctx.locations.list()),
  create: publicProcedure
    .use(enforceSender)
    .use(requireLocations)
    .input(LocationProfileInputSchema)
    .mutation(async ({ ctx, input }): Promise<LocationWriteResult> => oneOf(LOCATION_WRITE_RESULTS, await ctx.locations.create(input), 'failed')),
  update: publicProcedure
    .use(enforceSender)
    .use(requireLocations)
    .input(LocationUpdateInputSchema)
    .mutation(async ({ ctx, input }): Promise<LocationWriteResult> => oneOf(LOCATION_WRITE_RESULTS, await ctx.locations.update(input.id, input.profile), 'failed')),
  remove: publicProcedure
    .use(enforceSender)
    .use(requireLocations)
    .input(LocationIdInputSchema)
    .mutation(async ({ ctx, input }): Promise<LocationWriteResult> => oneOf(LOCATION_WRITE_RESULTS, await ctx.locations.remove(input.id), 'failed')),
  newTab: publicProcedure
    .use(enforceSender)
    .use(requireLocations)
    .input(LocationNewTabInputSchema)
    .mutation(async ({ ctx, input }): Promise<LocationNewTabResult> => oneOf(LOCATION_NEW_TAB_RESULTS, await ctx.locations.newTab(input.profileId), 'failed')),
});
