# Feature: Design tokens (Signal foundation and values)

Spec: `specs/design-tokens.spec.ts` (`TOKENS_STYLESHEET`, `SIGNAL_TOKENS`, `THEMED_SIGNAL_GROUPS`,
`SIGNAL_NAMES_WITH_LEGACY_VALUES`, `LEGACY_TOKEN_MIGRATION`, `CONTRAST_PAIRS`, `HEX_COLOUR_RATCHET`, `SIGNAL_SURFACES`,
`FONTS_STYLESHEET`, `GEIST_PACKAGE`, `GEIST_FONTS_ALIAS`, `TEXT_BODY_EMPHASIS_WEIGHT`, `BUNDLED_FONTS`). Source of truth:
the Signal token sheet (its values and its Migration table) and the round-2 council decisions.
Code: `apps/desktop/src/renderer/tokens.css` and `fonts.css`, imported by `main.tsx`. Each line maps to one named test.

## Decisions
- **One token source.** Every custom property that lives on `:root` is declared in `tokens.css`,
  light in a `:root` block and dark in a `@media (prefers-color-scheme: dark)` `:root` block that
  redefines only the names whose value changes. No other renderer stylesheet declares a custom
  property on `:root` (or `html`). Properties scoped to a component's own selector (`.seo-speed`,
  `.tab`, `.seo-ring`, `.devtools`, …) stay beside their rules.
- **Loaded first.** `main.tsx` imports `tokens.css` before any other stylesheet and before `App`
  (whose components import the feature stylesheets). No stylesheet is lazy-loaded.
- **Foundation: no visual change.** The legacy tokens moved into `tokens.css` with their names and
  values unchanged; a rule body anywhere else was untouched. `getComputedStyle` of the document
  element gave the same value for every legacy name, light and dark, as before (checked once against
  a production build); a snapshot pins the legacy values from there on, and each later change to it
  is on purpose.
- **The full Signal vocabulary.** Every `SIGNAL_TOKENS` name is defined at exactly its Signal value:
  colour, state and elevation in light and dark; type (a `font` shorthand, with its letter-spacing in
  the spec), radius, space, size and motion once.
- **Shared names carry Signal values.** `--text`, `--text-muted`, `--text-faint`, `--accent`,
  `--accent-soft`, `--accent-hover`, `--on-accent`, `--ok`, `--warn`, `--danger`, `--bg-hover` and
  `--bg-active` (`SIGNAL_NAMES_WITH_LEGACY_VALUES`) existed before Signal with the same meaning. The
  foundation kept their old values; since the values step they take their Signal values, light and
  dark, declared once per theme in the Signal part of `tokens.css`. `--icon` is a colour and stays
  one; the Signal icon size is `--icon-size`.
- **Migration map: aliases point at Signal.** `LEGACY_TOKEN_MIGRATION` maps all 89 legacy names:
  `alias` (the name stays) or `retire` (replaced; removed once no rule uses it). Since the values
  step, an alias whose Signal token has another name is exactly `var(<signal>)` in light with no dark
  override, so it follows the Signal token in both themes (`--bg-chrome: var(--bg-window)`,
  `--seo-panel-width: var(--w-panel)`). Retired names keep their values until their surface PR (but
  `--bg-strip` and `--bg-tab-hover`, retuned in the values step, see Tab row), which moves every rule off them and drops them from
  `tokens.css`: the row stays in the map, marked `removed`;
  layout constants (aliases with `signal: null`) keep theirs. Rules outside `tokens.css` change only
  where a Signal value left text under its minimum (`TEXT_COLOUR_RULES`, below) or a review asked
  for it (the tab spinner's track).
  A retired value that reads an alias moved with it: `--palette-sheet`'s gradient started at
  `var(--bg-chrome)`, so its first stop became `--bg-window` in the values step; the palette's surface
  PR then dropped the gradient for a flat `--bg-window`.
- **Contrast.** Every pair in `CONTRAST_PAIRS` (the text/background and UI/background pairs the
  token sheet names, plus body text, links and on-colour buttons on every surface) reaches its
  WCAG 2.x minimum, 4.5:1 for text and 3:1 for UI, in light and dark, computed from the values in
  `tokens.css` (a translucent fill composited over its opaque surface).
- **Tab row.** In the values step the active tab followed `--bg-window`, so the retired `--bg-strip`
  and `--bg-tab-hover` were retuned for the interim (the active tab 1.1:1 off the strip, a hovered tab
  between the two, the hairline between inactive tabs 1.1:1 off the strip). The chrome's surface PR
  moved the row onto Signal and dropped both names: the strip is `--bg-window`, an inactive tab
  `--bg-tab-idle`, a hovered one `--bg-hover`, the active one `--bg-surface` with `--e-raised`, and the
  tabs are pills `--space-1` apart with no hairline. `TAB_STRIP` now keeps, in both themes, the active
  tab at least 1.1:1 off the strip, an inactive one 1.09:1 (1.097 in light, Signal's own value) and a
  hovered one 1.1:1. A hovered tab no longer sits between the strip and the active tab (in light
  `--bg-hover` darkens the strip while the tabs lighten it), and in dark `--bg-tab-idle` and `--bg-hover`
  are one fill with the active tab's within 1.02:1 of it (`--e-raised` about 1.28:1 on the window), so
  no fill says which tab is active (council round 1: on main the active tab joined the toolbar). The
  active tab carries a 2px `--accent` line along its foot (`TAB_STRIP.activeIndicator`, an inset
  box-shadow beside `--e-raised`), at least 3:1 off the active, inactive and hovered fills and off the
  strip under it, in both themes; a hovered active tab keeps it, a focused one shows `--focus-ring` in
  its place, and forced colours, which drop it, draw the active tab's 1px outline.
- **Known exceptions.** `KNOWN_CONTRAST_EXCEPTIONS` records what still misses its minimum, for the
  surface PRs: `--ok` as text (21 rules) is under 4.5:1 in light, and those rules move to `--ok-ink`
  (only the 11px chips moved in the values step; Settings and Help moved their 4, leaving 17;
  Overview its band label and all-clear line, leaving 15; On-Page's "Good length" drew `--ok` through
  the meter's own property, so it never counted; the panels' all-clear line, Images' alt badge and
  Schema's block status, leaving 12; the DevTools drawer its robots line and 2xx code, leaving 10).
- **Text the Signal values left too faint.** A few rules drew text in a token whose Signal value
  falls under 4.5:1 where they use it; the values step points them at a token that passes
  (`TEXT_COLOUR_RULES`), and each pair joins `CONTRAST_PAIRS`. The status bar's failed-overrides
  chip, at 4.46:1 with `--danger-ink` on its 14% tint over `--bg-chrome`, takes the sheet's
  -ink-on-soft pairing instead: `--danger-soft` fill (5.30:1 light, 8.68:1 dark).
- **Hex ratchet.** Literal hex colours in renderer stylesheets other than `tokens.css` never exceed
  `HEX_COLOUR_RATCHET`; each surface PR lowers it to its new count (the command palette's rules held
  no literal hex, their colours were all tokens, so it stayed at 53; the new-tab view's held none
  either, so it stays there, as it does for the SEO sidebar's frame; Settings' switch knob was its one, so it is 52;
  the fullscreen notice's two went with the chrome's, so it is 50; Overview's and On-Page's rules held
  none, so it stays 50; Links' kind and rel flags, their dark overrides, the share card's image label
  and Schema's error mark held 17, so it is 33; the render profile's page-area frame held three literal
  whites, so it is 30).
- **Geist, bundled and local.** The type tokens name Geist and Geist Mono; frost ships them from the
  official `geist` npm package (`GEIST_PACKAGE`: pinned exactly, SIL Open Font License 1.1, listed in
  `THIRD_PARTY_NOTICES` with the licence text). Only static woff2 files, only the weights the type
  scale uses (`BUNDLED_FONTS`: Geist 400, 500 for body emphasis, 600; Geist Mono 400), no italics,
  variable or Pixel files. `fonts.css` holds one `@font-face` per file (`font-display: block`: the
  files are local, so there is no flash of a fallback), each `src` a single
  `url('@geist-fonts/<file>') format('woff2')`; the renderer's Vite config aliases `@geist-fonts` to
  the installed package's `dist/fonts/` (its `exports` map hides them). Vite emits the four files as
  hashed assets served from `app://` (the CSP's `font-src 'self'`): never a CDN, a remote URL or a
  `data:` URI, and nothing else of the package is bundled. `main.tsx` imports `fonts.css` right after
  `tokens.css`. The fonts are applied surface by surface, as each surface PR moves its text onto the
  `--text-*` tokens (the command palette first); `--font-ui`, the rest of the chrome's face, stays the
  system stack until its own surface PR.
- **Surface PRs.** A surface's rules (`SIGNAL_SURFACES`: its stylesheet and its class prefix, or, where
  other surfaces share the prefix or its classes share none, the exact classes and `-*` families it lists with its keyframes; a
  rule is the surface's when any selector names one of its classes, on a class boundary, or it sits in
  the surface's `@keyframes`) read only Signal tokens and legacy aliases, never a retired name or a
  literal colour; its text takes its face and size from a `--text-*` token (`font: var(--text-*)`,
  with that token's letter-spacing beside it in the same rule when it isn't `0`), at most changing the
  weight to a bundled one.
- **The command palette** (the first surface PR) follows the token sheet's Migration notes and the
  approved palette screen: a flat `--bg-window` band (`--palette-sheet`: "no gradients") holding a
  `--bg-surface` card at `--r-lg` with `--e-ring` and no border or drop shadow (`--palette-shadow`:
  "a band, not a floating sheet"); `--divider` for its rules; rows at `--r-sm` with the selected one
  on `--accent-soft` (no side bar) and its icon tile on `--accent`; a match highlight on
  `--accent-soft` at `--r-xs`, `--bg-surface` on the selected row; key hints on `--bg-surface` with
  `--e-ring` at `--h-badge`, in `--text-mono`; a `--bg-subtle` footer. Matched letters take
  `--text-body`'s emphasis weight (`TEXT_BODY_EMPHASIS_WEIGHT`), where the screen draws 600. The
  confirm step's Back button is a secondary button on the card: a `--bg-subtle` fill with an
  `--e-ring` edge, `--bg-hover` laid over it on hover (the screen's only secondary button, `--bg-surface`
  with `--e-raised`, sits on a tinted band and would vanish on the card). Help's
  key hints (`help.css`), which read the palette's key-hint names, move to the same Signal tokens.
- **The new-tab view** (the start view and "Jump back in") follows the token sheet's Migration notes;
  the approved canvas has no new-tab screen, so the rest comes from the token `use` notes. The view is
  flat `--bg-page` (`--start-glow`: "no gradient washes"); the FrostMark is `--accent` (`--start-mark`),
  in the tab row's empty-tab glyph too; the mark eases in over `--dur-slow` with `--ease-out`. The
  wordmark is `--text-display` (the type scale's largest: it was 44px at weight 300, which Geist isn't
  bundled in) and the hint `--text-body` in `--text-muted`. "Jump back in" takes `--text-caps` for its
  title, and its tiles are `--bg-surface` cards at `--r-md` with `--e-ring` in place of their border
  (`--jump-tile-edge`; a transparent 1px border stays, the edge forced colours draw), the label in
  `--text-body` at its emphasis weight and the host in `--text-small`
  (`--text-faint`, 12px). A tile's monogram is an `--h-chip` square at `--r-sm` on `--accent-soft`
  (`--jump-monogram-bg`) with its letter in `--accent` at `--text-body`'s size and weight 600; History's
  monogram, which shared the retired fill, moves to `--accent-soft` too. A hovered tile rings in
  `--accent` (it was an accent border) and lifts 1px over `--dur-fast`; a focused one takes
  `--focus-ring` beside a transparent 2px outline (forced colours drop the shadow and draw the
  outline). The setup checklist under it (`help.css`), which read `--jump-tile-edge` for its border
  and `--jump-tile-bg` for its fill, takes `--e-ring` and `--bg-surface` the same way.
- **The agent panel** (every rule of `components/agent/agent.css`) follows the Migration notes and
  the approved agent screen, where they agree: Geist on the `--text-*` tokens (the panel's own text at `--text-body`, its title at `--text-title`, secondary lines at `--text-small`,
  code, the context meter and skill instructions at `--text-mono`, chips at `--text-micro`); the open
  panel, its header and its footer on `--bg-sheet`, the header's rule `--divider`, its mark an
  `--accent` icon on an `--accent-soft` tile at `--r-md` (its tools keep the chrome's shared `.tool`
  style until the chrome's surface PR); your messages on `--accent-soft` at `--r-md`;
  tool cards, settings sections and the empty and setup hints `--bg-surface` cards at `--r-md` with
  `--e-ring` and no border (`--agent-edge`: "--e-ring", the hint's dashed outline included); code on
  `--bg-subtle` at `--r-sm`; status chips at `--h-badge` on their `-soft` fill with `-ink` text
  (running: `--accent` on `--accent-soft`); buttons `--h-control` pills on `--bg-surface` with
  `--e-raised` (hover lays `--bg-hover` over them), the primary one `--accent`; fields and selects with
  `--e-raised` and no border (`--border-field`), `--r-sm` inside cards and the composer's textarea at
  `--r-lg`, the fields and selects `--h-control` tall; focus shows `--focus-ring`;
  the attach menu an `--e-overlay` menu at `--r-md`. Where the screen and the Migration table differ,
  the table wins: the approval card and the revoke-all confirmation keep their warning fill and edge
  (`--agent-approval-bg` → `--warn-soft`, `--agent-approval-edge` → `--warn`), where the screen draws a
  plain `--bg-surface` card with `--e-overlay`, and its note and its "More code below" hint take
  `--warn-ink`. Warning text elsewhere
  (`--caution` and the approval edge used as text: the risk note, the "Untrusted" chip) takes
  `--warn-ink`, field errors `--danger-ink`; the collapsed rail stays on `--bg-window` (it shows in
  every other capture) with a `--divider` edge, and the open panel stays flush with the page (the
  screen's floating sheet, with gaps and `--r-lg` corners, is the workspace's surface PR). Nothing in
  the panel drew `--ok` as text, and it held no literal hex, so `KNOWN_CONTRAST_EXCEPTIONS` and
  `HEX_COLOUR_RATCHET` stay.
- **Settings and Help** (every rule of `settings.css`, `settings-ai-checks.css`,
  `settings-data-sources.css`, `settings-locations.css` and `help.css`: the Settings sheet and its
  sections; Help's sheet frame, keyboard shortcuts, What's New and Export Diagnostics; the new tab's
  setup checklist) follow the Migration notes and the approved Settings screen, where they agree.
  Settings is a `--bg-sheet` sheet (the screen's), set in Geist from `--text-body`: its title
  `--text-title`, section headings, questions and the Search Console headline `--text-heading`,
  secondary lines `--text-small`; sections are spaced by `--space-6` with no rule between them (the
  screen draws none). The nav's items are `--h-control` rows at `--r-md` in `--text-muted` at
  `--text-body`'s emphasis weight, hovered on `--bg-hover`; the section in view is a raised
  `--bg-surface` item (`--e-raised`, `--text`) with a transparent outline forced colours draw. Cards and
  row cards are `--bg-surface` at `--r-md` with `--e-ring` and a transparent 1px border (1px less
  padding: `--seo-card-edge`, `--seo-card` and `--shadow-card` → `--e-ring`); buttons are `--h-control`
  pills on `--bg-surface` with `--e-raised` (hover lays `--bg-hover` over them), the primary one
  `--accent`, as the agent panel's; fields and selects are `--h-control` tall at `--r-sm` with
  `--e-raised` and a transparent border (`--border-field`); focus shows `--focus-ring` beside a
  transparent 2px outline everywhere (it was a 2px `--accent` outline). A chosen radio row is the
  screen's: `--accent-soft` ringed in `--accent`, its mark an `--icon-size` ring of `--switch-off`, a
  5px `--accent` one when chosen (borders, so forced colours draw both; the screen's inset shadows and
  the old radial gradient would vanish there). The switch is the screen's: a 36px × `--h-badge` track
  on `--switch-off` (`--settings-switch-off` → `--switch-off`, `removed`), `--accent` when on, an 18px
  `--knob` (it was literal white with a drop shadow), moving over `--dur-fast` with `--ease-out`; the
  track keeps a transparent border forced colours draw. Notices are `--warn-ink` on `--warn-soft` at
  `--r-sm` (they were `--warn` on an 8% tint), errors `--danger-ink`, and status text, the account's
  feature marks and a connected headline `--ok-ink` (they drew `--ok` as text); the plan is a neutral
  `--h-badge` chip in `--text-micro` (`--text-muted` on `--bg-subtle`, it was an outlined pill); the
  avatar an `--h-field` circle on `--accent-soft`; the confirmation card rings in `--accent` with an
  `--accent-soft` halo. The sign-in code is `--text-display` with tabular figures, where it was a
  26px monospace at 0.12em: Geist Mono is bundled only at `--text-mono`'s 12px and 400, and a type
  token's letter-spacing is its own. A focused button keeps `--focus-ring` hovered, busy and primary
  (`FOCUS_RING_RULES`): the hovers' state checks sit in `:where()`, so they add no weight, and the
  plain `:focus-visible` rules come after them. A busy button shows it by its colours, not by fading
  (an `opacity` would dim the ring too): `--text-faint` text, and a primary one `--accent` on
  `--accent-soft`; under forced colours, which replace both, a busy button's text and edge are
  `GrayText`. A busy switch or choice fades only while it is not focused. A switch's knob, when on,
  has a 1px `--bg-surface` edge:
  `--knob` on `--accent` is 2.65:1 in dark, the edge on the track 3:1 or more in both themes. Help's
  sheet frame keeps the page card's `--bg-surface` (no screen
  draws Help: it is a document, not cards, and it also frames the Crawl and AI answers sheets, whose
  own text keeps its face until their surface PRs), with Settings' header and close button; shortcut
  groups take `--text-caps`, their rows `--divider` rules (they were `--bg-active`), the key hints
  `--text-mono` (as the palette's); What's New `--text-heading` titles over `--divider` rules;
  Export Diagnostics' Save… is a Settings button and its report `--text-mono` on `--bg-subtle` at
  `--r-sm` (the agent panel's code). The setup checklist's title is `--text-caps`, its rows
  `--h-control` tall, its step marks `--switch-off` rings filled `--ok` (a graphic) when done, "Done"
  `--ok-ink`, and its actions `--h-chip` pills on `--bg-surface` with `--e-raised` (hover lays
  `--bg-hover` over them; it ringed them in `--accent`). A transparent outline forced colours draw goes
  beside every `--focus-ring`. Settings' and Help's widths (`--settings-width`, `--settings-nav-width`,
  760px) stay layout constants. The floating sheet (gaps, `--r-lg` corners) is the workspace's surface
  PR. The visual baseline gains `help-shortcuts`.
- **The SEO sidebar's frame and shared parts** (the sidebar, its rail and "More panels", the header,
  body and footer; the cards, section heads, badges, page text and severity icons every panel shares;
  the pending, unavailable and empty states) follow the Migration notes, the token `use` notes and the
  approved main screen, where they agree. The `.seo` prefix names every panel's classes too, so its
  `SIGNAL_SURFACES` entry lists the frame's classes (`.seo-chip` is never `.seo-chip-button`, and
  `.seo-panel-tools`, `.seo-toggle` and the panels' interiors wait for their own PRs); `.seo-page-text`
  (no colour or type of its own) and `.pane-separator` (the agent panel shares it) stay out. Rail and
  panel are one `--bg-sheet` ("rail, sidebar, agent panel"; `--seo-bg`, and `--bg-chrome` under the
  rail), flush with the page and ruled by `--divider` (`--bg-chrome-edge`); the screen's floating
  sheets, with gaps and `--r-lg` corners, are the workspace's surface PR. Rail items are `--h-field`
  squares at `--r-md` with `--text-muted` icons at `--icon-size` (`--icon`), `--bg-hover` and
  `--bg-active` under the pointer; the open panel's item is raised (`--bg-surface`, `--e-raised`, its
  icon `--accent`, a transparent outline for forced colours) and loses the 3px side marker, as on the
  screen. Status dots say it by shape, not hue alone: an error a filled `--danger` square (corners
  half of `--r-xs`), a warning a `--warn` ring (`--caution`; a 2px border, not a shadow, so forced
  colours keep it), a pass a filled `--ok` disc (the screen's check glyph needs markup: a later PR), each
  cut out by a halo in the sheet or card under it (none on a hovered or focused "More panels" row, whose
  tint the halo would ring). The dots keep their own colours in forced colours
  (`forced-color-adjust: none`), where the halo and the ring's fill turn transparent. The rail tip and
  "More panels" are `--bg-surface` menus with `--e-overlay` (`--r-sm`, `--r-md`) in place of a border and
  a black drop shadow, a transparent 1px border kept for forced colours; a focused menu item takes
  `--focus-ring` (the menu's 4px padding holds it, and it is drawn above its neighbours) beside a
  transparent outline, over `--accent-soft`, and a hovered one `--bg-hover`. The header follows the agent panel's: no fill of its own, the panel's name at
  `--text-title` over its host in `--text-small`, a `--divider` rule; its tools keep the chrome's `.tool`
  style. The pressed pin and the toolbar's pressed toggle take `--accent` on `--accent-soft`. Cards
  (`.seo-section`, `.seo-score-card`, `.seo-issues`, the skeleton's score card) are `--bg-surface` at
  `--r-md` with `--e-ring` in place of their border (`--seo-card-edge`, `--shadow-card`; a transparent
  1px border stays) with their 12px by 14px padding (`--space-4` by `--space-2` + `--space-3`), so the
  panels' interiors keep their width, section titles `--text-caps`, count badges `--h-badge` pills on `--bg-subtle` in
  `--text-micro`, and a severity's badge (and the chip) its `-soft` fill with `-ink` text (`--caution` →
  `--warn`, `--info-tone` → `--accent`; inside a Changes region's title, a line of text, a badge keeps
  the line's height); notes `--text-small` in `--text-faint`, mono values
  `--text-mono`, the link button `--text-body` at its emphasis weight over a `--divider` rule. The body
  keeps its 12px (`--space-4`) padding where the screen draws 16px, so the panels' interiors keep their
  width until their own PRs. The skeleton is `--bg-subtle` (`--seo-skeleton`) with a soft `--bg-sheet`
  band sweeping over it (`--seo-skeleton-shine`), drawn as a blurred box rather than a gradient; both
  retired names are `removed`. The empty and unavailable hints keep the panel's 64px art on an
  `--accent-soft` tile at `--r-lg` (`--warn-soft` with `--warn-ink` art when unavailable), its inset edge
  gone, with a `--text-heading` title and a `--text-body` message in `--text-muted` (the screen's 40px
  disc holds an icon, not the panel's art). Nothing in the frame drew `--ok` as text, and it held no
  literal hex, so `KNOWN_CONTRAST_EXCEPTIONS` and `HEX_COLOUR_RATCHET` stay.

- **The browser chrome's rows** (`styles.css` from its top to the SEO sidebar: the grid, the tab row,
  the toolbar with the address bar and its loading line, the permission prompt, the fullscreen notice,
  the page area's frame and the status bar; and the toolbar's SEO sidebar toggle) follow the Migration
  notes, the token `use` notes and the approved canvas's chrome row, band slot, status bar and
  interaction states, where they agree. The two rows it kept are one row since the merged row's PR
  (below). The chrome's classes share no prefix, so its `SIGNAL_SURFACES` entry lists them with
  its keyframes and no `selectorPrefix`; the shared `.icon` (now `--icon-size`) and `.visually-hidden`,
  the new tab's view, the error panels and the bars later PRs move (the render-profile editor bar and
  chips, the find bar, History, the update notice) stay out. The rows sit on `--bg-window` (no separate
  strip: `--bg-strip` is `removed`); the status bar is `--h-status`, 28px where it was 26
  (`--tabstrip-height`, `--toolbar-height` and `--status-height` are `removed`). Text is Geist from the
  `--text-*` tokens: tabs, the address and the prompt `--text-body`, the status bar `--text-small` with
  the zoom in `--text-mono`. Tabs are `--h-control` pills `--space-1` apart, as `TAB_STRIP` describes:
  an inactive one on `--bg-tab-idle` in `--text-muted`, a hovered one on `--bg-hover` with its label
  `--text` (`--bg-tab-hover` is `removed`), the active one on `--bg-surface` with `--e-raised`, its label
  `--text` at `--text-body`'s emphasis weight with a 2px `--accent` line along its foot (an inset
  box-shadow: the one cue that is not fill, `TAB_STRIP`); the hairlines between inactive tabs and the active tab's
  flared corners (radial gradients into the toolbar) went. A tab's glyph is `--text-muted` at
  `--icon-sm`, its close button an `--h-badge` circle (`--bg-hover` under the pointer, `--bg-active`
  pressed), and a background tab asking for a permission shows the canvas's `--accent` ring (a 2px
  border, which forced colours keep) where it had a filled dot with a halo. The toolbar's tools
  (`.tool`, which the agent panel's and the SEO sidebar's headers share) and the new-tab button are
  `--h-control` circles with `--text-muted` icons (`--icon` → `--text-muted`) at `--icon-size`,
  `--bg-hover` hovered, `--bg-active` pressed, and a disabled tool `--text-faint` at half strength
  (`color-mix()` with `transparent`; `--text-faint` alone sits too close to the enabled `--text-muted`)
  where it faded to 0.32 (`GrayText` under forced colours, `FORCED_COLOURS_BUSY`); each tool has a
  transparent 1px border forced colours draw. The address bar is an `--h-field` pill on `--bg-surface` with `--e-raised` and a
  transparent border (`--border-field` and `--shadow-field` → `--e-raised`, `--radius-field` →
  `--r-pill`), with no hover tint (its `--text-faint` placeholder and badge would be 4.26:1 on `--bg-hover`
  over `--bg-surface` in dark; in light the old hover never changed it), its badges at `--icon-sm`; the
  secure badge stays an `--ok` graphic (3:1), so the `--ok`-as-text count stays 17. The loading line is
  a solid 2px `--accent` pill sliding along the toolbar's foot (it faded in and out by a gradient).
  Focus is `--focus-ring` beside a transparent 2px outline on the tabs, the tools, the new-tab button,
  the address (`:focus-within`) and the prompt's buttons, after the hovers, whose state checks sit in
  `:where()` (`FOCUS_RING_RULES`); the active tab also keeps a transparent 1px outline, so forced colours
  mark it. The permission prompt is the canvas's band slot: an `--accent-soft` band at `--r-md`
  (`--bg-prompt`: "band slot fill") inset by `--space-3` under the toolbar, with no edge or shadow
  (`--prompt-edge` and `--shadow-prompt`: none; a transparent border stays for forced colours), its icon
  a bare `--accent` glyph where it sat on a tinted tile, its question `--text-muted` with the origin
  `--text`; Allow and Block are `--h-chip` pills on `--bg-surface` with `--e-raised` (hover lays
  `--bg-hover` over them), the same weight, `--text-faint` while not yet armed (they faded); the dismiss
  button an `--h-chip` circle. The fullscreen notice is `--inverse` with `--on-inverse` text (its two
  literal hex colours and its inset edge went), still `FULLSCREEN_BANNER_HEIGHT` high. The status bar
  is `--text-muted` on `--bg-window`, the connection `--text-faint`, the zoom plain `--text-mono` (the
  canvas's; its outlined chip went). The page area's frame keeps `--bg-page`; the rule between the
  chrome and the page moved from the toolbar's foot to the top of the workspace (`--bg-chrome-edge` →
  `--divider`), so a band under the toolbar belongs to the chrome, and the status bar keeps a `--divider`
  rule above it while the page is flush (the page card, its corners and the floating sheets are the
  workspace's PR). The toolbar's SEO sidebar toggle had the classes `tool seo-toggle`, so it also drew
  the panels' `.seo-toggle` pill (a bordered 28px pill, its own font and focus outline); it is now
  `tool sidebar-toggle` (its `data-testid` unchanged), a plain tool, pressed `--accent` on
  `--accent-soft` as the SEO frame's PR decided (the canvas draws it `--text` on `--bg-active`). The
  names the chrome no longer reads but other surfaces still do stay declared: `--bg-chrome`,
  `--bg-chrome-edge`, `--icon`, `--border-field`, `--bg-field`, `--bg-field-hover`, `--shadow-field`,
  `--radius-control`, `--radius-field`, `--bg-prompt`, `--prompt-edge`, `--shadow-prompt`, `--find-height`,
  `--page-min-width` and `--font-ui` (the body's face, the system stack until its own PR). The
  render-profile toggle, a `.tool` too, showed it was pressed by an inset box-shadow that, later in the
  file at the same weight, replaced `.tool`'s `--focus-ring` (on main an opaque outline survived it): its
  pressed edge is now the tool's own border colour (`--render-edge`), so focus keeps its ring, and under
  forced colours it is `Highlight`, as the SEO sidebar toggle's is (`FORCED_COLOURS_PRESSED`; that rule
  sits after the toggle's own, which would otherwise win at the same weight); the rest of the
  render-profile bar waits for its PR. The connection
  dot keeps `--ok` beside its label, which says the state.

- **The merged chrome row** (`tabs.feature.md`, The chrome row, and its keyboard contract): the tab row
  (42px: `--h-control` with `--space-1` above and below) and the toolbar (50px: `--h-field` with
  `--space-2` above and below) became the canvas's one `--h-chrome` row, 56px, the chrome grid's first
  track, so the page area and the tab's view move up 36px. The row (`.chrome-row`, which takes the
  place of `.tabstrip` and `.toolbar`; the tablist keeps `.tabs`) is on `--bg-window`, `--space-4` in
  from the window's edges, its parts `--space-1` apart as the canvas's are; the canvas's order with the
  address bar as the tablist's next sibling. The canvas lays the address input over the active tab's
  slot only while editing (the active tab is the address "in place"); frost keeps its address bar
  always shown, an `--h-field` pill beside the tablist, so the "+" follows it, as the canvas's DOM order
  has it. The tablist scrolls with `--space-1` of padding and scroll padding, the room a focused tab's
  4px ring needs at either end (the reason the tab row was 42px). The loading line runs along the row's
  foot. The tools are `flex: none`, the row clips (`overflow: clip`, never scrolled by focus), and the
  widths give way in `tabs.feature.md`'s order: the tabs to 84px, then the tablist scrolls, and only in a
  narrow window the address bar from 360px to 240px (and below the window's 588px minimum, which tiling
  window managers ignore, on toward nothing before a tool is clipped), measured on the row's own width
  (an inline-size container, `100cqw`; `tabs.feature.md`). No colour, type or state of a tab, tool or the address changed, so `TAB_STRIP`,
  `FOCUS_RING_RULES`, `FORCED_COLOURS_BUSY`, `FORCED_COLOURS_PRESSED` and `CONTRAST_PAIRS` keep their
  values; the chrome's `SIGNAL_SURFACES` entry lists `.chrome-row` where it listed `.tabstrip` and
  `.toolbar`. No token was read by the toolbar alone, so nothing more is retired: `--tabstrip-height`
  and `--toolbar-height` were `removed` with the chrome's rows, and `--h-chrome` is now read.

- **The SEO panels' Overview and On-Page** (`seo-sidebar.feature.md`, Sidebar: Overview and On-Page;
  what their components render, less the frame's shared parts) follow the Migration notes, the token
  `use` notes and the approved main screen's Overview (its score card, counts, issue list, search
  preview and checks), where they agree with the sidebar's spec; On-Page has no screen and follows the
  notes. The `.seo` prefix is the frame's and every panel's, so each panel has a `SIGNAL_SURFACES` entry
  listing its classes. Some of their parts are other panels' too (an issue row is Links', Images',
  Social's and Page Speed's; a label and value row Indexability's, Social's, JavaScript's and the Search
  Console inspection's; a stat tile Links' and Images'; a tag Indexability's, Sitemaps' and Page
  Speed's; the eyebrow every panel's verdict label; the score ring the AI-readiness tile's and
  Visibility's): their rules move with these panels and draw the same there. The highlight and Copy as
  CSV toggles (`.seo-toggle`), `.seo-panel-tools` and `.seo-flash` are shared controls, left to their
  panels' PRs, and so are the AI-readiness tile, the "Page" card and the AI judgment card (features of
  their own). Text is Geist from the `--text-*` tokens, every space a `--space-*` step and every corner
  an `--r-*`; a part's own geometry (the 84px ring, which the frame's skeleton ring matches; the 6px
  meter; the 18px tag; the outline's 14px indent per level; the label columns) stays a layout constant.
  The panels stand their cards `--space-4` apart (the body's padding and the skeleton's gap; the
  screen's 16px is the workspace PR's, with the body's). **Score card:** `--space-5` in and between,
  as on the screen; the ring's arc is its band's graphics colour (`--ok`, `--warn` for "Needs work" where
  it was `--caution`, `--danger`) on a `--track` circle (`--seo-track`), easing in `--dur-slow`; the
  value `--text-display` in `--text`; the eyebrow ("Health score") `--text-micro` in `--text-muted`, in
  sentence case, as on the screen (it was 10.5px uppercase `--text-faint`, and every panel's eyebrow
  that labels a verdict or a value follows it; Page Speed's "Since the page loaded" heads its metric
  tiles instead, so it stays a section head: `--text-caps`, upper case); the band's label `--text-heading` in `--text`, as on the screen: the ring carries the
  band's colour and the word its name (it was 19px in the band's colour, and `--ok` text is 3.30:1);
  the summary `--text-small` in `--text-muted`, a noindexed page's reasons in `--danger-ink`. The
  partial note is a `--warn-soft` notice at `--r-md` (`--caution` at 12%), its text `--text-muted`, a
  transparent border kept for forced colours. **Counts:** the screen's pills, where they were three
  bordered tiles: `--h-chip` pills on `--bg-subtle`, the severity's icon, the number at weight 600 and
  its word in `--text-small`; a zero count is `--text-faint`, icon and all (it faded to 0.6), and
  `GrayText`, text and edge, under forced colours, which would otherwise show it like any other
  (`FORCED_COLOURS_BUSY`).
  **Issues:** they stay rows in the one `.seo-issues` card the frame drew, ruled by `--divider`
  (`--seo-card-edge`), where the screen draws each as its own card: that card is the frame's, and the
  other panels' issue lists share it. A row is `--r-sm`, `--bg-hover` under the pointer, its title
  `--text-body` at its emphasis weight, its category and lead value `--text-small` in `--text-muted`
  (the screen's; it was 11.5px `--text-faint`), its chevron `--text-muted` at `--icon-sm`, turning in
  `--dur-fast`; focus is `--focus-ring` beside a transparent outline, drawn above the next row (it was
  an inset 2px `--accent` outline). An open issue's labels are `--text-caps` in `--text-faint`, its why
  and fix `--text-small` in `--text-muted`, its facts and samples on `--bg-subtle` (they lay
  `--bg-hover` over the card) at `--r-sm`, opening with `prompt-in` in `--dur-base`. The all-clear line
  is `--ok-ink` with an `--ok` icon. **Search preview:** the screen's: crumbs `--text-small` in
  `--text-muted`, the title `--text-heading` at weight 500 in `--accent` (it mixed in 12% `--text`), the
  description `--text-small` in `--text-muted`. **Checks by category:** `--text-small` rows `--space-1`
  by `--space-4` apart, as on the screen, the count `--text-muted`; the status mark is 8px and differs
  by shape, as the rail's dots do: a filled `--ok` disc for a pass (the screen's check glyph needs
  markup), a filled `--danger` square for an error, a `--warn` ring (a 2px border) for a warning (it was
  a `--caution` disc), a hollow `--accent` diamond for a notice (the 8px box with a 2px border, as the warning ring's, turned 45°, so its
  4px hollow stays open and every side a solid run of `--accent`; no fractional border widths, which
  Chromium rounds down; an `--info-tone` disc; the screen draws
  it a ring like the warning's, in another hue only). The marks keep their colours in forced colours
  (`forced-color-adjust: none`, `FORCED_COLOURS_KEPT`), where a fill would turn to the canvas and every
  status look the same; and only these marks and the rail's dots may opt out of forced colours (any
  rule of any renderer stylesheet setting `forced-color-adjust` must be one `FORCED_COLOURS_KEPT` names,
  `only-kept-marks-opt-out-of-forced-colours`). **The audit's render profile** (above Overview) is an `--accent-soft` notice at
  `--r-md` (`--render-soft`; its `--render-edge` border is a transparent one for forced colours), its
  summary `--text-small` at weight 600. **On-Page:** the measured title and description are
  `--text-body`, their sections ruled by `--divider`; a length meter is a 6px `--r-pill` bar, its track
  `--track` with the recommended range `--ok` mixed 22% into it, its fill the verdict's graphics colour
  (`--ok`, `--warn` for short and long where it was `--caution`, `--danger`), its line `--text-small` in
  `--text-faint` with the count `--text-muted` at weight 600 and the verdict in its -ink (`--ok-ink`,
  `--warn-ink`, `--danger-ink`: it drew `--ok` through the meter's property, 3.30:1); the measured width
  `--text-faint`, `--warn-ink` when a result cuts it. Label and value rows are `--text-small` (label
  `--text-muted`), `--space-3` apart. The heading counts are `--text-small` at weight 600, an empty
  level `--text-faint` at 400; a tag is `--text-micro` in `--text-muted` on `--bg-subtle` at `--r-xs` (it
  was 10px bold system monospace on `--bg-hover`), an H1's `--accent` on `--accent-soft` (an `--accent`
  16% mix). The outline's rows are `--text-small`, `--space-1` above and below, their guide lines
  `--divider` (`--seo-card-edge`), each level's offset a component property set on every row (it was a
  `var()` fallback). Stat tiles are `--bg-subtle` at `--r-sm` (`--bg-hover`), the number `--text-title`,
  a warning count `--warn-ink` (`--caution`), the label `--text-small` in `--text-muted`. No retired name
  these panels read is unread elsewhere, so none is `removed`: `--seo-card-edge`, `--caution`,
  `--shadow-card`, `--info-tone`, `--render-edge` and `--render-soft` (retired) and `--seo-card` and
  `--seo-track` (aliases) stay for the panels and bars that still read them. The forced-colours palette
  leaves SVG fills and strokes as they are, so the ring and the meters keep their colours there.

- **The SEO panels' Links, Images, Social and Schema, and the controls the panels share**
  (`seo-panels.feature.md`, Links, Images and Social; `seo-schema.feature.md`; `seo-checks.feature.md`,
  the link checks; what their components render, less the frame's and Overview's and On-Page's shared
  parts) follow the Migration notes, the token `use` notes and the canvas's component board (buttons,
  field, segmented control, chips and badges, status dots), where they agree; no screen draws these
  panels. Each panel has a `SIGNAL_SURFACES` entry listing its classes, and so do the controls the
  panels share, defined beside Links, Images and Social, the first panels that draw them: the tools row
  and its toggles, the toast, the filters, the table of rows, the rel and loading flags, a row's
  actions and the all-clear line. They draw in Indexability, Page Speed, Compliance, Content,
  JavaScript, SERP, Visibility, Search Console and Changes too, and look the same there; those panels'
  own rules wait for their PRs, and so does `.seo-flag-chip` (the link status chip and its counts, a tone
  chip of Indexability's). Text is Geist from the `--text-*` tokens, every space a `--space-*` step, every
  corner an `--r-*`; a part's own geometry (the 18px badges, as On-Page's tag; the 16px and 18px status
  chips; the label and thumbnail columns; the raw view's 340px) stays a layout constant. The panels stand
  their cards `--space-4` apart. **Toggles** (highlight, Copy as CSV, Check links, Broken only) and **row
  actions** are the canvas's secondary button at `--h-chip`: a pill on `--bg-surface` with `--e-raised`
  and a transparent border, `--text-small` at weight 500 in `--text`, a leading `--icon-sm` icon in
  `--text-muted` (`--icon`), `--space-3` in before it and `--space-4` after the label (the canvas's 10 and
  14); a hover lays `--bg-hover` over them (an inset box-shadow, its state checks in `:where()`), a pressed
  toggle is `--accent` on `--accent-soft` with no shadow (it was a 14% `--accent` tint with an `--accent`
  edge), and under forced colours, which replace both, its edge is `Highlight` (`FORCED_COLOURS_PRESSED`).
  Disabled, a toggle or action is the token sheet's disabled control, `--text-faint` on `--bg-subtle` with no
  shadow, where it faded to half, and `GrayText`, text and edge, under forced colours
  (`FORCED_COLOURS_BUSY`). The **toast** is `--on-inverse` on `--inverse` at `--r-pill` with `--e-overlay`
  (it was `--text` on `--bg-chrome` with a literal shadow, darker in dark), fading in `--dur-base`. The
  **search field** is a field inside a card (`--radius-field`: "--r-sm inside cards", as Settings' fields): `--h-control` tall
  at `--r-sm` on `--bg-surface` with `--e-raised` and a transparent border, its icon `--text-muted`, its
  text `--text-body`, its placeholder `--text-faint`; focus (`:focus-within`) is `--focus-ring` where it
  was an `--accent` edge with a halo. The **rel select** is the same field. The **segmented control** is the
  canvas's: an `--r-pill` track on `--bg-subtle` with `--space-1` inside and between, its segments
  `--h-chip` pills in `--text-muted` (`--text` hovered), the chosen one raised (`--bg-surface`, `--e-raised`,
  `--text`; it was `--seo-card` with a literal shadow), each count `--text-faint`; a disabled segment
  (Schema's Tree for a block that did not parse) is `--text-faint`, where it faded. **Filter chips** are
  the canvas's chips: `--h-chip` pills on `--bg-subtle` (they were outlined by `--border-field`) in
  `--text-muted`, pressed `--accent` on `--accent-soft`. **Rows** (a link, an image) are ruled by
  `--divider`, each an `--r-sm` button, `--bg-hover` hovered or open, its title `--text-body` at weight
  500, its URL `--text-mono` or its line `--text-small` in `--text-muted`, a missing title or URL
  `--text-muted` in italics (`--text-faint` is 4.26:1 on a hovered row in dark), the count above them
  `--text-small` in `--text-faint`. A broken link's row loses its inset 2px `--danger` edge, which hid
  the focus ring (a box-shadow at a higher specificity) and was a coloured side bar: its status chip
  says "Broken". Focus on every control is `--focus-ring` beside a transparent 2px outline
  (`FOCUS_RING_RULES`), where they had a 2px `--accent` outline. **Badges** (a link's kind, its rel and
  target flags, Images' loading flags and alt badge, Schema's types) are On-Page's tag: 18px at `--r-xs` in `--text-micro`, on
  `--bg-subtle` in `--text-muted`, a status one its `-soft` fill with `-ink` text (alt present `--ok`, a
  missing alt and a loading problem `--warn`), an internal link `--accent` on `--accent-soft`. They were
  10px bold system monospace, and a link's kind and rel flags took the page highlight's hues (internal
  `#1f6feb`, external `#d4670c`, nofollow `#c42b5c`, and a violet and a teal; 17 literal hex with their
  dark overrides): one accent, no second hue, so an external link, "other" and the rel flags are
  neutral; each says its word, and the highlight in the page (`HIGHLIGHT_STYLES`, painted into the page,
  not the chrome) keeps its colours and labels. The all-clear line is `--ok-ink`. **Links:** the rel
  counts `--text-small` at weight 600; the link status notice a `--bg-subtle` note at `--r-sm` in
  `--text-muted`, its summary `--text-small` in `--text-muted`. **Images:** a row's facts `--text-small`,
  their labels `--text-caps` in `--text-muted` (`--text-faint` on a hovered row is under 4.5:1 in dark), a
  missing width and height `--warn-ink` (`--caution`). **Social:** a share card is `--bg-surface` at
  `--r-md` with `--e-ring` and a transparent border (`--seo-card-edge`, `--bg-field`), its rules
  `--divider`; its image label `--on-inverse` on `--inverse` in `--text-micro` (a literal translucent
  navy with white text); its domain `--text-small` in `--text-faint`, title `--text-body` at weight 600,
  description `--text-small` in `--text-muted`; the headings over the cards `--text-small` at weight 600 in
  `--text-muted`. **Schema:** the summary's status mark is shaped as the rail's dots (valid a filled `--ok`
  disc, warnings a 2px `--warn` ring, errors a filled `--danger` square; it was a disc in three hues with a
  tinted halo) and keeps its colours in forced colours (`FORCED_COLOURS_KEPT`), its verdict `--text-body`
  at weight 600; a top-level type count is a badge and its count `--text-micro` in `--text-muted`, ringed by
  `--e-ring` with a transparent border (`--accent` text on an `--accent-soft` tint over `--bg-subtle` is 4.18:1 in dark; the badge text is now `--accent-hover`, 5.47:1 there in dark); a block's
  status is a frame badge (`--h-badge` pill, `-ink` on `-soft`: valid `--ok`, cut `--warn`, invalid
  `--danger`), its types `--text-small` in `--text-faint`; counts by severity `--text-small` at weight 600, a
  zero `--text-faint`, icon and all (it faded), and `GrayText` under forced colours; a node's issue a
  `-soft` notice at `--r-sm` (error `--danger-soft`, warning `--warn-soft`, notice `--accent-soft`, where
  they were 8–10% tints; `--info-tone` → `--accent`) with a transparent border, its title `--text-small` at weight 600
  and its detail in `--text-muted`; the tree's rows `--r-sm`, `--bg-hover` hovered, a name `--text-body` at
  weight 500, its guide lines `--divider`; a property's name `--text-mono` in `--text-muted`, its count
  `--text-micro` in `--text-faint`; values `--text-small` (`--text-mono` for a literal or URL), a literal
  `--accent` (`--info-tone`); the open-URL button an `--h-badge` square at `--r-xs`, its icon
  `--text-muted` (`--icon`), `--accent` on `--bg-hover` hovered, disabled `--text-faint` at half strength
  (the chrome's disabled tool) and `GrayText` under forced colours; a reference a dashed `--accent` (40%)
  edge at `--r-sm`; the raw view `--text-mono` on `--bg-subtle` at `--r-sm` with a transparent border,
  `--danger` when the block did not parse (`--seo-bg`, `--seo-card-edge`), the error line a
  `--danger-soft` notice with its position in `--danger-ink`, the error's character `--danger-ink` on
  `--danger-soft` ringed in `--danger` (it was white on `--danger`) with a transparent outline forced
  colours draw, an invisible character's code point `--warn-ink` on `--warn-soft` in `--text-micro`;
  "Show more" `--text-small` at weight 500 in `--accent`, `--bg-hover` hovered. A rule that only set a
  `line-height` (a flag cut with ellipsis, the link status chip, its counts, a type badge) now centres
  its text by padding or a fixed height, since a surface rule takes its type from a token. The pending,
  unavailable and empty states were all the frame's (#37), so nothing there moved. No retired name these
  panels read is unread elsewhere, so none is `removed`; each later panel PR removes the ones its rules
  were the last to read. **Council round 1** (PR #46): a tinted badge in a row button lies over
  `--bg-hover` when the row is hovered or open, and `--accent` on `--accent-soft` there is 3.84:1 in dark,
  so the badges that drew it in these panels (a link's "int", Schema's type badges, an entity row's
  notice count, which is the frame's info badge) take `--accent-hover` (6.19 light, 5.03 dark hovered;
  6.80 and 5.96 at rest); `CONTRAST_PAIRS` composes the tinted badges over the hovered row (`under`), and
  the `-ink` on `-soft` badges pass there (alt, missing alt, loading flags, an entity's warning and
  error counts: 5.30 or more); the neutral badges' `--bg-subtle` is opaque. A raised control's hover
  overlay skips a pressed one (`HOVER_OVERLAYS_SKIP_PRESSED`): the Inspector's Tree, Rendered and Served
  buttons are `.seo-action`s, and `--accent` on `--bg-hover` over the pressed `--accent-soft` was 3.78:1 in
  dark. A nameless entity's "No name" is `--text-muted`, as "No anchor text". A pressed filter chip draws
  an `--accent` edge on its transparent border (`PRESSED_EDGES`; its fill alone is 1.06:1 off an unpressed
  chip in light), 3:1 or more on its fill and on the card. Three rules of later panels faded a disabled
  chip by `opacity: 0.5` over the shared rule's `--text-faint` (SERP's snippet sources, Changes' shot
  kinds, the AI judgment's targets in `ai-checks.css`): those declarations went. **Council round 2**: a
  disabled chip or segment keeps its fill, so its text is `--text-faint` at half strength
  (`DISABLED_INK`, as the toolbar's disabled tool and Schema's open-URL button; plain `--text-faint` is
  1.40:1 off the enabled `--text-muted` in light), pinned by `DISABLED_CONTROLS`; a disabled toggle or row
  action also loses its fill and shadow and goes from `--text` to `--text-faint`, so it keeps plain
  `--text-faint`.

- **The rest of the browser chrome** (the bands under the chrome row, the page area's panels, the
  DevTools drawer and the History sheet: `browser-chrome.feature.md`, `browser-polish.feature.md`,
  `render-profile.feature.md`, `devtools.feature.md`, `update-client.feature.md`) follows the
  Migration notes, the token `use` notes and the canvas's band slot, buttons, field and segmented
  control, where they agree. The chrome's PR already moved the permission prompt, the fullscreen
  notice and the page area's frame; its entry now also lists `.page-column` (layout only: the page area
  and the sheets above it). Each piece has its `SIGNAL_SURFACES` entry: the error and crash panels
  (`.panel`), the render profile (no shared prefix: `.render-*`, the tab badge `.tab-profile-*`, the
  status chips `.status-render-profile-*` and `.status-tab-overrides`), the DevTools drawer
  (`.devtools`), the find bar (`.find`), History (`.history`) and the update notice (`.update`). Text
  is Geist from the `--text-*` tokens, every space a `--space-*` step, every corner an `--r-*`, every
  rule `--divider` (`--bg-chrome-edge`), and focus `--focus-ring` beside a transparent 2px outline
  (they were 2px `--accent` outlines), after the hovers, whose state checks sit in `:where()`
  (`FOCUS_RING_RULES`). A disabled button is the token sheet's "--text-faint on --bg-subtle, no
  shadow" (it faded), `GrayText` under forced colours (`FORCED_COLOURS_BUSY`).
  **Bands.** The render-profile editor bar, the find bar and the update notice take the canvas's band
  slot, as the permission prompt did: "same shell for every band", an `--accent-soft` band at `--r-md`
  inset by `--space-3` under the chrome row, at least 44px high, with no edge or shadow (`--bg-prompt`,
  `--prompt-edge` and `--shadow-prompt` are `removed`; a transparent border stays for forced colours),
  its lead icon a bare `--accent` glyph (the update notice's sat on a tinted tile). So the find bar is
  52px with its inset where it was 40 (`--find-height`: "find is a band (≥ 44px)", `removed`), and the
  update notice's row 52 where it was 49; the page area moves down by the difference, and the tab's
  view with it (main lays it over the page area's box, whatever the rows above it measure). Band
  buttons are `--h-chip` pills (the canvas's "band buttons"): a secondary one on `--bg-surface` with
  `--e-raised` (hover lays `--bg-hover` over it), the primary one `--accent` with `--on-accent`
  (`--accent-hover` hovered; the update notice's Download and Show file were outlined `--accent` text,
  where the canvas fills them), a quiet one (Release notes, Later) transparent in `--text`, `--bg-hover`
  hovered; the close and dismiss buttons `--h-chip` circles in `--text-muted`. **Update notice:** its
  text `--text-body` in `--text-muted`, the headline `--text` at 600, release notes `--text-small`; a
  failed update is a `--danger-soft` band with a `--danger` icon (its words say what failed). **Find
  bar:** the input an `--h-chip` pill on `--bg-surface` with `--e-raised`, `--focus-ring` focused (it was
  an `--accent` border with a 3px `--accent-soft` halo); the count `--text-small` in `--text-muted`, "no
  matches" `--danger-ink` (it was `--danger`); its tools `--h-chip` circles in `--text-muted` (`--icon`),
  disabled `--text-faint` at half strength as the chrome's tools; Match case, pressed, is the canvas's
  segmented control's pressed item (`--bg-surface`, `--e-raised`, its "Aa" `--accent`; it was
  `--accent-soft`, which the band already is), `Highlight` under forced colours
  (`FORCED_COLOURS_PRESSED`); the divider `--divider`. **Render-profile editor bar:** its labels
  `--text-caps` in `--text-muted` (they were 10.5px `--text-faint`), the quick profiles `--h-chip`
  secondary pills (`--render-edge` and `--render-accent` under the pointer → `--bg-hover`), the selects
  and the user-agent and location fields `--h-chip` pills on `--bg-surface` with `--e-raised` (`--r-pill`:
  `--radius-field`), the user agent in `--text-mono`; Apply is the primary button, Reset a secondary
  one; checkboxes `accent-color: --accent`; errors `--danger-ink`; its notes `--warn-ink` on
  `--warn-soft` at `--r-sm` (a 10% `--caution` tint), the failed overrides' `--danger-ink` on
  `--danger-soft`; a tag in the bar (CSS off) a `--bg-surface` chip. **Page-area frame:** one accent,
  no second hue (`--render-accent`, `--render-soft`, `--render-edge` → `--accent`, `--accent-soft`,
  `--accent`, all three `removed`): the 4px edge and the device's outline `--accent`, the 30px header
  `--accent` with `--on-accent` text (`RENDER_FRAME` keeps its 30px header and 4px inset, so the view
  doesn't move), its tags outlined in `--on-accent` at 62% (a white 18% fill left their 11px text at
  3.5:1 in light; the edge, the one thing that groups a tag, is 3.41:1 on the header in light and 3.42:1 in
  dark, where 45% was 2.48 and 2.38), the failed tag `--danger` with `--on-accent`; its buttons `--h-badge` pills outlined
  the same way (62%, so the controls' edge is no weaker than the static tag's; `CONTRAST_PAIRS` computes it), hovered `--accent-hover`, the primary one (Reload to apply) `--on-accent` with `--accent`
  text (its two literal whites and the bar's third went). **Tab badge and status chip:** the badge is an
  `--icon-size` square at `--r-xs` on `--accent-soft` with an `--accent` icon, edged `--accent` (a border,
  not an inset shadow) while the tab needs a reload or the profile failed (its name says which); the
  status chip an `--h-badge` pill on `--accent-soft` in `--text-small` at weight 500, `--accent` text.
  The toolbar's render toggle, while a profile is in force, is `--accent` on `--accent-soft`, as the SEO
  toggle pressed; pressed, its edge is `--accent` (`--render-edge`).
  **Error and crash panels:** on `--bg-page` (the page area's), `--space-7` in; the art keeps its 76px
  badge, now at `--r-lg` with no inset edge, filled with its tone at 10% over the page (opaque, so the
  art's gap strokes match it): `--text-faint` (`--panel-art`, `removed`), `--danger` for a certificate
  error, `--warn` for a crash; the title `--text-display` (it was 22px), the message `--text-body` in
  `--text-muted` (14px), the error code `--text-mono` in `--text-faint` on `--bg-subtle` at `--r-sm` (on
  `--bg-hover` it was 4.2:1 in dark). Its buttons (`.panel-button`) are the app's secondary button:
  `--h-control` pills on `--bg-surface` with `--e-raised` and a transparent border (`--border-field`,
  `--shadow-field`, `--radius-control` and `--bg-field-hover`: hover lays `--bg-hover` over it), icons
  `--text-muted` at `--icon-sm`, the primary one `--accent` (`--accent-hover` hovered). Every panel that
  draws a `.panel-button` (Changes, Projects, the Crawl and AI answers sheets, the SERP, Visibility,
  JavaScript, Compliance and Search Console panels, the SEO sidebar's Retry) gets it too, the same
  there; it keeps their face (the rule sets no font: the error panel's own text sets `--text-body`), and
  their own rules that fade a disabled one (`.changes-capture`, `.inspector-pick`, `.seo-a11y-run`) wait
  for their PRs. The editor bar's checkbox labels still fade while disabled
  (`.render-check:has(input:disabled)`, `opacity: 0.5`): a native checkbox can't take the disabled colours, so
  the label fades with it. **DevTools drawer:** a `--bg-sheet` band ("rail, sidebar, agent panel") with a
  `--divider` top edge (`--bg-chrome`), its text `--text-small`; the resize edge `--accent-soft` under
  the pointer and `--accent` focused (inside it, a transparent outline forced colours draw: the drawer
  clips anything outside); tabs `--h-chip` pills in `--text-muted` at weight 500, `--bg-hover` hovered,
  the selected one the segmented control's pressed item (`--bg-surface`, `--e-raised`, `--text`; it was
  `--accent-soft`), `Highlight` under forced colours (`FORCED_COLOURS_PRESSED`); the toolbar's search
  and selects and its buttons `--h-badge` pills on `--bg-surface` with `--e-raised`; table heads
  `--text-muted` at weight 500 on `--bg-sheet`, rows ruled `--divider` (they were `--bg-hover`), hovered
  `--bg-hover`, selected `--accent-soft`; status text takes its -ink (a failed request, a blocked or
  allowed robots line, a 2xx/3xx/4xx/5xx code: `--ok-ink`, `--warn-ink`, `--danger-ink`, where they drew
  `--ok`, `--caution`, `--danger`), the codes `--text-micro` on `--bg-subtle` pills (the code says the
  class, not the hue alone); the waterfall's SVG bars keep graphics colours (`--accent`, `--text-faint`
  pending, `--warn` redirected, `--danger` failed); console rows `--text-mono`, a warning on `--warn-soft`
  and an error on `--danger-soft` (they were literal 8% tints), the repeat count an `--accent-soft` pill,
  the source `--text-muted` (`--text-faint` is 4.45:1 on `--danger-soft`); headings `--text-caps` in
  `--text-muted`; a masked header value `--text-faint` with no letter-spacing of its own. **History:**
  a `--bg-surface` sheet; its title `--text-title` (20px), day labels `--text-caps` in `--text-muted`,
  sticky on the sheet; the search an `--h-control` pill on `--bg-surface` with `--e-raised`, `--focus-ring`
  within (`:focus-within`; it was an `--accent` border and halo); Clear a secondary button in
  `--danger-ink` (it was `--danger`), More a secondary button, the selects `--h-control` at `--r-sm` with
  `--e-raised` (Settings'); rows `--h-field` at `--r-sm`, `--bg-hover` hovered, the time and host
  `--text-small` in `--text-muted` (`--text-faint` is 4.26:1 on a hovered row in dark), the time on one line
  in a 64px column (60px in a narrow column; "01:36 PM" wrapped in Geist at 56px), the label `--text-body`; the close and row actions `--h-control` and
  `--h-chip` circles in `--text-muted` (`--icon`); the monogram an `--h-badge` square at `--r-xs` on
  `--accent-soft`, its letter `--accent-hover` at `--text-micro` (it was 700, which Geist isn't bundled in);
  a row's change count an `--h-badge` pill in `--text-micro`, `--accent-hover` on `--accent-soft` (both lie
  over `--bg-hover` on a hovered row, where `--accent` is 3.84:1 in dark; `--accent-hover` is 5.03 there
  and 6.19 in light). Retired
  names these pieces were the last to read are `removed`: `--find-height`, `--bg-prompt`,
  `--prompt-edge`, `--shadow-prompt`, `--render-accent`, `--render-soft`, `--render-edge`,
  `--bg-field-hover`, `--shadow-field` and `--panel-art`. The others they read stay for the panels that
  still do (`--bg-chrome-edge`, `--border-field`, `--radius-control`, `--radius-field`, `--icon`,
  `--caution`). Two rules drew `--ok` as text (the robots line, a 2xx code) and the frame's three literal
  whites were hex, so this PR takes 2 off the `--ok`-as-text exception and 3 off the hex ratchet. The visual baseline
  gains `page-error` (a load Chromium refuses: `http://127.0.0.1:9/`, `ERR_UNSAFE_PORT`, so no request is
  made and nothing varies). A disabled button's colours are pinned (`TEXT_COLOUR_RULES` with `unfaded`:
  `--text-faint` on `--bg-subtle` and no `opacity` under 1, for `.panel-button`, primary or not, the update
  notice's buttons, the quick profiles and the drawer's buttons), so a fade put back fails. A row
  button in the drawer's table is a block that ellipsizes its own name, and the cells have `--space-1`
  of block padding, so its `--focus-ring` is drawn whole inside the clipping cell.

## Rollout
1. Screenshot baseline (Playwright, light and dark).
2. Foundation (done).
3. Values (done): re-point the aliases and swap the shared names to their Signal values; Geist is
   bundled (done, its own change), applied per surface through the `--text-*` tokens from step 4 on
   (the command palette first); `--font-ui` stays the system stack.
4. One PR per surface: rules move onto Signal tokens, retired names go (`removed`). The command
   palette is first (its `--palette-*` names `removed`), then the new-tab view (its `--start-*` and
   `--jump-*` names), the agent panel (its `--agent-*` names, but the aliases `--agent-bg` and
   `--agent-card`), Settings and Help (`--settings-switch-off`; `--settings-width` and
   `--settings-nav-width` stay layout constants), then the SEO sidebar's frame and shared parts
   (`--seo-skeleton` and `--seo-skeleton-shine`; the panels still read `--seo-card-edge`, `--caution`,
   `--info-tone` and `--bg-chrome-edge`), then the browser chrome's rows (`--tabstrip-height`,
   `--toolbar-height`, `--status-height`, `--bg-strip` and `--bg-tab-hover`), then the merged 56px row
   (`--h-chrome`; markup and the keyboard contract), then the SEO panels' interiors, Overview and
   On-Page first (no name retired: later panels read them all), then Links, Images, Social and Schema
   with the panels' shared controls (none retired either), then the rest of the browser chrome
   (`--find-height`, `--bg-prompt`, `--prompt-edge`, `--shadow-prompt`, `--render-accent`, `--render-soft`,
   `--render-edge`, `--bg-field-hover`, `--shadow-field` and `--panel-art`). The palette is the first to apply Geist (a rule reading `--text-*`); a font can
   now load whenever such text is drawn, so `geist-fonts-load` records font requests from launch, not
   from the moment the test starts watching.

## Unit (`apps/desktop/src/__tests__/design-tokens.test.ts`)
- **Scenario: tokens-stylesheet-holds-only-root-tokens** — `tokens.css` has only `:root` blocks
  (light, and dark under the media query) holding only custom properties, never one name twice in a context, and a dark value only overrides
  a light one.
- **Scenario: signal-tokens-are-defined** — every Signal token is in light; every colour, state and
  elevation token is in dark too, and nothing else is; every Signal token, shared names included,
  has exactly its spec values; `--icon` stays a colour.
- **Scenario: legacy-tokens-are-defined** — the migration map has all 89 legacy names; every one not
  `removed` is in `tokens.css`, which holds nothing beyond legacy and Signal names, and every
  replacement named is a Signal token.
- **Scenario: removed-legacy-tokens-are-gone** — only `retire` rows are `removed`; a `removed` name is
  declared in neither theme of `tokens.css`, and no renderer source (`.css`, `.ts`, `.tsx`,
  `index.html`) mentions it outside a comment.
- **Scenario: legacy-token-values-are-pinned** — the 89 legacy names' light and dark values match a
  committed snapshot (the values step updated it on purpose: the aliases became `var()`, their dark
  entries went, and the shared names took their Signal values; each surface PR drops its `removed`
  names from it).
- **Scenario: legacy-aliases-point-at-signal-tokens** — every alias whose Signal token has another
  name is exactly `var(<signal>)` in light and has no dark override; the self-aliases are exactly
  the shared names; `--w-panel` and `--w-rail` equal `SIDEBAR_PANEL_WIDTH` / `SIDEBAR_RAIL_WIDTH`
  (`specs/seo-sidebar.spec.ts`).
- **Scenario: signal-contrast-meets-aa** — every `CONTRAST_PAIRS` pair reaches its minimum WCAG 2.x
  contrast ratio in light and in dark, read from `tokens.css` (`var()` resolved, translucent colours
  composited, a translucent `over` on its opaque `under` first: a tinted badge over a hovered row; a pair
  whose `under` is translucent or whose `over` is opaque fails before compositing); the ratio helper matches known values (black on white 21:1, `#777` on white ≈ 4.48).
- **Scenario: known-contrast-exceptions-are-current** — each `KNOWN_CONTRAST_EXCEPTIONS` pair still
  misses its minimum in at least one theme, is not in `CONTRAST_PAIRS`, and exactly `rules`
  declarations in the renderer's stylesheets draw text in its `fg` (so fixing them removes the entry).
- **Scenario: tab-strip-sets-tabs-off-the-strip** — in light and dark, against the (opaque) strip
  (`TAB_STRIP.strip`), the active tab's fill reaches `TAB_STRIP.minActiveOnStrip`, an inactive tab's
  (`TAB_STRIP.idle`, composited over the strip) `minIdleOnStrip` and a hovered tab's (`TAB_STRIP.hover`,
  composited over the strip) `minHoverOnStrip`; `TAB_STRIP.activeIndicator` reaches `minIndicator`
  against the active, inactive and hovered fills (each composited over the strip) and the strip itself;
  and the cascades over `TAB_STRIP.activeTab` and `TAB_STRIP.activeTabHovered` in `styles.css` each give
  the active tab a `box-shadow` holding `TAB_STRIP.activeIndicatorShadow` (`inset 0 -2px 0
  var(--accent)`, the whole term), so the cue is really drawn, under the pointer too.
- **Scenario: text-colour-rules-resolve** — for each `TEXT_COLOUR_RULES` entry, in light and dark,
  the cascade over its `element` selectors in its stylesheet resolves `color` to `var(<color>)` (and
  `background` to `var(<background>)` where the entry names one), and that pair is in
  `CONTRAST_PAIRS`; for an `unfaded` entry (a disabled button shown by its colours), `opacity` resolves to
  nothing under 1, so a fade put back in place of the colours fails.
- **Scenario: focus-rings-outlast-hover-and-busy** — for each `FOCUS_RING_RULES` entry (Settings' and
  Help's controls, the chrome's tools, tabs, new-tab button, address bar and prompt buttons, an SEO
  issue's heading row and the panels' link button, the panels' toggles, row actions, segments,
  chips, select, search field and rows, and Schema's entity rows, references, open-URL button and
  "Show more", and the rest of the chrome's: the error panels' and the bands' buttons, the find bar's
  field and tools, the editor bar's chips and fields, the frame's buttons, the DevTools drawer's tabs,
  buttons, links and fields, and History's controls), in light and
  dark, the cascade over its `element` selectors in its stylesheet (specificity, with `:where()` adding
  none and a selector list split only outside parentheses, then source order) resolves `box-shadow` to
  `var(--focus-ring)` and `outline` to `2px solid transparent`, and sets no `opacity` under 1: a focused
  button keeps its ring, at full strength, when hovered, when busy (`aria-disabled`) and when primary;
  so does a focused switch, and the chosen choice. The resolver itself scores
  `.a:hover:where(:not([x], :disabled))` as two classes.
- **Scenario: busy-buttons-show-under-forced-colours** — for each `FORCED_COLOURS_BUSY` entry (a
  Settings button, a primary one and Export Diagnostics' Save, each busy and disabled; a disabled
  toolbar tool; the permission prompt's buttons before they arm; Overview's zero-count pill; a disabled
  panel toggle, row action, segment, filter chip and Schema's open-URL button; a disabled error-panel
  button, primary or not, update notice button, find bar tool, editor bar chip or button), in light and
  dark, the cascade over its `element` selectors with the `@media (forced-colors: active)` rules read
  too (a `border` shorthand counting as its colour) resolves `color` and `border-color` to `GrayText`:
  busy is shown by colour, which forced colours replace, and no later rule of the control's own wins
  over it. Every selector named is one of the stylesheet's.
- **Scenario: pressed-toggles-show-under-forced-colours** — for each `FORCED_COLOURS_PRESSED` entry (the
  SEO sidebar toggle and the render-profile toggle, pressed; a panel toggle, the chosen segment and a
  filter chip, pressed; the find bar's Match case, pressed; the DevTools drawer's selected tab), in light
  and dark, the cascade over its
  `element` selectors with the `@media (forced-colors: active)` rules read too resolves `border-color` to
  `Highlight`. Every selector named is one of the stylesheet's.
- **Scenario: status-marks-keep-their-colours-under-forced-colours** — for each `FORCED_COLOURS_KEPT`
  entry (the SEO rail's dots, Overview's category marks: pass, error, warning and notice; Schema's status
  mark: valid, warnings, errors), in light and
  dark, the cascade over its `element` selectors with the `@media (forced-colors: active)` rules read
  too resolves `forced-color-adjust` to `none`, so a mark whose fill or border colour is its status keeps
  it. Every selector named is one of the stylesheet's.
- **Scenario: only-kept-marks-opt-out-of-forced-colours** — every `forced-color-adjust` declaration in
  every renderer stylesheet, whatever surface its rule belongs to and whatever its value (`auto` too:
  a rule handing an element back to forced colours is not supported yet, and none exists), sits in a
  rule each of whose selectors a `FORCED_COLOURS_KEPT` entry for that stylesheet names, and a kept
  mark's is `none` (a nested `auto` would hand it back unseen by the cascade check); a declaration
  in a nested at-rule is matched on its nearest enclosing selector. It passes the kept marks at the top
  level, inside `@media (forced-colors: active)` and with that block nested in their rule; it catches
  `.seo-speed-source` (a panel not yet converted) in `styles.css`, `.seo-overview` and the kept
  `.seo-rail-dot` in `settings.css`, `auto`, a list with one unkept selector, an unkept rule with a
  nested block and a kept mark set to `auto` in a nested block.
- **Scenario: hover-overlays-skip-pressed-controls** — for each `HOVER_OVERLAYS_SKIP_PRESSED` entry
  (the panels' toggle and row action), its stylesheet has a hover rule for the control, and every rule
  with a compound selector holding the control's class and `:hover` (any order, after any ancestor) that
  sets `box-shadow` or `background` names `[aria-pressed='true']` in a `:not(…)` of that compound. It
  passes `.x:hover:where(:not(:disabled, [aria-pressed='true']))`, catches `.x:hover:where(:not(:disabled))`,
  `.x:hover { background }`, `.x.y:hover`, `.x:not(:disabled):hover` and `.tools .x:hover`, and ignores a
  hover that sets only `color` and `.x-danger:hover`.
- **Scenario: disabled-controls-dim-their-text** — for each `DISABLED_CONTROLS` entry (a disabled
  filter chip and segment), in light and dark, the cascade over its `element` selectors resolves `color`
  to `DISABLED_INK`.
- **Scenario: pressed-controls-draw-an-edge** — for each `PRESSED_EDGES` entry (a pressed filter chip),
  in light and dark, the cascade over its `element` selectors resolves `border-color` to `var(<edge>)`
  with a border that draws (non-zero width, a style other than `none` or `hidden`, shorthand included;
  it catches `border: 0 solid transparent` and `border-style: none`), and `CONTRAST_PAIRS` holds the edge on each of its `fills` at 3:1 or more. Every selector named is one
  of the stylesheet's.
- **Scenario: no-other-stylesheet-declares-root-tokens** — no other renderer stylesheet declares a
  custom property in a rule whose selector starts with `:root` or `html` (`html.x`,
  `:where(:root)`, … included).
- **Scenario: tokens-load-before-every-other-stylesheet** — `main.tsx` imports `tokens.css` first
  among stylesheets and before `App`.
- **Scenario: surface-rules-read-signal-tokens** — for each `SIGNAL_SURFACES` entry, every rule of the
  surface in its stylesheet (any selector in its list names one of the surface's classes on a class
  boundary, at any nesting: `@media`, `@container`; or it is in the surface's `@keyframes`; an entry's
  listed `classes` each start with its prefix, an entry with no prefix lists its classes, and its
  `keyframes` come only with them) reads only
  Signal tokens, legacy aliases and component-scoped custom properties (declared in the same
  stylesheet) in `var()` (whitespace allowed, no fallback in any property); declares no Signal or
  legacy name; holds no hex colour or colour function in any property; a colour-bearing value
  (`background-image` and custom properties included) holds only those, `transparent`,
  `currentColor`, `inherit`, `none`, lengths and `color-mix()` (so hex, `rgb()`, a gradient, `unset`,
  `initial`, any named colour fail; `text-decoration` may also name its line and style keywords, and
  a rule inside `@media (forced-colors: active)` the CSS system colours, `FORCED_COLOURS_SYSTEM_COLOURS`); a
  rule whose `box-shadow` reads `--focus-ring` sets an `outline` forced colours draw (non-zero width,
  not `none`: `outline: 2px solid transparent`); a rule setting `forced-color-adjust` has every selector
  named by a `FORCED_COLOURS_KEPT` entry for its stylesheet, its nearest enclosing selector when the
  declaration sits in a nested at-rule (it catches `.palette-x { forced-color-adjust: none; }`, and
  passes `.seo-rail-dot` in `styles.css`, also as `.seo-rail-dot { @media (forced-colors: active) { … } }`); no `font-size`, `font-family` or `line-height`; `font` only `var(--text-*)`; a
  rule whose `--text-*` token has a non-zero tracking sets exactly that `letter-spacing`, and any
  `letter-spacing` equals the tracking of the token its own rule sets; a `font-weight` is one
  `BUNDLED_FONTS` has for the family of its rule's own `--text-*` token (or for Geist when the rule
  inherits its font); at least one rule sets `font: var(--text-*)`. The guard itself catches a mixed
  selector list, an ancestor-qualified selector, `var( --retired)`, a named colour, a `var()`
  fallback (in a colour and in `padding`), a colour in the surface's keyframes, a caps rule without
  its letter-spacing, a body rule with caps letter-spacing, a gradient `background-image`,
  `color: unset`, Geist Mono at 500, a redeclared Signal or legacy name, a component property holding
  `rgb()`, `rgb()` in `filter`, hex in `scrollbar-color`, a `--focus-ring` with `outline: 0` or
  no outline, `GrayText` outside a forced-colours block and a named colour inside one; it accepts a component property (`--tone-ink: var(--ok-ink)`) read in the same rule,
  `text-decoration: underline`, `--focus-ring` beside `outline: 2px solid transparent`, and `GrayText`
  inside `@media (forced-colors: active)`; it ignores
  `.palettes`, `.x-palette`, and `.table-*` for a `.tab` surface. Each class and keyframes name an entry
  lists matches at least one rule of its stylesheet (a stale name fails, and so does a `-*` family with
  no member). For a surface that lists its classes
  (`.seo`, `.seo-panel`, `.seo-chip`, `.seo-rail-*`, keyframes `seo-panel-in`) it checks those, the
  `-*` family's members and the listed keyframes, and ignores the panels' classes under the same prefix
  (`.seo-links`, `.seo-panel-tools`, `.seo-chip-button`, `.seo-chips`, `.seo-toggle`), `.seo-railway`,
  `.x-seo-rail`, `.seos` and any other keyframes (`seo-ring-fill`, `seo-panel-in-more`). For a surface
  with no prefix (a fixture like the browser chrome's: `.tabstrip`, `.tab`, `.address-*`, keyframes `tab-spin`) it checks
  exactly those (`.tab[data-active='true']`, `.tab:has(.tab-main:focus-visible)`, `.address-input`) and
  ignores `.tabs`, `.tab-profile`, `.tabstrip-x`, `.addressbook`, `.x-tab` and `tab-spin-more`.
- **Scenario: hex-colours-do-not-grow** — the literal hex colours outside `tokens.css` (comments
  aside) stay at or under `HEX_COLOUR_RATCHET`.

## Unit, fonts (`apps/desktop/src/__tests__/fonts.test.ts`)
- **Scenario: bundled-fonts-cover-the-type-scale** — the (family, weight) pairs of `BUNDLED_FONTS`
  are exactly those the `SIGNAL_TOKENS.type` `font` shorthands use (each shorthand's weight and first
  family), plus Geist at `TEXT_BODY_EMPHASIS_WEIGHT` (which `--text-body`'s `use` names); every file
  is a static, upright woff2.
- **Scenario: fonts-stylesheet-declares-bundled-fonts** — `fonts.css` holds only `@font-face` blocks,
  exactly one per `BUNDLED_FONTS` entry (its family, weight, `font-style: normal`,
  `font-display: block`), each `src` a single local `url('@geist-fonts/<file>') format('woff2')` (no
  `http(s):`, no `data:`); the renderer's Vite config aliases `@geist-fonts` to the installed
  package's `dist/fonts/`; `main.tsx` imports `fonts.css` right after `tokens.css`.
- **Scenario: geist-is-pinned-and-installed** — `apps/desktop/package.json` pins `geist` to exactly
  `GEIST_PACKAGE.version` (no range); the installed package has that version; each `BUNDLED_FONTS`
  file exists there, larger than Vite's 4 KB inline limit (so it is never inlined as `data:`), and
  starts with the woff2 signature `wOF2`; its `LICENSE.txt` is the SIL Open Font License 1.1; and
  `NOTICE_PACKAGES` lists `geist`.

## End to end (`apps/desktop/e2e/fonts.e2e.ts`, the built app)
- **Scenario: geist-fonts-load** — a test-only main-process preload (`e2e/font-request-log.cjs`,
  required before the app's own code) records, from launch, every `app:` request for a woff2 with its
  response, and every console message of every page with that page's URL. In the chrome
  (`app://app/`), once the document has loaded (so the `@font-face` rules are registered) and with a
  `securitypolicyviolation` listener installed first, `document.fonts.load()` of each `BUNDLED_FONTS`
  face resolves to a loaded `FontFace` of that family and weight, whether or not a rule had already
  drawn it. Every `@font-face` `src` `url()` in the chrome's stylesheets resolves under
  `app://app/assets/` (so none is a CDN or `data:`), and so does every font entry in the chrome's
  Resource Timing buffer (kept from navigation start; a font fetched from any other origin would be
  there). One snapshot of the recorded requests, taken once they name a URL per bundled face, has
  exactly one URL per face, all under `app://app/assets/`, each answered 200 `font/woff2`. No CSP
  violation was reported: no event, and no CSP console message from an `app:` page since launch (a
  tab's own console is not the chrome's); a probe the chrome logs first is seen in that log with its
  `app:` URL, so the log is known to record. (The chrome page can't be reloaded to start clean: its
  navigation guard aborts that. No `session.webRequest` listener is used: one per event per session
  would replace the app's own.)
