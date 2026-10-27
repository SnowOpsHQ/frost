// Spec: specs/seo-sidebar.spec.ts (HIGHLIGHT_MODES: broken, HIGHLIGHT_PANELS, HIGHLIGHT_STYLES)
// Acceptance: specs/seo-checks.feature.md (Highlight)
import { JSDOM } from 'jsdom';
import { describe, expect, test } from 'vitest';
import { SNAPSHOT_LIMITS } from '@app/specs/seo-limits.spec';
import { HIGHLIGHT_PANELS, HIGHLIGHT_STYLES } from '@app/specs/seo-sidebar.spec';
import { highlightScript, OVERLAY_CONFIG, OVERLAY_KEY, paintHighlight, planHighlight, type OverlayDocument, type OverlayState } from '../highlight';

const domRect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('broken highlight', () => {
  test('highlight-broken-mode', async () => {
    const dom = new JSDOM(`<!doctype html><html><head></head><body><a href="/gone#top">Gone</a> <a href="/ok">OK</a> <a href="https://other.test/404">Elsewhere</a> <a href="mailto:x@y">Mail</a></body></html>`, { url: 'https://example.com/page', pretendToBeVisual: true });
    const { document } = dom.window;
    document.querySelectorAll('a').forEach((el, i) => (el.getBoundingClientRect = () => domRect(10, 30 * i, 120, 20)));
    const store: Record<string, unknown> = {};
    const answer = await paintHighlight(document as unknown as OverlayDocument, 'broken', OVERLAY_CONFIG, planHighlight, store, ['https://example.com/gone', 'https://other.test/404']);
    expect(answer).toEqual({ mode: 'broken', boxes: 2 });
    const root = (store[OVERLAY_KEY] as OverlayState).root as unknown as ShadowRoot;
    expect([...root.children].map((box) => box.textContent)).toEqual([HIGHLIGHT_STYLES.broken.label, HIGHLIGHT_STYLES.broken.label]);
    // Nothing listed: nothing outlined.
    await expect(paintHighlight(document as unknown as OverlayDocument, 'broken', OVERLAY_CONFIG, planHighlight, store)).resolves.toEqual({ mode: 'broken', boxes: 0 });
    await paintHighlight(document as unknown as OverlayDocument, 'off', OVERLAY_CONFIG, planHighlight, store);
    expect(document.documentElement.children).toHaveLength(2);
    // The Links panel owns the mode; the script carries the targets as data (capped), and only for `broken`.
    expect(HIGHLIGHT_PANELS.broken).toBe('links');
    const many = Array.from({ length: SNAPSHOT_LIMITS.maxLinks + 5 }, (_, i) => `https://example.com/${i}`);
    expect(highlightScript('broken', many)).toContain(JSON.stringify(many.slice(0, SNAPSHOT_LIMITS.maxLinks)));
    expect(highlightScript('links', many)).toMatch(/globalThis, \[\]\)$/);
  });
});
