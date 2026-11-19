/**
 * The chrome row as the window's title bar (Acceptance: `tabs.feature.md`, The chrome row: the row is the
 * window's title bar). On macOS and Windows the window draws no title bar strip of its own: the chrome
 * row (`CHROME_ROW_HEIGHT_PX` high) is the title bar and the OS's window controls are drawn over its
 * ends; on Linux the window keeps its native frame. Zod-free, so main and the chrome can import it.
 *
 * Measured on CI's macOS 15 and Windows Server 2025 runners (1× displays) through Chromium's Window
 * Controls Overlay (`navigator.windowControlsOverlay.getTitlebarAreaRect()`, the `titlebar-area-*` CSS
 * environment variables), which the row's padding reads at run time; the numbers here size the
 * window's minimum only.
 */
import { CHROME_ROW_HEIGHT_PX } from './tabs.spec';

/** The platforms frost builds for (Node's `process.platform` names). */
export type TitleBarPlatform = 'darwin' | 'win32' | 'linux';

/** The row's own end padding, `--space-4` (CSS px), which the window controls' room replaces. */
export const CHROME_ROW_PADDING_PX = 12;

/**
 * macOS: where the traffic lights sit (Electron's `trafficLightPosition`, DIP from the window's top
 * left). Electron lays the three buttons (16px frames, 12px lights) out in a box `y` + 16 + `y` high
 * and `x` + 54 + `x` wide from the window's corner: `y` = 20 makes the box the row's 56px, so the lights
 * are centred in it, and `x` = 20 gives them as much room after as before.
 */
export const TRAFFIC_LIGHT_POSITION = { x: 20, y: 20 } as const;

/**
 * macOS: the traffic lights' zone at the row's start (CSS px): `TRAFFIC_LIGHT_POSITION.x` + the three
 * lights (54) + `TRAFFIC_LIGHT_POSITION.x` again, what the overlay's `titlebar-area-x` reports. Back starts
 * there (the row's start padding is this or `--space-4`, whichever is more).
 */
export const TRAFFIC_LIGHTS_ZONE_PX = 94;

/**
 * Windows: the width of the caption buttons (minimise, maximise, close) the overlay draws at the row's
 * end (CSS px at 1×: the window's width less the overlay's `titlebar-area-width`).
 */
export const CAPTION_BUTTONS_WIDTH_PX = 137;

/**
 * Windows: the free strip the row keeps between its last tool and the caption buttons (CSS px), room
 * to take hold of the window by its title bar beside its controls. It replaces the row's
 * `--space-4` at that end.
 */
export const WINDOW_DRAG_STRIP_PX = 40;

/** Windows: the overlay the caption buttons are drawn on is as tall as the row. */
export const TITLE_BAR_OVERLAY_HEIGHT_PX = CHROME_ROW_HEIGHT_PX;

/**
 * Windows: the overlay's colours, the row's own, one pair per theme: `color` is the row's background
 * (`--bg-window`) and `symbolColor` the tools' icons (`--text-muted`). `tokens.css` holds the same
 * values; a guard keeps them equal.
 */
export const TITLE_BAR_OVERLAY_COLOURS = {
  light: { color: '#ececee', symbolColor: '#52525b' },
  dark: { color: '#0f0f11', symbolColor: '#a1a1aa' },
} as const;

/** The overlay's colours for the OS theme (`nativeTheme.shouldUseDarkColors`). */
export function titleBarOverlayColours(dark: boolean): { readonly color: string; readonly symbolColor: string } {
  return dark ? TITLE_BAR_OVERLAY_COLOURS.dark : TITLE_BAR_OVERLAY_COLOURS.light;
}

/**
 * The window options that make the row the title bar on `platform`, spread into
 * `new BrowserWindow({…})`: on macOS the hidden title bar with the traffic lights placed and the overlay
 * on (its colours are Windows' and Linux's only), on Windows the hidden title bar and the overlay in the
 * theme's colours, on Linux none (its native frame stays). Never `frame`.
 */
export function titleBarWindowOptions(platform: TitleBarPlatform, dark: boolean): Readonly<Record<string, unknown>> {
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHT_POSITION, titleBarOverlay: true };
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { height: TITLE_BAR_OVERLAY_HEIGHT_PX, ...titleBarOverlayColours(dark) } };
  return {};
}

/** Whether the chrome row is the window's title bar on `platform` (the native one hidden): macOS and Windows. */
export function rowIsTitleBar(platform: TitleBarPlatform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * The parts of Chromium's built-in controls that a page's style sheet can reach (`::-webkit-…`): the
 * `pseudo` names of the user-agent shadow parts that every standard control renders in Chromium
 * 156.0.8078.48 (read over the DevTools protocol, `DOM.getDocument` with `pierce`), plus the slider's
 * and the media slider's thumb and container, the seconds and milliseconds fields and the text track's
 * boxes, which that page did not render. `-internal-…` parts are left out: only the browser's own sheet
 * can name them. Re-read the list when Electron's Chromium changes.
 */
export const PAGE_NO_DRAG_CONTROL_PARTS = [
  '-webkit-calendar-picker-indicator', '-webkit-color-swatch', '-webkit-color-swatch-wrapper',
  '-webkit-datetime-edit', '-webkit-datetime-edit-ampm-field', '-webkit-datetime-edit-day-field',
  '-webkit-datetime-edit-fields-wrapper', '-webkit-datetime-edit-hour-field',
  '-webkit-datetime-edit-millisecond-field', '-webkit-datetime-edit-minute-field',
  '-webkit-datetime-edit-month-field', '-webkit-datetime-edit-second-field', '-webkit-datetime-edit-text',
  '-webkit-datetime-edit-week-field', '-webkit-datetime-edit-year-field', '-webkit-details-marker',
  '-webkit-file-upload-button', '-webkit-inner-spin-button', '-webkit-input-placeholder', '-webkit-media-controls',
  '-webkit-media-controls-current-time-display', '-webkit-media-controls-enclosure',
  '-webkit-media-controls-fullscreen-button', '-webkit-media-controls-mute-button',
  '-webkit-media-controls-overlay-enclosure', '-webkit-media-controls-panel', '-webkit-media-controls-play-button',
  '-webkit-media-controls-time-remaining-display', '-webkit-media-controls-timeline',
  '-webkit-media-controls-toggle-closed-captions-button', '-webkit-media-controls-volume-control-container',
  '-webkit-media-controls-volume-control-hover-background', '-webkit-media-controls-volume-slider',
  '-webkit-media-slider-container', '-webkit-media-slider-thumb', '-webkit-media-text-track-container',
  '-webkit-media-text-track-display', '-webkit-meter-bar', '-webkit-meter-even-less-good-value',
  '-webkit-meter-inner-element', '-webkit-meter-optimum-value', '-webkit-meter-suboptimum-value',
  '-webkit-progress-bar', '-webkit-progress-inner-element', '-webkit-progress-value', '-webkit-search-cancel-button',
  '-webkit-slider-container', '-webkit-slider-runnable-track', '-webkit-slider-thumb',
  '-webkit-textfield-decoration-container',
] as const;

/** The standard pseudo-elements with a box of their own (`PAGE_NO_DRAG_SELECTORS`). */
const PAGE_NO_DRAG_STANDARD_SELECTORS = [
  '*',
  '*::before',
  '*::after',
  '*::backdrop',
  '*::placeholder',
  '*::file-selector-button',
  '*::details-content',
  '*::checkmark',
  '*::picker-icon',
  '*::picker(select)',
  '*::interest-button',
  '*::column',
  '*::column::scroll-marker',
  '*::scroll-button(*)',
  '*::scroll-marker',
  '*::scroll-marker-group',
  '::view-transition',
  '::view-transition-group(*)',
  '::view-transition-group-children(*)',
  '::view-transition-image-pair(*)',
  '::view-transition-old(*)',
  '::view-transition-new(*)',
] as const;

/**
 * A browsed page never drags the window (`tabs.feature.md`, Dragging). Without a native title bar
 * Electron takes drag regions from every WebContentsView of the window, a tab's page view included
 * (`WebContentsView::NonClientHitTest`, Electron 45, which has no switch per WebContents), so a page
 * that styles `app-region: drag` would move the window and lose its own clicks there. Where the row is
 * the title bar, each tab view's main-frame document gets `PAGE_NO_DRAG_CSS` in the user origin, where
 * `!important` beats the page's own (in shadow trees too); child frames give Electron no regions.
 *
 * The value is `initial` (no region at all), not `no-drag`: Blink sends a rectangle for every box whose
 * region is set, drag or not. The selectors are every element and each standard pseudo-element
 * Chromium 156 gives a box of its own and lets carry the property; a rule each, so one a later Chromium
 * drops cannot void the others. Left out on purpose: `::first-letter`, `::first-line` and `::marker`
 * (Chromium does not apply the property to them, and a universal `::first-letter` rule makes one in
 * every block, which splits its text). After them come the built-in controls' parts a page can style
 * (`PAGE_NO_DRAG_CONTROL_PARTS`). Known limit: a pseudo-element or a control part a later Chromium
 * adds is not covered until it is listed; a page that sets a drag region there only costs itself
 * those clicks.
 */
export const PAGE_NO_DRAG_SELECTORS: readonly string[] = [...PAGE_NO_DRAG_STANDARD_SELECTORS, ...PAGE_NO_DRAG_CONTROL_PARTS.map((part) => `*::${part}`)];

export const PAGE_NO_DRAG_CSS = PAGE_NO_DRAG_SELECTORS.map((selector) => `${selector} { app-region: initial !important; }`).join('\n');

/**
 * The room the chrome row gives the window's controls on `platform`, on top of
 * `CHROME_MIN_CONTENT_WIDTH_PX` (CSS px): the traffic lights' zone on macOS and the caption buttons with
 * the drag strip on Windows, each less the `--space-4` it replaces; 0 on Linux.
 */
export function chromeRowInset(platform: TitleBarPlatform): number {
  if (platform === 'darwin') return TRAFFIC_LIGHTS_ZONE_PX - CHROME_ROW_PADDING_PX;
  if (platform === 'win32') return CAPTION_BUTTONS_WIDTH_PX + WINDOW_DRAG_STRIP_PX - CHROME_ROW_PADDING_PX;
  return 0;
}
