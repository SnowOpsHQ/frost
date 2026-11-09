// Spec: specs/workspace-db.feature.md — workspace-sweeps-wired (Orphans and when the sweeps run)
import { describe, expect, test, vi } from 'vitest';
import type { PurgePlan } from '@app/db';
import type { PurgeFiles, PurgeFilesResult } from '../purge-files';
import { createWorkspaceSweeps, startupChain, sweptAfterPurge } from '../projects-main';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const PLAN = { projectId: '01920000-0000-7000-8000-0000000000aa' } as unknown as PurgePlan;

function fakeStore(calls: string[], fail: { readings?: boolean; workspace?: boolean } = {}) {
  return {
    deleteOrphanReadings: vi.fn(async () => {
      calls.push('deleteOrphanReadings');
      if (fail.readings) throw Object.assign(new Error('/home/someone/frost.db is locked'), { name: 'SqliteError' });
      return 2;
    }),
    tombstoneOrphanWorkspaceRows: vi.fn(async (_now?: number) => {
      calls.push('tombstoneOrphanWorkspaceRows');
      if (fail.workspace) throw new TypeError('boom');
      return 3;
    }),
  };
}

describe('projects main sweeps', () => {
  test('workspace-sweeps-wired', async () => {
    // Startup: the deleted projects' purges, then both sweeps, then retention's startup.
    const calls: string[] = [];
    const log = vi.fn((_line: string) => undefined);
    const store = fakeStore(calls);
    const sweeps = createWorkspaceSweeps({ store, log, now: () => 7_000 });
    await startupChain(
      async () => {
        calls.push('purgeDeleted');
        return 0;
      },
      sweeps.startup,
      async () => {
        calls.push('retention.startup');
      },
    );
    expect(calls).toEqual(['purgeDeleted', 'deleteOrphanReadings', 'tombstoneOrphanWorkspaceRows', 'retention.startup']);
    expect(store.tombstoneOrphanWorkspaceRows).toHaveBeenCalledWith(7_000);
    expect(store.deleteOrphanReadings).toHaveBeenCalledWith();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'projects: removed 2 search readings whose capture is gone',
      'projects: tombstoned 3 competitors and tags left by deleted projects, pages or searches',
    ]);

    // After a purge: the readings sweep only when it `purged`; the answer is passed through unchanged.
    for (const [result, swept] of [
      [{ status: 'purged', purgeId: '01920000-0000-7000-8000-0000000000bb', plan: PLAN }, true],
      [{ status: 'stale' }, false],
      [{ status: 'empty' }, false],
      [{ status: 'changed' }, false],
      [null, false],
    ] as [PurgeFilesResult | null, boolean][]) {
      const order: string[] = [];
      const inner: PurgeFiles = {
        execute: vi.fn(async () => {
          order.push('execute');
          return { result, files: 1, freedBytes: 10 };
        }),
      };
      const purges = sweptAfterPurge(inner, createWorkspaceSweeps({ store: fakeStore(order), log }).readings);
      expect(await purges.execute(PLAN, 'purge-now', 9_000)).toEqual({ result, files: 1, freedBytes: 10 });
      expect(inner.execute).toHaveBeenCalledWith(PLAN, 'purge-now', 9_000);
      expect(order, JSON.stringify(result)).toEqual(swept ? ['execute', 'deleteOrphanReadings'] : ['execute']);
    }

    // A failing sweep is logged by its error's name (never its message) and the chain goes on.
    const failing: string[] = [];
    const failLog = vi.fn((_line: string) => undefined);
    await startupChain(async () => failing.push('purgeDeleted'), createWorkspaceSweeps({ store: fakeStore(failing, { readings: true, workspace: true }), log: failLog }).startup, async () => {
      failing.push('retention.startup');
    });
    expect(failing).toEqual(['purgeDeleted', 'deleteOrphanReadings', 'tombstoneOrphanWorkspaceRows', 'retention.startup']);
    expect(failLog.mock.calls.map(([line]) => line)).toEqual(['projects: the orphan readings sweep failed (SqliteError)', 'projects: the workspace sweep failed (TypeError)']);
  });
});
