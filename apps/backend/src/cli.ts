import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { DEFAULT_PLAN, PLAN_FEATURES, PLANS, type Plan } from '@app/specs/entitlements-snapshot.spec';
import { openDatabase, type Database } from './db/client';
import { migrate } from './db/migrate';
import { users } from './db/schema';
import { entitlementRow, generateEntitlementKey, PlanSchema, setPlan } from './entitlements';
import { EnvError, parseDatabaseEnv } from './env';

// The backend's admin CLI (spec `entitlements.feature.md`, Admin CLI):
//   pnpm --filter @app/backend admin <command>
// `runCli` is the whole CLI behind injected I/O, so tests drive it on an in-memory database. Run as a
// script it opens the database from `DATABASE_URL` / `PGLITE_DIR` only when a command needs one.

export const CLI_USAGE = `Usage: pnpm --filter @app/backend admin <command>

Commands:
  migrate                 Apply pending database migrations.
  keygen [kid]            Generate an entitlement signing key. Prints the server's private key and
                          the desktop's public JWKS to stdout (nothing is written to disk).
                          kid defaults to the key's RFC 7638 thumbprint.
  grant <email> <plan>    Set an account's plan (${PLANS.join(' | ')}).
  show <email>            Print an account's plan and features.
  help                    Print this help.

Database: DATABASE_URL (postgres://), else the PGlite directory PGLITE_DIR.
`;

/** Exit codes: done, a command that failed (unknown account …), a usage error. */
export const CLI_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export interface CliIo {
  /** The database, or how to open it (only commands that need one ask). */
  readonly db?: Database | (() => Promise<Database>) | undefined;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const featureList = (plan: Plan): string => (PLAN_FEATURES[plan].length === 0 ? '(none)' : PLAN_FEATURES[plan].join(', '));

async function findUser(db: Database, email: string): Promise<{ id: string; email: string } | undefined> {
  const rows = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return rows[0];
}

/** Runs one CLI command; answers its exit code. Never throws for a usage or lookup problem. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...args] = argv;
  const usage = (problem?: string): number => {
    io.err(`${problem ? `${problem}\n\n` : ''}${CLI_USAGE}`);
    return CLI_EXIT.usage;
  };
  const database = async (): Promise<Database> => {
    if (!io.db) throw new Error('no database configured');
    return typeof io.db === 'function' ? io.db() : io.db;
  };

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      io.out(CLI_USAGE);
      return CLI_EXIT.ok;

    case 'migrate': {
      if (args.length !== 0) return usage('migrate takes no arguments.');
      const applied = await migrate(await database());
      io.out(applied.length === 0 ? 'Database is up to date.\n' : `Applied ${applied.length} migration(s):\n${applied.map((id) => `  ${id}\n`).join('')}`);
      return CLI_EXIT.ok;
    }

    case 'keygen': {
      if (args.length > 1) return usage('keygen takes at most one argument (the kid).');
      let key;
      try {
        key = await generateEntitlementKey(args[0]);
      } catch {
        return usage('kid must be 1-64 letters, digits, ".", "_" or "-".');
      }
      // Single-quoted so a shell `.env` keeps the JSON's double quotes (base64url has no `'`).
      io.out(
        [
          `# frost entitlement signing key, generated ${new Date().toISOString()}.`,
          '',
          '# --- Server environment: SECRET --------------------------------------------------------',
          "# The backend's signing key. Keep it in the server's secret store or an untracked .env only:",
          '# never commit it, log it, or put it in a desktop build.',
          `ENTITLEMENT_KEY_ID=${key.kid}`,
          `ENTITLEMENT_SIGNING_KEY='${key.privateJwkJson}'`,
          '',
          '# --- Desktop build environment: public ----------------------------------------------------',
          '# The verification keys a desktop build trusts. During a rotation, list the old key here too',
          "# and in the server's ENTITLEMENT_PUBLIC_KEYS until every snapshot it signed has expired.",
          `FROST_PUBLIC_ENTITLEMENT_JWKS='${JSON.stringify(key.jwks)}'`,
          '',
        ].join('\n'),
      );
      return CLI_EXIT.ok;
    }

    case 'grant': {
      const [email, plan] = args;
      if (email === undefined || plan === undefined || args.length !== 2) return usage('grant needs an email and a plan.');
      const parsed = PlanSchema.safeParse(plan);
      if (!parsed.success) return usage(`Unknown plan. The plan must be one of: ${PLANS.join(', ')}.`);
      const db = await database();
      const user = await findUser(db, email);
      if (!user) {
        io.err(`No account with the email ${email.trim().toLowerCase()}.\n`);
        return CLI_EXIT.failed;
      }
      await setPlan(db, user.id, parsed.data);
      io.out(`${user.email}: plan ${parsed.data} (features: ${featureList(parsed.data)}). The next snapshot carries it.\n`);
      return CLI_EXIT.ok;
    }

    case 'show': {
      const [email] = args;
      if (email === undefined || args.length !== 1) return usage('show needs an email.');
      const db = await database();
      const user = await findUser(db, email);
      if (!user) {
        io.err(`No account with the email ${email.trim().toLowerCase()}.\n`);
        return CLI_EXIT.failed;
      }
      const row = await entitlementRow(db, user.id);
      const plan = row?.plan ?? DEFAULT_PLAN;
      io.out(
        [
          `email:    ${user.email}`,
          `user:     ${user.id}`,
          `plan:     ${plan}${row ? '' : ' (default; never granted)'}`,
          `features: ${featureList(plan)}`,
          `updated:  ${row ? row.updatedAt.toISOString() : '-'}`,
          '',
        ].join('\n'),
      );
      return CLI_EXIT.ok;
    }

    case undefined:
      return usage();
    default:
      return usage('Unknown command.');
  }
}

/** Is this module the process's entry script (`tsx src/cli.ts …`), not an import? */
function isEntryScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let handle: Awaited<ReturnType<typeof openDatabase>> | undefined;
  const open = async (): Promise<Database> => {
    let env;
    try {
      env = parseDatabaseEnv(process.env);
    } catch (error) {
      if (error instanceof EnvError) {
        console.error(error.message);
        process.exit(CLI_EXIT.usage);
      }
      throw error;
    }
    handle = await openDatabase(env);
    return handle.db;
  };
  let code: number;
  try {
    code = await runCli(process.argv.slice(2), { db: open, out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) });
  } catch (error) {
    // The name only: a driver error can carry connection details or query parameters.
    console.error(`admin: failed (${error instanceof Error ? error.name : 'unknown error'}${error instanceof Error && error.name === 'MigrationError' ? `: ${error.message}` : ''})`);
    code = CLI_EXIT.failed;
  } finally {
    await handle?.close();
  }
  process.exitCode = code;
}

if (isEntryScript()) await main();
