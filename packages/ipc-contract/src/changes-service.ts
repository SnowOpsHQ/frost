import type {
  CaptureAnswer,
  DiffAnswer,
  DiffInput,
  HistoryAnswer,
  HistoryInput,
  PagesAnswer,
  PagesInput,
  VersionAnswer,
  VersionInput,
} from '@app/specs/changes.spec';

// Change intelligence as the `changes.*` procedures and other phases see it (Phase 6 Task 3; spec
// `changes.spec.ts`, `changes.schema.ts`; acceptance `changes-capture.feature.md`). Main implements
// both interfaces (`apps/desktop/src/main/changes/service.ts`) over `@app/db`; this package only
// knows them.

export { CHANGES_READ_API, type ChangesReadApi } from '@app/specs/changes.schema';

/** What the `changes.*` procedures call. Every method answers; none rejects. */
export interface ChangesService {
  /**
   * Captures the tab's page (only the active tab, with a ready audit of its current URL) into the
   * project (default Unfiled): a new version when it changed since its lane's latest, else one more
   * capture of that version. A refusal names why (`CAPTURE_REFUSALS`).
   */
  capture(tabId: number, options: { readonly projectId?: string }): Promise<CaptureAnswer>;
  /** The page's versions, newest first, a page at a time. */
  history(input: HistoryInput): Promise<HistoryAnswer>;
  /** One version's snapshot (`null`: none, or unreadable). */
  version(input: VersionInput): Promise<VersionAnswer>;
  /** The diff of two versions of one lane: stored, else computed (`null` for two lanes or an unreadable version). */
  diff(input: DiffInput): Promise<DiffAnswer>;
  /** Captured pages, most recently captured first. */
  pages(input: PagesInput): Promise<PagesAnswer>;
}

/**
 * The read-only operations of `CHANGES_READ_API`, for callers inside main (Phase 5's agent): each
 * takes the operation's input and answers what its output schema accepts. Never rejects.
 */
export interface ChangesReadService {
  listPages(input: PagesInput): Promise<PagesAnswer>;
  history(input: HistoryInput): Promise<HistoryAnswer>;
  getVersion(input: VersionInput): Promise<VersionAnswer>;
  diff(input: DiffInput): Promise<DiffAnswer>;
}
