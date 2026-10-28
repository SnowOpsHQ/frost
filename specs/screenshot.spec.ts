/**
 * Screenshots of a tab's page (Phase 6 Task 5; acceptance `screenshot.feature.md`; storage is the
 * `ci_screenshots` table of `capture-db.spec.ts`). Plain values and types with no Zod, so the chrome
 * renderer can use them; the Zod schemas of the procedures' inputs and answers are
 * `screenshot.schema.ts` (main and the IPC contract), each `satisfies` a type here.
 *
 * A screenshot is taken by main from the tab's own WebContents (`capturePage`): the visible viewport,
 * the whole page (stitched from viewport captures while the page is scrolled), or an area the user
 * drags out on the page. The scripts that read the page's size, scroll it and draw the area selector
 * run only in `SCREENSHOT_WORLD_ID`. The PNG is written under the profile directory and named by its
 * own SHA-256; no procedure ever takes a path, a file name or a hash.
 */
import type { ScreenshotKind } from './capture-db.spec';
import type { SearchParams } from './capture-search-params.schema';
import type { RenderProfile } from './render-profile.spec';

/**
 * The isolated world the screenshot scripts run in (measure, scroll and settle, restore the scroll,
 * the area selector and its cancel). Phase 6 owns `1_600`–`1_602`; no other script uses this one.
 */
export const SCREENSHOT_WORLD_ID = 1_601;

/**
 * The directory in `<userData>/<CAPTURES_DIR_NAME>` (`capture-db.spec.ts`) holding screenshot files,
 * each named `<sha256>.png`. Created `0700`; files `0600`.
 */
export const SCREENSHOTS_DIR_NAME = 'screenshots' as const;

/** The bounds of a screenshot, its stored file and the images the chrome is shown. */
export const SCREENSHOT_LIMITS = {
  /** Tallest stitched full page, in device pixels; a taller page is cut there (`truncated`). */
  maxStitchedHeightPx: 16_384,
  /** Most pixels (width × height, device pixels) in one stitched full page; past it the page is cut (`truncated`). */
  maxPixels: 64_000_000,
  /** Most viewport captures one full page is stitched from; past them the page is cut (`truncated`). */
  maxSegments: 40,
  /** Largest PNG kept (bytes); a larger one is refused (`too-large`), and nothing is written. */
  maxPngBytes: 50 * 1_024 * 1_024,
  /** Animation frames a full page waits for after each scroll before the segment is captured. */
  segmentSettleFrames: 2,
  /** Longest wait for one scroll to settle (ms); past it the segment is captured as it is. */
  segmentTimeoutMs: 3_000,
  /** Longest a whole full-page screenshot may take (ms); past it, it fails (`capture-failed`) and the scroll is restored. */
  fullPageDeadlineMs: 30_000,
  /** Longest an area selection waits for the user's drag (ms); past it, it is cancelled. */
  areaTimeoutMs: 60_000,
  /** Smallest selected area's width and height (CSS px); a smaller drag (a click) selects nothing and the selection goes on. */
  minAreaCssPx: 4,
  /** Width of a gallery thumbnail (px); never upscaled. */
  thumbWidth: 320,
  /** Tallest gallery thumbnail (px): a taller shot's thumbnail shows its top only. */
  thumbMaxHeight: 480,
  /** Widest preview (px); a larger shot is scaled down to fit, never up. */
  previewMaxWidth: 1_600,
  /** Tallest preview (px); a larger shot is scaled down to fit, never up. */
  previewMaxHeight: 4_000,
  /** The preview's JPEG quality (0–100). */
  previewJpegQuality: 82,
} as const;
/** `SCREENSHOT_LIMITS`' shape, any values (tests use tighter ones). */
export type ScreenshotLimits = { readonly [K in keyof typeof SCREENSHOT_LIMITS]: number };

/**
 * Why a screenshot was not taken (`TakeScreenshotAnswer`):
 * - `no-tab`: the id names no open tab (or the tab has no page view);
 * - `not-active`: only the tab in front is captured;
 * - `no-page`: the tab shows no web page (`http(s)`);
 * - `busy`: a screenshot of this tab is already being taken;
 * - `cancelled`: the area selection ended without an area (Esc, Cancel, its timeout), or while the
 *   screenshot was taken the page navigated, the tab closed or another tab was brought to the front;
 * - `too-large`: the PNG is over `maxPngBytes`;
 * - `capture-failed`: the page could not be captured, measured or scrolled, or the full page ran
 *   past its deadline;
 * - `store-failed`: the file or its row could not be written;
 * - `no-project`: the project does not exist or was deleted.
 */
export const SCREENSHOT_REFUSALS = ['no-tab', 'not-active', 'no-page', 'busy', 'cancelled', 'too-large', 'capture-failed', 'store-failed', 'no-project'] as const;
export type ScreenshotRefusal = (typeof SCREENSHOT_REFUSALS)[number];

/** How the Changes panel explains a refusal (frost's own wording). */
export const SCREENSHOT_REFUSAL_MESSAGES: Readonly<Record<ScreenshotRefusal, string>> = {
  'no-tab': 'That tab is no longer open.',
  'not-active': 'Only the tab in front can be captured.',
  'no-page': 'Open a web page to take a screenshot of it.',
  busy: 'A screenshot of this page is already being taken.',
  cancelled: 'Screenshot cancelled.',
  'too-large': 'This screenshot is too large to keep.',
  'capture-failed': 'The page could not be captured. Reload it and try again.',
  'store-failed': 'The screenshot could not be saved.',
  'no-project': 'That project no longer exists.',
};

/** Said beside Full page: the page is scrolled to be captured, and the page itself can tell. */
export const FULL_PAGE_SCROLL_NOTE = 'Full page scrolls the page to capture it; the page can see the scrolling.';

/** Shown while an area is being selected on the page. */
export const AREA_SELECT_HINT = 'Drag on the page to select an area · Esc to cancel';

/** How each kind is named (buttons, gallery entries, palette actions). */
export const SCREENSHOT_KIND_LABELS: Readonly<Record<ScreenshotKind, string>> = {
  viewport: 'Viewport',
  full: 'Full page',
  area: 'Area',
};

/** The two images of a stored screenshot the chrome can ask for: a gallery thumbnail and a larger preview. */
export const SCREENSHOT_IMAGE_SIZES = ['thumb', 'preview'] as const;
export type ScreenshotImageSize = (typeof SCREENSHOT_IMAGE_SIZES)[number];

// ---- Inputs ------------------------------------------------------------------------------------

/** `screenshots.take`: the tab (it must be the active one), the kind, and the project (default Unfiled). */
export interface TakeScreenshotInput {
  tabId: number;
  kind: ScreenshotKind;
  projectId?: string;
}

/** Where a newest-first page of screenshots continues: after this one. */
export interface ScreenshotsCursor {
  createdAt: number;
  id: string;
}

/** `screenshots.list`: screenshots of a page and/or a project (either may be left out), newest first. */
export interface ScreenshotsInput {
  url?: string;
  projectId?: string;
  cursor?: ScreenshotsCursor;
  limit?: number;
}

/** `screenshots.image`: one stored screenshot's thumbnail or preview. */
export interface ScreenshotImageInput {
  id: string;
  size: ScreenshotImageSize;
}

/** `screenshots.reveal` and `screenshots.copy`: one stored screenshot, by its row id. */
export interface ScreenshotIdInput {
  id: string;
}

/** `screenshots.cancelArea`: ends the tab's pending area selection. */
export interface CancelAreaInput {
  tabId: number;
}

// ---- Answers -----------------------------------------------------------------------------------

/** An `area` screenshot's selected rectangle, in CSS px of the page's viewport (whole pixels). */
export interface ScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A screenshot: saved (its row id, kind, pixel size, PNG bytes, and `truncated` when a full page was
 * cut at a cap), or refused.
 */
export type TakeScreenshotAnswer =
  | { status: 'saved'; id: string; kind: ScreenshotKind; width: number; height: number; bytes: number; truncated: boolean }
  | { status: 'refused'; reason: ScreenshotRefusal };

/** One stored screenshot as the chrome and the read API see it: no path, no file name, no hash. */
export interface ScreenshotEntry {
  id: string;
  projectId: string;
  pageUrl: string;
  /** The capture (Task 6's capture run) it was taken with; `null` for one the user took. */
  captureId: string | null;
  kind: ScreenshotKind;
  /** The selected area of an `area` screenshot; `null` for the other kinds. */
  rect: ScreenshotRect | null;
  width: number;
  height: number;
  /** The PNG file's size. */
  bytes: number;
  /** Viewport captures it is made of (1 but for a full page). */
  segments: number;
  renderProfile: RenderProfile | null;
  searchParams: SearchParams | null;
  createdAt: number;
}

export interface ScreenshotsAnswer {
  screenshots: ScreenshotEntry[];
  next: ScreenshotsCursor | null;
}

/** A `data:image/png;base64,…` or `data:image/jpeg;base64,…` URL, or `null` (no such screenshot, or its file is missing or does not match its hash). */
export type ScreenshotImageAnswer = string | null;
