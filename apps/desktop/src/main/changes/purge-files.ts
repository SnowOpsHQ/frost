import { lstat } from 'node:fs/promises';
import type { ChangeIntelRepository, ExecutePurgeResult, PurgePlan, PurgePolicy } from '@app/db';
import type { PurgeReason } from '@app/specs/capture-db.spec';
import type { ScreenshotFiles } from '../screenshots/store';

// The audited purge path's last steps, shared by a project's delete (`projects.ts`), "Purge now" and
// retention's enforcement (`retention.ts`); spec `retention.feature.md` and the plan's "The purge
// path".
// - A `retention` or `purge-now` purge reads the project's policy again just before it runs, and
//   gives up (`changed`) if it is no longer the plan's.
// - `executePurge` records the purge and its tombstones and deletes the rows in one transaction.
// - Then, for each hash of the executed plan's `unreferencedHashes`, with the hash's lock held (a
//   screenshot holds it from its file's write until its row is written, `screenshots/store.ts`), it
//   checks `isHashReferenced` again and unlinks the file only if no row names it.
// Purges run one at a time; the files are unlinked by hash only, through the screenshot store (never
// a path). The answer says what was really freed: the rows' stored bytes, plus the files really
// unlinked, measured (`ci_purges.bytes` keeps the planned figure).

export interface PurgeFilesDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: Pick<ChangeIntelRepository, 'executePurge' | 'isHashReferenced' | 'project'>;
  /** The screenshot files (`screenshots/store.ts`): `unlink` by hash, with the hash's `lock`; `fileFor` to measure it first. */
  readonly files: Pick<ScreenshotFiles, 'unlink' | 'lock' | 'fileFor'>;
  readonly log?: (message: string) => void;
}

export type PurgeFilesResult = ExecutePurgeResult | { readonly status: 'changed' };

export interface PurgeFiles {
  /**
   * The project's policy checked again (`changed`: it is not the plan's any more), then
   * `executePurge(plan, reason, at)`, then the files no row names any more. Answers the repository's
   * answer, how many files were removed and the bytes really freed; rejects only when the purge
   * itself fails (rolled back).
   */
  execute(plan: PurgePlan, reason: PurgeReason, at: number): Promise<{ readonly result: PurgeFilesResult | null; readonly files: number; readonly freedBytes: number }>;
}

/** An error's code or name: never its message (a file error's message holds its path). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};
const samePolicy = (retention: { readonly mode: string; readonly value: number | null }, policy: PurgePolicy): boolean =>
  retention.mode === 'forever' ? policy.mode === 'forever' : retention.mode === policy.mode && 'value' in policy && retention.value === policy.value;

export function createPurgeFiles({ store, files, log }: PurgeFilesDeps): PurgeFiles {
  /** One purge at a time (a delete, a "Purge now" and an enforcement may meet). */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Unlinks the hash's file if no row names it, with its lock held; answers the bytes freed (`null`: kept). */
  const removeFile = async (hash: string): Promise<number | null> => {
    const release = await files.lock(hash);
    try {
      if (await store.isHashReferenced(hash)) return null;
      const size = await lstat(files.fileFor(hash)).then(
        (found) => (found.isFile() && !found.isSymbolicLink() ? found.size : 0),
        () => 0,
      );
      return (await files.unlink(hash)) ? size : null;
    } finally {
      release();
    }
  };

  return {
    execute: (plan, reason, at) =>
      serial(async () => {
        // The user's policy may have changed since the plan (a retention purge follows it, a "Purge now" showed it).
        if (reason !== 'project-deleted') {
          const project = await store.project(plan.projectId);
          if (project === null || !samePolicy(project.retention, plan.policy)) return { result: { status: 'changed' as const }, files: 0, freedBytes: 0 };
        }
        const result = await store.executePurge(plan, reason, at);
        if (result?.status !== 'purged') return { result, files: 0, freedBytes: 0 };
        let removed = 0;
        let freedBytes = result.plan.bytes - result.plan.fileBytes;
        for (const hash of result.plan.unreferencedHashes) {
          try {
            const freed = await removeFile(hash);
            if (freed !== null) {
              removed += 1;
              freedBytes += freed;
            }
          } catch (error) {
            log?.(`a screenshot file could not be removed (${codeOf(error)})`);
          }
        }
        return { result, files: removed, freedBytes };
      }),
  };
}
