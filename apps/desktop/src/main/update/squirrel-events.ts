import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  WIN_SQUIRREL_EVENTS,
  WIN_SQUIRREL_HOOK_WAIT_MS,
  WIN_SQUIRREL_UPDATE_EXE,
  winSquirrelShortcutArgs,
} from '@app/specs/windows-package.spec';

/**
 * Squirrel's install events on Windows (specs/windows-package.spec.ts `WIN_SQUIRREL_EVENTS`;
 * acceptance: specs/windows-package.feature.md, Squirrel events). Checked in main before anything
 * else starts: an event run creates or removes the shortcuts through Squirrel's `Update.exe` and
 * exits, and never takes the single-instance lock, opens a database or shows a window.
 */

/** What to do for one launch: start normally, exit at once, or run `Update.exe` and then exit. */
export type SquirrelAction =
  | { kind: 'none' }
  | { kind: 'exit' }
  | { kind: 'shortcut'; args: readonly ['--createShortcut' | '--removeShortcut', string] };

/**
 * The action for a launch. Only a packaged build on Windows reacts, and only to an `argv[1]` that is
 * exactly one of the events; later arguments (Squirrel passes the version) are not looked at.
 */
export function squirrelEventAction(input: { platform: NodeJS.Platform; isPackaged: boolean; argv: readonly string[] }): SquirrelAction {
  const first = input.argv[1];
  if (input.platform !== 'win32' || !input.isPackaged || first === undefined || !Object.hasOwn(WIN_SQUIRREL_EVENTS, first)) {
    return { kind: 'none' };
  }
  const action = WIN_SQUIRREL_EVENTS[first as keyof typeof WIN_SQUIRREL_EVENTS];
  return action === 'exit' ? { kind: 'exit' } : { kind: 'shortcut', args: winSquirrelShortcutArgs(action) };
}

/** The part of a spawned process the handler uses. */
export interface SquirrelChild {
  once(event: 'exit' | 'error', listener: () => void): unknown;
  unref(): void;
}

export interface SquirrelDeps {
  platform: NodeJS.Platform;
  argv: readonly string[];
  execPath: string;
  exists: (file: string) => boolean;
  spawn: (command: string, args: readonly string[]) => SquirrelChild;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

const defaultDeps = (): SquirrelDeps => ({
  platform: process.platform,
  argv: process.argv,
  execPath: process.execPath,
  exists: existsSync,
  // No shell; detached with no stdio, so nothing ties Update.exe to this process's console.
  spawn: (command, args) => spawn(command, [...args], { shell: false, detached: true, stdio: 'ignore', windowsHide: true }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
});

/**
 * Acts on a Squirrel event, if this launch is one: returns `true` when it handled the launch (the
 * app then exits with code 0, after `Update.exe` has finished or `WIN_SQUIRREL_HOOK_WAIT_MS` has
 * passed), `false` when the app should start normally. A missing `Update.exe` or a spawn error
 * exits 0 quietly: there is nothing else to do, and Squirrel only waits for the exit.
 */
export function handleSquirrelEvent(app: { isPackaged: boolean; exit(code?: number): void }, deps: SquirrelDeps = defaultDeps()): boolean {
  const action = squirrelEventAction({ platform: deps.platform, isPackaged: app.isPackaged, argv: deps.argv });
  if (action.kind === 'none') return false;

  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    app.exit(0);
  };
  if (action.kind === 'exit') {
    exit();
    return true;
  }

  const updateExe = path.resolve(path.dirname(deps.execPath), ...WIN_SQUIRREL_UPDATE_EXE);
  if (!deps.exists(updateExe)) {
    exit();
    return true;
  }
  try {
    const child = deps.spawn(updateExe, action.args);
    child.once('exit', exit);
    child.once('error', exit);
    child.unref();
  } catch {
    exit();
    return true;
  }
  deps.setTimeout(exit, WIN_SQUIRREL_HOOK_WAIT_MS);
  return true;
}
