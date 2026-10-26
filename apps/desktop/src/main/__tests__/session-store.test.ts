// Spec: specs/browser-session-db.spec.ts (DB_FILE_NAME)
// Acceptance: specs/browser-session-db.feature.md (Main wiring)
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appRouter } from '@app/ipc-contract';
import { DB_FILE_NAME } from '@app/specs/browser-session-db.spec';
import { flushBeforeQuit, loadSavedState, openBrowserSessionStore } from '../session-store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'frost-session-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Electron's `app`, as far as the quit flush uses it. */
class FakeApp extends EventEmitter {
  quit = vi.fn(() => {
    const event = { preventDefault: vi.fn() };
    this.emit('will-quit', event);
    this.events.push(event);
  });
  events: { preventDefault: ReturnType<typeof vi.fn> }[] = [];
}

describe('main session store', () => {
  test('session-persists-across-reopen', async () => {
    const log = vi.fn();
    const first = openBrowserSessionStore(dir, log);
    expect(first.file).toBe(path.join(dir, DB_FILE_NAME));
    const session = { tabs: [{ url: 'https://a.test/', title: 'A' }, { url: 'https://b.test/', title: 'B' }], activeIndex: 1 };
    const decision = { origin: 'https://a.test', topLevelOrigin: 'https://a.test', permission: 'notifications', decision: 'block' } as const;
    first.writer.saveSession(session);
    first.writer.recordVisit('https://a.test/');
    first.writer.savePermissionDecision(decision);

    // Quitting waits for the flush, then quits for real.
    const app = new FakeApp();
    flushBeforeQuit(app, first);
    app.quit();
    expect(app.events[0]?.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2));
    expect(app.events[1]?.preventDefault).not.toHaveBeenCalled();

    const second = openBrowserSessionStore(dir, log);
    expect(await loadSavedState(second, log)).toEqual({ session, decisions: [decision] });
    expect(await second.repository.recentVisits()).toMatchObject([{ url: 'https://a.test/', visitCount: 1 }]);
    await second.close();
    expect(log).not.toHaveBeenCalled();
  });

  test('db-only-in-main', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const outside = ['apps/desktop/src/renderer', 'apps/desktop/src/preload', 'packages/ipc-contract/src'];
    const files = outside.flatMap((sub) => sourceFiles(path.join(root, sub)));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"](?:@app\/db|node:sqlite|drizzle-orm)/);
      expect(source, file).not.toMatch(/(?:require|import)\(\s*['"](?:@app\/db|node:sqlite|drizzle-orm)/);
    }
    // No IPC procedure is about SQL or the database.
    const procedures = Object.keys(appRouter._def.procedures);
    expect(procedures.length).toBeGreaterThan(0);
    for (const name of procedures) expect(name).not.toMatch(/sql|sqlite|database|db\b|exec|query|session/i);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) return sourceFiles(file);
    return /\.(?:ts|tsx)$/.test(name) ? [file] : [];
  });
}
