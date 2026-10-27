import { useEffect, useRef, useState } from 'react';
import type { Notice } from '@app/specs/browser.spec';
import type { NoticeKind } from '@app/specs/tabs.spec';
import { createNoticeTracker, type NoticeTracker } from '../notice';

/** The status-bar notice to show: the latest one main raised, for `NOTICE_DISPLAY_MS` (`notice.ts`). */
export function useNotice(notice: Notice | null | undefined): NoticeKind | null {
  const [shown, setShown] = useState<NoticeKind | null>(null);
  const tracker = useRef<NoticeTracker | null>(null);
  useEffect(() => {
    const created = createNoticeTracker(setShown);
    tracker.current = created;
    return () => {
      created.dispose();
      tracker.current = null;
    };
  }, []);
  const seq = notice === undefined ? undefined : (notice?.seq ?? 0);
  useEffect(() => {
    if (notice !== undefined) tracker.current?.update(notice);
  }, [seq]);
  return shown;
}
