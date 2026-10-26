import type { Notice } from '@app/specs/browser.spec';
import { NOTICE_DISPLAY_MS, type NoticeKind } from '@app/specs/tabs.spec';

// The status bar's notice (spec `tabs.feature.md`, `notice-shows-then-clears`): main raises notices
// as `{ seq, kind }` in its state. The notice present when the chrome starts is history; each new
// `seq` shows its kind for `NOTICE_DISPLAY_MS` (a newer one restarts the timer).

export interface NoticeTracker {
  /** Feeds the latest `state.notice`. */
  update(notice: Notice | null): void;
  /** Cancels a pending clear. */
  dispose(): void;
}

export function createNoticeTracker(show: (kind: NoticeKind | null) => void): NoticeTracker {
  let seen: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    update(notice) {
      const seq = notice?.seq ?? 0;
      const fresh = seen !== undefined && seq !== seen;
      seen = seq;
      if (!fresh || !notice) return;
      clearTimeout(timer);
      show(notice.kind);
      timer = setTimeout(() => {
        timer = undefined;
        show(null);
      }, NOTICE_DISPLAY_MS);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
