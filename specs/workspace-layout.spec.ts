/**
 * The workspace's layout: how the SEO rail and sheet, the page card and the agent panel sit in the
 * window (Signal step 3, the last surface; acceptance `workspace-layout.feature.md`). Plain values with
 * no Zod and no imports beyond the Zod-free layout specs, so the chrome renderer and main import them
 * as they are (strict Trusted Types).
 *
 * The approved canvas draws the workspace as floating sheets: rounded cards (`--r-lg`) on the
 * window's `--bg-window`, `--space-3` apart and `--space-3` in from the window's left and right edges,
 * with no rules between them. The page is a native view (`WebContentsView`) laid over the page card's
 * box; main rounds its corners with `View.setBorderRadius()` to the card's radius (`pageViewRadius`).
 */
import { AGENT_RAIL_WIDTH } from './agent-panel.spec';
import { RENDER_FRAME } from './render-profile.spec';
import { PAGE_MIN_WIDTH, SIDEBAR_PANEL_WIDTH_RANGE, SIDEBAR_RAIL_WIDTH } from './seo-sidebar.spec';
import { CHROME_MIN_CONTENT_WIDTH_PX } from './tabs.spec';

/**
 * The space between two sheets of the workspace, and between the outer sheets and the window's left
 * and right edges: `--space-3`. The chrome row above and the status bar below already leave room, so
 * there is none at the top or the bottom (as on the canvas).
 */
export const WORKSPACE_GAP = { token: '--space-3', px: 8 } as const;

/**
 * The gap and inset in a workspace too narrow for the SEO sheet at its minimum (`workspace-layout.feature.md`,
 * A narrow window): `--space-1`.
 */
export const WORKSPACE_GAP_TIGHT = { token: '--space-1', px: 4 } as const;

/**
 * Below this width of the workspace (CSS px; the `chrome` container, the window's content width,
 * which the workspace's stack spans), the gaps and inset are `WORKSPACE_GAP_TIGHT`: with `WORKSPACE_GAP`
 * there and the agent collapsed, the SEO sheet would fall under its minimum beside the page's
 * (2 insets + the SEO rail + 3 gaps + the sheet's minimum + the page's + the agent's rail: 748).
 * One rule: `@container chrome (width < 748px)`.
 */
export const TIGHT_WORKSPACE_BELOW = 2 * WORKSPACE_GAP.px + SIDEBAR_RAIL_WIDTH + 3 * WORKSPACE_GAP.px + SIDEBAR_PANEL_WIDTH_RANGE.min + PAGE_MIN_WIDTH + AGENT_RAIL_WIDTH;

/** The gap and inset (CSS px) in a workspace `width` wide. */
export function workspaceGap(width: number): number {
  return width < TIGHT_WORKSPACE_BELOW ? WORKSPACE_GAP_TIGHT.px : WORKSPACE_GAP.px;
}

/** Every sheet's corner, and so the page card's and the native page view's: `--r-lg` ("sheets, rail, page card, palette"). */
export const SHEET_RADIUS = { token: '--r-lg', px: 16 } as const;

/**
 * What the workspace row spends on anything but the page and the open panels' own widths, inside the
 * workspace's inset (the row's measured width, `sidebar-layout.ts`): the SEO rail, the collapsed agent
 * panel's rail, and the gaps between the row's sheets (the SEO rail | the SEO sheet while it is open,
 * the SEO sidebar | the page column, the page column | the agent panel). The sheets' edges are inside
 * their own widths, so nothing else is counted.
 */
export function workspaceRowChrome(open: { readonly sidebar: boolean; readonly agent: boolean }, gap: number = WORKSPACE_GAP.px): number {
  const gaps = open.sidebar ? 3 : 2;
  return SIDEBAR_RAIL_WIDTH + (open.agent ? 0 : AGENT_RAIL_WIDTH) + gaps * gap;
}

/** The workspace row's width in a window `contentWidth` CSS px wide: the window less the inset on either side. */
export function workspaceRowWidth(contentWidth: number): number {
  return contentWidth - 2 * workspaceGap(contentWidth);
}

/**
 * The radius main gives the tab's native view (`View.setBorderRadius`, in CSS px), so its corners are
 * the page card's:
 * - HTML fullscreen: the view fills the window, so it has no corner (0);
 * - a render profile's page-area frame: the view sits `RENDER_FRAME.inset` inside the card, so its
 *   corner is the card's less that inset, concentric with the card's at the bottom (Electron gives a
 *   view one radius for all four corners; the top two sit under the frame's header);
 * - otherwise the card's own (`SHEET_RADIUS`).
 */
export function pageViewRadius(view: { readonly fullscreen: boolean; readonly framed: boolean }): number {
  if (view.fullscreen) return 0;
  return view.framed ? SHEET_RADIUS.px - RENDER_FRAME.inset : SHEET_RADIUS.px;
}

/**
 * The device outline a framed device preset draws around its view (`render-profile-view.ts`, one
 * pixel outside it): its corner is the framed view's, grown by that pixel.
 */
export const RENDER_DEVICE_OUTLINE_RADIUS = SHEET_RADIUS.px - RENDER_FRAME.inset + 1;

/**
 * The sheets of the workspace and how each is drawn: its fill, its elevation and the edge forced
 * colours draw (they drop box-shadows and repaint fills). `border`: a transparent 1px border inside
 * the sheet's own width; `outline`: a transparent 1px outline outside its box, for the page card
 * (whose box the native view covers, border and all) and the sheets that fill the page column in its
 * place. Every sheet has `SHEET_RADIUS` corners and clips its content to them, but the agent rail
 * (`clips: false`): it holds only its toggle, which never reaches its corners, and the toggle's 4px
 * focus ring reaches past the rail's 38px content box (a 34px control), so clipping would cut it.
 *
 * `stylesheet` is where the sheet's fill is declared; the shape (radius, elevation, edge) of the page
 * column's sheets is one rule in `styles.css`. A fill is a Signal surface token, never a legacy alias
 * (the page card and Help's frame read `--bg-page` and the agent panel `--agent-bg` until the base
 * face's PR, specs/design-tokens.feature.md, which `removed` both).
 */
export interface WorkspaceSheet {
  readonly name: string;
  readonly selector: string;
  readonly stylesheet: string;
  readonly fill: '--bg-sheet' | '--bg-surface';
  readonly elevation: '--e-sheet' | '--e-ring';
  readonly edge: 'border' | 'outline';
  readonly clips?: false;
}

export const WORKSPACE_SHEETS = [
  { name: 'SEO rail', selector: '.seo-rail', stylesheet: 'styles.css', fill: '--bg-sheet', elevation: '--e-sheet', edge: 'border' },
  { name: 'SEO sheet', selector: '.seo-panel', stylesheet: 'styles.css', fill: '--bg-sheet', elevation: '--e-sheet', edge: 'border' },
  { name: 'page card', selector: '.page-area', stylesheet: 'styles.css', fill: '--bg-surface', elevation: '--e-ring', edge: 'outline' },
  { name: 'agent rail', selector: '.agent-rail', stylesheet: 'components/agent/agent.css', fill: '--bg-sheet', elevation: '--e-sheet', edge: 'border', clips: false },
  { name: 'agent panel', selector: '.agent-main', stylesheet: 'components/agent/agent.css', fill: '--bg-sheet', elevation: '--e-sheet', edge: 'border' },
  { name: 'DevTools drawer', selector: '.devtools', stylesheet: 'styles.css', fill: '--bg-sheet', elevation: '--e-sheet', edge: 'border' },
  { name: 'History', selector: '.history-sheet', stylesheet: 'styles.css', fill: '--bg-surface', elevation: '--e-ring', edge: 'outline' },
  { name: 'Projects', selector: '.projects-sheet', stylesheet: 'styles.css', fill: '--bg-surface', elevation: '--e-ring', edge: 'outline' },
  { name: 'screenshot editor', selector: '.shot-editor-sheet', stylesheet: 'styles.css', fill: '--bg-surface', elevation: '--e-ring', edge: 'outline' },
  { name: 'Settings', selector: '.settings-sheet', stylesheet: 'settings.css', fill: '--bg-sheet', elevation: '--e-ring', edge: 'outline' },
  { name: 'Help, Crawl and AI answers', selector: '.help-sheet', stylesheet: 'help.css', fill: '--bg-surface', elevation: '--e-ring', edge: 'outline' },
] as const satisfies readonly WorkspaceSheet[];

/**
 * The rules that collapse the page area while a sheet fills the page column (`height: 0`). Each also
 * hides it (`visibility: hidden`), or its ring and edge would draw a line along the column's foot.
 */
export const PAGE_AREA_COLLAPSES = [
  { stylesheet: 'styles.css', selector: ".page-column[data-history='open'] > .page-area" },
  { stylesheet: 'styles.css', selector: '.page-column:has(> .projects-sheet) > .page-area' },
  { stylesheet: 'styles.css', selector: '.page-column:has(> .shot-editor-sheet) > .page-area' },
  { stylesheet: 'settings.css', selector: '.page-column:has(> .settings-sheet) > .page-area' },
  { stylesheet: 'help.css', selector: '.page-column:has(> .help-sheet) > .page-area' },
] as const;

/**
 * A narrow window (`workspace-layout.feature.md`, A narrow window): the window's minimum content width (CSS px,
 * `CHROME_MIN_CONTENT_WIDTH_PX`, 588) and, there, the SEO sheet's width with the agent collapsed (the row less the
 * page's minimum and `workspaceRowChrome`, with the tight gaps: 160). Below the panel's minimum the SEO body's padding is
 * `SEO_BODY_NARROW_PADDING`; the query is on the panel's content box, inside its 1px border.
 */
export const NARROW_WINDOW = {
  width: CHROME_MIN_CONTENT_WIDTH_PX,
  seoSheet: workspaceRowWidth(CHROME_MIN_CONTENT_WIDTH_PX) - PAGE_MIN_WIDTH - workspaceRowChrome({ sidebar: true, agent: false }, workspaceGap(CHROME_MIN_CONTENT_WIDTH_PX)),
} as const;
export const SEO_BODY_NARROW_PADDING = { token: '--space-1', belowContentWidth: SIDEBAR_PANEL_WIDTH_RANGE.min - 2 } as const;

/**
 * What wraps under the panel's minimum (the `seo-panel` query; `workspace-layout.feature.md`, A narrow
 * window): each rule's selector, the stylesheet that holds it, and the declarations it takes there.
 */
export const NARROW_PANEL_WRAPS = [
  { stylesheet: 'styles.css', selector: '.seo-score-card', set: { 'flex-direction': 'column', 'align-items': 'flex-start' } },
  { stylesheet: 'ai-readiness.css', selector: '.ai-score', set: { 'flex-direction': 'column', 'align-items': 'flex-start' } },
  { stylesheet: 'styles.css', selector: '.seo-section-head', set: { 'flex-wrap': 'wrap' } },
  { stylesheet: 'styles.css', selector: '.seo-toggle', set: { height: 'auto', 'min-height': 'var(--h-chip)', 'white-space': 'normal' } },
  { stylesheet: 'styles.css', selector: '.seo-action', set: { height: 'auto', 'min-height': 'var(--h-chip)', 'white-space': 'normal' } },
] as const;
