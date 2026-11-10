import type { Migration } from './migrations';

// Location profiles (Phase 12 Task 10b; spec `specs/location-profiles.spec.ts`,
// `LOCATION_PROFILE_TABLES`; acceptance `specs/location-profiles.feature.md`). Ids `0240`–`0249` are
// Phase 12's; this list is spread in `MIGRATIONS` in id order after the data usage counter's `0243`
// and before the SERP-API readings' `0245` (plan Global constraints). It creates exactly the table of
// `location-profiles-schema.ts`: a label, a proxy scheme, host and port per profile. **No secret
// column**: a proxy's username and password live only in main's key store
// (`location-credentials.json`). The `CHECK`s spell out `LOCATION_PROXY_SCHEMES` and
// `LOCATION_LIMITS` as they are at the time of writing (`location-profiles.test.ts` checks they accept
// exactly them): an applied migration never changes.

export const LOCATION_PROFILES_MIGRATIONS: readonly Migration[] = [
  {
    id: '0244_location_profiles',
    sql: `
      CREATE TABLE location_profiles (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
        label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
        scheme TEXT NOT NULL CHECK (scheme IN ('http', 'https', 'socks5')),
        host TEXT NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
        port INTEGER NOT NULL CHECK (typeof(port) = 'integer' AND port BETWEEN 1 AND 65535),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer'),
        updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer')
      );
    `,
  },
];
