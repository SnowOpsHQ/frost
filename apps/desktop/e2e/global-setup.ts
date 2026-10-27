import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR } from './harness';

/** A dev-server URL literal, as `electron-forge start` bakes `MAIN_WINDOW_VITE_DEV_SERVER_URL` into main. */
const DEV_SERVER_URL_LITERAL = /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/;

/**
 * The e2e suite drives `.vite/build` as left by the last build. `electron-forge start` overwrites it
 * with a dev bundle that loads the (by then stopped) Vite dev server instead of `app://`, so refuse
 * to run against a missing or dev bundle rather than fail obscurely.
 */
export default async function globalSetup(): Promise<void> {
  const mainBundle = path.join(APP_DIR, '.vite/build/main.cjs');
  const source = await readFile(mainBundle, 'utf8').catch(() => null);
  const hint = 'run `pnpm --filter @app/desktop build` (or `pnpm test:e2e`, which builds first)';
  if (source === null) throw new Error(`e2e: ${mainBundle} is missing; ${hint}.`);
  if (DEV_SERVER_URL_LITERAL.test(source)) {
    throw new Error(`e2e: ${mainBundle} is a dev build from \`electron-forge start\` (it loads the dev server, not app://); ${hint}.`);
  }
}
