import type { DiagnosticsResult } from '@app/specs/diagnostics.spec';
import type { HelpOpenResult } from '@app/specs/help.spec';
import type { DiagnosticsReport, HelpOpenLinkInput, HelpViewState, SaveDiagnosticsInput, WhatsNewAnswer } from '@app/specs/whats-new.schema';

// Help as the `help.*` procedures see it (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`).
// Main implements it (`apps/desktop/src/main/help/main.ts`); this package only knows the interface.

export interface HelpService {
  /** App window `windowId`'s count of Help menu requests so far, and the sheet the last one asked for. */
  state(windowId: number): HelpViewState;
  /**
   * Resolves with window `windowId`'s state once its `seq` exceeds `sinceSeq` (at once if it already
   * does), or when `signal` aborts. At most `MAX_PENDING_HELP_WATCHES` wait; one more answers the oldest early.
   */
  watch(windowId: number, sinceSeq: number, signal?: AbortSignal): Promise<HelpViewState>;
  /** The running version and the bundled release notes (none if they failed their schema at startup). */
  whatsNew(): WhatsNewAnswer;
  /** `true` once per version change, for the first chrome that asks (main records the version then). */
  takeWhatsNew(): Promise<boolean>;
  /**
   * Opens a Help page or a bundled release's page in the system browser for app window `windowId`
   * (the IPC sender's): only with a live user gesture there (spent), only through `resolveExternalOpen`.
   */
  openLink(windowId: number, link: HelpOpenLinkInput): HelpOpenResult;
  /**
   * Export Diagnostics (Phase 11 Task 12, `diagnostics.feature.md`): builds a scrubbed report, keeps
   * it under a fresh id and answers both, for review in the chrome. Nothing is sent anywhere.
   */
  diagnostics(): Promise<DiagnosticsReport>;
  /**
   * Saves kept report `input.reportId` (never text from the chrome) through main's save dialog,
   * parented to app window `windowId` (the IPC sender's): one dialog at a time. Never rejects.
   */
  saveDiagnostics(windowId: number, input: SaveDiagnosticsInput): Promise<DiagnosticsResult>;
}
