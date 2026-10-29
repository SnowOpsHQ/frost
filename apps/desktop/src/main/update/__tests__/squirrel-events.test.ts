// Spec: specs/windows-package.spec.ts · Acceptance: specs/windows-package.feature.md (Squirrel events)
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  WIN_EXECUTABLE,
  WIN_SQUIRREL_EVENTS,
  WIN_SQUIRREL_FIRSTRUN,
  WIN_SQUIRREL_HOOK_LIMIT_MS,
  WIN_SQUIRREL_HOOK_WAIT_MS,
} from '@app/specs/windows-package.spec';
import { handleSquirrelEvent, squirrelEventAction, type SquirrelChild, type SquirrelDeps } from '../squirrel-events';

const EXEC_PATH = path.resolve('/LocalAppData/frost/app-1.2.3', WIN_EXECUTABLE);
const UPDATE_EXE = path.resolve('/LocalAppData/frost/Update.exe');

/** A fake child process whose `exit` / `error` the test fires. */
function fakeChild() {
  const listeners = new Map<string, () => void>();
  const child: SquirrelChild & { fire(event: 'exit' | 'error'): void; unrefed: boolean } = {
    unrefed: false,
    once(event, listener) {
      listeners.set(event, listener);
      return child;
    },
    unref() {
      child.unrefed = true;
    },
    fire(event) {
      listeners.get(event)?.();
    },
  };
  return child;
}

/** A run of `handleSquirrelEvent` with every effect recorded. */
function harness(argv: string[], options: { platform?: NodeJS.Platform; isPackaged?: boolean; updateExe?: boolean; spawnThrows?: boolean } = {}) {
  const exits: number[] = [];
  const spawned: { command: string; args: readonly string[] }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const child = fakeChild();
  const deps: SquirrelDeps = {
    platform: options.platform ?? 'win32',
    argv: [EXEC_PATH, ...argv],
    execPath: EXEC_PATH,
    exists: (file) => (options.updateExe ?? true) && file === UPDATE_EXE,
    spawn: (command, args) => {
      if (options.spawnThrows) throw new Error('spawn EACCES');
      spawned.push({ command, args });
      return child;
    },
    setTimeout: (fn, ms) => void timers.push({ fn, ms }),
  };
  const app = { isPackaged: options.isPackaged ?? true, exit: (code = 0) => void exits.push(code) };
  const handled = handleSquirrelEvent(app, deps);
  return { handled, exits, spawned, timers, child };
}

describe('Squirrel events (Windows)', () => {
  test.each([
    ['--squirrel-install', '--createShortcut'],
    ['--squirrel-updated', '--createShortcut'],
    ['--squirrel-uninstall', '--removeShortcut'],
  ] as const)('squirrel-shortcut-events (%s)', (event, verb) => {
    const run = harness([event, '1.2.3']);
    expect(run.handled).toBe(true);
    expect(run.spawned).toEqual([{ command: UPDATE_EXE, args: [verb, WIN_EXECUTABLE] }]);
    expect(run.child.unrefed).toBe(true);
    // Waits for Update.exe: no exit until it exits.
    expect(run.exits).toEqual([]);
    run.child.fire('exit');
    expect(run.exits).toEqual([0]);
    // The wait limit firing afterwards does not exit twice.
    for (const timer of run.timers) timer.fn();
    expect(run.exits).toEqual([0]);
  });

  test('squirrel-shortcut-wait-is-bounded', () => {
    const run = harness(['--squirrel-install', '1.2.3']);
    expect(run.timers.map((t) => t.ms)).toEqual([WIN_SQUIRREL_HOOK_WAIT_MS]);
    expect(WIN_SQUIRREL_HOOK_WAIT_MS).toBeLessThan(WIN_SQUIRREL_HOOK_LIMIT_MS / 2);
    // Update.exe never exits: the timer ends the run.
    run.timers[0]?.fn();
    expect(run.exits).toEqual([0]);
    run.child.fire('exit');
    expect(run.exits).toEqual([0]);
  });

  test('squirrel-obsolete-exits-at-once', () => {
    const run = harness(['--squirrel-obsolete', '1.2.3']);
    expect(run).toMatchObject({ handled: true, exits: [0], spawned: [], timers: [] });
  });

  test('squirrel-firstrun-starts-normally', () => {
    expect(harness([WIN_SQUIRREL_FIRSTRUN])).toMatchObject({ handled: false, exits: [], spawned: [] });
  });

  test('squirrel-events-only-packaged-on-windows', () => {
    for (const event of Object.keys(WIN_SQUIRREL_EVENTS)) {
      for (const platform of ['darwin', 'linux'] as const) {
        expect(harness([event, '1.2.3'], { platform }), `${event} on ${platform}`).toMatchObject({ handled: false, exits: [], spawned: [] });
      }
      expect(harness([event, '1.2.3'], { isPackaged: false }), `${event} unpackaged`).toMatchObject({ handled: false, exits: [], spawned: [] });
    }
  });

  test('squirrel-other-args-ignored', () => {
    const others = [
      [],
      ['https://example.com/'],
      ['1.2.3', '--squirrel-install'], // only argv[1] counts
      ['--squirrel-install=1.2.3'],
      ['--SQUIRREL-INSTALL'],
      ['-squirrel-install'],
      ['--squirrel-installx'],
      ['--squirrel-'],
      ['toString'],
      ['__proto__'],
    ];
    for (const argv of others) {
      expect(harness(argv), argv.join(' ')).toMatchObject({ handled: false, exits: [], spawned: [] });
      expect(squirrelEventAction({ platform: 'win32', isPackaged: true, argv: ['frost.exe', ...argv] })).toEqual({ kind: 'none' });
    }
  });

  test('squirrel-update-exe-missing-exits-quietly', () => {
    expect(harness(['--squirrel-install', '1.2.3'], { updateExe: false })).toMatchObject({ handled: true, exits: [0], spawned: [], timers: [] });
    expect(harness(['--squirrel-uninstall', '1.2.3'], { spawnThrows: true })).toMatchObject({ handled: true, exits: [0], spawned: [] });
    const failed = harness(['--squirrel-updated', '1.2.3']);
    failed.child.fire('error');
    expect(failed.exits).toEqual([0]);
  });
});
