import { useEffect, useId, useRef, useState } from 'react';
import type { TabState } from '@app/specs/browser.spec';
import { MAX_HISTORY_PAGE, type ScreenshotKind } from '@app/specs/capture-db.spec';
import { AREA_SELECT_HINT, FULL_PAGE_SCROLL_NOTE, type ScreenshotEntry, type ScreenshotsCursor, type TakeScreenshotAnswer } from '@app/specs/screenshot.spec';
import { SCREENSHOTS_PAGE_SIZE, canScreenshot, countBadge, formatBytes, laneLabel, pixelSizeText, screenshotAlt, screenshotInput, screenshotKindLabel } from '../../changes-view';
import { ReloadIcon } from '../../icons';
import { ipc } from '../../ipc';
import { useProjectsGeneration } from './projects-sheet';
import { onScreenshotFinished, runScreenshot, useScreenshotRun } from './screenshot-runs';

// Screenshots in the Changes panel (acceptance `screenshot.feature.md`, The Changes panel): the
// Screenshot group (Viewport, Full page, Select area, with the full page's scrolling note and the
// area selection's Cancel; what runs is per tab, `screenshot-runs.ts`), and the page's gallery. Images are `data:` URLs main makes from the
// stored file (`screenshots.image`); a screenshot is only ever named by its row id. No inline styles
// (strict CSP).

/** `screenshots.take` of `tabId` (into `projectId`, Unfiled when `undefined`); `null` on an IPC failure. */
export const takeScreenshot = (tabId: number, kind: ScreenshotKind, projectId?: string): Promise<TakeScreenshotAnswer | null> =>
  ipc.screenshots.take.mutate(screenshotInput(tabId, kind, projectId)).catch(() => null);

const KINDS: readonly { readonly kind: ScreenshotKind; readonly label: string }[] = [
  { kind: 'viewport', label: 'Viewport' },
  { kind: 'full', label: 'Full page' },
  { kind: 'area', label: 'Select area' },
];

/** Takes a screenshot through the tab's run (`screenshot-runs.ts`): the panel and the palette both start them here. */
export const startScreenshot = (tabId: number, kind: ScreenshotKind, projectId?: string): Promise<TakeScreenshotAnswer | null> =>
  runScreenshot((id, which) => takeScreenshot(id, which, projectId), tabId, kind);

/**
 * The Screenshot group. `announce` gets each outcome (`undefined` as one starts here) for the panel's
 * live region; `saved` is called after a screenshot was saved (the gallery reads again). What runs
 * is the tab's (`useScreenshotRun`), wherever it was started, so a remounted panel still shows the
 * area's Cancel and announces the outcome.
 */
export function ScreenshotControls({ tab, projectId, announce, saved }: {
  readonly tab: TabState;
  readonly projectId: string | undefined;
  readonly announce: (answer: TakeScreenshotAnswer | null | undefined) => void;
  readonly saved: () => void;
}) {
  const tabId = tab.id;
  const running = useScreenshotRun(tabId);
  const labelId = useId();
  const noteId = useId();
  // The latest callbacks, so the listener is set up once per tab.
  const latest = useRef({ announce, saved });
  latest.current = { announce, saved };
  useEffect(
    () =>
      onScreenshotFinished((finishedTab, answer) => {
        if (finishedTab !== tabId) return;
        latest.current.announce(answer);
        if (answer?.status === 'saved') latest.current.saved();
      }),
    [tabId],
  );

  const take = (kind: ScreenshotKind) => {
    announce(undefined);
    void startScreenshot(tabId, kind, projectId);
  };
  const enabled = canScreenshot(tab) && running === null;

  return (
    <div className="changes-shot" data-testid="screenshot-controls" data-running={running ?? ''}>
      <div className="changes-shot-row" role="group" aria-labelledby={labelId}>
        <span className="changes-shot-label" id={labelId}>
          Screenshot
        </span>
        <div className="seo-segmented changes-shot-kinds">
          {KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              className="seo-segment changes-shot-kind-button"
              data-testid={`screenshot-${kind}`}
              data-busy={running === kind}
              disabled={!enabled}
              // The full page's note is said with it, and shown below.
              title={kind === 'full' ? FULL_PAGE_SCROLL_NOTE : undefined}
              aria-describedby={kind === 'full' ? noteId : undefined}
              onClick={() => take(kind)}
            >
              {running === kind && kind !== 'area' ? 'Saving…' : label}
            </button>
          ))}
        </div>
      </div>
      <p className="changes-note changes-shot-note" id={noteId} data-testid="screenshot-full-note">
        {FULL_PAGE_SCROLL_NOTE}
      </p>
      {running === 'area' ? (
        <div className="changes-shot-selecting" role="status" aria-live="polite" data-testid="screenshot-area-hint">
          <span>{AREA_SELECT_HINT}</span>
          <button type="button" className="seo-action" data-testid="screenshot-area-cancel" onClick={() => void ipc.screenshots.cancelArea.mutate({ tabId }).catch(() => false)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A screenshot's time, to the minute. */
const shotTime = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type ImageState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly src: string } | { readonly status: 'missing' };

/** `screenshots.image` of `id` at `size` while `wanted`; `missing` when main has none (the file is gone or changed). */
function useImage(id: string, size: 'thumb' | 'preview', wanted: boolean): ImageState {
  const [state, setState] = useState<ImageState>({ status: 'loading' });
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    setState({ status: 'loading' });
    ipc.screenshots.image
      .query({ id, size })
      .then((src) => live && setState(src === null ? { status: 'missing' } : { status: 'ready', src }))
      .catch(() => live && setState({ status: 'missing' }));
    return () => {
      live = false;
    };
  }, [id, size, wanted]);
  return state;
}

function ScreenshotItem({ entry }: { readonly entry: ScreenshotEntry }) {
  const thumb = useImage(entry.id, 'thumb', true);
  const [previewing, setPreviewing] = useState(false);
  const preview = useImage(entry.id, 'preview', previewing);
  const [note, setNote] = useState<string | null>(null);
  const alt = screenshotAlt(entry);
  const reveal = async () => setNote((await ipc.screenshots.reveal.mutate({ id: entry.id }).catch(() => false)) ? null : 'The file is no longer there.');
  const copy = async () => setNote((await ipc.screenshots.copy.mutate({ id: entry.id }).catch(() => false)) ? 'Image copied.' : 'The image could not be copied.');
  return (
    <li className="changes-shot-item" data-testid="screenshot" data-id={entry.id} data-kind={entry.kind}>
      <div className="changes-shot-thumb" data-state={thumb.status}>
        {thumb.status === 'ready' ? <img src={thumb.src} alt={alt} data-testid="screenshot-thumb" /> : <span className="changes-shot-missing">{thumb.status === 'loading' ? 'Loading…' : 'Image unavailable'}</span>}
      </div>
      <div className="changes-shot-meta">
        <span className="changes-shot-head">
          <span className="changes-shot-kind" data-testid="screenshot-kind">
            {screenshotKindLabel(entry.kind)}
          </span>
          <span className="changes-shot-time">{shotTime(entry.createdAt)}</span>
        </span>
        <span className="changes-shot-size" data-testid="screenshot-size">
          {pixelSizeText(entry.width, entry.height)} · {formatBytes(entry.bytes)}
        </span>
        <span className="changes-shot-chips">
          <span className="seo-chip changes-shot-profile" data-testid="screenshot-profile">
            {laneLabel(entry)}
          </span>
        </span>
        <span className="changes-shot-actions">
          <button type="button" className="seo-action" data-testid="screenshot-preview-toggle" aria-expanded={previewing} onClick={() => setPreviewing(!previewing)}>
            {previewing ? 'Hide preview' : 'Preview'}
          </button>
          <button type="button" className="seo-action" data-testid="screenshot-reveal" onClick={() => void reveal()}>
            Reveal in folder
          </button>
          <button type="button" className="seo-action" data-testid="screenshot-copy" onClick={() => void copy()}>
            Copy image
          </button>
        </span>
        <span className="changes-note changes-shot-feedback" role="status" aria-live="polite" data-testid="screenshot-feedback">
          {note ?? ''}
        </span>
      </div>
      {previewing ? (
        <figure className="changes-shot-preview" data-testid="screenshot-preview" data-state={preview.status}>
          {preview.status === 'ready' ? <img src={preview.src} alt={alt} data-testid="screenshot-preview-image" /> : <p className="seo-empty-line">{preview.status === 'loading' ? 'Loading the preview…' : 'The image is no longer available.'}</p>}
          <button type="button" className="panel-button changes-shot-close" data-testid="screenshot-preview-close" onClick={() => setPreviewing(false)}>
            Close preview
          </button>
        </figure>
      ) : null}
    </li>
  );
}

type GalleryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly screenshots: readonly ScreenshotEntry[]; readonly next: ScreenshotsCursor | null; readonly loadingMore: boolean; readonly moreFailed: boolean };

/** The page's screenshots, newest first: read on mount and whenever `generation` changes (after a screenshot, as many as were listed and one more). */
export function ScreenshotGallery({ url, generation }: { readonly url: string; readonly generation: number }) {
  const [state, setState] = useState<GalleryState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const listed = useRef(0);
  // Read again when projects change: a delete or a purge (`Retention.tsx`) may have removed screenshots.
  const projects = useProjectsGeneration();
  listed.current = state.status === 'ready' ? state.screenshots.length : 0;
  useEffect(() => {
    let live = true;
    const limit = Math.min(MAX_HISTORY_PAGE, Math.max(SCREENSHOTS_PAGE_SIZE, listed.current + 1));
    ipc.screenshots.list
      .query({ url, limit })
      .then((answer) => live && setState({ status: 'ready', screenshots: answer.screenshots, next: answer.next, loadingMore: false, moreFailed: false }))
      .catch(() => live && setState({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [url, generation, attempt, projects]);
  const loadMore = () => {
    if (state.status !== 'ready' || state.next === null || state.loadingMore) return;
    const { next } = state;
    setState({ ...state, loadingMore: true, moreFailed: false });
    const settle = (change: (current: Extract<GalleryState, { status: 'ready' }>) => GalleryState) => setState((current) => (current.status === 'ready' && current.next === next ? change(current) : current));
    ipc.screenshots.list
      .query({ url, cursor: next, limit: SCREENSHOTS_PAGE_SIZE })
      .then((answer) =>
        settle((current) => {
          const seen = new Set(current.screenshots.map((shot) => shot.id));
          return { ...current, screenshots: [...current.screenshots, ...answer.screenshots.filter((shot) => !seen.has(shot.id))], next: answer.next, loadingMore: false };
        }),
      )
      .catch(() => settle((current) => ({ ...current, loadingMore: false, moreFailed: true })));
  };

  return (
    <section className="seo-section changes-shots" data-testid="screenshots" data-state={state.status}>
      <header className="seo-section-head">
        <h3 className="seo-section-title">Screenshots</h3>
        {state.status === 'ready' ? <span className="seo-badge">{countBadge(state.screenshots.length, state.next !== null)}</span> : null}
      </header>
      {state.status === 'loading' ? <p className="seo-empty-line">Reading this page’s screenshots…</p> : null}
      {state.status === 'error' ? (
        <div className="changes-error">
          <p className="seo-empty-line">The screenshots of this page could not be read.</p>
          <button type="button" className="panel-button" onClick={() => setAttempt((n) => n + 1)}>
            <ReloadIcon />
            <span>Retry</span>
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && state.screenshots.length === 0 ? (
        <p className="seo-empty-line" data-testid="screenshots-empty">
          No screenshots of this page yet. They are kept on this computer, in frost’s profile folder.
        </p>
      ) : null}
      {state.status === 'ready' && state.screenshots.length > 0 ? (
        <ul className="changes-shot-list" aria-label="Screenshots, newest first">
          {state.screenshots.map((entry) => (
            <ScreenshotItem key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : null}
      {state.status === 'ready' && state.next !== null ? (
        <button type="button" className="seo-action changes-load-more" data-testid="screenshots-load-more" data-busy={state.loadingMore} disabled={state.loadingMore} onClick={loadMore}>
          {state.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
      {state.status === 'ready' && state.moreFailed ? <p className="seo-empty-line">More screenshots could not be read.</p> : null}
    </section>
  );
}
