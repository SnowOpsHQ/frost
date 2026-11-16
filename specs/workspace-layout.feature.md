# Feature: The workspace's layout (floating sheets)

Spec: `specs/workspace-layout.spec.ts` (`WORKSPACE_GAP`, `SHEET_RADIUS`, `workspaceRowChrome`,
`workspaceRowWidth`, `pageViewRadius`, `RENDER_DEVICE_OUTLINE_RADIUS`, `WORKSPACE_SHEETS`,
`PAGE_AREA_COLLAPSES`, `NARROW_WINDOW`, `SEO_BODY_NARROW_PADDING`, `WORKSPACE_GAP_TIGHT`,
`TIGHT_WORKSPACE_BELOW`, `workspaceGap`, `NARROW_PANEL_WRAPS`). Signal step 3, the last surface: how the pieces sit in the window, not their
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
  right edges (the workspace's inline padding), but in a workspace narrower than
  `TIGHT_WORKSPACE_BELOW` (748px), where they are `--space-1` (A narrow window); none at the top (the chrome row's own room, or a
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
  to its corners; the band takes the card's radius, so its inner corner is the framed view's 12px and
  no wedge of the card's fill shows between them; a device preset's outline follows the view's corner,
  `RENDER_DEVICE_OUTLINE_RADIUS`).
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
  with the page at 326); at the 588px minimum (tight gaps) the page keeps 320 and the sheet is 160px
  (178 before); with the sidebar collapsed the page is 484px (498 before). The gaps never touch the
  chrome row, whose width rules (`tabs.feature.md`) are unchanged, so no control leaves the row.
  `sidebar-layout.ts` and the DevTools drawer count the gap the workspace's width gives
  (`workspaceGap`); main's bounds come from the page card's measured box, so they follow.
- **A narrow window** (`NARROW_WINDOW`). The collapsed agent panel never shrinks (`flex: none` on
  its wrapper): its rail stays `AGENT_RAIL_WIDTH` wide with its gap to the window's edge, where flex
  shrink had squeezed the wrapper to 24px and cut the rail's corner and toggle. Below the panel's
  minimum (`SIDEBAR_PANEL_WIDTH_RANGE.min`, a 298px content box inside its border; only a window too
  narrow for it gets there) the SEO body's padding is `--space-1` (`SEO_BODY_NARROW_PADDING`, a
  container query on the panel), not the canvas's `--space-5`.
  **Tight gaps** (`WORKSPACE_GAP_TIGHT`, the owner's choice on #52, round 2). In a workspace narrower
  than `TIGHT_WORKSPACE_BELOW` (748px: where, with `--space-3` gaps and the agent collapsed, the SEO
  sheet would fall under its minimum beside the page's), every gap and inset of the workspace is
  `--space-1` together: the window's edges, rail | sheet, sheet | page, page | agent, the DevTools
  drawer's gap, and the bands' inset and gap above the workspace, so their edges stay on the sheets'.
  The two gaps inside the page column above the page card (the command palette's band and a Projects
  run's band) stay `--space-3`: they cost no width, and Projects' rules keep to its own container's
  queries (`projects-sheet-stacks-by-its-own-width`). One rule:
  `@container chrome (width < 748px)` on `.chrome` (`container: chrome / inline-size`), whose width
  is the workspace's (its stack spans the chrome's one column); the DevTools drawer's section
  (`devtools-styles-are-delimited`) and the agent's stylesheet repeat the same query for the drawer
  and the separator. Corners stay `--r-lg` and the native view's radius is unchanged. At
  the 588px minimum the sheet is 160px and its body's content box 150px, 140px beside its vertical
  scrollbar. `main` renders a 191px sheet there (content 156px) only because its collapsed agent
  rail is squeezed to about 27px and clipped (fixed in round 1); with a whole 40px rail it would be
  178px (content about 144px). So at 588px the body is 16px narrower than `main` renders it (4px
  narrower than `main` with a whole rail). The room is accepted; what costs the text is the parts that
  keep everything on one line, so under the panel's minimum (the same `seo-panel` query) they wrap
  (`NARROW_PANEL_WRAPS`): Overview's score card puts its ring above its words (it left them about 8px
  beside the 84px ring), the AI-readiness tile's score row likewise (`ai-readiness.css`, which holds the
  tile's rules and loads before `styles.css`), a section head puts its badge under its title, and the
  panels' toggles and actions wrap a long label onto a second line, their height automatic from
  `--h-chip` up. The bar, agent collapsed at 588px: Overview's, On-Page's, Links' and Changes' bodies
  don't scroll sideways (as on `main`) and Overview's first card clips no more words than `main`'s
  (1); Page Speed, Content and Visibility scrolled sideways on `main` too. Measured: Overview, On-Page
  and Links no longer scroll and Overview's first card clips no word. Changes' capture card stacks too
  (round 3): its Screenshot row puts the kinds under their label and the kinds run as rows (they were
  three columns, about 26px short, their labels overlapping), and the Project picker puts its select
  under its label (12px short), so Changes doesn't scroll sideways either. None of this applies at a
  width the panel's minimum fits, so nothing changes at 748px and wider.
  Two consequences of the tight layout, deliberate: the SEO separator's 8px hit area covers the
  panel's last 4px, which with classic scrollbars (Linux, Windows) is its border and about 3px of the
  body's scrollbar, so pressing the scrollbar's right edge under 748px starts a resize (the separator
  can't reach under the native view on the other side); and crossing 748px is a step, not a slope:
  the tight gaps free 20px, so at 747px the SEO sheet is 19px wider than at 748px and the page card
  starts 7px further right.
  Options that change behaviour (the sheet opening collapsed, the page giving way) were not needed.
  The window's minimum stays 588px.
- **Resizing.** A pane's separator (`.pane-separator`) moves from the pane's own edge into the gap
  beside the page, its 2px line in the middle of the gap (still only on hover, drag and focus). It is
  8px wide (`--space-3`) at every width: with `--space-3` gaps it fills the gap; with tight gaps it
  covers the 4px gap and the pane's own 4px edge beside it (never the page card, which the native view
  covers), so its hit area and focus line stay as they were. Drag, keys, ranges and storage are
  unchanged.
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
- **The workspace clips 1px outside itself.** Each sheet clips its own content. The workspace's stack
  clips its sheets' ink 1px outside its box (`overflow: clip` with `overflow-clip-margin: 1px`, where
  it was `overflow: hidden` at its edge): the sheets' 1px rings show, and their `--e-sheet` shadows
  stop there. Chromium sizes a shadow's ink at about 1.5 times its blur, so unclipped they reached
  about 16px up into the chrome row, over the address bar, which Chromium composites (it overlaps the
  text caret's layer). Anything painted later that overlaps a composited layer is composited too, and
  text in a layer that isn't opaque loses its subpixel (LCD) antialiasing: on CI's 1x renders the
  tab, the SEO header and the agent panel's text turned greyscale. What the clip cuts is under 1%
  opaque above the sheets; below them the canvas's status bar covers the shadows, so the canvas draws
  none there either. The row inside doesn't clip.
- **Entrance animations end.** A sheet's or a card's entrance animation (`seo-panel-in`,
  `agent-panel-in`, `palette-in`, `mark-in`, `panel-in`, `prompt-in`) fills `backwards`, not `both`:
  each ends at the element's own style, so nothing changes on screen, but an animation that stays in
  effect keeps its element composited, and Chromium assumes a composited transform animation overlaps
  what a sheet's shadow now reaches (the new tab's mark composited the agent panel beside the page
  card). The Search Console panel's two (`.gsc` and its calendar `.gsc-cal`, `panel-in`), which waited
  for PR #50's stylesheet to land, fill `backwards` too: neither sets a transform or an opacity of its
  own, so neither needs the animation's end state.
- **Where the canvas and the app differ.** The canvas draws the SEO sheet's body 16px in, and the
  frame's PR left that to this one (the panels' interiors kept their width until their own PRs, all
  now in): the body's padding is `--space-5` (it was `--space-4`), so every panel's content is 8px
  narrower. The canvas also stands Overview's cards 16px apart; each panel's PR decided its own cards
  stand `--space-4` apart (their wrappers' gaps), so they stay, as do the body's and the skeleton's
  gaps. The canvas has no collapsed agent rail, DevTools drawer, render-profile frame, Projects run
  band or narrow window; those follow the rules above.

## Known differences
- **`devtools-drawer-light`'s tab text is greyscale** where the base's had subpixel (LCD)
  antialiasing; dark keeps it. A CI probe (run 43893592708) in that capture found no layer for the
  tab in either theme, light greyscale both before and after dark (so not capture timing), and 16
  other layers composited for overlap in that state (the rail's scroller, the SEO sheet, the page
  card, the agent rail, the drawer, the separator, the palette's status). The cause wasn't found; the
  baseline keeps the render.

## Scenarios
- **Scenario: workspace-layout-values** (`apps/desktop/src/__tests__/chrome-grid-styles.test.ts`) —
  `WORKSPACE_GAP` and `SHEET_RADIUS` are their tokens' values in `SIGNAL_TOKENS`;
  `workspaceRowChrome` counts the rails and two or three gaps; `workspaceRowWidth` takes the inset off
  both sides; `pageViewRadius` is 16, 0 in fullscreen (framed or not) and 12 framed;
  `RENDER_DEVICE_OUTLINE_RADIUS` is 13.
- **Scenario: workspace-is-padded-and-gapped** (same file) — `.workspace-stack` has inline padding
  `--space-3` and no block padding, no border, and clips 1px outside itself (`overflow: clip`,
  `overflow-clip-margin: 1px`); `.workspace` and `.seo` have
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
- **Scenario: narrow-window-styles** (`chrome-grid-styles.test.ts`) — `.agent[data-open='false']` is
  `flex: none`; `.seo-panel` is the `seo-panel` inline-size container, and only under
  `SIDEBAR_PANEL_WIDTH_RANGE.min` less its 2px of border is `.seo-body`'s padding
  `SEO_BODY_NARROW_PADDING`, and each `NARROW_PANEL_WRAPS` rule wraps there (its stylesheet's
  `seo-panel` query) and nowhere outside it, the query coming after every top-level rule of each
  selector it overrides (at the same weight the later rule wins: written before them, it had no
  effect on the toggles); `.render-frame` takes the card's radius
  (`border-radius: inherit`).
- **Scenario: entrance-animations-end** (same file) — no rule in any renderer stylesheet runs an
  animation with `both` or `forwards` fill.
- **Scenario: narrow-window-keeps-the-sheets-whole** (e2e `workspace.e2e.ts`) — the chrome laid out
  588px wide with the SEO sheet open on Overview and the agent collapsed: the agent rail is
  `AGENT_RAIL_WIDTH` wide with `WORKSPACE_GAP_TIGHT` to the chrome's right edge, the gaps between the
  sheets `WORKSPACE_GAP_TIGHT`, the SEO sheet the row less the page's minimum and `workspaceRowChrome`
  (160px), the page `PAGE_MIN_WIDTH`; the workspace's gap is `WORKSPACE_GAP_TIGHT` at a chrome one pixel
  under `TIGHT_WORKSPACE_BELOW` and `WORKSPACE_GAP` at it and in a 776px chrome; the SEO body's
  padding is `--space-1` (it is `--space-5` at a width the panel's minimum fits); on Overview the
  body doesn't scroll sideways, and neither the score card's text column (and each line in it) nor
  the first toggle or action overflows its own box (`scrollWidth <= clientWidth`: text clipped inside
  its box counts, which comparing boxes with the body's edge missed); on Changes the body doesn't
  scroll sideways and neither each screenshot kind (and its label) nor the Project picker (its label
  and select) is cut inside its own box. The visual set's `narrow-window` capture draws Overview.
- **Scenario: separators-sit-in-the-gap** (same file) — `.pane-separator` is `WORKSPACE_GAP` wide
  with its line centred; the SEO separator sits `WORKSPACE_GAP` past the sidebar's right edge, the
  agent's as far past its left.
- **Scenario: tight-gaps-switch-together** (same file) — `.chrome` is the `chrome` inline-size
  container; every `@container chrome` query in the renderer's stylesheets is
  `(width < TIGHT_WORKSPACE_BELOW px)`, and together they set `--space-1` for each gap and inset that is
  `--space-3` outside them: the stack's padding, the row's and the SEO sidebar's gap, the drawer's
  margin and its `max-height`, the four bands' margin, and both separators' offsets, their lines
  centred in the 4px gap.
- **Scenario: pane-room-counts-the-gaps** (`renderer/__tests__/sidebar-layout.test.ts`) —
  `roomForPanes` is the row less `PAGE_MIN_WIDTH` and `workspaceRowChrome` with the layout's gap (the
  tight one in a narrow workspace); the shrink order and `paneMax` follow.
- **Scenario: drawer-keeps-the-page-gap-counted** (`renderer/__tests__/devtools-view.test.ts`) — the
  drawer's column is its parent's height less the workspace's gap (`WORKSPACE_GAP`, or the tight one).
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
  the `View` prototype's `setBorderRadius` (Electron has no getter: this proves the value main passed
  on each OS, not the drawing; that the corner is drawn rounded was shown by a screen capture on Linux CI
  only, probe 43660054663); with a render profile the view
  sits in the frame (`fitRenderViewport`) with radius 12; in HTML fullscreen it fills the window with
  radius 0, and gets 16 back on leaving. The permission prompt keeps its own e2e
  (`permissions.e2e.ts`: the view starts below the band); the update notice is a band of the same
  slot, so it moves the card as the find bar does.
