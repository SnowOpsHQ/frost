// Spec: specs/browser-session-db.spec.ts (SESSION_WRITE_BATCH_MS)
// Acceptance: specs/browser-session-db.feature.md (Writer)
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SESSION_WRITE_BATCH_MS } from '@app/specs/browser-session-db.spec';
import { createDrizzle } from '../client';
import { runMigrations } from '../migrations';
import { createSessionRepository, type SessionRepository, type SessionWrite } from '../repository';
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

  test('write-failure-logged-once', async () => {
    const log = vi.fn();
    const failing: SessionRepository = { ...repo, write: vi.fn(async () => Promise.reject(new Error('disk full'))), savePermissionDecision: vi.fn(async () => Promise.reject(new Error('disk full'))) };
    const writer = createSessionWriter(failing, { now: () => clock, log });
    writer.saveSession(tabs(1));
    await expect(writer.flush()).resolves.toBeUndefined();
    writer.recordVisit('https://a.example/');
    await expect(writer.flush()).resolves.toBeUndefined();
    writer.savePermissionDecision({ origin: 'https://a.example', topLevelOrigin: 'https://a.example', permission: 'geolocation', decision: 'allow' });
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(failing.write).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toContain('disk full');
  });
});
