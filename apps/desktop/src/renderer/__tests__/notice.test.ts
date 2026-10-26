// Spec: specs/tabs.spec.ts (NOTICE_DISPLAY_MS) · Acceptance: specs/tabs.feature.md (Renderer)
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NOTICE_DISPLAY_MS, type NoticeKind } from '@app/specs/tabs.spec';
import { createNoticeTracker } from '../notice';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('status-bar notice', () => {
  test('notice-shows-then-clears', () => {
    const shown: (NoticeKind | null)[] = [];
    const tracker = createNoticeTracker((kind) => shown.push(kind));

    // The notice present at start-up is history, not news.
    tracker.update({ seq: 3, kind: 'tab-limit' });
    tracker.update({ seq: 3, kind: 'tab-limit' });
    expect(shown).toEqual([]);

    tracker.update({ seq: 4, kind: 'tab-limit' });
    expect(shown).toEqual(['tab-limit']);
    vi.advanceTimersByTime(NOTICE_DISPLAY_MS - 1);
    expect(shown).toEqual(['tab-limit']);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['tab-limit', null]);

    // A newer notice restarts the timer.
    tracker.update({ seq: 5, kind: 'tab-limit' });
    vi.advanceTimersByTime(NOTICE_DISPLAY_MS - 10);
    tracker.update({ seq: 6, kind: 'tab-limit' });
    vi.advanceTimersByTime(NOTICE_DISPLAY_MS - 1);
    expect(shown).toEqual(['tab-limit', null, 'tab-limit', 'tab-limit']);
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toBeNull();

    // No notice yet at start-up (null), then the first one shows.
    const fresh: (NoticeKind | null)[] = [];
    const second = createNoticeTracker((kind) => fresh.push(kind));
    second.update(null);
    second.update({ seq: 1, kind: 'tab-limit' });
    expect(fresh).toEqual(['tab-limit']);
    // Disposing cancels the pending clear.
    second.dispose();
    vi.advanceTimersByTime(NOTICE_DISPLAY_MS);
    expect(fresh).toEqual(['tab-limit']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
