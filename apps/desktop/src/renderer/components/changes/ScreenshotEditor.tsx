import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  SCREENSHOT_EDIT_COLOR_LABELS,
  SCREENSHOT_EDIT_COLORS,
  SCREENSHOT_EDIT_FULL_NOTE,
  SCREENSHOT_EDIT_LIMITS,
  SCREENSHOT_EDIT_RESULT_MESSAGES,
  SCREENSHOT_EDIT_TOO_BIG_NOTE,
  SCREENSHOT_EDIT_TOOL_LABELS,
  SCREENSHOT_EDIT_TOOLS,
  type ScreenshotEditColor,
  type ScreenshotEditPoint,
  type ScreenshotEditResult,
  type ScreenshotEditTool,
  type ScreenshotEntry,
} from '@app/specs/screenshot.spec';
import { screenshotAlt } from '../../changes-view';
import { useSeqChange } from '../../hooks/useSeqChange';
import { ipc } from '../../ipc';
import { onSettingsOpened } from '../../settings-open';
import { onProjectsOpened } from './projects-sheet';
import {
  addStep,
  canRedo,
  canUndo,
  closeScreenshotEditor,
  drawOp,
  editOf,
  EMPTY_HISTORY,
  notifyScreenshotEdited,
  onScreenshotEditorOpened,
  opSizeFor,
  overlayFits,
  overlaySize,
  previewScale,
  rectBetween,
  redo,
  renderOverlay,
  toSourcePoint,
  undo,
  useScreenshotEditor,
  type DrawContext,
  type EditorHistory,
  type EditorStep,
  type OverlayCanvas,
} from '../../screenshot-editor';

// The screenshot editor (Phase 11 Task 7, Decision 9; acceptance `screenshot.feature.md`, Editing): a
// sheet over the page column (the tab's view is hidden while it shows, as with Projects). It draws on
// the entry's preview; Save renders the annotations alone onto a transparent canvas of the crop's
// size in the screenshot's pixels (`renderOverlay`) and main composites the copy. No inline styles
// (strict CSP): the canvas is sized by its own attributes, colours come from the stylesheet.

/**
 * The sheet, when a screenshot is open in the editor (`App.tsx` mounts it in the page column). One
 * sheet at a time (`help.feature.md`; whole-branch review): Settings, Projects or History opening
 * (`historySeq`: History's open requests) closes it, and its opening closes History (`onOpen`); the
 * Help sheets, Settings and Projects are handled where the editor opens (`openScreenshotEditor`).
 */
export function ScreenshotEditorSheet({ historySeq, onOpen }: { readonly historySeq?: number | undefined; readonly onOpen?: () => void } = {}) {
  const entry = useScreenshotEditor();
  const latestOnOpen = useRef(onOpen);
  latestOnOpen.current = onOpen;
  useEffect(() => onScreenshotEditorOpened(() => latestOnOpen.current?.()), []);
  useEffect(() => onSettingsOpened(closeScreenshotEditor), []);
  useEffect(() => onProjectsOpened(closeScreenshotEditor), []);
  useSeqChange(historySeq, closeScreenshotEditor);
  return entry === null ? null : <ScreenshotEditor key={entry.id} entry={entry} />;
}

type Preview = { readonly status: 'loading' } | { readonly status: 'ready'; readonly image: HTMLImageElement } | { readonly status: 'missing' };
type Outcome = { readonly status: ScreenshotEditResult | 'too-big' | 'full' | 'no-text'; readonly message: string };

/** A real canvas, for the overlay. */
const makeCanvas = (width: number, height: number): OverlayCanvas => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { get width() { return canvas.width; }, set width(value) { canvas.width = value; }, get height() { return canvas.height; }, set height(value) { canvas.height = value; }, getContext: () => canvas.getContext('2d'), toDataURL: (type) => canvas.toDataURL(type) };
};

function ScreenshotEditor({ entry }: { readonly entry: ScreenshotEntry }) {
  const [preview, setPreview] = useState<Preview>({ status: 'loading' });
  const [history, setHistory] = useState<EditorHistory>(EMPTY_HISTORY);
  const [tool, setTool] = useState<ScreenshotEditTool>('box');
  const [color, setColor] = useState<ScreenshotEditColor>(SCREENSHOT_EDIT_COLORS[0]);
  const [filled, setFilled] = useState(false);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<EditorStep | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLElement>(null);
  const dragFrom = useRef<ScreenshotEditPoint | null>(null);

  useEffect(() => {
    let live = true;
    ipc.screenshots.image
      .query({ id: entry.id, size: 'preview' })
      .then((src) => {
        if (!live) return;
        if (src === null) return setPreview({ status: 'missing' });
        const image = new Image();
        image.onload = () => live && setPreview({ status: 'ready', image });
        image.onerror = () => live && setPreview({ status: 'missing' });
        image.src = src;
      })
      .catch(() => live && setPreview({ status: 'missing' }));
    root.current?.focus();
    return () => {
      live = false;
    };
  }, [entry.id]);

  const scale = preview.status === 'ready' ? previewScale(entry, { width: preview.image.naturalWidth, height: preview.image.naturalHeight }) : 1;
  const shown = useMemo(() => editOf(draft === null ? history : { steps: [...history.steps, draft], undone: [] }), [history, draft]);
  const fits = overlayFits(overlaySize(entry, editOf(history).crop));

  // Draws the preview, the annotations (in screenshot pixels, scaled to the preview) and the crop.
  useEffect(() => {
    const el = canvas.current;
    if (!el || preview.status !== 'ready') return;
    const { image } = preview;
    if (el.width !== image.naturalWidth) el.width = image.naturalWidth;
    if (el.height !== image.naturalHeight) el.height = image.naturalHeight;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(image, 0, 0);
    ctx.save();
    ctx.scale(scale, scale);
    for (const op of shown.ops) drawOp(ctx as DrawContext, op);
    const { crop } = shown;
    if (crop !== null) {
      ctx.fillStyle = 'rgb(15 23 42 / 0.55)';
      ctx.fillRect(0, 0, entry.width, crop.y);
      ctx.fillRect(0, crop.y + crop.height, entry.width, entry.height - crop.y - crop.height);
      ctx.fillRect(0, crop.y, crop.x, crop.height);
      ctx.fillRect(crop.x + crop.width, crop.y, entry.width - crop.x - crop.width, crop.height);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, 1.5 / scale);
      ctx.setLineDash([6 / scale, 4 / scale]);
      ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
    }
    ctx.restore();
  }, [preview, shown, scale, entry.width, entry.height]);

  const say = (status: Outcome['status'], message: string) => setOutcome({ status, message });
  const commit = (step: EditorStep) => {
    const next = addStep(history, step);
    if (next === null) return say('full', SCREENSHOT_EDIT_FULL_NOTE);
    setHistory(next);
    setOutcome(null);
  };
  /** A pointer's position in the screenshot's pixels. */
  const pointOf = (event: PointerEvent<HTMLCanvasElement>): ScreenshotEditPoint => {
    const el = event.currentTarget;
    const box = el.getBoundingClientRect();
    const x = ((event.clientX - box.left) * el.width) / Math.max(1, box.width);
    const y = ((event.clientY - box.top) * el.height) / Math.max(1, box.height);
    return toSourcePoint({ x, y }, scale, entry);
  };
  const stepBetween = (from: ScreenshotEditPoint, to: ScreenshotEditPoint): EditorStep | null => {
    if (tool === 'arrow') return from.x === to.x && from.y === to.y ? null : { tool: 'arrow', color, size: opSizeFor('arrow', scale), from, to };
    const rect = rectBetween(from, to, entry);
    if (rect === null) return null;
    if (tool === 'crop') return { tool: 'crop', rect };
    return { tool: 'box', color, size: opSizeFor('box', scale), rect, filled };
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || preview.status !== 'ready') return;
    const at = pointOf(event);
    if (tool === 'text') {
      const value = text.trim();
      if (value === '') return say('no-text', 'Type the text first, then click where it goes.');
      return commit({ tool: 'text', color, size: opSizeFor('text', scale), at, text: value });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = at;
  };
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (dragFrom.current !== null) setDraft(stepBetween(dragFrom.current, pointOf(event)));
  };
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    setDraft(null);
    if (from === null) return;
    const step = stepBetween(from, pointOf(event));
    if (step !== null) commit(step);
  };

  const save = async () => {
    if (saving) return;
    const edit = editOf(history);
    const overlay = renderOverlay(entry, edit, makeCanvas);
    if (overlay.status === 'too-big') return say('too-big', SCREENSHOT_EDIT_TOO_BIG_NOTE);
    if (overlay.status === 'too-large') return say('too-large', SCREENSHOT_EDIT_RESULT_MESSAGES['too-large']);
    if (overlay.status === 'failed') return say('invalid', SCREENSHOT_EDIT_RESULT_MESSAGES.invalid);
    setSaving(true);
    setOutcome(null);
    const answer = await ipc.screenshots.saveEdit.mutate({ sourceId: entry.id, crop: edit.crop, overlay: overlay.overlay, ops: edit.ops }).catch(() => null);
    setSaving(false);
    const status: ScreenshotEditResult = answer?.status ?? 'store-failed';
    say(status, SCREENSHOT_EDIT_RESULT_MESSAGES[status]);
    if (status === 'saved') notifyScreenshotEdited();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeScreenshotEditor();
      return;
    }
    // In the text field, its own undo.
    if (event.target instanceof HTMLInputElement) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      setHistory(event.shiftKey ? redo(history) : undo(history));
    } else if (mod && key === 'y') {
      event.preventDefault();
      setHistory(redo(history));
    }
  };

  return (
    <section ref={root} className="shot-editor-sheet" data-testid="screenshot-editor" data-state={preview.status} aria-label="Edit screenshot" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="shot-editor">
        <header className="shot-editor-head">
          <h2 className="shot-editor-title">Edit screenshot</h2>
          <span className="shot-editor-hint">Saves a new screenshot; the original stays as it is.</span>
          <button type="button" className="panel-button" data-testid="screenshot-editor-close" onClick={closeScreenshotEditor}>
            Close
          </button>
        </header>
        <div className="shot-editor-tools" role="toolbar" aria-label="Annotation tools">
          <div className="seo-segmented shot-editor-tool-group" role="group" aria-label="Tool">
            {SCREENSHOT_EDIT_TOOLS.map((each) => (
              <button key={each} type="button" className="seo-segment" data-testid={`screenshot-editor-tool-${each}`} aria-pressed={tool === each} onClick={() => setTool(each)}>
                {SCREENSHOT_EDIT_TOOL_LABELS[each]}
              </button>
            ))}
          </div>
          <div className="shot-editor-swatches" role="group" aria-label="Colour">
            {SCREENSHOT_EDIT_COLORS.map((each) => (
              <button key={each} type="button" className="shot-editor-swatch" data-color={each} data-testid="screenshot-editor-color" aria-label={SCREENSHOT_EDIT_COLOR_LABELS[each]} title={SCREENSHOT_EDIT_COLOR_LABELS[each]} aria-pressed={color === each} onClick={() => setColor(each)}>
                <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                  <circle cx="10" cy="10" r="9" fill={each} stroke="currentColor" strokeWidth="1" />
                </svg>
              </button>
            ))}
          </div>
          {tool === 'box' ? (
            <label className="shot-editor-check">
              <input type="checkbox" data-testid="screenshot-editor-filled" checked={filled} onChange={(event) => setFilled(event.currentTarget.checked)} />
              Filled
            </label>
          ) : null}
          {tool === 'text' ? (
            <input
              className="shot-editor-text"
              data-testid="screenshot-editor-text"
              type="text"
              placeholder="Text, then click the image"
              aria-label="Annotation text"
              maxLength={SCREENSHOT_EDIT_LIMITS.maxTextChars}
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
            />
          ) : null}
          <span className="shot-editor-actions">
            <button type="button" className="seo-action" data-testid="screenshot-editor-undo" disabled={!canUndo(history)} onClick={() => setHistory(undo(history))}>
              Undo
            </button>
            <button type="button" className="seo-action" data-testid="screenshot-editor-redo" disabled={!canRedo(history)} onClick={() => setHistory(redo(history))}>
              Redo
            </button>
            {editOf(history).crop !== null ? (
              <button type="button" className="seo-action" data-testid="screenshot-editor-uncrop" onClick={() => commit({ tool: 'crop', rect: null })}>
                Clear crop
              </button>
            ) : null}
            <button type="button" className="panel-button shot-editor-save" data-testid="screenshot-editor-save" data-busy={saving} disabled={saving || preview.status !== 'ready'} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save as a copy'}
            </button>
          </span>
        </div>
        <p className="changes-note shot-editor-status" role="status" aria-live="polite" data-testid="screenshot-editor-status" data-outcome={outcome?.status ?? ''}>
          {outcome?.message ?? (fits ? '' : SCREENSHOT_EDIT_TOO_BIG_NOTE)}
        </p>
        <div className="shot-editor-stage">
          {preview.status === 'ready' ? (
            <canvas
              ref={canvas}
              className="shot-editor-canvas"
              data-testid="screenshot-editor-canvas"
              data-tool={tool}
              data-scale={scale}
              role="img"
              aria-label={screenshotAlt(entry)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                dragFrom.current = null;
                setDraft(null);
              }}
            />
          ) : (
            <p className="seo-empty-line">{preview.status === 'loading' ? 'Loading the screenshot…' : 'The image is no longer available.'}</p>
          )}
        </div>
      </div>
    </section>
  );
}
