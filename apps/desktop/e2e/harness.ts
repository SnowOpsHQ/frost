import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { HARDENED_WEB_PREFERENCES } from '@app/specs/window-hardening.spec';

/** apps/desktop: Electron loads `package.json#main` (`.vite/build/main.cjs`) from here. */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Launches the unpackaged built app (`pnpm --filter @app/desktop build` first). This bundle has no
 * dev-server URL, so it serves the renderer from `app://`. The packaged binary can't be driven:
 * its fuses disable the inspector arguments Playwright relies on.
 *
 * `ELECTRON_RUN_AS_NODE` is stripped from the child environment: when inherited (some shells and
 * agent harnesses export it) Electron would start as plain Node and never open a window.
 */
export async function launchApp(extraArgs: readonly string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  const app = await _electron.launch({ args: [APP_DIR, ...extraArgs], env, cwd: APP_DIR });
  const page = await app.firstWindow();
  return { app, page };
}

/** The built renderer's entry script, as `app://` serves it (`/assets/index-<hash>.js`). */
export async function appEntryScriptUrl(): Promise<string> {
  const assets = await readdir(path.join(APP_DIR, '.vite/renderer/main_window/assets'));
  const script = assets.find((name) => /^index-.*\.js$/.test(name));
  if (!script) throw new Error('e2e: no index-*.js in the built renderer');
  return `app://app/assets/${script}`;
}

/** A loopback HTTP server standing in for a foreign (non-app) page: `/` is a blank page, `/ok.js` a script. */
export async function startLoopbackServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/ok.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('/* ok */');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>loopback</title><p>loopback</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Creates, from the main process, a window the app never tracked: the same hardened webPreferences
 * and the app's own preload (so `window.frostIpc` exists), loading `url`. Resolves the window id and
 * the `loadURL` error message, if the load failed.
 */
export async function openUntrackedWindow(app: ElectronApplication, url: string): Promise<{ id: number; loadError: string | null }> {
  return app.evaluate(
    async ({ app: electronApp, BrowserWindow }, { url, prefs }) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { ...prefs, preload: `${electronApp.getAppPath()}/.vite/build/preload.cjs` },
      });
      try {
        await win.loadURL(url);
        return { id: win.id, loadError: null };
      } catch (error) {
        return { id: win.id, loadError: error instanceof Error ? error.message : String(error) };
      }
    },
    { url, prefs: { ...HARDENED_WEB_PREFERENCES } },
  );
}

/** Destroys the windows `openUntrackedWindow` created. */
export async function destroyWindows(app: ElectronApplication, ids: readonly number[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ids) => {
    for (const id of ids) BrowserWindow.fromId(id)?.destroy();
  }, [...ids]);
}

/** The Playwright page whose URL starts with `prefix`. */
export async function pageAt(app: ElectronApplication, prefix: string): Promise<Page> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const page = app.windows().find((p) => p.url().startsWith(prefix));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`e2e: no window at ${prefix}`);
}
