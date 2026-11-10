import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SiteCrawlRepository } from '@app/db';
import type { CrawlIpcService } from '@app/ipc-contract';
import { csvCell } from '@app/seo-core';
import type { CrawlCsvAnswer, CrawlPageListRow, CrawlPagesAnswer, CrawlStructureAnswer } from '@app/specs/site-crawl.schema';
import { CRAWL_CSV_COLUMNS, CRAWL_CSV_READ_ROWS, CRAWL_LIMITS, CRAWL_PAGE_FLAGS, CRAWL_TREE_LIMITS, crawlCsvFileName, crawlPageFlags, type CrawlReadRefusal } from '@app/specs/site-crawl.spec';
import type { CrawlChanges } from './changes';
import type { CrawlService } from './service';

// The site crawl's IPC service in main (Phase 12 Task 7; spec `site-crawl.spec.ts`, `site-crawl.schema.ts`;
// acceptance `site-crawl.feature.md`, Pages and Site structure: Main). What the `crawl.*` procedures call:
// - `status`, `start`, `pause`, `resume`, `cancel` and `delete` are the crawl service's own (main's door to
//   crawling; `start` and `resume` refused `unavailable` while the L6 gate is closed);
// - `watch` waits on the change counter (`changes.ts`) and answers the view with the version it read;
// - `pages` and `structure` read the crawl tables a page or a tree level at a time, in SQL (the
//   repository's `pagesPage`, `treeLevel`, `depthHistogram`, `orphansOf` / `orphanCount`), never a full list;
// - `exportCsv` asks main's own save dialog first (`dialogs.ts`; the renderer never names a path), then
//   fixes the export's rows and their order in one statement (`pageOrder`: the ids, at most
//   `CRAWL_LIMITS.maxPagesCap`), reads them `CRAWL_CSV_READ_ROWS` at a time by id and appends each batch
//   to the file, opened owner-only (`CRAWL_CSV_COLUMNS`, every cell through `csvCell`). A running crawl can
//   neither duplicate nor skip a row; one export at a time (`exporting`).
// Every method answers: a run that is gone is `not-found`, a database failure `store-failed` and one log
// line (the error's code or name, never its message).

export interface CrawlIpcDeps {
  readonly service: Pick<CrawlService, 'status' | 'start' | 'pause' | 'resume' | 'cancel' | 'delete'>;
  readonly repo: Pick<SiteCrawlRepository, 'getRun' | 'pagesPage' | 'pageOrder' | 'pagesByIds' | 'treeLevel' | 'depthHistogram' | 'orphansOf' | 'orphanCount'>;
  readonly changes: Pick<CrawlChanges, 'version' | 'wait'>;
  /**
   * Main's save dialog, parented to app window `windowId` (else the focused one), offering `defaultName`;
   * the absolute path the user chose, or `null` (cancelled). Without it nothing is ever written.
   */
  readonly chooseCsvPath?: (windowId: number | null, defaultName: string) => Promise<string | null>;
  /** Opens the chosen file for the CSV, emptied, owner-only (default: `openOwnerOnly`, `mode: 0o600`); batches are appended to it. */
  readonly openCsv?: (file: string) => Promise<CsvSink>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** Where the CSV's batches go, in order. */
export interface CsvSink {
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Mode changes a file system may refuse (FAT, some network shares): the file is still written. */
const CHMOD_UNSUPPORTED: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EINVAL']);

/**
 * Opens `file` (the one the user chose in main's dialog) for the CSV readable by its owner only, as the
 * rank CSV's `writeOwnerOnly`: opened without truncating (`O_WRONLY | O_CREAT`, created `0o600`), set to
 * `0o600` (POSIX; a file system refusing it with `EPERM`, `ENOTSUP` or `EINVAL` is let be), and only then
 * emptied; batches are appended in order.
 */
export async function openOwnerOnly(file: string): Promise<CsvSink> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT, 0o600);
  try {
    if (process.platform !== 'win32') {
      try {
        await handle.chmod(0o600);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code !== 'string' || !CHMOD_UNSUPPORTED.has(code)) throw error;
      }
    }
    await handle.truncate(0);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return { write: async (text) => void (await handle.write(text, null, 'utf8')), close: () => handle.close() };
}

/** An error's code or name: never its message (it may hold a path). */
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error';
};

const refused = (reason: CrawlReadRefusal) => ({ status: 'refused' as const, reason });

const text = (value: string | number | boolean | null): string => (value === null ? '' : typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value));

/** One page row as the CSV's cells, in `CRAWL_CSV_COLUMNS` order. */
function csvCells(row: CrawlPageListRow): string[] {
  const fetched = new Date(row.fetchedAt);
  return [
    row.url,
    row.finalUrl,
    row.outcome,
    row.status,
    row.indexable,
    row.title,
    row.canonical,
    row.depth,
    row.inlinks,
    row.outlinks,
    row.wordCount,
    row.robotsCrawl,
    row.robotsGooglebot,
    row.score,
    row.findings.map((finding) => finding.id).join(' '),
    crawlPageFlags(row)
      .map((flag) => CRAWL_PAGE_FLAGS[flag])
      .join('; '),
    row.bytes,
    Number.isNaN(fetched.getTime()) ? null : fetched.toISOString(),
  ].map(text);
}

/** The CSV's lines for `rows` (each through `csvCell`), without line ends. */
export function crawlCsvLines(rows: readonly CrawlPageListRow[]): string[] {
  return rows.map((row) => csvCells(row).map(csvCell).join(','));
}

/** The CSV's header line. */
export const CRAWL_CSV_HEADER = CRAWL_CSV_COLUMNS.map(csvCell).join(',');

export function createCrawlIpcService(deps: CrawlIpcDeps): CrawlIpcService {
  const { service, repo, changes } = deps;
  const now = deps.now ?? Date.now;
  const log = (line: string): void => deps.log?.(`crawl: ${line}`);
  const openCsv = deps.openCsv ?? openOwnerOnly;
  /** One CSV export at a time, app-wide. */
  let exporting = false;

  /** Runs a read, answering `not-found` for a run that is gone and `store-failed` (one log line) for a failure. */
  const reading = async <T>(what: string, runId: string, read: () => Promise<T>): Promise<T | ReturnType<typeof refused>> => {
    try {
      if ((await repo.getRun(runId)) === null) return refused('not-found');
      return await read();
    } catch (error) {
      log(`${what} failed (${codeOf(error)})`);
      return refused('store-failed');
    }
  };

  return {
    status: () => service.status(),

    async watch(sinceVersion, signal, sender) {
      await changes.wait(sinceVersion, signal, sender);
      // The version first: a change while the view is read makes the next poll answer at once.
      const version = changes.version();
      return { version, status: await service.status() };
    },

    start: (input) => service.start(input),
    pause: (runId) => service.pause(runId),
    resume: (runId) => service.resume(runId),
    cancel: (runId) => service.cancel(runId),
    delete: (runId) => service.delete(runId),

    pages: ({ runId, filter, sort, direction, offset, limit }): Promise<CrawlPagesAnswer> =>
      reading('the pages read', runId, async () => {
        const { total, rows } = await repo.pagesPage(runId, { filter, sort, direction, offset, limit });
        return { status: 'ok' as const, total, offset, rows };
      }),

    structure: ({ runId, prefix }): Promise<CrawlStructureAnswer> =>
      reading('the structure read', runId, async () => {
        const tree = await repo.treeLevel(runId, prefix, CRAWL_TREE_LIMITS.maxChildren);
        const depths = await repo.depthHistogram(runId);
        const urls = await repo.orphansOf(runId, { limit: CRAWL_TREE_LIMITS.maxOrphansShown, offset: 0 });
        const total = await repo.orphanCount(runId);
        return { status: 'ok' as const, tree: { prefix, nodes: tree.nodes, more: tree.more }, depths, orphans: { urls, total } };
      }),

    async exportCsv(windowId, { runId, filter, sort, direction }): Promise<CrawlCsvAnswer> {
      if (exporting) return refused('exporting');
      exporting = true;
      try {
        // A run that is gone is refused before any dialog.
        const known = await reading('the CSV read', runId, async () => true as const);
        if (known !== true) return known;
        if (deps.chooseCsvPath === undefined) return { status: 'cancelled' };
        let file: string | null;
        try {
          file = await deps.chooseCsvPath(windowId, crawlCsvFileName(now()));
        } catch (error) {
          log(`the save dialog failed (${codeOf(error)})`);
          return refused('write-failed');
        }
        // Only an absolute path the dialog answered; anything else writes nothing.
        if (typeof file !== 'string' || file === '' || !path.isAbsolute(file)) return { status: 'cancelled' };
        // The export's rows and their order, fixed in one statement: nothing written or changed meanwhile moves them.
        let order: number[];
        try {
          order = await repo.pageOrder(runId, { filter, sort, direction }, CRAWL_LIMITS.maxPagesCap);
        } catch (error) {
          log(`the CSV read failed (${codeOf(error)})`);
          return refused('store-failed');
        }
        let sink: CsvSink;
        try {
          sink = await openCsv(file);
        } catch (error) {
          log(`the CSV file could not be opened (${codeOf(error)})`);
          return refused('write-failed');
        }
        let rows = 0;
        let failed: CrawlReadRefusal | null = null;
        try {
          await sink.write(`${CRAWL_CSV_HEADER}\r\n`);
          for (let at = 0; at < order.length; at += CRAWL_CSV_READ_ROWS) {
            let batch: CrawlPageListRow[];
            try {
              batch = await repo.pagesByIds(runId, order.slice(at, at + CRAWL_CSV_READ_ROWS));
            } catch (error) {
              log(`the CSV read failed (${codeOf(error)})`);
              failed = 'store-failed';
              break;
            }
            if (batch.length === 0) continue;
            await sink.write(`${crawlCsvLines(batch).join('\r\n')}\r\n`);
            rows += batch.length;
          }
        } catch (error) {
          log(`the CSV file could not be written (${codeOf(error)})`);
          failed = 'write-failed';
        } finally {
          try {
            await sink.close();
          } catch (error) {
            log(`the CSV file could not be closed (${codeOf(error)})`);
            failed ??= 'write-failed';
          }
        }
        return failed === null ? { status: 'saved', rows } : refused(failed);
      } finally {
        exporting = false;
      }
    },
  };
}
