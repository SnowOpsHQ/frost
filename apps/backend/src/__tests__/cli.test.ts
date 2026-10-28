import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { compactVerify, createLocalJWKSet, decodeProtectedHeader } from 'jose';
import {
  ENTITLEMENT_JWS_TYPE,
  EntitlementClaimsSchema,
  EntitlementJwksSchema,
  PLAN_FEATURES,
  PLANS,
} from '@app/specs/entitlements-snapshot.spec';
import { CLI_EXIT, describeDatabaseTarget, runCli } from '../cli';
import { openMemoryDatabase, queryRows, type Database, type DatabaseHandle } from '../db/client';
import { loadMigrations, migrate } from '../db/migrate';
import { issueSnapshot, loadEntitlementSigner } from '../entitlements';
import { EnvError, parseDatabaseEnv, parseEnv } from '../env';
import { createTestBackend, signedInWithPassword, type TestBackend } from './helpers';

// Acceptance: specs/entitlements.feature.md (Admin CLI).

let backend: TestBackend | undefined;
let handle: DatabaseHandle | undefined;
afterEach(async () => {
  vi.doUnmock('../entitlements');
  vi.resetModules();
  await backend?.close();
  await handle?.close();
  backend = undefined;
  handle = undefined;
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(argv: readonly string[], db?: Database): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { ...(db ? { db } : {}), out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join(''), err: err.join('') };
}

/** `NAME='value'` from keygen's output. */
function assignment(text: string, name: string): string {
  const match = new RegExp(`^${name}='([^'\\n]*)'$`, 'm').exec(text) ?? new RegExp(`^${name}=([^\\s']+)$`, 'm').exec(text);
  if (!match?.[1]) throw new Error(`no ${name} in output`);
  return match[1];
}

async function withUser(): Promise<TestBackend> {
  backend = await createTestBackend();
  await signedInWithPassword(backend);
  return backend;
}

async function planRows(db: Database): Promise<number> {
  return (await queryRows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM entitlements`))[0]?.n ?? -1;
}

describe('admin CLI', () => {
  it('cli-keygen-round-trips', async () => {
    const run = await cli(['keygen']);
    expect(run.code).toBe(CLI_EXIT.ok);
    expect(run.err).toBe('');
    // Clearly labelled: which part is the server's secret and which the desktop's public set.
    expect(run.out).toMatch(/secret/i);
    expect(run.out).toMatch(/public/i);
    const signingKey = assignment(run.out, 'ENTITLEMENT_SIGNING_KEY');
    const keyId = assignment(run.out, 'ENTITLEMENT_KEY_ID');
    const jwksText = assignment(run.out, 'FROST_PUBLIC_ENTITLEMENT_JWKS');
    const jwks = EntitlementJwksSchema.parse(JSON.parse(jwksText));
    expect(jwksText).not.toContain('"d"');
    expect(jwks.keys.map((k) => k.kid)).toEqual([keyId]);

    // The printed key is a valid server environment …
    const env = parseEnv({ BETTER_AUTH_SECRET: 's'.repeat(32), ENTITLEMENT_SIGNING_KEY: signingKey, ENTITLEMENT_KEY_ID: keyId });
    const signer = await loadEntitlementSigner({ signingKey: env.ENTITLEMENT_SIGNING_KEY, keyId: env.ENTITLEMENT_KEY_ID });
    // … whose snapshot verifies with the printed JWKS.
    const snapshot = await issueSnapshot(signer, { id: 'u1', email: 'erin@example.com' }, 'pro');
    expect(decodeProtectedHeader(snapshot)).toEqual({ alg: 'EdDSA', kid: keyId, typ: ENTITLEMENT_JWS_TYPE });
    const { payload } = await compactVerify(snapshot, createLocalJWKSet(jwks));
    const claims = EntitlementClaimsSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
    expect(claims.features).toEqual([...PLAN_FEATURES.pro]);

    // Every run is a new key.
    const again = await cli(['keygen']);
    expect(assignment(again.out, 'ENTITLEMENT_SIGNING_KEY')).not.toBe(signingKey);
  });

  it('cli-grant-and-show', async () => {
    const b = await withUser();
    const db = b.database.db;
    const before = await cli(['show', 'alice@example.com'], db);
    expect(before.code).toBe(CLI_EXIT.ok);
    expect(before.out).toMatch(/plan:\s+free/);
    expect(before.out).toMatch(/features:\s+\(none\)/);

    const granted = await cli(['grant', 'Alice@Example.com', 'pro'], db);
    expect(granted.code).toBe(CLI_EXIT.ok);
    expect(granted.out).toContain('alice@example.com');
    expect(granted.out).toContain('pro');

    const after = await cli(['show', 'alice@example.com'], db);
    expect(after.code).toBe(CLI_EXIT.ok);
    expect(after.out).toMatch(/plan:\s+pro/);
    expect(after.out).toContain(PLAN_FEATURES.pro.join(', '));

    expect((await cli(['grant', 'alice@example.com', 'free'], db)).code).toBe(CLI_EXIT.ok);
    expect((await cli(['show', 'alice@example.com'], db)).out).toMatch(/plan:\s+free/);
    for (const plan of PLANS) expect((await cli(['grant', 'alice@example.com', plan], db)).code).toBe(CLI_EXIT.ok);
  });

  it('cli-unknown-user', async () => {
    const b = await withUser();
    const db = b.database.db;
    for (const argv of [
      ['grant', 'nobody@example.com', 'pro'],
      ['show', 'nobody@example.com'],
    ]) {
      const run = await cli(argv, db);
      expect(run.code).toBe(CLI_EXIT.failed);
      expect(run.err).toMatch(/no account/i);
      expect(run.err).toContain('nobody@example.com');
    }
    expect(await planRows(db)).toBe(0);
  });

  it('cli-unknown-plan', async () => {
    const b = await withUser();
    const run = await cli(['grant', 'alice@example.com', 'gold'], b.database.db);
    expect(run.code).toBe(CLI_EXIT.usage);
    expect(run.err).toMatch(/plan/i);
    for (const plan of PLANS) expect(run.err).toContain(plan);
    expect(await planRows(b.database.db)).toBe(0);
  });

  it('cli-usage', async () => {
    // The documented exit codes (README, Admin CLI) are these numbers.
    expect(CLI_EXIT).toEqual({ ok: 0, failed: 1, usage: 2 });
    for (const argv of [[], ['frobnicate'], ['grant'], ['grant', 'alice@example.com'], ['show'], ['grant', 'a@example.com', 'pro', 'extra']]) {
      const run = await cli(argv);
      expect(run.code, argv.join(' ')).toBe(CLI_EXIT.usage);
      expect(run.err).toMatch(/usage/i);
    }
    const help = await cli(['help']);
    expect(help.code).toBe(CLI_EXIT.ok);
    for (const command of ['migrate', 'keygen', 'grant', 'show']) expect(help.out).toContain(command);
  });

  it('cli-migrate', async () => {
    handle = await openMemoryDatabase();
    const ids = (await loadMigrations()).map((m) => m.id);
    const first = await cli(['migrate'], handle.db);
    expect(first.code).toBe(CLI_EXIT.ok);
    for (const id of ids) expect(first.out).toContain(id);
    const second = await cli(['migrate'], handle.db);
    expect(second.code).toBe(CLI_EXIT.ok);
    expect(second.out).toMatch(/up to date/i);
    // Already applied: nothing pending.
    expect(await migrate(handle.db)).toEqual([]);
  });

  it('cli-keygen-exit-codes', async () => {
    const badKid = await cli(['keygen', 'not a valid kid!']);
    expect(badKid.code).toBe(CLI_EXIT.usage);
    expect(badKid.err).toMatch(/kid/);
    expect(badKid.out).toBe('');

    // Anything else that fails while generating is a failure, not a usage error.
    vi.resetModules();
    vi.doMock('../entitlements', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../entitlements')>()),
      generateEntitlementKey: () => Promise.reject(new Error('no entropy')),
    }));
    const { runCli: mockedCli } = await import('../cli');
    const err: string[] = [];
    const code = await mockedCli(['keygen'], { out: () => undefined, err: (t) => err.push(t) });
    expect(code).toBe(CLI_EXIT.failed);
    expect(err.join('')).not.toMatch(/usage/i);
  });

  it('cli-database-env-production', () => {
    let error: unknown;
    try {
      parseDatabaseEnv({ NODE_ENV: 'production' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    expect((error as Error).message).toMatch(/DATABASE_URL/);
    const url = 'postgres://admin:hunter2-secret@db.internal.example:5432/frost';
    expect(parseDatabaseEnv({ NODE_ENV: 'production', DATABASE_URL: url }).DATABASE_URL).toBe(url);
    expect(parseDatabaseEnv({}).DATABASE_URL).toBeUndefined();
    expect(() => parseDatabaseEnv({ NODE_ENV: 'staging' })).toThrow(EnvError);
  });

  it('cli-database-target', () => {
    const url = 'postgres://admin:hunter2-secret@db.internal.example:5432/frost?sslmode=require';
    const postgres = describeDatabaseTarget(parseDatabaseEnv({ DATABASE_URL: url }));
    expect(postgres).toBe('Postgres db.internal.example:5432');
    for (const secret of ['admin', 'hunter2', 'sslmode', url]) expect(postgres).not.toContain(secret);
    const pglite = describeDatabaseTarget(parseDatabaseEnv({ PGLITE_DIR: '/tmp/frost-test-pglite' }));
    expect(pglite).toBe('PGlite /tmp/frost-test-pglite');
  });
});
