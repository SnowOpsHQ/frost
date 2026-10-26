// Spec: specs/browser-session-db.spec.ts (SESSION_WRITE_BATCH_MS)
// Acceptance: specs/browser-session-db.feature.md (Writer)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SESSION_WRITE_BATCH_MS } from '@app/specs/browser-session-db.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository, type SessionWrite } from '../repository';
import { openSessionStore } from '../store';
import { createSessionWriter } from '../writer';

let repo: SessionRepository;
let writes: SessionWrite[];
let clock: number;

beforeEach(() => {
  vi.useFakeTimers();
  const raw = new DatabaseSync(':memory:');
  runMigrations(raw);
  const real = createSessionRepository(createDrizzle(raw));
  writes = [];
  clock = 1_000;
  repo = {
    ...real,
    write: vi.fn(async (write: SessionWrite) => {
      writes.push(write);
      await real.write(write);
    }),
    savePermissionDecision: vi.fn(real.savePermissionDecision),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const tabs = (n: number) => ({ tabs: Array.from({ length: n }, (_, i) => ({ url: `https://t${i}.example/`, title: `T${i}` })), activeIndex: n - 1 });

describe('writer', () => {
  test('writes-are-batched', async () => {
    const writer = createSessionWriter(repo, { now: () => clock });
    for (let i = 1; i <= 100; i++) {
      clock += 1;
      writer.saveSession(tabs((i % 5) + 1));
      writer.recordVisit(`https://v${i % 10}.example/`);
    }
    writer.updateVisitTitle('https://v3.example/', 'Visit 3');
    await vi.advanceTimersByTimeAsync(SESSION_WRITE_BATCH_MS - 1);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    // The latest strip and every visit, in that one write.
    expect(writes[0]?.session).toEqual(tabs((100 % 5) + 1));
    expect(writes[0]?.visits).toHaveLength(10);
    expect(writes[0]?.visits?.reduce((sum, v) => sum + v.visits, 0)).toBe(100);
    expect(await repo.loadSession()).toEqual(tabs(1));
    const visits = await repo.recentVisits();
    expect(visits).toHaveLength(10);
    expect(visits.find((v) => v.url === 'https://v3.example/')).toMatchObject({ title: 'Visit 3', visitCount: 10 });
    // Nothing pending, nothing written; the next change starts a new window.
    await vi.advanceTimersByTimeAsync(SESSION_WRITE_BATCH_MS * 3);
    expect(writes).toHaveLength(1);
    writer.recordVisit('https://v1.example/');
    await vi.advanceTimersByTimeAsync(SESSION_WRITE_BATCH_MS);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ visits: [{ url: 'https://v1.example/', visits: 1, lastVisitAt: clock, title: '' }] });
  });

  test('flush-writes-pending', async () => {
    const writer = createSessionWriter(repo, { now: () => clock });
    writer.saveSession(tabs(2));
    writer.recordVisit('https://a.example/');
    await writer.flush();
    expect(writes).toHaveLength(1);
    expect(await repo.loadSession()).toEqual(tabs(2));
    expect(await repo.recentVisits()).toHaveLength(1);
    // The cancelled timer writes nothing more.
    await vi.advanceTimersByTimeAsync(SESSION_WRITE_BATCH_MS * 2);
    expect(writes).toHaveLength(1);
    // A flush with nothing pending is a no-op that still waits for earlier writes.
    await writer.flush();
    expect(writes).toHaveLength(1);
  });

  test('close-flushes-then-closes', async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-db-close-'));
    try {
      const store = openSessionStore({ dir });
      expect(store.isOpen).toBe(true);
      store.writer.saveSession(tabs(3));
      await store.close();
      expect(store.isOpen).toBe(false);
      // Idempotent; the pending strip was written before the database closed.
      await store.close();
      const again = openSessionStore({ dir });
      expect(await again.repository.loadSession()).toEqual(tabs(3));
      await again.close();
      expect(again.isOpen).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('permission-decisions-written-at-once', async () => {
    const writer = createSessionWriter(repo, { now: () => clock });
    const decision = { origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'geolocation', decision: 'allow' } as const;
    writer.savePermissionDecision(decision);
    expect(repo.savePermissionDecision).toHaveBeenCalledTimes(0);
    // No batch window: the next microtasks write it.
    await vi.advanceTimersByTimeAsync(0);
    expect(repo.savePermissionDecision).toHaveBeenCalledExactlyOnceWith(decision, clock);
    expect(await repo.loadPermissionDecisions()).toEqual([decision]);
  });

  test('write-failures-logged-once-per-kind', async () => {
    const log = vi.fn();
    const sqliteError = (errcode: number, message: string) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode });
    let next: Error = sqliteError(13, 'database or disk is full');
    const failing: SessionRepository = {
      ...repo,
      write: vi.fn(async () => Promise.reject(next)),
      savePermissionDecision: vi.fn(async () => Promise.reject(next)),
    };
    const writer = createSessionWriter(failing, { now: () => clock, log });
    writer.saveSession(tabs(1));
    await expect(writer.flush()).resolves.toBeUndefined();
    writer.recordVisit('https://a.example/');
    await expect(writer.flush()).resolves.toBeUndefined();
    writer.savePermissionDecision({ origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'geolocation', decision: 'allow' });
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(failing.write).toHaveBeenCalledTimes(2);
    // The same kind (disk full) three times: one line.
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('database or disk is full');
    // Another kind (an I/O error, an extended code of it too) is reported once more.
    next = sqliteError(10, 'disk I/O error');
    writer.recordVisit('https://b.example/');
    await writer.flush();
    next = sqliteError(10 | (3 << 8), 'disk I/O error (read)');
    writer.recordVisit('https://c.example/');
    await writer.flush();
    next = new Error('something else entirely');
    writer.recordVisit('https://d.example/');
    await writer.flush();
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('database or disk is full'),
      expect.stringContaining('disk I/O error'),
      expect.stringContaining('something else entirely'),
    ]);
  });
});
