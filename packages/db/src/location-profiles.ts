import { asc, eq, sql } from 'drizzle-orm';
import { isLocationPort, isLocationProfileId, isLocationProxyScheme, LOCATION_LIMITS, normalizeLocationHost, normalizeLocationLabel, type LocationProxyScheme } from '@app/specs/location-profiles.spec';
import type { SessionDatabase } from './client';
import { locationProfiles } from './location-profiles-schema';

// Location profiles' rows (Phase 12 Task 10b; spec `specs/location-profiles.spec.ts`; acceptance
// `specs/location-profiles.feature.md`). Written at once; read back checked (a tampered row is
// skipped). At most `LOCATION_LIMITS.maxProfiles` rows: the insert itself refuses past it. Never
// synced, never cleared by Clear Browsing Data, and never holds a secret.

export interface StoredLocationProfile {
  readonly id: string;
  readonly label: string;
  readonly scheme: LocationProxyScheme;
  readonly host: string;
  readonly port: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A profile's values as written (`label`, `host` already normalised by the caller; checked again here). */
export interface LocationProfileValues {
  readonly label: string;
  readonly scheme: LocationProxyScheme;
  readonly host: string;
  readonly port: number;
}

export interface LocationProfilesRepository {
  /** Every valid profile, oldest first (at most `maxProfiles`). */
  list(): Promise<StoredLocationProfile[]>;
  get(id: string): Promise<StoredLocationProfile | null>;
  /** Inserts a new profile; `false` when invalid, the id exists, or `maxProfiles` are stored. */
  insert(id: string, values: LocationProfileValues, at: number): Promise<boolean>;
  /** Replaces a profile's values; `false` when invalid or no such profile. */
  update(id: string, values: LocationProfileValues, at: number): Promise<boolean>;
  /** Deletes a profile; whether one was there. */
  remove(id: string): Promise<boolean>;
}

function validValues(values: LocationProfileValues): boolean {
  return normalizeLocationLabel(values.label) === values.label && isLocationProxyScheme(values.scheme) && normalizeLocationHost(values.host) === values.host && isLocationPort(values.port);
}

function rowOf(row: typeof locationProfiles.$inferSelect): StoredLocationProfile | null {
  const values = { label: row.label, scheme: row.scheme as LocationProxyScheme, host: row.host, port: row.port };
  if (!isLocationProfileId(row.id) || !validValues(values) || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt)) return null;
  return { id: row.id, ...values, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export function createLocationProfilesRepository(db: SessionDatabase): LocationProfilesRepository {
  const get = async (id: string): Promise<StoredLocationProfile | null> => {
    if (!isLocationProfileId(id)) return null;
    const [row] = await db.select().from(locationProfiles).where(eq(locationProfiles.id, id)).limit(1);
    return row ? rowOf(row) : null;
  };
  return {
    async list() {
      const rows = await db.select().from(locationProfiles).orderBy(asc(locationProfiles.createdAt), asc(locationProfiles.id)).limit(LOCATION_LIMITS.maxProfiles);
      return rows.map(rowOf).filter((row): row is StoredLocationProfile => row !== null);
    },
    get,
    async insert(id, values, at) {
      if (!isLocationProfileId(id) || !validValues(values) || !Number.isSafeInteger(at)) return false;
      if ((await get(id)) !== null) return false;
      // The cap is checked inside the statement, so two inserts can never pass it together.
      await db.run(
        sql`INSERT OR IGNORE INTO location_profiles (id, label, scheme, host, port, created_at, updated_at) SELECT ${id}, ${values.label}, ${values.scheme}, ${values.host}, ${values.port}, ${at}, ${at} WHERE (SELECT count(*) FROM location_profiles) < ${LOCATION_LIMITS.maxProfiles}`,
      );
      return (await get(id)) !== null;
    },
    async update(id, values, at) {
      if (!isLocationProfileId(id) || !validValues(values) || !Number.isSafeInteger(at)) return false;
      if ((await get(id)) === null) return false;
      await db.update(locationProfiles).set({ ...values, updatedAt: at }).where(eq(locationProfiles.id, id));
      return true;
    },
    async remove(id) {
      if (!isLocationProfileId(id) || (await db.select({ id: locationProfiles.id }).from(locationProfiles).where(eq(locationProfiles.id, id)).limit(1)).length === 0) return false;
      await db.delete(locationProfiles).where(eq(locationProfiles.id, id));
      return true;
    },
  };
}
