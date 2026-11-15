# Feature: The workspace's layout (floating sheets)

Spec: `specs/workspace-layout.spec.ts` (`WORKSPACE_GAP`, `SHEET_RADIUS`, `workspaceRowChrome`,
`workspaceRowWidth`, `pageViewRadius`, `RENDER_DEVICE_OUTLINE_RADIUS`, `WORKSPACE_SHEETS`,
`PAGE_AREA_COLLAPSES`). Signal step 3, the last surface: how the pieces sit in the window, not their
interiors (`design-tokens.feature.md`). Source: the approved canvas's light and dark main screens, its
agent, Settings and palette screens, and its token sheet (`--r-lg`: "sheets, rail, page card,
palette"). Code: `apps/desktop/src/renderer/styles.css` (Layout, Workspace, Page area, SEO sidebar,
DevTools drawer, the sheets of the page column), `components/agent/agent.css`, `sidebar-layout.ts`,
`components/devtools/DevtoolsDrawer.tsx`, `render-profile-view.ts`; main:
`apps/desktop/src/main/browser/controller.ts` (`applyBounds`). Each line maps to one named test.

## Decisions
- **Floating sheets.** The workspace (between the chrome row, with any band under it, and the status
  bar) is the window's `--bg-window` holding rounded sheets, left to right: the SEO rail, the SEO
  sheet while the sidebar is open, the page column, and the agent panel (its rail when collapsed). The
  sheets are `WORKSPACE_GAP` (`--space-3`, 8px) apart and the same in from the window's left and
  right edges (the workspace's inline padding); none at the top (the chrome row's own room, or a
  band's `--space-3` margin under it) or at the bottom (the status bar's). The gaps replace the rules
  that ruled the pieces off: the workspace's top `--divider`, the sidebar's right edge, the panel's
  left edge, the agent panel's left edge, the status bar's top rule and the DevTools drawer's top
  edge are gone.
- **Sheets** (`WORKSPACE_SHEETS`): every one has `SHEET_RADIUS` (`--r-lg`) corners and clips its
  content to them (but the agent rail, whose one toggle never reaches its corners and whose focus
  ring reaches past its content box). The SEO rail, the SEO sheet, the agent rail, the open agent panel and the DevTools
  drawer are `--bg-sheet` (the agent's `--agent-bg`) with `--e-sheet` ("rail, sidebar, agent panel")
  and a transparent 1px border inside their own widths (forced colours drop the shadow and repaint
  the fill, and draw the border). The page card (`.page-area`) is `--bg-page` (`--bg-surface`) with
  `--e-ring`, as on the canvas; the sheets that fill the page column in its place (History, Projects,
  the screenshot editor, Settings, and Help's frame, which also holds Crawl and AI answers) keep their
  own fills and take the page card's shape: `--r-lg`, `--e-ring`. Their forced-colours edge is a
  transparent 1px **outline** outside the box: the native view covers the page card's whole box,
  border included, and a border would move the sheets' content. The SEO sidebar's and agent panel's
  wrappers (`.seo`, `.agent`) are plain flex boxes with no fill or edge of their own; the SEO sidebar
  holds its rail and sheet `WORKSPACE_GAP` apart. A rail's items keep their place inside its border
  (1px less padding). The collapsed agent rail is a sheet like the SEO rail (the canvas draws neither
  collapsed agent nor its rail), so its badge's halo is the sheet's fill.
- **The page card and the native view.** The tab's `WebContentsView` is laid over exactly the page
  card's box (the page area, as before: `setPageBounds`), with no gap and no overlap, and main rounds
  its corners to the card's: `pageViewRadius` through `View.setBorderRadius()` (Electron 45: one
  radius for all four corners, in DIPs, so it matches at 1× and 2×; on Linux, Windows and macOS). Main
  sets it with the view's bounds (`applyBounds`), so it follows every state: `SHEET_RADIUS` (16) in
  the workspace, 0 in HTML fullscreen (the view fills the window: no gap, no corner) and
  `SHEET_RADIUS − RENDER_FRAME.inset` (12) inside a render profile's page-area frame, concentric with
  the card at the bottom (the frame's inset band, its header and its art are HTML in the card, clipped
  to its corners; a device preset's outline follows the view's corner, `RENDER_DEVICE_OUTLINE_RADIUS`).
  The cut-out corners still take the page's clicks (Electron's note); they lie inside the card's box.
- **The card's box is reported whenever it changes.** The page area reports its box to main on
  every resize, and now also when it moves without changing size: in a window too narrow for the
  panels at their minimums the page is held at `PAGE_MIN_WIDTH`, so opening or collapsing a pane
  moves it sideways at one size. It observes the row's other sheets (the SEO sidebar, the agent
  panel) as well as itself. (Before, the view stayed where the card had been.)
- **Window chrome width.** Inside the workspace's inset the row spends `workspaceRowChrome` on
  anything but the page and the open panels (the two rails and two gaps, a third gap while the SEO
  sheet is open). `sidebar-layout.ts` counts it where it counted the two 1px edges, so each panel
  still gives way before the page goes under `PAGE_MIN_WIDTH`, in the same order (the agent panel to
  its minimum, then the SEO sheet). In the tiled 776px window with the SEO sheet open and the agent
  collapsed, the page keeps `PAGE_MIN_WIDTH` and the SEO sheet narrows from 360 to 328px (it was 360,
  with the page at 326); at the 588px minimum the page keeps 320 and the sheet is 140px (178 before),
  its content clipped, as a narrow window always did; with the sidebar collapsed the page is 468px
  (498 before). The gaps never shrink and never touch the chrome row, whose width rules
  (`tabs.feature.md`) are unchanged, so no control leaves the row.
- **Resizing.** A pane's separator (`.pane-separator`) moves from the pane's own edge into the gap
  beside the page: `WORKSPACE_GAP` wide, filling it, its 2px line in the middle (still only on hover,
  drag and focus). Drag, keys, ranges and storage are unchanged.
- **Bands.** The permission prompt, the find bar, the render-profile editor bar and the update notice
  are chrome rows above the workspace, already `--space-3` in from the window's edges with
  `--space-3` under each (the canvas's band slot), so their edges line up with the sheets' and a band
  pushes the whole workspace down, alone or together, as before. Unchanged.
- **The command palette's band** stays at the top of the page column on the window's fill, pushing
  the page card down; its card is `--r-lg` with `--e-ring` as before. Its padding is the canvas's,
  `0 0 --space-3` (it was `--space-4` by `--space-5`, with a `--divider` rule under it): the card
  spans the column's width up to `--palette-width`, centred, and `WORKSPACE_GAP` separates it from the
  page card. The band's height (`PALETTE_SHEET_HEIGHT`) and the page's minimum below it are unchanged.
- **Sheets in the page column.** History, Projects, the screenshot editor, Settings and Help (and
  Crawl and AI answers in Help's frame) fill the page column as before, as rounded sheets; the page
  area under them is zero-high and hidden (`PAGE_AREA_COLLAPSES`: `visibility: hidden`, so its ring
  and outline do not draw a line at the column's foot). A Projects capture run is a band of
  `--projects-run-band` above the page card, now a sheet with `WORKSPACE_GAP` under it in place of its
  `--divider` rule. The error and crash panels and the new-tab view fill the page card and are clipped
  to its corners.
- **The DevTools drawer** is a sheet under the workspace row, `WORKSPACE_GAP` below it and as wide as
  the row; it keeps the page at least `DEVTOOLS_HEIGHT.pageMinVisible` above it, gap counted (its CSS
  `max-height` and the drawer's column both take the gap off). Its resize edge stays its top 6px.
- **Status bar.** Full width under the workspace on the window's fill, with no rule and no fill of its
  own (the body's `--bg-window` shows through), so the sheets' edges and shadows show over it.
- **The workspace doesn't clip.** Each sheet clips its own content; the workspace and its stack no
  longer `overflow: hidden` (they would cut the sheets' rings and shadows at their edges); the window
  clips what a too-narrow row leaves past it.
- **Where the canvas and the app differ.** The canvas draws the SEO sheet's body 16px in, and the
  frame's PR left that to this one (the panels' interiors kept their width until their own PRs, all
  now in): the body's padding is `--space-5` (it was `--space-4`), so every panel's content is 8px
  narrower. The canvas also stands Overview's cards 16px apart; each panel's PR decided its own cards
  stand `--space-4` apart (their wrappers' gaps), so they stay, as do the body's and the skeleton's
  gaps. The canvas has no collapsed agent rail, DevTools drawer, render-profile frame, Projects run
  band or narrow window; those follow the rules above.

## Scenarios
- **Scenario: workspace-layout-values** (`apps/desktop/src/__tests__/chrome-grid-styles.test.ts`) —
  `WORKSPACE_GAP` and `SHEET_RADIUS` are their tokens' values in `SIGNAL_TOKENS`;
  `workspaceRowChrome` counts the rails and two or three gaps; `workspaceRowWidth` takes the inset off
  both sides; `pageViewRadius` is 16, 0 in fullscreen (framed or not) and 12 framed;
  `RENDER_DEVICE_OUTLINE_RADIUS` is 13.
- **Scenario: workspace-is-padded-and-gapped** (same file) — `.workspace-stack` has inline padding
  `--space-3` and no block padding, no border and no overflow clip; `.workspace` and `.seo` have
  `gap: var(--space-3)` and no border, fill or overflow clip; `.agent` has no border or fill; the
  status bar has no border and no fill; no rule in any renderer stylesheet draws a `--divider` edge on
  `.workspace-stack`, `.seo`, `.seo-panel`, `.agent`, `.status-bar` or `.devtools`.
- **Scenario: sheets-are-rounded-and-raised** (same file) — every `WORKSPACE_SHEETS` entry resolves
  (its stylesheet, then `styles.css`, which loads last) `border-radius: var(--r-lg)`, its `fill` as
  its background, its `elevation` as its box-shadow, its edge (`border: 1px solid transparent`, or
  `outline: 1px solid transparent`) and an overflow that clips (`clip`, or the `hidden` / `auto` it
  had; the agent rail none).
- **Scenario: page-area-collapses-hide-it** (same file) — every rule that sets the page area's
  `height: 0` is in `PAGE_AREA_COLLAPSES` and sets `visibility: hidden`; the Projects run's rule that
  gives it back its height sets `visibility: visible`.
- **Scenario: separators-sit-in-the-gap** (same file) — `.pane-separator` is `WORKSPACE_GAP` wide
  with its line centred; the SEO separator sits `WORKSPACE_GAP` past the sidebar's right edge, the
  agent's as far past its left.
- **Scenario: pane-room-counts-the-gaps** (`renderer/__tests__/sidebar-layout.test.ts`) —
  `roomForPanes` is the row less `PAGE_MIN_WIDTH` and `workspaceRowChrome`; the shrink order and
  `paneMax` follow.
- **Scenario: drawer-keeps-the-page-gap-counted** (`renderer/__tests__/devtools-view.test.ts`) — the
  drawer's column is its parent's height less `WORKSPACE_GAP`.
- **Scenario: page-view-is-rounded** (`main/browser/__tests__/controller.test.ts`) — with its bounds
  main sets the view's radius to `pageViewRadius`: 16 in the page area, 0 in HTML fullscreen (notice
  and full), 16 again on leaving it; one radius with each `setBounds`.
- **Scenario: framed-view-is-rounded** (`main/browser/__tests__/render-profile.test.ts`) — 12 while
  the tab has a render profile (the page area resized too), 16 once it is reset.
- **Scenario: page-view-matches-the-card** (e2e `workspace.e2e.ts`; Linux, Windows and macOS) — in
  each state (the SEO sidebar open and collapsed, at its narrowest and widest; the agent panel open
  and collapsed; the find bar and the render-profile editor bar, alone and together; the DevTools
  drawer; the palette's band; two window sizes; a narrow chrome with the page held at its minimum,
  the agent panel opening and collapsing beside the open SEO sheet) the view's bounds equal the page card's box (`x`, `y`,
  `width`, `height` each within 1px), the sheets beside it stand `WORKSPACE_GAP` off it, and the
  radius main last set on the view is `pageViewRadius` of that state, read from a spy the test puts on
  the `View` prototype's `setBorderRadius` (Electron has no getter); with a render profile the view
  sits in the frame (`fitRenderViewport`) with radius 12; in HTML fullscreen it fills the window with
  radius 0, and gets 16 back on leaving. The permission prompt keeps its own e2e
  (`permissions.e2e.ts`: the view starts below the band); the update notice is a band of the same
  slot, so it moves the card as the find bar does.
