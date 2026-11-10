import type { CompareAnswer, CopyCsvAnswer, RankCsvKind, RankRange, RankSeriesAnswer, RankTableAnswer, ReadingDatesAnswer, SaveCsvAnswer } from '@app/specs/rankings.spec';

// The rankings as the `rankings.*` procedures see them (Phase 10 Task 5; spec `rankings.spec.ts`,
// `rankings.schema.ts`; acceptance `rankings.feature.md`, Router and Export). Main implements it
// (`apps/desktop/src/main/changes/rankings.ts`); this package only knows the interface. Every method
// answers and none rejects; every read is of one live project (`not-found` otherwise), and no method
// takes a path or a file name: Save CSV asks for the file in main's own dialog.

export interface RankingsService {
  /** The project's rank table in `range` (`tag`: saved searches carrying it only), with its retention, site, competitors and tags. */
  table(projectId: string, range: RankRange, tag: string | null): Promise<RankTableAnswer>;
  /** One search's points in `range` (oldest first). */
  series(projectId: string, searchKey: string, range: RankRange): Promise<RankSeriesAnswer>;
  /** One search's readings, newest first (the Compare view's date picker). */
  readingDates(projectId: string, searchKey: string): Promise<ReadingDatesAnswer>;
  /** Readings `a` and `b` side by side; `not-found` unless both are of this live project. */
  compare(projectId: string, a: string, b: string): Promise<CompareAnswer>;
  /** The table (`table`) or every point (`history`) as CSV on main's clipboard; the line count, or `null`. */
  copyCsv(projectId: string, kind: RankCsvKind, range: RankRange, tag: string | null): Promise<CopyCsvAnswer>;
  /**
   * The same CSV written to the file the user picks in main's save dialog, parented to app window
   * `windowId` (the sender's; `null`: the focused window). Cancel writes nothing.
   */
  saveCsv(windowId: number | null, projectId: string, kind: RankCsvKind, range: RankRange, tag: string | null): Promise<SaveCsvAnswer>;
}
