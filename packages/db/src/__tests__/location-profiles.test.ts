// Spec: specs/location-profiles.spec.ts (LOCATION_PROFILE_TABLES, LOCATION_PROFILE_MIGRATION_IDS, LOCATION_LIMITS,
// LOCATION_PROXY_SCHEMES); plan docs/plans/phase-12-big-bets.md Global constraints (0244 after 0243, before 0245), Task 10b
// Acceptance: specs/location-profiles.feature.md (Behaviour: a profile; location-credentials-never-leave-main: no secret column)
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, test } from 'vitest';
import { LOCATION_LIMITS, LOCATION_PROFILE_MIGRATION_IDS, LOCATION_PROFILE_TABLES, LOCATION_PROXY_SCHEMES } from '@app/specs/location-profiles.spec';
import { createDrizzle } from '../client';
import { LOCATION_PROFILES_MIGRATIONS } from '../location-profiles-migrations';
import { locationProfiles } from '../location-profiles-schema';
import { createLocationProfilesRepository, type LocationProfilesRepository } from '../location-profiles';
import { MIGRATIONS, runMigrations } from '../migrations';
import { uuidv7 } from '../change-intel/ids';

let raw: DatabaseSync;
let repo: LocationProfilesRepository;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  repo = createLocationProfilesRepository(createDrizzle(raw));
});

const NOW = Date.UTC(2026, 10, 10, 12);
const BERLIN = { label: 'Berlin', scheme: 'http', host: 'proxy.example.net', port: 3128 } as const;
const accepts = (row: Record<string, unknown>) => {
  const full = { id: uuidv7(NOW), label: 'X', scheme: 'http', host: 'h.example', port: 8080, created_at: NOW, updated_at: NOW, ...row };
  try {
    raw.prepare('INSERT INTO location_profiles (id, label, scheme, host, port, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(full.id, full.label, full.scheme, full.host, full.port, full.created_at, full.updated_at);
    return true;
  } catch {
    return false;
  }
};

describe('location profiles store', () => {
  test('location-profiles-migration-creates-table', () => {
    expect(LOCATION_PROFILES_MIGRATIONS.map((m) => m.id)).toEqual([...LOCATION_PROFILE_MIGRATION_IDS]);
    // Spread after 0243 (data usage) and before 0245 (SERP-API readings): ids stay in order.
    const ids = MIGRATIONS.map((m) => m.id);
    const at = ids.indexOf('0244_location_profiles');
    expect(at).toBeGreaterThan(ids.indexOf('0243_data_api_usage'));
    expect(at).toBeLessThan(ids.indexOf('0245_serp_api_readings'));
    expect([...ids].sort()).toEqual(ids.filter((id) => !id.startsWith('9')).sort().concat(ids.filter((id) => id.startsWith('9')).sort()));
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'location_%'").all().map((row) => row['name']);
    expect(tables).toEqual([...LOCATION_PROFILE_TABLES]);
    // Exactly the Drizzle table's columns, and none of them a secret.
    const columns = raw.prepare('PRAGMA table_info(location_profiles)').all().map((row) => String(row['name']));
    expect(columns).toEqual(getTableConfig(locationProfiles).columns.map((column) => column.name));
    expect(columns.some((name) => /user|pass|secret|cred|token|auth/i.test(name))).toBe(false);
  });

  test('location-profiles-checks-accept-exactly-the-spec', () => {
    for (const scheme of LOCATION_PROXY_SCHEMES) expect(accepts({ scheme }), scheme).toBe(true);
    expect(accepts({ scheme: 'socks4' })).toBe(false);
    expect(accepts({ port: 0 })).toBe(false);
    expect(accepts({ port: LOCATION_LIMITS.maxPort + 1 })).toBe(false);
    expect(accepts({ port: '80x' })).toBe(false);
    expect(accepts({ port: 80.5 })).toBe(false);
    expect(accepts({ label: '' })).toBe(false);
    expect(accepts({ label: 'x'.repeat(LOCATION_LIMITS.maxLabelChars + 1) })).toBe(false);
    expect(accepts({ host: 'h'.repeat(LOCATION_LIMITS.maxHostChars + 1) })).toBe(false);
  });

  test('location-profiles-crud', async () => {
    const id = uuidv7(NOW);
    expect(await repo.insert(id, BERLIN, NOW)).toBe(true);
    expect(await repo.insert(id, BERLIN, NOW)).toBe(false);
    expect(await repo.get(id)).toEqual({ id, ...BERLIN, createdAt: NOW, updatedAt: NOW });
    expect(await repo.update(id, { ...BERLIN, label: 'Berlin 2', port: 8080 }, NOW + 1)).toBe(true);
    expect(await repo.list()).toEqual([{ id, ...BERLIN, label: 'Berlin 2', port: 8080, createdAt: NOW, updatedAt: NOW + 1 }]);
    // Invalid values are never written.
    expect(await repo.update(id, { ...BERLIN, host: 'http://x' }, NOW + 2)).toBe(false);
    expect(await repo.insert(uuidv7(NOW), { ...BERLIN, label: ' padded ' }, NOW)).toBe(false);
    expect(await repo.update(uuidv7(NOW), BERLIN, NOW)).toBe(false);
    expect(await repo.remove(id)).toBe(true);
    expect(await repo.remove(id)).toBe(false);
    expect(await repo.list()).toEqual([]);
  });

  test('location-profiles-capped', async () => {
    for (let i = 0; i < LOCATION_LIMITS.maxProfiles; i++) expect(await repo.insert(uuidv7(NOW + i), { ...BERLIN, label: `L${i}` }, NOW + i)).toBe(true);
    expect(await repo.insert(uuidv7(NOW + 100), BERLIN, NOW + 100)).toBe(false);
    expect(await repo.list()).toHaveLength(LOCATION_LIMITS.maxProfiles);
  });

  test('location-profiles-tampered-row-skipped', async () => {
    const id = uuidv7(NOW);
    expect(await repo.insert(id, BERLIN, NOW)).toBe(true);
    raw.prepare("UPDATE location_profiles SET host = 'not a host!' WHERE id = ?").run(id);
    expect(await repo.list()).toEqual([]);
    expect(await repo.get(id)).toBeNull();
  });
});
