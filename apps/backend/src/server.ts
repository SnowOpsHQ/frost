import { serve } from '@hono/node-server';
import { createApp } from './app';
import { openDatabase } from './db/client';
import { migrate } from './db/migrate';
import { createEmailTransport } from './email';
import { EnvError, parseEnv } from './env';

// Local runner: `pnpm --filter @app/backend dev`. Binds 127.0.0.1 unless HOST says otherwise.
// Nothing in this repo deploys it.

async function main(): Promise<void> {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const database = await openDatabase(env);
  const applied = await migrate(database.db);
  console.log(`[backend] database: ${database.kind === 'pglite' ? `PGlite at ${env.PGLITE_DIR}` : 'Postgres (DATABASE_URL)'}; migrations applied: ${applied.length}`);

  const app = createApp({
    db: database.db,
    auth: { secret: env.BETTER_AUTH_SECRET, baseURL: env.BETTER_AUTH_URL },
    email: createEmailTransport(env.EMAIL_TRANSPORT),
  });
  const server = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, (info) => {
    console.log(`[backend] listening on http://${info.address}:${info.port} (public URL ${env.BETTER_AUTH_URL})`);
  });

  const stop = (): void => {
    server.close(() => {
      void database.close().then(() => process.exit(0));
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

await main();
