import type { ChangeIntelRepository, ExecutePurgeResult, PurgePlan } from '@app/db';
import type { PurgeReason } from '@app/specs/capture-db.spec';

// The audited purge path's last steps, shared by a project's delete (`projects.ts`), "Purge now" and
// retention's enforcement (`retention.ts`); spec `retention.feature.md` and the plan's "The purge
// path". `executePurge` records the purge and its tombstones and deletes the rows in one
// transaction; then each hash of the executed plan's `unreferencedHashes` is checked again with
// `isHashReferenced` (a screenshot saved since may name it) and its file unlinked only if no row
// names it. Purges run one at a time; the files are unlinked by hash only, through the screenshot
// store (never a path).

export interface PurgeFilesDeps {
  /** `SessionStore.changeIntel`. */
  readonly store: Pick<ChangeIntelRepository, 'executePurge' | 'isHashReferenced'>;
  /** The screenshot files (`screenshots/store.ts`): only `unlink`, by hash. */
  readonly files: { unlink(sha256: string): Promise<boolean> };
  readonly log?: (message: string) => void;
}

export interface PurgeFiles {
  /**
   * `executePurge(plan, reason, at)`, then the files no row names any more. Answers the repository's
   * answer and how many files were removed; rejects only when the purge itself fails (rolled back).
   */
  execute(plan: PurgePlan, reason: PurgeReason, at: number): Promise<{ readonly result: ExecutePurgeResult | null; readonly files: number }>;
}

/** An error's code or name: never its message (a file error's message holds its path). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

export function createPurgeFiles({ store, files, log }: PurgeFilesDeps): PurgeFiles {
  /** One purge at a time (a delete, a "Purge now" and an enforcement may meet). */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    execute: (plan, reason, at) =>
      serial(async () => {
        const result = await store.executePurge(plan, reason, at);
        let removed = 0;
        if (result?.status !== 'purged') return { result, files: removed };
        for (const hash of result.plan.unreferencedHashes) {
          try {
            if (!(await store.isHashReferenced(hash)) && (await files.unlink(hash))) removed += 1;
          } catch (error) {
            log?.(`a screenshot file could not be removed (${codeOf(error)})`);
          }
        }
        return { result, files: removed };
      }),
  };
}
