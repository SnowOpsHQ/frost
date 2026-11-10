import { useSyncExternalStore } from 'react';
import {
  MAX_OVERLAY_DATA_URL_CHARS,
  SCREENSHOT_EDIT_LIMITS,
  SCREENSHOT_OVERLAY_PREFIX,
  type ScreenshotEditOp,
  type ScreenshotEditPoint,
  type ScreenshotEntry,
  type ScreenshotRect,
} from '@app/specs/screenshot.spec';
import { closeProjects } from './components/changes/projects-sheet';
import { askSettingsToClose } from './settings-open';

// The screenshot editor's logic (Phase 11 Task 7, Decision 9; spec `screenshot.spec.ts`, Editing;
// acceptance `screenshot.feature.md`, Editing): its undo history, the conversion from the preview's
// pixels to the screenshot's, drawing the ops onto a 2D context, and the overlay the chrome sends on
// Save (the annotations alone, transparent, exactly the crop's size in the screenshot's pixels; never
// a page pixel). Which entry is open is kept here too (`ScreenshotEditor.tsx` reads it), like the
// Projects sheet. Pure but for that store; the canvas is injected so tests need no DOM.

// ---- History ------------------------------------------------------------------------------------

/** One step of the editor: an annotation, or a crop (`rect: null` clears it). */
export type EditorStep = ScreenshotEditOp | { readonly tool: 'crop'; readonly rect: ScreenshotRect | null };

/** The steps done (oldest first) and the ones undone (most recently undone last). */
export interface EditorHistory {
  readonly steps: readonly EditorStep[];
  readonly undone: readonly EditorStep[];
}

export const EMPTY_HISTORY: EditorHistory = { steps: [], undone: [] };

/** Whether the history holds as many steps as the editor keeps (`maxOps`). */
export const historyFull = (history: EditorHistory, maxOps: number = SCREENSHOT_EDIT_LIMITS.maxOps): boolean => history.steps.length >= maxOps;

/** `history` with `step` done (the redo tail dropped); `null` when it is full. */
export function addStep(history: EditorHistory, step: EditorStep, maxOps: number = SCREENSHOT_EDIT_LIMITS.maxOps): EditorHistory | null {
  return historyFull(history, maxOps) ? null : { steps: [...history.steps, step], undone: [] };
}

export const canUndo = (history: EditorHistory): boolean => history.steps.length > 0;
export const canRedo = (history: EditorHistory): boolean => history.undone.length > 0;

export function undo(history: EditorHistory): EditorHistory {
  const last = history.steps.at(-1);
  return last === undefined ? history : { steps: history.steps.slice(0, -1), undone: [...history.undone, last] };
}

export function redo(history: EditorHistory): EditorHistory {
  const next = history.undone.at(-1);
  return next === undefined ? history : { steps: [...history.steps, next], undone: history.undone.slice(0, -1) };
}

/** What the history amounts to: the last crop (`null`: none) and the annotations, oldest first. */
export function editOf(history: EditorHistory): { readonly crop: ScreenshotRect | null; readonly ops: ScreenshotEditOp[] } {
  let crop: ScreenshotRect | null = null;
  const ops: ScreenshotEditOp[] = [];
  for (const step of history.steps) {
    if (step.tool === 'crop') crop = step.rect;
    else ops.push(step);
  }
  return { crop, ops };
}

// ---- Pixels -------------------------------------------------------------------------------------

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/** The preview's pixels per screenshot pixel (at most 1: a preview is never larger). */
export const previewScale = (source: PixelSize, preview: PixelSize): number => (source.width > 0 && preview.width > 0 ? Math.min(1, preview.width / source.width) : 1);

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A point on the preview (its pixels) in the screenshot's whole pixels, inside the screenshot. */
export function toSourcePoint(point: ScreenshotEditPoint, scale: number, source: PixelSize): ScreenshotEditPoint {
  return { x: clamp(Math.round(point.x / scale), 0, source.width - 1), y: clamp(Math.round(point.y / scale), 0, source.height - 1) };
}

/** The rectangle two screenshot points span (inclusive), inside the screenshot; `null` when it is under 2 × 2 px. */
export function rectBetween(a: ScreenshotEditPoint, b: ScreenshotEditPoint, source: PixelSize): ScreenshotRect | null {
  const x = clamp(Math.min(a.x, b.x), 0, source.width - 1);
  const y = clamp(Math.min(a.y, b.y), 0, source.height - 1);
  const width = clamp(Math.max(a.x, b.x), 0, source.width - 1) - x + 1;
  const height = clamp(Math.max(a.y, b.y), 0, source.height - 1) - y + 1;
  return width < 2 || height < 2 ? null : { x, y, width, height };
}

/** An op's size for a tool drawn at `scale` (stroke 3 px, text 18 px on the preview), in screenshot pixels. */
export function opSizeFor(tool: 'arrow' | 'box' | 'text', scale: number): number {
  const onPreview = tool === 'text' ? 18 : 3;
  return clamp(Math.round(onPreview / (scale > 0 ? scale : 1)), SCREENSHOT_EDIT_LIMITS.minOpSize, SCREENSHOT_EDIT_LIMITS.maxOpSize);
}

/** The overlay's size: the crop's, or the whole screenshot's. */
export const overlaySize = (source: PixelSize, crop: ScreenshotRect | null): PixelSize => (crop === null ? { width: source.width, height: source.height } : { width: crop.width, height: crop.height });

/** Whether the chrome can draw an overlay that size (Open question 9: `maxOverlaySide`, `maxOverlayPixels`). */
export function overlayFits(size: PixelSize): boolean {
  const { maxOverlaySide, maxOverlayPixels } = SCREENSHOT_EDIT_LIMITS;
  return size.width >= 1 && size.height >= 1 && size.width <= maxOverlaySide && size.height <= maxOverlaySide && size.width * size.height <= maxOverlayPixels;
}

// ---- Drawing ------------------------------------------------------------------------------------

/** What drawing needs of a 2D context (a real `CanvasRenderingContext2D` has it all). */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'translate' | 'scale' | 'beginPath' | 'moveTo' | 'lineTo' | 'closePath' | 'stroke' | 'fill' | 'fillRect' | 'strokeRect' | 'fillText'
> & { strokeStyle: unknown; fillStyle: unknown; lineWidth: number; lineCap: CanvasLineCap; lineJoin: CanvasLineJoin; font: string; textBaseline: CanvasTextBaseline };

/** Draws one annotation in screenshot pixels (the caller sets any transform). */
export function drawOp(ctx: DrawContext, op: ScreenshotEditOp): void {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (op.tool === 'arrow') {
    const { from, to } = op;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(10, op.size * 4);
    // The shaft stops where the head starts, so the round cap does not poke through its tip.
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const shaft = Math.max(0, length - head * 0.8);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(from.x + Math.cos(angle) * shaft, from.y + Math.sin(angle) * shaft);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (op.tool === 'box') {
    const { x, y, width, height } = op.rect;
    if (op.filled) ctx.fillRect(x, y, width, height);
    else {
      // Inside the box's own pixels.
      const inset = Math.min(op.size, width, height) / 2;
      ctx.lineWidth = Math.min(op.size, width, height);
      ctx.lineJoin = 'miter';
      ctx.strokeRect(x + inset, y + inset, Math.max(0, width - inset * 2), Math.max(0, height - inset * 2));
    }
  } else {
    ctx.font = `600 ${op.size}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(op.text, op.at.x, op.at.y);
  }
  ctx.restore();
}

/** A canvas the overlay is drawn on (`document.createElement('canvas')`; tests pass a fake). */
export interface OverlayCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): DrawContext | null;
  toDataURL(type: 'image/png'): string;
}

export type OverlayResult = { readonly status: 'ready'; readonly overlay: string } | { readonly status: 'too-big' } | { readonly status: 'too-large' } | { readonly status: 'failed' };

/**
 * The overlay Save sends: a transparent canvas of the crop's size (in screenshot pixels), the ops
 * drawn on it translated by the crop's origin (nothing else: no page pixels), as a PNG `data:` URL.
 * `too-big` when the chrome cannot draw that size (or the canvas does not encode), `too-large` when
 * its URL is past `MAX_OVERLAY_DATA_URL_CHARS`. The canvas is emptied afterwards.
 */
export function renderOverlay(source: PixelSize, edit: { readonly crop: ScreenshotRect | null; readonly ops: readonly ScreenshotEditOp[] }, makeCanvas: (width: number, height: number) => OverlayCanvas): OverlayResult {
  const size = overlaySize(source, edit.crop);
  if (!overlayFits(size)) return { status: 'too-big' };
  const canvas = makeCanvas(size.width, size.height);
  try {
    if (canvas.width !== size.width || canvas.height !== size.height) return { status: 'too-big' };
    const ctx = canvas.getContext('2d');
    if (ctx === null) return { status: 'too-big' };
    ctx.save();
    ctx.translate(-(edit.crop?.x ?? 0), -(edit.crop?.y ?? 0));
    for (const op of edit.ops) drawOp(ctx, op);
    ctx.restore();
    const overlay = canvas.toDataURL('image/png');
    // A canvas past what the renderer can encode answers `data:,`.
    if (!overlay.startsWith(SCREENSHOT_OVERLAY_PREFIX) || overlay.length <= SCREENSHOT_OVERLAY_PREFIX.length) return { status: 'too-big' };
    if (overlay.length > MAX_OVERLAY_DATA_URL_CHARS) return { status: 'too-large' };
    return { status: 'ready', overlay };
  } catch {
    return { status: 'failed' };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

// ---- Which screenshot is open (per window) --------------------------------------------------------

let open: ScreenshotEntry | null = null;
/** Bumped after an edit is saved (the gallery reads again). */
let saves = 0;
const listeners = new Set<() => void>();
/** Told when the editor opens (the Help sheets and, through `ScreenshotEditorSheet`, History close). */
const openedListeners = new Set<() => void>();
const notify = (): void => {
  for (const listener of [...listeners]) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Opens the editor on `entry` (one at a time: another entry replaces it). It is a page-column sheet,
 * one at a time with the Help sheets, Settings, Projects and History (`help.feature.md`; whole-branch
 * review): Settings closes (unless a sign-in waits for its confirmation there: the editor then stays
 * shut and this answers `false`), Projects closes, and the Help sheets and History close (they listen
 * with `onScreenshotEditorOpened`).
 */
export function openScreenshotEditor(entry: ScreenshotEntry): boolean {
  if (!askSettingsToClose()) return false;
  closeProjects();
  open = entry;
  notify();
  for (const listener of [...openedListeners]) listener();
  return true;
}

/** Subscribes to the editor opening; answers the unsubscribe. */
export function onScreenshotEditorOpened(listener: () => void): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

export function closeScreenshotEditor(): void {
  if (open === null) return;
  open = null;
  notify();
}

/** Says that an edited copy was saved. */
export function notifyScreenshotEdited(): void {
  saves += 1;
  notify();
}

/** The screenshot open in the editor (`null`: closed). */
export const useScreenshotEditor = (): ScreenshotEntry | null => useSyncExternalStore(subscribe, () => open);

/** Grows each time an edited copy is saved. */
export const useScreenshotEdits = (): number => useSyncExternalStore(subscribe, () => saves);
