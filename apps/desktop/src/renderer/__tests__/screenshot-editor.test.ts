// Spec: specs/screenshot.spec.ts (SCREENSHOT_EDIT_LIMITS, SCREENSHOT_OVERLAY_PREFIX, MAX_OVERLAY_DATA_URL_CHARS, ScreenshotEditOp)
// Acceptance: specs/screenshot.feature.md (Editing; Scenario screenshot-editor-history: undo-redo, ops-bounded, overlay-sized-to-crop)
import { describe, expect, test } from 'vitest';
import { MAX_OVERLAY_DATA_URL_CHARS, SCREENSHOT_EDIT_LIMITS, SCREENSHOT_OVERLAY_PREFIX, type ScreenshotEditOp } from '@app/specs/screenshot.spec';
import {
  addStep,
  canRedo,
  canUndo,
  editOf,
  EMPTY_HISTORY,
  historyFull,
  opSizeFor,
  overlayFits,
  overlaySize,
  previewScale,
  rectBetween,
  redo,
  renderOverlay,
  toSourcePoint,
  undo,
  type DrawContext,
  type EditorHistory,
  type OverlayCanvas,
} from '../screenshot-editor';

const ARROW: ScreenshotEditOp = { tool: 'arrow', color: '#e5484d', size: 4, from: { x: 10, y: 10 }, to: { x: 60, y: 40 } };
const BOX: ScreenshotEditOp = { tool: 'box', color: '#0090ff', size: 3, rect: { x: 100, y: 120, width: 30, height: 20 }, filled: true };
const TEXT: ScreenshotEditOp = { tool: 'text', color: '#111111', size: 18, at: { x: 5, y: 6 }, text: 'Look here' };

/** A canvas that records what is drawn on it, and answers `url` (or a PNG URL) when encoded. */
function fakeCanvas(url?: string) {
  const calls: string[] = [];
  const made: { width: number; height: number }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => calls.push(`${key}(${args.map((a) => (typeof a === 'number' ? Math.round(a) : String(a))).join(',')})`)),
    set: (target, key: string, value) => ((target[key] = value), true),
  }) as unknown as DrawContext;
  const make = (width: number, height: number): OverlayCanvas => {
    made.push({ width, height });
    const canvas: OverlayCanvas = { width, height, getContext: () => ctx, toDataURL: () => url ?? `${SCREENSHOT_OVERLAY_PREFIX}iVBORw0KGgo=` };
    lastCanvas = canvas;
    return canvas;
  };
  let lastCanvas: OverlayCanvas | null = null;
  return { make, calls, made, last: () => lastCanvas };
}

describe('screenshot editor', () => {
  test('undo-redo', () => {
    // Undo and redo step through drawings and crops; a new step drops the redo tail.
    let history: EditorHistory = EMPTY_HISTORY;
    expect(canUndo(history)).toBe(false);
    history = addStep(history, ARROW)!;
    history = addStep(history, { tool: 'crop', rect: { x: 0, y: 0, width: 50, height: 50 } })!;
    history = addStep(history, BOX)!;
    expect(editOf(history)).toEqual({ crop: { x: 0, y: 0, width: 50, height: 50 }, ops: [ARROW, BOX] });
    history = undo(undo(history));
    expect(editOf(history)).toEqual({ crop: null, ops: [ARROW] });
    expect(canRedo(history)).toBe(true);
    history = redo(history);
    expect(editOf(history)).toEqual({ crop: { x: 0, y: 0, width: 50, height: 50 }, ops: [ARROW] });
    history = addStep(history, TEXT)!;
    expect(canRedo(history)).toBe(false);
    expect(redo(history)).toBe(history);
    // A cleared crop is a step too.
    history = addStep(history, { tool: 'crop', rect: null })!;
    expect(editOf(history)).toEqual({ crop: null, ops: [ARROW, TEXT] });
    expect(undo(EMPTY_HISTORY)).toBe(EMPTY_HISTORY);
  });

  test('ops-bounded', () => {
    // Ops bounded: at `maxOps` steps nothing more is added (undone steps do not count).
    let full: EditorHistory = EMPTY_HISTORY;
    for (let i = 0; i < SCREENSHOT_EDIT_LIMITS.maxOps; i++) full = addStep(full, ARROW)!;
    expect(historyFull(full)).toBe(true);
    expect(addStep(full, BOX)).toBeNull();
    expect(editOf(full).ops).toHaveLength(SCREENSHOT_EDIT_LIMITS.maxOps);
    expect(addStep(undo(full), BOX)).not.toBeNull();
  });

  test('overlay-sized-to-crop', () => {
    // Preview pixels to the screenshot's: scaled, rounded, clamped inside it.
    const source = { width: 3_200, height: 2_000 };
    const scale = previewScale(source, { width: 1_600, height: 1_000 });
    expect(scale).toBe(0.5);
    expect(previewScale(source, { width: 4_000, height: 2_500 })).toBe(1);
    expect(toSourcePoint({ x: 10.3, y: 20.6 }, scale, source)).toEqual({ x: 21, y: 41 });
    expect(toSourcePoint({ x: -5, y: 5_000 }, scale, source)).toEqual({ x: 0, y: 1_999 });
    expect(rectBetween({ x: 40, y: 30 }, { x: 10, y: 20 }, source)).toEqual({ x: 10, y: 20, width: 31, height: 11 });
    expect(rectBetween({ x: 10, y: 20 }, { x: 10, y: 50 }, source)).toBeNull();
    expect(rectBetween({ x: 3_100, y: 1_900 }, { x: 9_000, y: 9_000 }, source)).toEqual({ x: 3_100, y: 1_900, width: 100, height: 100 });
    expect(opSizeFor('arrow', 0.5)).toBe(6);
    expect(opSizeFor('text', 1)).toBe(18);
    expect(opSizeFor('text', 0.001)).toBe(SCREENSHOT_EDIT_LIMITS.maxOpSize);

    // The overlay is sized to the crop in screenshot pixels, drawn translated by its origin, nothing but the ops.
    expect(overlaySize(source, null)).toEqual(source);
    expect(overlaySize(source, { x: 100, y: 200, width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
    const canvas = fakeCanvas();
    const crop = { x: 100, y: 200, width: 640, height: 480 };
    expect(renderOverlay(source, { crop, ops: [BOX, TEXT] }, canvas.make)).toEqual({ status: 'ready', overlay: `${SCREENSHOT_OVERLAY_PREFIX}iVBORw0KGgo=` });
    expect(canvas.made).toEqual([{ width: 640, height: 480 }]);
    expect(canvas.calls[1]).toBe('translate(-100,-200)');
    expect(canvas.calls).toContain('fillRect(100,120,30,20)');
    expect(canvas.calls).toContain('fillText(Look here,5,6)');
    expect(canvas.calls.some((call) => call.startsWith('drawImage'))).toBe(false);
    // Emptied afterwards.
    expect(canvas.last()).toMatchObject({ width: 0, height: 0 });
    const whole = fakeCanvas();
    renderOverlay(source, { crop: null, ops: [] }, whole.make);
    expect(whole.made).toEqual([source]);
    expect(whole.calls).toContain('translate(0,0)');

    // A crop past the canvas limits is refused before a canvas is made (Open question 9); so is a
    // canvas that does not encode, and a URL past the cap.
    expect(overlayFits({ width: 16_384, height: 16_384 })).toBe(true);
    expect(overlayFits({ width: 16_385, height: 16_384 })).toBe(false);
    expect(overlayFits({ width: SCREENSHOT_EDIT_LIMITS.maxOverlaySide + 1, height: 1 })).toBe(false);
    const huge = fakeCanvas();
    expect(renderOverlay({ width: 20_000, height: 20_000 }, { crop: null, ops: [] }, huge.make)).toEqual({ status: 'too-big' });
    expect(huge.made).toEqual([]);
    expect(renderOverlay(source, { crop: null, ops: [] }, fakeCanvas('data:,').make)).toEqual({ status: 'too-big' });
    expect(renderOverlay(source, { crop: null, ops: [] }, fakeCanvas(`${SCREENSHOT_OVERLAY_PREFIX}${'A'.repeat(MAX_OVERLAY_DATA_URL_CHARS)}`).make)).toEqual({ status: 'too-large' });
  });
});
