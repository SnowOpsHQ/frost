import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
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
 *
 * Every launch gets its own profile (Chromium's `--user-data-dir`, which `app.getPath('userData')`
 * follows): the browser-session database, the browse partition and the rest never touch the real
 * frost profile, and no launch sees another's tabs or permission decisions. Pass `userDataDir` to
 * relaunch on the same profile (the caller then owns that directory); otherwise a temporary one is
 * created and removed when the app closes.
 */
export async function launchApp(
  extraArgs: readonly string[] = [],
  options: { userDataDir?: string } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  const ownProfile = options.userDataDir === undefined ? await mkdtemp(path.join(tmpdir(), 'frost-e2e-profile-')) : null;
  const userDataDir = options.userDataDir ?? ownProfile!;
  let app: ElectronApplication;
  try {
    app = await _electron.launch({ args: [APP_DIR, `--user-data-dir=${userDataDir}`, ...extraArgs], env, cwd: APP_DIR });
  } catch (error) {
    if (ownProfile !== null) await rm(ownProfile, { recursive: true, force: true });
    throw error;
  }
  // Synchronous: the worker may exit right after the app closes, before an async removal ran.
  if (ownProfile !== null) app.once('close', () => rmSync(ownProfile, { recursive: true, force: true }));
  // The chrome (`app://app`), not a tab: a restored tab's page can be the first page Playwright sees.
  await app.firstWindow();
  const page = await pageAt(app, 'app://app/');
  return { app, page };
}

/**
 * Starts the built app on `userDataDir` **without** Playwright: no inspector and no DevTools
 * attached to any page, so nothing answers a page's JavaScript dialogs for it (Playwright does,
 * over DevTools, for every page it drives). `stop()` kills its process tree.
 */
export function launchUndrivenApp(userDataDir: string): { stop(): void } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  // Its own process group (like Playwright's launches), so `killProcessTree` takes all of it.
  const child = spawn(electron, [APP_DIR, `--user-data-dir=${userDataDir}`], { env, cwd: APP_DIR, detached: true, stdio: 'ignore' });
  return {
    stop: () => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
    },
  };
}

/** How long `closeApp` waits for the app to quit before it kills the app's process tree. */
export const APP_CLOSE_TIMEOUT_MS = 10_000;

/**
 * Closes `app` (spec `ipc-e2e.feature.md`, Harness): Playwright's `close()` (the app quits, so
 * pending writes are flushed); if that has not finished within `timeoutMs`, the app's whole
 * process tree is killed, so a wedged app fails only its own test and never hangs the worker's
 * teardown. A no-op for `undefined`.
 */
export async function closeApp(app: ElectronApplication | undefined, options: { timeoutMs?: number } = {}): Promise<void> {
  if (!app) return;
  const pid = app.process().pid;
  const exited = new Promise<void>((resolve) => {
    if (app.process().exitCode !== null || app.process().signalCode !== null) resolve();
    else app.process().once('exit', () => resolve());
  });
  const closed = app.close().catch(() => undefined);
  const timeout = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(resolve, ms, 'timeout').unref());
  if ((await Promise.race([closed, timeout(options.timeoutMs ?? APP_CLOSE_TIMEOUT_MS)])) !== 'timeout') return;
  if (pid !== undefined) killProcessTree(pid);
  // Playwright's close() settles once the process is gone; neither waits forever.
  await Promise.race([Promise.all([closed, exited]), timeout(5_000)]);
}

/**
 * SIGKILLs `pid`, its process group (Playwright starts Electron as a group leader) and every
 * descendant `ps` lists (renderers, GPU and zygote processes). POSIX only, like the suite.
 */
function killProcessTree(pid: number): void {
  const children = new Map<number, number[]>();
  try {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child === undefined || parent === undefined || !Number.isInteger(child) || !Number.isInteger(parent)) continue;
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
  } catch {
    // No `ps`: the group kill below still takes most of the tree.
  }
  const tree: number[] = [];
  for (const queue = [pid]; queue.length > 0; ) {
    const next = queue.shift()!;
    tree.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  const kill = (target: number): void => {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  kill(-pid);
  for (const target of tree) kill(target);
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
 * and, unless `preload: false`, the app's own preload (so `window.frostIpc` exists), loading `url`.
 * Resolves the window id and the `loadURL` error message, if the load failed.
 */
export async function openUntrackedWindow(
  app: ElectronApplication,
  url: string,
  options: { preload?: boolean } = {},
): Promise<{ id: number; loadError: string | null }> {
  return app.evaluate(
    async ({ app: electronApp, BrowserWindow }, { url, prefs, preload }) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: preload ? { ...prefs, preload: `${electronApp.getAppPath()}/.vite/build/preload.cjs` } : prefs,
      });
      try {
        await win.loadURL(url);
        return { id: win.id, loadError: null };
      } catch (error) {
        return { id: win.id, loadError: error instanceof Error ? error.message : String(error) };
      }
    },
    { url, prefs: { ...HARDENED_WEB_PREFERENCES }, preload: options.preload ?? true },
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
