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

/**
 * A browsed page never drags the window (`tabs.feature.md`, Dragging). Without a native title bar
 * Electron takes drag regions from every WebContentsView of the window, a tab's page view included
 * (`WebContentsView::NonClientHitTest`, Electron 45), so a page that styles `app-region: drag` would
 * move the window and lose its own clicks there. Each tab view's main-frame document gets this style
 * sheet in the user origin, where `!important` beats the page's own; child frames give Electron no
 * regions.
 */
export const PAGE_NO_DRAG_CSS = '*, *::before, *::after, *::backdrop { app-region: no-drag !important; }';

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
