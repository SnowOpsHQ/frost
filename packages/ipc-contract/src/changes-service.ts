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
import type { ScreenshotKind } from '@app/specs/capture-db.spec';
import type { ScreenshotImageAnswer, ScreenshotImageSize, ScreenshotsAnswer, ScreenshotsInput, TakeScreenshotAnswer } from '@app/specs/screenshot.spec';

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
  /** Screenshots of a page and/or a project, newest first (no images, paths or hashes). */
  listScreenshots(input: ScreenshotsInput): Promise<ScreenshotsAnswer>;
}

/**
 * What the `screenshots.*` procedures call (Phase 6 Task 5; spec `screenshot.spec.ts`; acceptance
 * `screenshot.feature.md`). A screenshot is named by its row id only: nothing here takes a path, a
 * file name or a hash. Every method answers; none rejects.
 */
export interface ScreenshotsService {
  /**
   * Takes a screenshot of the tab's page (only the active tab, showing a web page) into the project
   * (default Unfiled): saved with its row id and size, or refused with a reason (`SCREENSHOT_REFUSALS`).
   * An `area` resolves once the user has dragged one on the page (or it was cancelled).
   */
  take(tabId: number, options: { readonly kind: ScreenshotKind; readonly projectId?: string }): Promise<TakeScreenshotAnswer>;
  /** Screenshots of a page and/or a project, newest first, a page at a time. */
  list(input: ScreenshotsInput): Promise<ScreenshotsAnswer>;
  /** A screenshot's thumbnail or preview as a `data:` URL (`null`: no such screenshot, or its file is missing or changed). */
  image(id: string, size: ScreenshotImageSize): Promise<ScreenshotImageAnswer>;
  /** Shows the screenshot's file in the system's file manager; whether it is there. */
  reveal(id: string): Promise<boolean>;
  /** Writes the screenshot to the system clipboard as an image; whether it was written. */
  copy(id: string): Promise<boolean>;
  /** Ends the tab's pending area selection (the screenshot is refused as `cancelled`); whether one was pending. */
  cancelArea(tabId: number): Promise<boolean>;
}
