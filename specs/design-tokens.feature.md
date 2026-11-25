# Feature: Design tokens (Signal foundation and values)

Spec: `specs/design-tokens.spec.ts` (`TOKENS_STYLESHEET`, `SIGNAL_TOKENS`, `THEMED_SIGNAL_GROUPS`,
`SIGNAL_NAMES_WITH_LEGACY_VALUES`, `LEGACY_TOKEN_MIGRATION`, `CONTRAST_PAIRS`, `GRAPHICS_ONLY_COLOURS`, `HEX_COLOUR_RATCHET`, `SIGNAL_SURFACES`,
`FONTS_STYLESHEET`, `GEIST_PACKAGE`, `GEIST_FONTS_ALIAS`, `TEXT_BODY_EMPHASIS_WEIGHT`, `BUNDLED_FONTS`, `BASE_TYPE`, `TEXT_TYPE_RULES`). Source of truth:
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
  dark, declared once per theme in the Signal part of `tokens.css`. `--icon`, the old icon colour, is
  not one: no rule read it by the cleanup, so it is `removed`; the Signal icon size is `--icon-size`.
- **Migration map: aliases point at Signal.** `LEGACY_TOKEN_MIGRATION` maps all 89 legacy names:
  `alias` (the name stays) or `retire` (replaced; removed once no rule uses it). Since the values
  step, an alias whose Signal token has another name is exactly `var(<signal>)` in light with no dark
  override, so it follows the Signal token in both themes (`--bg-chrome: var(--bg-window)`,
  `--seo-panel-width: var(--w-panel)`). Retired names keep their values until their surface PR (but
  `--bg-strip` and `--bg-tab-hover`, retuned in the values step, see Tab row), which moves every rule off them and drops them from
  `tokens.css`: the row stays in the map, marked `removed`;
  layout constants (aliases with `signal: null`) keep theirs. An alias of another Signal token goes the
  same way once no rule reads it (the cleanup, below): `removed`, never for a self-alias (a Signal
  token's own name) or a layout constant, which nothing replaces. Rules outside `tokens.css` change only
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
- **Graphics-only colours.** `--ok` is under 4.5:1 as text on a card in light (3.30:1; 3.16 on the
  sheet): a graphics colour (3:1), so no rule draws text in it (`GRAPHICS_ONLY_COLOURS`); text in its
  tone takes `--ok-ink`, and an icon draws it by `stroke`. The values step recorded the 21 rules that
  drew it as text as known exceptions (`KNOWN_CONTRAST_EXCEPTIONS`, with a rule count) and the surface
  PRs moved them (only the 11px chips moved in the values step; Settings and Help moved their 4,
  leaving 17; Overview its band label and all-clear line, leaving 15; On-Page's "Good length" drew
  `--ok` through the meter's own property, so it never counted; the panels' all-clear line, Images' alt
  badge and Schema's block status, leaving 12; the DevTools drawer its robots line and 2xx code,
  leaving 10; Page Speed's "Live" source badge, leaving 9; Content's present query term and all-terms
  mark, leaving 7; the Changes panel, Projects and Rankings their statuses, added words, captured
  targets and rises, leaving 2; AI readiness its pass, leaving 1). The cleanup moved the last, the
  address bar's secure badge (a lock icon, `color: var(--ok)` on its `currentColor` stroke), to
  `stroke: var(--ok)` on the icon, the same pixels, so the list went and `GRAPHICS_ONLY_COLOURS` took
  its place. A rule draws text in it when its `color` or `-webkit-text-fill-color` reads it anywhere in
  the value (spaces in `var( … )`, `!important`, inside `color-mix()`), or reads a custom property its
  stylesheet sets to a value that reads it (one level), at any nesting. That wider match (the first
  round of review; it had read only an exact `color: var(--ok)`) found two more icon tiles colouring
  their icon through `color`: the verdict icon of Indexability, Compliance and JavaScript
  (`.seo-verdict-icon`, `--verdict`) and of Page Speed (`.seo-speed-verdict-icon`, `--band`); they set
  the icon's `stroke` now (its only `currentColor`), the same pixels. Under forced colours a mark
  coloured by `stroke` keeps its token, where `color` gave `CanvasText`: the lock and the verdict icons
  stay above 3:1 on the forced `Canvas` only because Chromium makes `prefers-color-scheme` follow the
  contrast theme (`--ok` is about 3.2–3.3:1 on a light `Canvas`, about 12:1 on black), and nothing
  verifies this on Windows.
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
  whites, so it is 30; Page Speed's phase and resource-type hues, light and dark, held 26, so it is 4; Content's difficult-sentence chips held 4, so it is 0).
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
  `tokens.css`. The fonts were applied surface by surface, as each surface PR moved its text onto the
  `--text-*` tokens (the command palette first), and since the base face (below) the body draws Geist
  too, so Geist 400 is drawn from launch.
- **The base face.** `body` sets `font: var(--text-body)` (`BASE_TYPE`): the canvas's base, whose boards
  set Geist 13px/1.45 on their root and `font: inherit` on their buttons. It was `13px/1.4` in the system
  stack (`--font-ui`, now `removed`): the same size, a line height of 1.45 for 1.4, Geist for the system
  face. No other rule sets a font on `html`, `:root` or `body`, and no rule anywhere spells out a face: a
  `font` names a `--text-*` token or `inherit`, and only `fonts.css` names a family. Form controls take
  the font around them only where a rule says so (Chromium gives them a system font): `button` and
  `input` keep `font: inherit`, a `select` or `textarea` sets its own type through its class. Text that
  inherited the body's face because nothing around it set one sets its own now (`TEXT_TYPE_RULES`): the
  SEO panels' wrapper (`.seo`) and `.panel-button` set no font, so six texts of the visual baseline drew
  the system stack: the `.panel-button` labels Compliance's "Run accessibility check", JavaScript's "Fetch
  again", SERP's "Check for selector updates", Visibility's "Enable on-device intent" and "Classify", and
  JavaScript's "Not set". `.panel-button`, the app's secondary button, sets `font: var(--text-body)` and
  keeps its weight 500 (the canvas's buttons: body text at the emphasis weight), in every panel it sits
  in; a panel that wants another face for it names both classes (`.panel-button.x`), which wins whatever
  the order of the stylesheets. Every other panel's buttons inherited `--text-body` at 500 already, but
  one: Rankings' API-check notice (`.rankings-notice`, `--text-small`) drew its Send and Cancel at 12px;
  they are 13px now, as AI answers' Send and Cancel already were (a secondary button is one size
  everywhere; no exception rule). No capture shows that notice. A missing value (`.seo-missing`, a modifier: `--text-faint`, italic)
  takes the type of the value it stands in for: in a JavaScript field `.seo-js-value`'s `--text-small`
  (`.seo-js-field .seo-missing`, its italic restored after the shorthand). Comparing the computed type
  and box of every element of every capture, before and after, found three blocks whose text sets its own
  type but whose line box was the body's line height (a block's strut is its own font): Page Speed's
  "Since the page loaded" header, Content's result preview description row and Help's key hints. Each
  grew 0.65px a line; each now takes the type of the text it holds (`--text-caps`, `--text-small`,
  `--text-small`), so the header is 15.95px (it was 18.2) and the description's lines 16.8px (18.2), and
  the key hints, whose own boxes are taller, don't move. Review found a fourth by rendering, in no capture:
  JavaScript's "Served HTML unavailable" card (`.seo-js-state[data-verdict='unavailable']`), a plain block
  whose first line is its inline eyebrow; that eyebrow takes a line of its own (`.seo-js-state >
  .seo-eyebrow { display: block }`), so the line is the eyebrow's 14.3px, as the other verdict cards'
  eyebrows are (in a flex head). Not a `font` on the card: `--text-micro` needs its tracking beside it,
  and the card's summary, facts and button would inherit that. The cascade check reads only rules that name an element, so a
  type an element inherited from its container is invisible to it: the notice and the card were found by
  rendering every DOM state the renderer's component tests produce under main's CSS and the branch's. The three aliases the
  workspace's sheets read went in the same PR, with no pixel changed: the page card, the new-tab view,
  the error panels and Help's frame (`.page-area`, `.start`, `.panel`, `.panel-card`'s badge tint,
  `.help-sheet`) read `--bg-surface` (`--bg-page`), the agent panel's sheet (`.agent-main`) `--bg-sheet`
  (`--agent-bg`) and the SEO rail (`.seo-rail`) `--w-rail` (`--seo-rail-width`); `WORKSPACE_SHEETS`
  pins those fills. The Help frame (`.help`, `.help-sheet`) still sets no font: text in it that sets none
  inherits the body's, now `--text-body`.
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
  flat `--bg-surface` (`--bg-page` until the base face; `--start-glow`: "no gradient washes"); the FrostMark is `--accent` (`--start-mark`),
  in the tab row's empty-tab glyph too; the mark eases in over `--dur-slow` with `--ease-out`. The
  wordmark is `--text-display` (the type scale's largest: it was 44px at weight 300, which Geist isn't
  bundled in). Under it (UI polish round 2; the hint that repeated the address bar's placeholder is gone)
  the search field is the address bar's face at a larger size: an `--r-pill` on `--bg-surface` with
  `--e-raised` and a transparent 1px border (the edge forced colours draw), 44px tall (`--h-field` plus
  `--space-2`), its glyph `--text-faint`, its text `--text-heading` at weight 400 (typed text, not a heading) with a
  `--text-faint` placeholder, and `--focus-ring` around the whole field
  while it holds focus (`:focus-within`, beside a transparent 2px outline). "Jump back in" takes `--text-caps` for its
  title, and its tiles are `--bg-surface` cards at `--r-md` with `--e-ring` in place of their border
  (`--jump-tile-edge`; a transparent 1px border stays, the edge forced colours draw), the label in
  `--text-body` at its emphasis weight and the host in `--text-small`
  (`--text-faint`, 12px). A tile's monogram is an `--h-chip` square at `--r-sm` on `--accent-soft`
  (`--jump-monogram-bg`) with its letter in `--accent` at `--text-body`'s size and weight 600; History's
  monogram, which shared the retired fill, moves to `--accent-soft` too. A hovered tile rings in
  `--accent` (it was an accent border) and lifts 1px over `--dur-fast`; a focused one takes
  `--focus-ring` beside a transparent 2px outline (forced colours drop the shadow and draw the
  outline). The setup checklist under it (`help.css`), which read `--jump-tile-edge` for its border
  and `--jump-tile-bg` for its fill, takes `--e-ring` and `--bg-surface` the same way. Its progress meter
  (UI polish round 2, `help.feature.md`) is one 4px `--r-pill` segment per item on `--bg-active`,
  filled `--ok` when done (a graphic, 3:1, as the step marks), kept under forced colours
  (`FORCED_COLOURS_KEPT`) for the same reason; "Hide this checklist" is a chip-height `--text-muted`
  text button that lays `--bg-hover` under itself on hover.
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
  `--warn-ink`, field errors `--danger-ink`; the collapsed rail stayed on `--bg-window` with a `--divider` edge and the open panel flush with the
  page until the workspace's layout (`workspace-layout.feature.md`), which makes both floating sheets
  (`--bg-sheet` at `--r-lg` with `--e-sheet`, `--space-3` off the page). Nothing in
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
  `--h-control` tall, its step marks 1px `--switch-off` rings (Later states: 1.5px, drawn as 1px) filled `--ok` (a graphic) when done, kept under forced colours (`FORCED_COLOURS_KEPT`), "Done"
  `--ok-ink`, and its actions `--h-chip` pills on `--bg-surface` with `--e-raised` (hover lays
  `--bg-hover` over them; it ringed them in `--accent`). A transparent outline forced colours draw goes
  beside every `--focus-ring`. Settings' and Help's widths (`--settings-width`, `--settings-nav-width`,
  760px) stay layout constants. The workspace's layout (`workspace-layout.feature.md`) makes both
  rounded sheets in the page column (`--r-lg`, `--e-ring`). The visual baseline gains `help-shortcuts`.
- **The SEO sidebar's frame and shared parts** (the sidebar, its rail and "More panels", the header,
  body and footer; the cards, section heads, badges, page text and severity icons every panel shares;
  the pending, unavailable and empty states) follow the Migration notes, the token `use` notes and the
  approved main screen, where they agree. The `.seo` prefix names every panel's classes too, so its
  `SIGNAL_SURFACES` entry lists the frame's classes (`.seo-chip` is never `.seo-chip-button`, and
  `.seo-panel-tools`, `.seo-toggle` and the panels' interiors wait for their own PRs); `.seo-page-text`
  (no colour or type of its own) and `.pane-separator` (the agent panel shares it; the chrome's entry
  lists it since the workspace's layout) stay out. Rail and
  panel are `--bg-sheet` ("rail, sidebar, agent panel"; `--seo-bg`, and `--bg-chrome` under the
  rail); they were flush with the page and ruled by `--divider` (`--bg-chrome-edge`) until the
  workspace's layout (`workspace-layout.feature.md`) made them two floating sheets, with gaps and
  `--r-lg` corners. Rail items are `--h-field`
  squares at `--r-md` with `--text-muted` icons at `--icon-size` (`--icon`), `--bg-hover` and
  `--bg-active` under the pointer; the open panel's item is raised (`--bg-surface`, `--e-raised`, its
  icon `--accent`, a transparent outline for forced colours) and loses the 3px side marker, as on the
  screen. Status dots say it by shape, not hue alone: an error a filled `--danger` square (corners
  half of `--r-xs`), a warning a `--warn` ring (`--caution`; a 2px border, not a shadow, so forced
  colours keep it), a pass the screen's check glyph (`PASS_CHECK`, Later states: it was a filled `--ok` disc), each
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
  kept its 12px (`--space-4`) padding where the screen draws 16px, so the panels' interiors kept their
  width until their own PRs; with all of them in, the workspace's layout gives it the screen's 16px
  (`--space-5`, `workspace-layout.feature.md`). The skeleton is `--bg-subtle` (`--seo-skeleton`) with a soft `--bg-sheet`
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
  canvas's; its outlined chip went). The page area's frame keeps `--bg-page` (`--bg-surface` since the base face); the rule between the
  chrome and the page moved from the toolbar's foot to the top of the workspace (`--bg-chrome-edge` →
  `--divider`), so a band under the toolbar belongs to the chrome, and the status bar kept a `--divider`
  rule above it while the page was flush. The workspace's layout (`workspace-layout.feature.md`) made
  the page area the page card (`--r-lg`, `--e-ring`, the native view's corners rounded to match) and
  the sheets' gaps replaced both rules. The toolbar's SEO sidebar toggle had the classes `tool seo-toggle`, so it also drew
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
  narrow window the address bar from 360px to 240px (and below the window's 664px minimum, which tiling
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
  The panels stand their cards `--space-4` apart (and so does the skeleton), where the screen
  draws 16px: each panel's PR kept it, and the workspace's layout left it (the body's padding took
  the screen's 16px there). **Score card:** `--space-5` in and between,
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
  by shape, as the rail's dots do: the screen's check glyph for a pass (`PASS_CHECK`, Later states: it
  was a filled `--ok` disc), a filled `--danger` square for an error, a `--warn` ring (a 2px border) for a warning (it was
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
  (`--ok`, `--warn` for short and long where it was `--caution`, `--danger`) outlined by a 1px `--bg-surface`
  boundary (Later states: as Page Speed's timing segments, so "fits" meets the card's colour), its line `--text-small` in
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
  not an inset shadow) while the tab needs a reload (dashed) or the profile failed (solid; Later states: the
  two were the same edge, which forced colours drew as they draw the transparent one at rest, now `Canvas`); the
  status chip an `--h-badge` pill on `--accent-soft` in `--text-small` at weight 500, `--accent` text.
  The toolbar's render toggle, while a profile is in force, is `--accent` on `--accent-soft`, as the SEO
  toggle pressed; pressed, its edge is `--accent` (`--render-edge`).
  **Error and crash panels:** on `--bg-page` (the page area's; `--bg-surface` since the base face), `--space-7` in; the art keeps its 76px
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
  for their PRs. The editor bar's checkbox labels faded while disabled
  (`.render-check:has(input:disabled)`, `opacity: 0.5`), as a native checkbox can't take the disabled colours;
  since Later states the label takes `DISABLED_INK` (`GrayText` under forced colours) and the box keeps its
  own disabled look. A `.panel-button` busy but still focusable (`aria-disabled`: the crawl sheet's Export
  CSV and Start crawl, AI answers' Ask) takes the disabled colours too, keeping its focus ring (Later states). **DevTools drawer:** a `--bg-sheet` band ("rail, sidebar, agent panel") with a
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
- **The SEO panels' Indexability, Page Speed and Compliance** (`seo-indexability.feature.md`,
  `seo-speed.feature.md` and `seo-compliance.feature.md`, Panel; `seo-checks.feature.md`, the sitemap and
  return-link checks; what their components render, less the frame's, Overview's, On-Page's and the
  shared controls' parts) follow the Migration notes, the token `use` notes and the canvas's component
  board (badges, status dots, notice), where they agree; no screen draws these panels. Each panel has a
  `SIGNAL_SURFACES` entry listing its classes; Indexability's holds the parts Compliance, JavaScript and
  Search Console draw too (the verdict card, its signals, the tone pills and status chips), whose rules
  sit with it, and the sitemap checks' rules that Links' PR left (the samples, the files). Text is Geist
  from the `--text-*` tokens, every space a `--space-*` step, every corner an `--r-*`; a part's own
  geometry (the 44px verdict tile and its 26px glyph, the 18px status chip, the chain's and the rows'
  label columns, the meters' and bars' heights) stays a layout constant. The panels stand their cards
  `--space-4` apart. **Verdict cards** (Indexability's, the security verdict, Page Speed's lab verdict,
  and JavaScript's) are cards like the others: `--bg-surface` at `--r-md` with `--e-ring` and a
  transparent border, where they were a gradient wash of the verdict's colour with a tinted edge and a
  card shadow (no gradients). The verdict's colour is its icon's: an `--r-md` tile on the verdict's
  `-soft` fill (indexable, secure and good `--ok`, canonicalised, attention and needs improvement
  `--warn` where it was `--caution`, not indexable, insecure and poor `--danger`, pending and local
  `--accent` where it was `--info-tone`, a measurement with no band `--text-faint` on `--bg-subtle`); a
  panel that sets only `--verdict` gets a 14% tint of it; JavaScript's PR sets each of its verdicts' `-soft` fill too
  (its passing icon was 2.82:1 on that tint in light). The label is
  `--text-title` in `--text`, as Overview's band, the icon and the word carrying the verdict (it was
  18px in the verdict's colour, `--ok` text 3.30:1); the summary `--text-small` in `--text-muted`, the
  reasons `--text-small` at weight 500 beside a 6px bullet in the verdict's colour. The **signals** under
  a verdict are shape-coded as the rail's dots and kept in forced colours (`FORCED_COLOURS_KEPT`): a
  pass a filled `--ok` disc, a warning a 2px `--warn` ring, an error a filled `--danger` square, a
  neutral one ("Unknown", "Not applicable") an 8×2px `--text-faint` dash (they were discs in four hues
  with a tinted halo), their label `--text-micro` in `--text-muted` (10.5px `--text-faint`), their value
  `--text-small` at weight 600, ruled off by `--divider`. **Tone pills** (`.seo-pill`: an HTTP status,
  the canonical's state, robots.txt's outcome, a crawler's verdict, a header's state, a sitemap's
  state) are the canvas's status badges, as the frame's `.seo-badge`: `--h-badge` pills in `--text-micro`,
  a status one `-ink` on its `-soft` fill (warn `--warn-ink` on `--warn-soft` where it was `--caution`
  on its 14% tint), a neutral one `--text-muted` on `--bg-subtle` (`--bg-hover`). **Status chips**
  (`.seo-flag-chip`: an hreflang flag, a mixed resource's kind, a return link's outcome, a link's status
  and the link checks' counts) are 18px at `--r-xs` in `--text-micro`, the same pairs; a link's status
  chip sits in a row button, so its pairs are composed over a hovered row too (`under`): its warn tone
  was `--caution` on a 13% tint, 2.88:1 in light there, and `--warn-ink` on `--warn-soft` is 5.30 or
  more. **Notes** (the response's source, the mixed content and accessibility notes) are an
  `--accent-soft` notice at `--r-sm` (a 10% `--info-tone` tint) in `--text-small` `--text-muted`;
  **warnings and problems** (Page Speed's Wayland note, a check that timed out or failed) a `--warn-soft`
  notice in `--text-small` `--text` with a `--warn` icon; each keeps a transparent border for forced
  colours. **Nested lists** (robots.txt's crawlers, the security headers, an impact's group) are
  `--r-sm` boxes with `--e-ring` and a transparent border on the card, where they were bordered
  `--seo-bg` boxes, their rows ruled by `--divider`; an impact's group loses its 3px left edge in the
  impact's colour (its badge says it). Card titles' icons are `--icon-sm` in `--text-muted` (`--icon`),
  sub-heads `--text-small` at weight 600, inline icons `--icon-sm`. **Indexability:** the redirect chain's
  arrow `--text-faint`, a hop's URL `--text-muted` and the final one `--text` (it was bold: Geist Mono
  is bundled at 400 only); a kept header's name `--text-mono` in `--text-muted` (600 10.5px system
  monospace); a crawler's name `--text-body` at weight 500, its rule `--text`, its group `--text-small`
  in `--text-faint`; robots.txt's pending mark an `--accent` disc that pulses; an hreflang code that is
  not valid `--danger-ink` on `--danger-soft` (it was its 14% tint). **Page Speed:** the live line is
  `--text-small` in `--text-muted`, its 8px mark shape-coded and kept in forced colours (measuring or
  paused a `--text-faint` disc, live an `--ok` disc pulsing in `--ok`, unavailable a `--warn` ring);
  Resume is `--text-small` at weight 600 in `--accent`, underlined hovered, `--focus-ring` focused (an
  `--accent` outline); the lab note a `--bg-subtle` note at `--r-sm` (`--bg-hover`). "Since the page
  loaded" heads the metric tiles, so it takes the section heads' rule (`.seo-section-title`, which now
  names it) in place of a rule of its own that repeated it. A metric tile is a card (`--r-md`,
  `--e-ring`) without its 3px top edge in the band's colour; its short name `--text-caps` in
  `--text-muted`, its band a badge (`-ink` on `-soft`: good `--ok`, needs improvement `--warn`, poor
  `--danger`; it was the band's colour as 11px text, `--ok` 3.30:1; the head wraps, and so does the
  badge's text, so "Needs improvement" stays inside a half-width tile at the 300px panel), its value `--text-display` in
  `--text` (it was 22px in the band's colour), its hint `--text-small` in `--text-faint` with an `--accent`
  icon, its name `--text-small` in `--text-faint`; the meter's zones mix the band's graphics colour 55%
  into `--track` (`--seo-track`, `--caution` → `--warn`), its marker `--text`. The timing and totals tiles
  are `--bg-subtle` at `--r-sm` (`--bg-hover`), their labels `--text-small` in `--text-faint`, their values
  `--text-body` at weight 600. **One accent, no second hue:** the navigation timing's six phases were six
  hues and the requests by type seven (26 literal hex with their dark overrides): the phases are now
  steps of `--accent` mixed into `--track` in time order (redirect 55%, then 64, 73, 82 and 91%, the
  response `--accent`). Neighbouring steps are only about 1.1:1 apart, so every segment is outlined by a
  `--bg-surface` stroke: 2px at any scale (`vector-effect: non-scaling-stroke`), painted under the fill
  (`paint-order: stroke`) on whole pixels (`shape-rendering: crispEdges`), so a solid 1px column of it
  shows past each segment's end, never over a segment's own fill. That boundary is at least 3:1 off both
  segments it divides, and the stroke never covers a segment's own fill. Every phase with a duration
  shows: one shorter than `NAVIGATION_PHASE_MIN_WIDTH` is drawn at it, and the next one starts where it
  is drawn to end (The panels at 300px). The stroke's colour, width and paint order are pinned (`TEXT_COLOUR_RULES`, `drawn`). The
  legend's swatches are the same steps, with no edge: the palest, 55% of `--accent` in `--track`, is
  3.20:1 on the card in light and 3.40:1 in dark (`CONTRAST_PAIRS`; the boundary beside the palest
  segment is the same pair), and the ramp can't start lower (40% is 2.56:1 in light). They are kept in
  forced colours (the bars are SVG fills, which forced colours leave as they are); every type's bar is
  `--accent` on `--track`, its row's label naming it; the load and DOM-ready marks are `--text` and
  `--text-muted` (load was `--danger`, which is no error). A type with no request is `--text-faint`
  (it faded to half). Party and cache flags and the issues' source are badges: "3rd party"
  `--warn-ink` on `--warn-soft` (`--caution` on its tint), "Live" `--ok-ink` on `--ok-soft` (it drew `--ok`
  text, one of the `--ok`-as-text exceptions), the others `--text-muted` on `--bg-subtle`. A largest
  request's open button is the chrome's tool at `--h-chip`. **Compliance:** a header's name `--text-mono`
  (600 11.5px system monospace), wrapping at its hyphens rather than cut short (12px Geist Mono beside
  "Not applicable" no longer fits), `--text-muted` when unknown or not applicable; a mixed resource's
  element `--text-mono` in `--text-faint`. The accessibility check's intro is an `--accent-soft` notice at
  `--r-md` (a dashed 30% `--accent` edge on a 5% tint), its art an `--accent` glyph on a `--bg-surface`
  tile; its hint `--text-small` in `--text-faint`; its progress an `--accent` bar on `--track`, easing in
  `--dur-base`; Run keeps the app's panel button (the chrome's PR moved it: disabled, `--text-faint` on
  `--bg-subtle`), less the 32px height and the 0.7 fade its own rules added: the panel button's height
  and its own disabled state show it. The **impacts** keep the
  canvas's statuses: critical `--danger`, serious and moderate `--warn` (moderate was `--caution`, a
  second amber), minor the accent's (`--info-tone`); the word says which. The tally's tiles are
  `--bg-subtle` at `--r-sm` with a transparent border (they were tinted by the impact, edge and fill), the
  number `--text-title` in the impact's -ink (`--accent-hover` for minor), the label `--text-small` in
  `--text-muted`, a zero `--text-faint` and `GrayText`, text and edge, under forced colours
  (`FORCED_COLOURS_BUSY`), as Overview's zero-count pill. An impact's badge is `-ink` on `-soft`
  (`--accent-hover` on `--accent-soft` for minor); "Scored" `--text-caps` in `--text-muted` (10.5px
  `--text-faint`). A rule's row is a row button: `--r-sm`, `--bg-hover` hovered (`--dur-fast`), its help
  `--text-body` at weight 500, its id and count `--text-small` in `--text-muted` (`--text-faint` is under
  4.5:1 on a hovered row in dark), its count a neutral `--h-badge` pill, `--text-muted` on `--bg-subtle`
  (it was the impact's colour on its tint, which over a hovered row would need its own pairs; the group's
  badge already names the impact); focus is `--focus-ring` beside a transparent outline (an inset
  `--accent` outline). An element's sample is a `--bg-subtle` box at `--r-sm` (a bordered card), its
  selector `--text`, its summary `--text-small` in `--text-muted`. No retired name these panels read is
  unread elsewhere, so none is `removed`: `--seo-card-edge`, `--caution`, `--shadow-card`, `--info-tone`
  and `--icon` (retired) and `--seo-card`, `--seo-bg` and `--seo-track` (aliases) are still read by
  JavaScript, Search Console, Changes, the AI cards and other later panels.

- **The SEO panels' Content, JavaScript, SERP and Visibility** (`seo-content.feature.md`,
  `seo-javascript.feature.md`, `serp-panels.feature.md`, `visibility-probes.feature.md`; what their
  components render, less the frame's, the shared controls' and Indexability's verdict card, signals
  and pills, which JavaScript borrows) follow the Migration notes, the token `use` notes and the
  canvas's component board where they agree; no screen draws these panels. Each has a
  `SIGNAL_SURFACES` entry: Content and JavaScript list their classes under `.seo`, SERP and Visibility
  own their `.serp` and `.visibility` prefixes. Text is Geist from the `--text-*` tokens, every space a
  `--space-*` step, every corner an `--r-*`; a part's own geometry (the 24px and 18px monograms, the
  96×54 video frame, the 18px term and place marks, the 22px rank column, the probe table's 560px)
  stays a layout constant. The panels stand their cards `--space-4` apart. **Content's result
  preview** is frost's drawing of a result, not the app's chrome, but the Migration table already maps
  its colours onto Signal (`--serp-title` → `--accent`, `--serp-path` → `--text-muted`, `--serp-glyph`
  → `--bg-subtle`, `--serp-glyph-mark` → `--text-muted`, all four now `removed`): a result card is
  `--bg-surface` at `--r-md` (`--r-lg` on mobile) with `--e-ring` and a transparent border, its site
  name `--text-small` in `--text`, its address and date `--text-small` in `--text-muted` (the address
  wraps, so the page's crumb shows whole), its title
  Overview's preview title (`--text-heading` at weight 500 in `--accent`), its description
  `--text-small` in `--text-muted`, a missing value `--text-faint` in italics, the stars `--warn` (a
  graphic beside the rating's words), the monogram an `--r-pill` disc of `--bg-subtle` with its letter
  in `--text-micro` and `--text-muted`, a rich card's badge On-Page's tag; it is set in Geist, where it
  was a literal Arial stack (`SNIPPET_FONT` is only the face the width table was measured in; the
  previews are not to scale), and the device caption is a `--text-caps` label in `--text-muted`. The
  **width meters** sit in an `--r-sm` box with `--e-ring` on the card (they were on a translucent
  `--bg-hover`; `--ok` on `--bg-subtle` is 2.998:1 in light, under 3:1), the label column at least as wide as its
  longest word (`minmax(min-content, 1fr)`, so at 300px the verdict wraps rather than drawing over it), each verdict "… px: fits"
  `--ok-ink`, "… px: cut" `--warn-ink` (`--caution`) and "Nothing to measure" `--text-faint`, the bar's
  fill `--ok`, `--warn` or `--text-faint` on `--track`, outlined by a 1px `--bg-surface` boundary as
  On-Page's length meters' (Later states: the "fits" fill is 2.23:1 on `--track` in light, 3.30:1 on the
  boundary). A **field** (a draft's title and description,
  the site name) is Settings' field inside a card: `--h-control` (a textarea from 76px) at `--r-sm` on
  `--bg-surface` with `--e-raised` and a transparent border, `--text-body`, its placeholder
  `--text-faint`; focus is `--focus-ring` with a transparent outline, where it was an `--accent` edge
  with a halo; its label `--text-small` at weight 500 in `--text-muted`, the count `--text-faint`. The
  **danger toggles** ("Delete draft", "Delete all notes…") are the shared toggle, hovered with a
  `--danger` edge and `--danger-ink` text (`--danger` is 4.37:1 on the hovered toggle in light). The
  **target query**: its clear button an `--h-badge` circle in `--text-muted`, `--text` on `--bg-hover`
  hovered, with its own focus ring (it had none); each place's mark keeps its shape (a ring with a
  check, a half disc, a dashed ring) in `--ok` (drawn by `stroke`, not `color`), `--accent` and
  `--text-faint`; a term is an 18px `--r-xs` badge in `--text-micro` (a fixed 18px box, its line centred by
  `(18px - 2px - 1.3em) / 2` of block padding), absent `--text-muted` with a 1px dashed `--text-faint` edge at weight 400,
  present `--ok-ink` on `--ok-soft` (was `--ok` on its 14% tint) at weight 600 with a 1px solid `--ok` edge
  (`STATE_EDGES`: 5.53:1 and 3.30:1 on the card in light; council round 1 on PR #49 found the first
  edges, a `--track` dash and a transparent solid line, invisible outside forced colours), so absent is
  dashed and present solid in forced colours too; "exact
  phrase" `--text-small` in italics. **n-grams:** rows ruled by `--divider`, the phrase `--text-body`,
  its count `--text-small` at weight 600 in `--text-muted`, the bar `--accent` on `--track` (it was a
  70% mix); the highlight button an `--h-badge` square at `--r-xs` in `--text-muted`, `--text` on
  `--bg-hover` hovered (the hover skips a pressed one: `HOVER_OVERLAYS_SKIP_PRESSED`), pressed `--accent`
  on `--accent-soft` with an `--accent` edge on its transparent border (`PRESSED_EDGES`; it was a 50%
  `--accent` edge on a 14% tint) and `Highlight` under forced colours (`FORCED_COLOURS_PRESSED`), focus
  the ring (it was a 2px `--accent` outline); a place mark (T, H1, D, U) an 18px `--r-xs` badge in
  `--text-micro`, a place the phrase is in `--accent` on `--accent-soft`, one it is not in `--text-faint`
  at half strength (`DISABLED_INK`) and `GrayText` under forced colours (`FORCED_COLOURS_BUSY`), with a
  transparent edge forced colours draw. **Readability:** the score `--text-display`, its band
  `--text-body` at weight 600 in `--text-muted`, the formula and the scale's ends `--text-small` in
  `--text-faint`, the scale's marker `--accent` on `--track`; its tiles On-Page's stat tiles
  (`--bg-subtle` at `--r-sm`, the label `--text-small` in `--text-muted`, the value `--text-heading`; they
  were translucent `--bg-hover`); a difficult sentence an `--r-sm` `--bg-subtle` box, its text
  `--text-small`, its meta `--text-small` in `--text-faint`, and its reason chip ("Long", "Complex") a
  neutral 18px badge (the term's fixed box), `--text-muted` on `--bg-surface` with `--e-ring`: it took the page highlight's two
  hues (`#b45309`, `#be185d`, the hex ratchet's 4), and its word says the reason, as the boxes in the
  page do. **JavaScript:** its verdict colour and its icon tile's fill (`--verdict` and `--verdict-soft`, read by
  Indexability's card: `--ok` on `--ok-soft` 3.00:1 in light, where the 14% fallback tint was 2.82:1) `--ok`,
  `--warn` (`--caution`), `--danger` or `--text-faint`, on `--ok-soft`, `--warn-soft`, `--danger-soft` or
  `--bg-subtle` (as a measurement with no band); its notes `--text-small` in `--text-muted`, the
  partial-comparison note `--warn-ink` (`--caution`); fields and items ruled by `--divider`, a field's
  label `--text-small` at weight 600, its served and rendered labels `--text-caps` in `--text-muted`,
  counts and details `--text-small` in `--text-faint`. **SERP:** the parameters a card (`--bg-surface`,
  `--r-md`, `--e-ring`, a transparent border; it was `--seo-card-edge` and `--shadow-card`), each label
  `--text-caps` in `--text-muted`, each value `--text-small` at weight 500, the four columns at least as
  wide as their label and their value's longest word (`minmax(min-content, 1fr)`; a value wraps between
  words, `break-word`), so "Language" and "Desktop" fit whole at 300px, while the engine and the
  query, which span two columns, break anywhere, so a long or unbroken query wraps inside the card (council
  round 2 on PR #49: `anywhere` on every value let "Desktop" break, and the cut one-line query widened
  the grid); the intent chip the canvas's
  info badge (`--h-badge` pill, `--accent` on `--accent-soft`, `--text-micro`; it was a 14% tint), its
  confidence `--text-small` in `--text-muted`; the composition bar `--r-pill` on `--track` (its segments
  and swatches keep `SERP_OUTLINE_STYLES`' colours, SVG attributes, as the outlines in the page), its
  counts `--text-small`; tables `--text-small` with tabular figures (Visibility's table keeps them), their header cells `--text-small` at weight 600 in
  `--text-muted` (sentence case: `--text-caps` pushed the ownership table past a 360px panel), rows
  ruled by `--divider` (`border-spacing: 0`, not `border-collapse`); a result's rank `--text-small` in
  `--text-faint`, its type `--text-caps` in `--text-muted`, title `--text-body`, domain `--text-small` in
  `--text-faint` ("No link" keeps its italics); a state that is not a reading a 32px `--r-sm` tile of
  `--accent-soft` with an `--accent` icon, a problem (unreadable, disabled) `--warn-soft` and `--warn`
  (`--caution`; they were mixes with `--seo-bg`), its title `--text-body` at weight 600; Edit search and
  Track this search are cards as the parameters, their labels the parameters' labels, their selects
  the shared select (`--h-control`, `--r-sm`, `--e-raised`; they were 30px `--radius-field` boxes with a
  `--border-field` edge) with a focus ring (they had none). **Visibility:** the probe table's fact
  column sticks on `--bg-surface`; a cell that differs is `--warn-ink` on `--warn-soft` at weight 600 with
  a 2px `--warn` edge on its left (it was a 13% `--caution` tint and an inset box-shadow, which forced
  colours drop: the edge is a border they draw), and an agent column that differs heads in `--warn-ink`
  with a 2px `--warn` underline (it was `--caution` alone); the robots.txt notes `--text-small`. No row
  in these panels is hoverable, so no tinted badge lies over `--bg-hover`. No markup changed.

- **The Changes panel, Projects, Rankings, Inspector and the screenshot editor** (what the components in
  `components/changes/` render: `changes-panel.feature.md`, `changes-capture.feature.md`,
  `projects.feature.md`, `rankings.feature.md`, `retention.feature.md`, `inspector.feature.md`,
  `screenshot.feature.md`) follow the Migration notes, the token `use` notes and the canvas's component
  board (buttons, field, segmented control, chips and badges), where they agree; no screen draws them.
  Each prefix has its `SIGNAL_SURFACES` entry: `.changes` (Capture now and the project picker, the
  history, the diff, the screenshots; the pick hint `.changes-shot-selecting` is the Inspector's too),
  `.inspector`, `.shot-editor`, and `.projects` and `.retention` in `styles.css`; in `rankings.css`
  `.rankings`, `.compare`, and a class list for `.projects-*` with `.project-settings-*` (Settings has
  no type of its own). No rule elsewhere is theirs alone;
  the `.page-column … > .page-area` rules of the Projects sheet and the shot editor are layout the chrome's
  entry checks too. Their `.panel-button`, `.seo-action`, `.seo-segment`, `.seo-select`, chips, badges,
  cards and hints are the shared ones, already converted, and stay. Text is Geist from the `--text-*`
  tokens (the panel, the sheets and the editor set `--text-body`, so what draws no type of its own, the
  .panel-button among it, is Geist too), every space a `--space-*` step, every corner an `--r-*`, every
  rule `--divider` (`--seo-card-edge`, `--bg-chrome-edge`), focus `--focus-ring` beside a transparent 2px
  outline after the hovers (it was a 2px `--accent` outline, an inset `--accent` line or the browser's
  own), and status words take their -ink (`--ok`, `--caution`, `--warn`, `--danger` as text → `--ok-ink`,
  `--warn-ink`, `--danger-ink`), each beside the word that says it. A part's own geometry (the tree's
  14px indent per level, the 96px thumbnails, the table's compact cells, the 18px badges, the 22px
  swatches, the columns' widths) stays a layout constant. Capture now and Pick element no longer fade
  when disabled: the shared button's disabled colours say it (`TEXT_COLOUR_RULES`, `unfaded`).
  **Changes panel:** its cards `--space-4` apart; notes `--text-small` in `--text-muted`, a warning note
  `--warn-ink`; the capture status `--text-small` at weight 500, refused or failed `--warn-ink`, a first or
  new version and a saved screenshot `--ok-ink`; the project picker an `--h-control` field at `--r-sm` with
  `--e-raised` (`--border-field`, `--radius-field`, `--bg-field`). A version is an `--r-sm` row with a
  transparent border, `--bg-hover` hovered (the hover skips the chosen one,
  `HOVER_OVERLAYS_SKIP_PRESSED`); the chosen one `--accent-soft` with an `--accent` edge (it was a 40%
  `--accent` edge on a 10% tint; `PRESSED_EDGES`), `Highlight` under forced colours
  (`FORCED_COLOURS_PRESSED`); its time `--text-small` at 600, its count and a first version's summary
  `--text-muted` (`--text-faint` on a hovered row is 4.26:1 in dark). The diff's region titles
  `--text-body` at 600, its rows ruled by `--divider` in `--text-small`, a field's labels and the context's
  label `--text-caps` in `--text-faint`. A change's kind is a badge of its word with a mark (`+` added, `−`
  removed, `~` changed): `--h-badge` pill in `--text-micro`, `-ink` on `-soft` (it was the tone on its own
  14% tint, `--ok` 2.82:1). The inline edits are `-ink` on `-soft` at `--r-xs`: removed words struck through on
  `--danger-soft`, added words underlined on `--ok-soft` (they were tints, the added words `--ok`), and each
  is said "[removed: …]" / "[added: …]" to screen readers, so struck, underlined and said, they read
  without hue and with none under forced colours. The screenshot controls are ruled off by `--divider`;
  their label `--text-small` at 600; a disabled kind is the shared segment's `DISABLED_INK`
  (`DISABLED_CONTROLS`); the area hint an `--accent-soft` notice at `--r-md` with a transparent border; a
  shot's thumbnail and preview at `--r-sm` edged by `--divider`, the thumbnail's empty state on
  `--bg-subtle` (`--bg-hover`) in `--text-faint`, its time `--text-faint` and size `--text-muted` in
  `--text-small`. **Projects:** a `--bg-surface` sheet (the page card's fill), History's: the title `--text-title`,
  `--space-5` in; Close an `--h-control` circle, a list's icon buttons (star, Remove) `--h-chip` circles in
  `--text-muted` (`--icon`, `--radius-control`) at `--icon-sm`, `--bg-hover` hovered; the sheet's buttons the
  canvas's secondary button at `--h-chip` (`--text-small` at 500 on `--bg-surface` with `--e-raised`, hover
  lays `--bg-hover` over it), disabled `--text-faint` on `--bg-subtle` with no shadow (it faded to half),
  `GrayText` under forced colours (`FORCED_COLOURS_BUSY`), Delete and Purge `--danger-ink`; fields and menus
  `--h-control` at `--r-sm` on `--bg-surface` with `--e-raised` and a transparent border, `--text-body`
  (Settings'; they were 30px with an `--accent` edge and halo focused), the textarea `--space-2` in; the
  list and the main column `--space-1` in, so a focused row's ring is whole. A project is an `--r-sm` row,
  the chosen one `--accent-soft` with an `--accent` edge (`PRESSED_EDGES`; it was the fill alone),
  `Highlight` under forced colours, where the others' edges take the canvas; its "Due" an 18px pill in
  `--text-micro`; section titles `--text-caps` (they were 12px at 600), counts `--text-faint`; a page's and
  a search's rows ruled by `--divider` (disabled during a capture run, `DISABLED_INK` and no hover tint: Later
  states), a tag an `--accent-soft` pill in `--text-micro`; the capture run, a
  series, Bulk add and Compare's pickers `--bg-surface` cards at `--r-md` with `--e-ring` and a transparent
  border (`--border-field`, `--radius-field`); a run's outcomes and a blocked run's reason, Bulk add's
  outcomes `--ok-ink`, `--warn-ink`, `--danger-ink` (they drew `--ok`, `--warn`, `--danger`). The views
  (Pages, Rankings, Compare, Settings) stay tabs: `--h-control`, `--text-body` at 500 in `--text-muted`,
  `--text` hovered, the chosen one `--text` over a 2px `--accent` underline (a border, so focus keeps its
  ring), `Highlight` under forced colours, where the others' underlines take the canvas.
  **Rankings and Compare:** the table `--text-small` (it was 11.5px; its compact cells keep their 3px, the
  first `--space-1` so a row button's ring is whole), its heads `--text-micro` in `--text-muted`, rows ruled
  by `--divider`, no `border-collapse` (separate borders, no spacing: the same lines); the selected row
  `--accent-soft`, its search at weight 600 (the open series under it says which, too); tags `--bg-subtle`
  pills in `--text-micro`; a rise or a new search `--ok-ink`, a fall or a lost one `--danger-ink`, written
  as `+3`, `−2`, "New", "Lost" (Compare: "Up 2", "Down 2", "New", "Gone"), the capped mark `--warn-ink`,
  each holding 4.5:1 on the selected row (`CONTRAST_PAIRS`); the trend's line and dots `--accent`; notices
  `--accent-soft` at `--r-md`; "Your site" an `--accent-soft` pill in `--text-micro`. **Inspector:** the
  tree, its matches and its sources `--text-mono` (they were 11.5px system monospace) on `--bg-surface`
  cards at `--r-md` with `--e-ring`, `--space-1` in; a node an `--r-xs` row with a transparent border,
  `--bg-hover` hovered, the selected one `--accent-soft` with an `--accent` edge (`PRESSED_EDGES`; the fill
  alone before), `Highlight` under forced colours where the others' edges take the canvas; its tag
  `--accent`, preview `--text-muted`, a shadow root `--text-muted` in italics (`--text-faint`, 4.26:1 on a
  hovered row in dark); the twisty turns in `--dur-fast`; facts and the attributes table `--text-small`, the
  table's names `--text-mono`; the chosen view (Tree, Rendered, Served) the shared row action pressed:
  `--accent` on `--accent-soft` with an `--accent` edge (`PRESSED_EDGES`), `Highlight` under forced colours,
  keeping the shared focus ring; in a source, matching lines `--accent-soft`, the current one a 2px
  `--accent` line on its leading edge (a border: it was an inset shadow forced colours drop), and under
  forced colours the current line `Highlight`, the other matches `CanvasText`; line numbers `--text-muted`
  (`--text-faint` on a match is under 4.5:1 in dark). **Screenshot editor:** a `--bg-surface` sheet,
  `--space-5` in, its title `--text-heading`, hint `--text-small`; the text field an `--h-control` field at
  `--r-sm`; a swatch an `--h-badge` circle outlined by `--switch-off` (`--border-field`: a white swatch
  needs 3:1 on the sheet), the chosen one ringed by a 2px `--accent` border (`PRESSED_EDGES`), `Highlight`
  under forced colours where the others' rings take the canvas; the canvas at `--r-sm`, edged by `--divider`.
  No retired name these surfaces read is unread elsewhere (the AI answers, Crawl, Search Console and the
  later panels still read `--caution`, `--seo-card-edge`, `--bg-chrome-edge`, `--radius-control`,
  `--radius-field`, `--icon` and `--border-field`), so none is `removed`. Five rules drew `--ok` as text (the
  capture and screenshot statuses, the added words, a captured target, a rise), so this PR takes 5 off
  the `--ok`-as-text exception; they held no literal hex, so `HEX_COLOUR_RATCHET` stays.

- **The panel stylesheets** (each feature's own stylesheet: `gsc-panel.css`, `gsc-inspection.css`,
  `gsc-targets.css`, `ai-checks.css`, `ai-readiness.css`, `ai-answers.css`, `crawl.css` and `location.css`;
  `gsc-panel.feature.md`, `gsc-inspection.feature.md`, `seo-content.feature.md`, `ai-checks.feature.md`,
  `ai-readiness.feature.md`, `page-type.feature.md`, `ai-answers.feature.md`, `site-crawl.feature.md`,
  `location-profiles.feature.md`) follow the Migration notes, the token `use` notes and the canvas's
  component board (buttons, field, segmented control, chips and badges), where they agree; no screen
  draws them. Each stylesheet has one `SIGNAL_SURFACES` entry, by its prefix (`.gsc`, `.gsc-inspect`,
  `.gsc-targets`, `.ai-judgment`, `.crawl`, `.tab-location`) or, where its classes share none, a class
  list (`ai-readiness.css`: `.ai-*`, `.page-type-*`, `.page-intent-*`; `ai-answers.css`: `.ai-answers-*`,
  `.ai-answer-*`). Text is Geist from the `--text-*` tokens, every space a `--space-*` step, every corner
  an `--r-*`, every rule `--divider` (`--seo-card-edge`, `--border-field`, `--bg-chrome-edge`, `--gsc-grid`),
  cards `--bg-surface` at `--r-md` with `--e-ring` and a transparent border (`--seo-card`, `--shadow-card`),
  fields inside a card `--h-control` at `--r-sm` on `--bg-surface` with `--e-raised` and a transparent
  border (`--radius-field`, `--bg-field`), status text its `-ink` (`--caution` → `--warn-ink`, `--danger` →
  `--danger-ink`, AI readiness's pass `--ok` → `--ok-ink`), and focus `--focus-ring` beside a transparent
  2px outline (`FOCUS_RING_RULES`), where they had a 2px `--accent` outline or an `--accent` border and halo;
  a part's own geometry (the calendar's 256px, the AI ring's 64px, the notice art's 48px, the badge's
  18px) stays a layout constant. A feature stylesheet loads before `styles.css` (its component imports it,
  inside `App`), so a shared control's rule there wins a tie: a rule of these sheets that changes a
  shared control (`.panel-button`, `.seo-chip-button`, `.seo-select`) outweighs it by naming both classes,
  and its guard entries read `styles.css` after the stylesheet (`loadsBefore`). **Search Console:** the
  panel's cards stand `--space-4` apart; its property line `--text-small`, its label `--text-caps`; the
  month and filter selects are the panels' select at `--text-small`, a filter in force an `--accent` edge
  and text; the custom dates in force or open a pressed chip (`--accent` on `--accent-soft`, an `--accent`
  edge, `PRESSED_EDGES`), each `Highlight` under forced colours. The calendar is a popover card with
  `--e-overlay` (a literal shadow); its arrows `--h-chip` circles; a day `--h-chip` tall at `--r-sm`,
  `--bg-hover` hovered, the chosen range an `--accent-soft` band in `--accent` with its ends `--accent`
  and `--on-accent`, each day of it ringed `Highlight` under forced colours (a transparent border, so they
  draw it); an arrow or a day out of range `DISABLED_INK` and `GrayText` (they faded to 0.35 and 0.45). A
  notice is a card, its art on `--accent-soft` (an error's `--warn-soft` with `--warn-ink` art, as the
  sidebar's unavailable hint), its title `--text-heading`. A total tile is a card button: label
  `--text-small`, value `--text-title`, hint `--text-small` in `--text-muted` (`--text-faint` is 4.26:1 on
  a hovered tile in dark); hover lays `--bg-hover` over it, skipping the pressed one
  (`HOVER_OVERLAYS_SKIP_PRESSED`); the tile the chart shows keeps its fill and draws a 2px `--accent` edge
  (its border and a line inside it, as on main), `Highlight` under forced colours. The chart is a card:
  its line and dots `--accent` (one series, 4.5:1 or more on the card; its values are in the hidden
  table and the summary), its grid `--divider` (`--gsc-grid`, `removed`), its axis labels `--text-micro`
  at weight 400 in `--text-faint` (`--gsc-axis`, `--gsc-line`: aliases, now unread, kept). Top queries:
  `--text-small`, heads `--text-micro` in `--text-muted`, rows ruled `--divider`. While another scope or
  range is read the data dims to 0.55 only while focus is not inside it (a fade would dim a focused
  tile's ring, as a busy switch in Settings); so does the URL Inspection card's body
  (`FADES_SPARE_FOCUS`). The chart's left gutter (`GSC_CHART.padLeft`) grew from 38 to 52 units for
  the larger axis type, so a tiny CTR step ("0.0005%") stays inside the card from 300px to 560px; Top
  queries' numbers are `--text-micro` at weight 400 (its 0.01em tracking stays: a type token's tracking
  is its own), the query column 38% (it was 40%), and below a 360px panel (a 324px container: `.gsc` is
  325px beside the scrollbar at 360) its columns give the numbers the room (the query 28%, clicks and
  impressions 21% each, CTR 17%, position 13%), where six-digit counts ran into each other. A focused chosen tile keeps its inner line under the ring; a
  focused answer in the AI answers list is raised over its neighbours, so its ring is whole. **URL Inspection:**
  `--text-small` throughout; a rich result item an `--r-sm` box ruled `--divider`; a group's label
  `--text-caps`, "Error" `--danger-ink`, "Warning" `--warn-ink`. **Content's targets:** rows ruled
  `--divider`, `--text-small`; "Use as target" is the panels' chip at `--h-chip` (it was squeezed to 24px)
  and no longer fades (`opacity: 0.5` stacked on the chip's disabled colour). **AI judgment:** its model
  text set apart by a 2px `--divider` rule on its leading edge; fields `--text-small`; the target chip at
  `--h-chip`. Check with AI while its call runs (`aria-disabled`, still focusable) faded to 0.6, dimming
  its focus ring: it is `DISABLED_INK` (`DISABLED_CONTROLS`, unfaded), `GrayText` under forced colours,
  and keeps `--focus-ring`; its rule names `.seo-chip-button` too, so the chip's hover (`--text`) does not
  win. **AI readiness:** the 64px ring's value `--text-title`; the basis line `--text-body` at 600; checks
  and assistants ruled `--divider`, labels `--text-body` at 600, the rest `--text-small`; a verdict says
  its word beside a glyph shaped by status (check, triangle, cross, info), in `--ok-ink`, `--warn-ink`,
  `--danger-ink` or `--text-muted`. **The "Page" card:** its type `--text-heading`, "Unsure" `--warn-ink`;
  a signal that disagrees `--warn-ink` with a wavy `--warn` underline, so it reads without hue; the intent
  row ruled `--divider`. **The Crawl and AI answers sheets** (in Help's frame, which keeps no font of its
  own: each sheet sets `--text-body` on its root, and nothing in the frame relies on the system face any
  more, so Help could set it itself; this PR leaves `help.css` alone): section titles `--text-heading`,
  notes `--text-small` in `--text-muted`, the status line an `--accent-soft` notice at `--r-sm`; fields,
  selects and the crawl's textareas the field inside a card; a crawl run and an answer are cards (a run
  chosen, an answer or a citation of the watched domain `--accent-soft` with an `--accent` edge,
  `PRESSED_EDGES`, `Highlight` under forced colours); an answer in the list a row at `--r-sm`, `--bg-hover`
  hovered (skipping the chosen one); a cited domain a `--bg-subtle` pill; the crawl's Pages and Site
  structure are a segmented control (they were underlined tabs: the chosen one raised, `Highlight` under
  forced colours); the table `--text-small` with `--text-micro` heads; the depth bars keep the native
  meter in `--accent`, which forced colours draw. Their destructive buttons (`.crawl-danger`,
  `.ai-answers-danger`) never looked destructive: their rule loaded before `.panel-button`'s `--text`, at
  the same weight. They are `--danger-ink` now by a two-class rule (`TEXT_COLOUR_RULES`, resting and
  hovered), disabled still `--text-faint`. **Location badge:** an 18px pill in `--text-micro`,
  `--accent-hover` on `--accent-soft`, since it lies on every tab state and `--accent` there is 4.18:1 on a
  hovered inactive tab in light. Retired names: `--gsc-grid` had no other reader and is `removed`; the
  others these sheets read stay for `styles.css` and `rankings.css` (`--seo-card-edge`, `--border-field`,
  `--bg-chrome-edge`, `--caution`, `--shadow-card`, `--radius-field`, `--radius-control`). One rule drew
  `--ok` as text (AI readiness's pass), so the exception count drops by 1; the sheets held no hex.
- **The cleanup** (the rollout's closing PR) drops the legacy names no rule reads any more. An exact
  count of each name's readers (`var(--name)` on a name boundary in every `.css`, `.ts` and `.tsx` under
  `apps/desktop/src`, comments aside) found 9 retired names and 8 aliases that nothing read: they are
  `removed` (`--radius-control`, `--radius-field`, `--icon`, `--bg-chrome-edge`, `--border-field`,
  `--shadow-card`, `--caution`, `--info-tone`, `--seo-card-edge`; `--bg-field`, `--seo-bg`, `--seo-card`,
  `--seo-track`, `--serp-card`, `--serp-text`, `--gsc-line`, `--gsc-axis`). Four aliases were read only
  by their own converted surface, so their readers take the Signal token the alias named and they are
  `removed` too: the body's fill is `--bg-window` (`--bg-chrome`), and the palette's card, a "Jump back
  in" tile and the agent panel's six cards `--bg-surface` (`--palette-bg`, `--jump-tile-bg`,
  `--agent-card`). Kept: the self-aliases (Signal tokens), the layout constants, `--seo-panel-width`
  (the sidebar's resize sets it on the panel; `--w-panel` is only its default) and four names Left for
  later: `--font-ui` (text that sets no font of its own still draws in it), and `--bg-page`, `--agent-bg`
  and `--seo-rail-width`, whose readers are the workspace's sheets. The last rule that drew `--ok` as
  text moved to `stroke` (Graphics-only colours). Nothing draws differently: every capture of the
  visual baseline matches it, and the computed value of every Signal token and of every element shown in
  those captures is the same as before, light and dark.

- **The panels at 300px.** The SEO panel is 300px at its narrowest (`SIDEBAR_PANEL_WIDTH_RANGE.min`): a
  card's content is about 226px there. Seven parts, kept from before Signal, cut their text or scrolled
  sideways at that width (Left for later); each is laid out for it now, by its own width or by none
  (`NARROW_PANEL_FITS`), never by the `seo-panel` query, which applies only under the panel's minimum
  (`NARROW_PANEL_WRAPS`, `workspace-layout.feature.md`), and none changes the 300px minimum, the
  workspace's layout or the 588px rules. Measured with long real values (a deep URL, "United Kingdom",
  five-digit numbers with their units, 50-character queries, a 59-character domain) at 300px, the default
  360px and the widest 560px: on `main` each part below cut its text or, the table, scrolled 60px (89px
  with the long domain); now no text in them is cut (`scrollWidth <= clientWidth` on the text itself) and
  nothing scrolls.
  - **Page Speed's requests by type:** a type's size wraps between its words (`.seo-speed-bytes`), so
    "size unavailable" (cross-origin requests without `Timing-Allow-Origin`) takes two lines in the 64px
    column, where it ran 23px past it at every width; a size ("123.4 kB") is narrower than the column and
    stays on one line. The columns keep their widths (each row is its own grid, so a column sized by its
    content would no longer line up with the rows above it).
  - **Page Speed's navigation timing:** every phase with a duration shows. A phase shorter than
    `NAVIGATION_PHASE_MIN_WIDTH` (1.5 of the row's 100: 3.4px at 300px, 4.3px at 360, 7.3px at 560) is
    drawn at it, and the phase after it starts where it is drawn to end, not at its real start, and ends
    at its real end. On `main` the next phase started at the short one's real end and its fill and 1px
    boundary covered it: a loopback page's Connect phase showed 0px at 300px, 360px and 560px; now each
    of its three phases shows 2px or more at 300px and 6px or more at 560px. This moves phases, on
    purpose: the alternative that keeps every start can't show two short phases in a row (they start
    under a pixel apart). What moves, and by how much (`waterfall-shows-every-phase` tests each): near short
    phases and at the axis's end a phase's start and end move by up to n × the minimum, n the number of
    phases (a long redirect then five short phases before the load event: starts move by up to 7.1 and the
    redirect's end by 6.9); a phase between the minimum and about twice it, after a widened one, has its
    end pushed (Connect at 1–17ms of 1,000 is drawn to 3.0, not 1.7); and a row pushed past the axis's end
    is pulled back from there, which moves a long phase's end too (a 999ms request ends at 98.5, not 99.9).
    The DOMContentLoaded and load markers stay at their real times, so a pushed bar can pass one (a 3–5ms
    response drawn from 4.5 to 6.0 beside DOMContentLoaded at 4.0). The bars show the order and rough
    share of the phases; the legend under them gives each phase's real duration. The minimum was 0.8
    (1.8px at 300px, under 1px past the next one's boundary).
  - **Page Speed's timing and totals tiles:** three tiles need about 270px to hold "Page weight" and "DOM
    ready" whole; where a card is narrower (227px at 300px, 251px at 324px) they take two columns
    (`@container speed-card`, the card's own width). On the branch's first round "DOM ready" was cut 13px,
    "Page weight" 14px and "Transferred" 8px at 300px, and the first two 5–6px at 324px; at 360px and wider
    nothing changes.
  - **Compliance's tally:** four tiles need about 280px to hold "Moderate" whole; where the results are
    narrower (227px at 300px) the tiles take two columns, two rows (`@container a11y-results`, the
    results' own width). On `main` "Moderate" was cut 14px, "Serious" 3px and "Critical" 1px at 300px.
  - **Content's result preview:** a crumb of the address line is one box (`.seo-serp-crumb`,
    `inline-block`, each but the last holding its `›` after a no-break space), so the trail breaks between
    crumbs: on `main` it broke "cold-brew-" from "coffee-at-home" at 348px and 300px (the card breaks
    anywhere). A crumb wider than the card still wraps inside itself. The text reads as before.
  - **Content's width meters:** a verdict's number and its unit are joined by a no-break space
    (`widthMeter`'s label), so a narrow meter wraps between words, never inside "12,345 px": on `main`,
    at 324px, "12,345 px of about 920 | px: cut".
  - **SERP's Who owns page 1:** at the default 360px panel (its wrap 287px) it is the four-column table, as
    on `main`. A domain wraps (it was cut by an ellipsis) only at its dots (a `<wbr>` after each,
    `domainLabels`) and hyphens, never inside a label: `overflow-wrap: break-word`, not the page text's
    `anywhere`, which let the table's auto layout squeeze the column and break "brewguide.exam|ple"; the
    column is never narrower than its longest label, so only a single label wider than it would scroll. The
    table has no inline padding at its outer edges (the card has its own): the four columns had left
    "brewguide.example" 0.5px short of one line at 360px (120.5px of 121px); now the column is 119.8px
    for a 115px name. With five long real domains (`LONG_DOMAINS`: `seriouseats.com`, `example.co.uk`, the
    fixture's two and `the-very-long-green-tea-company-of-great-britain.co.uk`, as the table names them)
    at 360px the 59-character one takes three lines, broken after hyphens, every other domain one, nothing
    scrolls. Where four columns don't fit (`@container serp-table (width < 280px)` on the tables' wrap:
    227px at 300px, where it scrolled 60px sideways) the table stacks: each row two lines, the domain
    across the row (breaking anywhere there) and its counts under it in three columns under their headers,
    the head likewise. Where three counts can't hold their headers (`width < 180px`: the 588px window's
    111px, where "Results" ran 12px and "Positions" 22px past their columns and the wrap scrolled 22px) a
    row takes three lines: the domain, then Results and Share under their headers, then Positions across
    the row, only the last line ruled. A round raised the stacking threshold to 300px, which stacked the
    table at the default width; it is 280px again. It stays table markup with its header cells, and
    Chromium's accessibility tree still holds a table of 4 column headers, 2 row headers and 6 cells. The
    probe table (Visibility) shared the wrap but none of these rules; since UI polish round 2 it has no
    wrap and lays itself out (below). The
    parameter grid above it holds at 300px (it broke twice in #49).
  - **Search Console's controls:** the range row wraps (`flex-wrap`), "More ranges…" at its own width, its
    longest preset's (no longer capped at 45% of the row; no `min-width: 0`), never wider than the row. The
    filters are a split fixed by the stylesheet, whatever is chosen and on every OS: the country and device
    selects in two equal columns (`grid-template-columns: repeat(2, minmax(0, 1fr))`, `min-width: 0`), a
    name too long for its select ending in an ellipsis (`text-overflow`), and "Clear filters" on the line
    under them, so the selects keep their widths when it comes and goes. Under `@container gsc (width <
    280px)` (the 300px panel's 256px) each select takes the row. The first round sized a select by its
    chosen option (`field-sizing: content`): the halves were equal only while each chosen label was under
    half the row ("St. Vincent & Grenadines" made them 173px and 117px), arrowing through a closed select
    wrapped and unwrapped the row, and macOS CI drew them unequal. Two columns hold "United Kingdom"
    (125px with the select's padding and arrow) from a 258px panel, so 280px, not the 260px suggested,
    keeps 11px in hand. Measured on Linux with every country Search Console names (`GSC_COUNTRY_ALPHA3`):
    at 360px the selects are 155px and 155px on one line with "All countries", "United Kingdom" and "South
    Georgia & South Sandwich Islands" (ellipsis) chosen, at the same places each time; at 300px each is
    256px on its own line, "United Kingdom" whole. The only movement on a choice is "Clear filters" taking
    its line when the first filter is set and leaving it when the last is cleared. On `main`, at 300px,
    "More ranges…" was cut 12px, "United Kingdom" 49px ("United…"), "All devices" 20px and the days 1-2px
    each; at 360px "United Kingdom" was cut 19px (beside "Clear filters").
  - **Content's Search Console targets:** a suggested query wraps (the decision: the whole query shows, on
    as many lines as it needs, because its tooltip, the only way to the cut part, is out of the keyboard's
    reach, and Search Console's queries are mostly a line); where it doesn't fit beside its clicks and
    "Use as target" (about 40px of the row at 300px on `main`), those go under it together, at the row's
    end (`.gsc-targets-end`, the one markup change besides the crumbs and the table's class). A page's URL
    in the target pages list keeps its one line with an ellipsis: its title holds the whole URL, as for
    every URL in the panels.
  - **The AI answers sheet's citations** (found by #55's review, not a panel): a citation is a flex row
    of its title and URL beside "Open in tab", and the URL (`overflow-wrap: anywhere`) asked for the
    whole row, so the button wrapped onto two lines beside a long URL. The button keeps its own width
    (`.ai-answer-citation .panel-button { flex: none }`); the URL wraps beside it.
  - **Visibility's probe table** (UI polish round 2; Left for later until then, as no item of this work
    named it): an eight-column table (Fact, the browser, seven crawlers), wider than any panel. Measured
    after a run on the probe page it scrolled 997px sideways at the default 360px, 1,057px at 300px and
    1,173px in the 588px window (where the panel body also scrolled 37px), and each of its 8 URL cells
    was cut 134px by an ellipsis (the URL in its title). Now chips choose a crawler and the table
    compares it with the browser in three fixed columns (`serp-panels.feature.md`, Decisions: the
    probes compare one agent with the browser at a time): `table-layout: fixed`, the fact 30% and each
    value 35% (`.visibility-table`, no `min-width`), a value wrapping in its column (`overflow-wrap:
    break-word`; a URL `anywhere`, `.visibility-table td .seo-page-text`, no longer PageText's one line
    with an ellipsis), a header without end padding (the first round broke "smartphon|e" at 300px), the
    fact column no longer sticky (nothing scrolls under it), the wrap's sideways scroll gone with the
    wrap (`.serp-table-wrap` is the ownership table's alone); robots.txt as read wraps its URL too
    (`.visibility-robots-file`: it was cut by an ellipsis at 300px). At 300px, the default 360px
    and the 664px window nothing scrolls sideways and no chip, header, cell, note or robots.txt line is
    cut (`visibility-comparison-fits`).
  - **Not here:** the Changes panel's capture card at the 588px window, which `workspace-layout.feature.md`
    records as fixed (round 3 of the layout PR: the Screenshot row and the Project picker stack; its e2e
    checks they are whole). Under the
    panel's minimum, in the 588px window, Search Console's scope and day segments are cut ("Whole
    property" 12px) and its body scrolls 9px: that width is `NARROW_PANEL_WRAPS`', not these parts'.

## Rollout
1. Screenshot baseline (Playwright, light and dark).
2. Foundation (done).
3. Values (done): re-point the aliases and swap the shared names to their Signal values; Geist is
   bundled (done, its own change), applied per surface through the `--text-*` tokens from step 4 on
   (the command palette first); `--font-ui` stays the system stack (until step 6).
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
   `--render-edge`, `--bg-field-hover`, `--shadow-field` and `--panel-art`), then Indexability, Page Speed and Compliance (none retired: JavaScript,
   Search Console and later panels read each), then Content, JavaScript, SERP and Visibility (Content's
   result preview was the last reader of `--serp-title`, `--serp-path`, `--serp-glyph` and
   `--serp-glyph-mark`, now `removed`; `--serp-card` and `--serp-text` are aliases), then the Changes panel, Projects, Rankings, Inspector and
   the screenshot editor (none retired: other surfaces still read each), then the panel stylesheets (`--gsc-grid`). The palette is the first to apply Geist (a rule reading `--text-*`); a font can
   now load whenever such text is drawn, so `geist-fonts-load` records font requests from launch, not
   from the moment the test starts watching.
5. Cleanup (done): the names no rule reads are `removed`, retired names and aliases of another Signal
   token alike (21: `--bg-chrome`, `--palette-bg`, `--jump-tile-bg` and `--agent-card` after their
   readers moved to their Signal tokens), and the last `--ok`-as-text rule moved to `stroke`, with no
   pixel changed.
6. Base face (done): `body` sets `--text-body` (`BASE_TYPE`) and the six texts that inherited the system
   face set their own type (`TEXT_TYPE_RULES`), with a re-baseline; `--font-ui`, `--bg-page`, `--agent-bg`
   and `--seo-rail-width` are `removed`. The legacy names still declared are the Signal tokens' own names,
   the layout constants and `--seo-panel-width`. What is left is listed under Left for later.
7. Later states (done): the states the rollout left with no visible cue, or one that failed a contrast or
   forced-colours check. A pass is a check (`PASS_CHECK`); the editor bar's disabled checkbox labels, a busy
   `.panel-button` marked `aria-disabled` (the crawl sheet's Export CSV and Start crawl, AI answers' Ask)
   and a Projects row during a capture run take the disabled colours, `GrayText` under forced colours, with
   no fade; the busy screenshot kind no longer pulses; the tab's render-profile badge edges "needs reload"
   dashed and "failed" solid, with no edge at rest under forced colours (and its name says which); Help's
   setup check is a 1px ring, its marks kept under forced colours; the meters' fill has a `--bg-surface`
   boundary, square at its inner end. Round 1: a pass check on a hovered or focused "More panels" row sits
   on a `--bg-surface` disc, and AI answers' busy Ask opens nothing.
8. The panels at 300px (done): the parts that cut their text or scrolled sideways at the panel's
   narrowest width are laid out for it (`NARROW_PANEL_FITS`, The panels at 300px), and the navigation
   timing shows every phase (`NAVIGATION_PHASE_MIN_WIDTH`).
9. UI polish round 2, the SEO panels: Visibility's probe table compares one crawler with the browser
   and fits the panel (The panels at 300px; the last Left-for-later item of the panels), and Overview's
   scores, counts and "Highlight everything" are one summary card (`seo-sidebar.feature.md`, Overview,
   the summary; `.seo-summary` joins the Overview's `SIGNAL_SURFACES` classes, `.seo-score-card` is a
   row in it and no longer a card of its own).

## Unit (`apps/desktop/src/__tests__/design-tokens.test.ts`)
- **Scenario: tokens-stylesheet-holds-only-root-tokens** — `tokens.css` has only `:root` blocks
  (light, and dark under the media query) holding only custom properties, never one name twice in a context, and a dark value only overrides
  a light one.
- **Scenario: signal-tokens-are-defined** — every Signal token is in light; every colour, state and
  elevation token is in dark too, and nothing else is; every Signal token, shared names included,
  has exactly its spec values; `--icon` is not a Signal name (it is `removed`; the size is `--icon-size`).
- **Scenario: legacy-tokens-are-defined** — the migration map has all 89 legacy names; every one not
  `removed` is in `tokens.css`, which holds nothing beyond legacy and Signal names, and every
  replacement named is a Signal token.
- **Scenario: removed-legacy-tokens-are-gone** — a `removed` row is a `retire` row or an `alias` of
  another Signal token (its `signal` neither null nor its own name), and no `removed` name is a Signal
  token; each surface PR's, the cleanup's and the base face's names are among them, and every name not
  `removed` is a self-alias, a layout constant or `--seo-panel-width`; a `removed` name is declared in
  neither theme of `tokens.css`, and no renderer source (`.css`, `.ts`, `.tsx`, `index.html` under
  `src/renderer`, each kind present in the search) mentions it outside a comment. A script's comments are
  found by a scanner that keeps string, template and regex literals whole (`'a//b var(--bg-chrome)'` is
  still read; fixtures: double quotes, a template with `${…}`, a URL, a regex holding `//` or a quote).
  The renderer is enough: nothing in `src/main`, `src/preload`, `src/workers` or `e2e/visual.css`
  reads a token.
- **Scenario: legacy-token-values-are-pinned** — the 89 legacy names' light and dark values match a
  committed snapshot (the values step updated it on purpose: the aliases became `var()`, their dark
  entries went, and the shared names took their Signal values; each surface PR, the cleanup and the
  base face drop their `removed` names from it).
- **Scenario: legacy-aliases-point-at-signal-tokens** — every alias still declared whose Signal token
  has another name is exactly `var(<signal>)` in light and has no dark override; the self-aliases are exactly
  the shared names; `--w-panel` and `--w-rail` equal `SIDEBAR_PANEL_WIDTH` / `SIDEBAR_RAIL_WIDTH`
  (`specs/seo-sidebar.spec.ts`).
- **Scenario: signal-contrast-meets-aa** — every `CONTRAST_PAIRS` pair reaches its minimum WCAG 2.x
  contrast ratio in light and in dark, read from `tokens.css` (`var()` resolved, translucent colours
  composited, a translucent `over` on its opaque `under` first: a tinted badge over a hovered row; a pair
  whose `under` is translucent or whose `over` is opaque fails before compositing); the ratio helper matches known values (black on white 21:1, `#777` on white ≈ 4.48).
- **Scenario: graphics-only-colours-draw-no-text** — each `GRAPHICS_ONLY_COLOURS` name still misses
  4.5:1 on `--bg-surface` in at least one theme (else the entry is stale) and is no text pair in
  `CONTRAST_PAIRS`, and no declaration in the renderer's stylesheets draws text in it: `color` or
  `-webkit-text-fill-color` reading it anywhere in the value, or through a custom property the stylesheet
  sets to it (one level). Fixtures: a plain rule, `@media`, `@supports`, native nesting, a custom property,
  `var( --ok )`, `!important`, `-webkit-text-fill-color` and `color-mix()` are caught; `--ok-ink`, a
  `stroke`, a border and a custom property only a `stroke` reads are not.
- **Scenario: body-sets-the-base-type** — `BASE_TYPE.font` is a type token; `body`'s rule in `styles.css`
  sets exactly `font: var(--text-body)` and no other font longhand or letter-spacing; it is the only rule
  in any renderer stylesheet setting a font on `:root`, `html` or `body` (a selector whose subject is one of
  them or `*`, also inside `:where()` or `:is()`, never a pseudo-element; fixtures: `:where(body)` with a
  font and with a line height, `*` with a size, `:is(html)` and `body` in a list are caught; `body .x`, `.body`,
  `*::before`, `* .x` and a rule with no font are not); `button` and `input` each sit in
  a rule setting `font: inherit`; and no stylesheet but `fonts.css` sets `font-family` or a `font` that
  is not one `var(--text-*)` or `inherit` (so nothing names the system stack).
- **Scenario: text-type-rules-resolve** — for each `TEXT_TYPE_RULES` entry, its `font` is a type token and
  its `weight` one `BUNDLED_FONTS` has for that token's family; each selector it names is one of its
  stylesheets'; in light and dark the cascade over its `element` (its stylesheet, then each
  `loadsBefore`) resolves `font` to `var(<font>)`, and `font-weight` and `font-style` to the entry's
  `weight` and `style`, or to nothing set when it names none, and `display` to the entry's `display` when it
  names one; a `font` shorthand resets the weight and
  style set before it (the resolver's fixtures: a shorthand after a weight and an italic drops both; a
  later weight sets it again; `.panel-button.x`'s font wins over `.panel-button`'s from a stylesheet
  loaded after it, and drops its weight). The six texts are each named in an entry.
- **Scenario: tab-strip-sets-tabs-off-the-strip** — in light and dark, against the (opaque) strip
  (`TAB_STRIP.strip`), the active tab's fill reaches `TAB_STRIP.minActiveOnStrip`, an inactive tab's
  (`TAB_STRIP.idle`, composited over the strip) `minIdleOnStrip` and a hovered tab's (`TAB_STRIP.hover`,
  composited over the strip) `minHoverOnStrip`; `TAB_STRIP.activeIndicator` reaches `minIndicator`
  against the active, inactive and hovered fills (each composited over the strip) and the strip itself;
  and the cascades over `TAB_STRIP.activeTab` and `TAB_STRIP.activeTabHovered` in `styles.css` each give
  the active tab a `box-shadow` holding `TAB_STRIP.activeIndicatorShadow` (`inset 0 -2px 0
  var(--accent)`, the whole term), so the cue is really drawn, under the pointer too.
- **Scenario: cascade-checks-read-every-at-rule** — the cascade resolver every check below uses reads a rule
  inside any at-rule, and applies its block by the state it resolves in (`CASCADE_CONTEXTS`, `CascadeContext`):
  the dark and forced-colours blocks as before; a `prefers-reduced-motion: reduce` block only in reduced motion;
  an upper-bound width `@media` (`max-width: 760px`) only with the viewport narrow; a `@container` block only
  with that container narrow (`seo-panel`, not `chrome`; `*` names every container); `@supports (display: grid)`
  always and `@supports not (display: grid)` never; `@keyframes` never; features joined by `and` all must hold,
  and an at-rule inside another applies when both do. Native nesting under one parent selector is read:
  `.a { &:hover { … } }` is `.a:hover`, `.a { .b { … } }` is `.a .b`, `.a { & + & { … } }` is `.a + .a`, and
  `.a { @media (forced-colors: active) { … } }` sets `.a` under forced colours. It throws on what it can't
  apply (`@layer`, `min-width`, `width >`, a comma list, `not` or `or` in a `@media` query, an unknown media
  feature, an unnamed `@container`, `@container not (width < 300px)`, `@supports (not (display: grid))`,
  `@supports (display: grid) and (not (display: flex))`, nesting under a selector list such as
  `.a, .b.c { &:hover { … } }`, `div, .a { &:hover { … } }`, `.a, .b { & + & { … } }` or `.a, .b { .c { … } }`
  (each takes `:is()` of the whole list, which is not modelled), and `.a { &[title='&'] { … } }`), so nothing
  is skipped unread. Every renderer stylesheet's at-rules are among those it applies: each stylesheet's rules resolve in
  every `CASCADE_CONTEXTS` state without a throw. A focus ring a `@container chrome (width < 700px)` rule takes
  away, or a colour a reduced-motion rule changes, fails its check in that state. Each check below runs in light
  and dark in every `CASCADE_CONTEXTS` state.
- **Scenario: text-colour-rules-resolve** — for each `TEXT_COLOUR_RULES` entry, in light and dark,
  the cascade over its `element` selectors in its stylesheet (and then each of its `loadsBefore`, read
  after it: a later sheet's rule wins a tie, two classes win whatever the order) resolves `color` to `var(<color>)` (and
  `background` to `var(<background>)` where the entry names one), and that pair is in
  `CONTRAST_PAIRS`; for an `unfaded` entry (a disabled button shown by its colours), `opacity` resolves to
  nothing under 1, so a fade put back in place of the colours fails; and each of a `drawn` entry's
  declarations resolves to its value (the timing boundary's, and the length and width meters' fill
  boundary's, `stroke: currentColor`, `stroke-width: 2px` and `paint-order: stroke`; the meters' also
  `shape-rendering: crispEdges`, since an anti-aliased 1px boundary split into two columns at about 2:1,
  and `rx: 0`, since crisp, the fill's `rx="3"` drew a staircase at each end; the length meter's pill clip
  rounds the outer end, and the width meter's fill is clipped to its track's shape, `seo-content.feature.md`'s
  `snippet-editor-previews`, since its bar does not clip: its mark stands 1px past it). A busy `.panel-button`
  marked `aria-disabled` is `--text-faint` on `--bg-subtle`, unfaded, hovered too and primary or not.
- **Scenario: fades-spare-focus** — in each `FADES_SPARE_FOCUS` stylesheet, every rule setting an
  `opacity` under 1 ends each selector with `:not(:focus-within)`, and one such rule exists; it catches
  the same fade without it, and a list with one selector that lacks it.
- **Scenario: focus-rings-outlast-hover-and-busy** — for each `FOCUS_RING_RULES` entry (Settings' and
  Help's controls, the chrome's tools, tabs, new-tab button, address bar and prompt buttons, an SEO
  issue's heading row and the panels' link button, the panels' toggles, row actions, segments,
  chips, select, search field and rows, and Schema's entity rows, references, open-URL button and
  "Show more", and the rest of the chrome's: the error panels' and the bands' buttons, the find bar's
  field and tools, the editor bar's chips and fields, the frame's buttons, the DevTools drawer's tabs,
  buttons, links and fields, and History's controls; and Page Speed's Resume and Compliance's
  accessibility rule rows; and Content's danger toggles, fields, query clear button and n-gram
  highlight button, and SERP's editor selects; and the Changes panel's versions and project picker,
  Projects' buttons, fields, rows, views and link button, the rank table's row button, the Inspector's
  tree rows, matches and chosen view, and the screenshot editor's swatches and text field), in light and
  dark, the cascade over its `element` selectors in its stylesheet (specificity, with `:where()` adding
  none and a selector list split only outside parentheses, then source order) resolves `box-shadow` to
  `var(--focus-ring)` (inset layers before it allowed, an outer layer not; an entry's `insetBefore`, the
  chosen Search Console tile's inner `--accent` line, required exactly) and `outline` to `2px solid
  transparent`, and sets no `opacity` under 1: a focused
  button keeps its ring, at full strength, when hovered, when busy (`aria-disabled`) and when primary;
  so does a focused switch, and the chosen choice, and a `.panel-button` busy while still focusable
  (`aria-disabled`: the crawl sheet's Export CSV and Start crawl, AI answers' Ask), primary or not. The resolver itself scores
  `.a:hover:where(:not([x], :disabled))` as two classes.
- **Scenario: busy-buttons-show-under-forced-colours** — for each `FORCED_COLOURS_BUSY` entry (a
  Settings button, a primary one and Export Diagnostics' Save, each busy and disabled; a disabled
  toolbar tool; the permission prompt's buttons before they arm; Overview's zero-count pill; a disabled
  panel toggle, row action, segment, filter chip and Schema's open-URL button; a disabled error-panel
  button, primary or not, update notice button, find bar tool, editor bar chip or button; the
  accessibility tally's tile for an impact with no violated rule; an n-gram's place mark for a place it is not in; a disabled Projects sheet button and
  Delete project; a `.panel-button` busy while focusable (`aria-disabled`), primary or not; the editor bar's
  checkbox label whose box is disabled; a Projects page or search row during a capture run, its label,
  hovered, and its last-capture line), in light and
  dark, the cascade over its `element` selectors with the `@media (forced-colors: active)` rules read
  too (a `border` shorthand counting as its colour) resolves `color` and `border-color` to `GrayText`:
  busy is shown by colour, which forced colours replace, and no later rule of the control's own wins
  over it. Every selector named is one of the stylesheet's.
- **Scenario: pressed-toggles-show-under-forced-colours** — for each `FORCED_COLOURS_PRESSED` entry (the
  SEO sidebar's and the AI agent's toggles (one `.sidebar-toggle` rule) and the render-profile toggle, pressed; a panel toggle, the chosen segment and a
  filter chip, pressed; the find bar's Match case, pressed; the DevTools drawer's selected tab; an n-gram's highlight button,
  pressed; the chosen version, project, view, node, Inspector view, source match and swatch), in light
  and dark, the cascade over its
  `element` selectors with the `@media (forced-colors: active)` rules read too resolves `border-color` to
  `Highlight`. An entry with `rest` (a version, a project, a tree row, a source line, a swatch, a Projects view) also
  resolves `border-color` to `Canvas` over its first selector alone, the item unchosen (forced colours paint a
  transparent border, so without the reset every item draws the same edge), and the source line's `match`
  to `CanvasText` over its first two, a matching line that is not the current one. Every selector named is
  one of the stylesheet's.
- **Scenario: status-marks-keep-their-colours-under-forced-colours** — for each `FORCED_COLOURS_KEPT`
  entry (the SEO rail's dots, Overview's category marks: pass (a check), error, warning and notice; Help's
  setup steps, done and not done; Schema's status
  mark: valid, warnings, errors; a verdict's signal marks: pass, warning, error and neutral; Page Speed's
  live line: measuring or paused, live and unavailable; its navigation timing's phase swatches), in light and
  dark, the cascade over its `element` selectors with the `@media (forced-colors: active)` rules read
  too resolves `forced-color-adjust` to `none`, so a mark whose fill or border colour is its status keeps
  it. Every selector named is one of the stylesheet's.
- **Scenario: pass-marks-draw-a-check** — in light and dark, in every `CASCADE_CONTEXTS` state, `PASS_CHECK.selector` resolves in
  `styles.css` to `PASS_CHECK.size` square, `fill: none`, `stroke: var(--ok)` and `stroke-width`
  `PASS_CHECK.strokeWidth` (2px: two device pixels at 1×, solid at this size); `CONTRAST_PAIRS` holds
  `--ok` on `--bg-sheet` and on `--bg-surface` at 3:1. Each of `PASS_CHECK.backs` resolves `background`
  to its value (the rail's halo `var(--seo-dot-back)`, Overview's `transparent`, a hovered or focused
  "More panels" row's `var(--bg-surface)`), and to its `forced` value with the forced-colours rules read,
  so a green disc put back under the check fails. `PassCheck` (`icons.tsx`) draws it: Overview's
  passing categories hold one `aria-hidden` SVG of `PASS_CHECK.viewBox` whose path is `PASS_CHECK.d`, and
  a category with an error none (`overview-page-type.test.ts`, `a-passing-category-draws-a-check`); the
  SEO rail's pass dot holds that path, and its error dot none (`seo-sidebar.e2e.ts`,
  `good-page-scores-high` and `bad-page-shows-issues`).
- **Scenario: only-kept-marks-opt-out-of-forced-colours** — every `forced-color-adjust` declaration in
  every renderer stylesheet, whatever surface its rule belongs to and whatever its value (`auto` too:
  a rule handing an element back to forced colours is not supported yet, and none exists), sits in a
  rule each of whose selectors a `FORCED_COLOURS_KEPT` entry for that stylesheet names, and a kept
  mark's is `none` (a nested `auto` would hand it back unseen by the cascade check); a declaration
  in a nested at-rule is matched on its nearest enclosing selector. It passes the kept marks at the top
  level, inside `@media (forced-colors: active)` and with that block nested in their rule; it catches
  `.seo-speed-source` (no kept mark) in `styles.css`, `.seo-overview` and the kept
  `.seo-rail-dot` in `settings.css`, `auto`, a list with one unkept selector, an unkept rule with a
  nested block and a kept mark set to `auto` in a nested block.
- **Scenario: hover-overlays-skip-pressed-controls** — for each `HOVER_OVERLAYS_SKIP_PRESSED` entry
  (the panels' toggle and row action, Content's n-gram highlight button, the Changes panel's version), its stylesheet has a hover rule for the control, and every rule
  with a compound selector holding the control's class and `:hover` (any order, after any ancestor) that
  sets `box-shadow` or `background` names `[aria-pressed='true']` in a `:not(…)` of that compound. It
  passes `.x:hover:where(:not(:disabled, [aria-pressed='true']))`, catches `.x:hover:where(:not(:disabled))`,
  `.x:hover { background }`, `.x.y:hover`, `.x:not(:disabled):hover` and `.tools .x:hover`, and ignores a
  hover that sets only `color` and `.x-danger:hover`.
- **Scenario: disabled-controls-dim-their-text** — for each `DISABLED_CONTROLS` entry (a disabled
  filter chip and segment, and the Changes panel's screenshot kinds; the AI judgment's busy chip, the
  Search Console calendar's arrows and days out of range, Content's "Use as target"; the editor bar's
  checkbox labels whose box is disabled; a Projects page or search row during a capture run, its label
  hovered and its last-capture line), in light and dark,
  the cascade over its `element` selectors resolves `color` to `DISABLED_INK` and sets no `opacity` under 1,
  and no rule of its cascade whose subject names one of those selectors' classes runs an `animation` whose
  `@keyframes` set `opacity` (a pulse is a fade). It catches the busy screenshot kind's pulse put back,
  and passes an icon's pulse inside a button and a spin. Its limits: only rules whose subject is the
  control are read, so a pulse on a container around it passes; and every state of its classes is
  read, so an opacity entrance animation on a listed control would fail it (none exists).
- **Scenario: pressed-controls-draw-an-edge** — for each `PRESSED_EDGES` entry (a pressed filter chip,
  a pressed n-gram highlight button; the chosen version, project, node,
  Inspector view and swatch),
  in light and dark, the cascade over its `element` selectors resolves `border-color` to `var(<edge>)`
  with a border that draws (non-zero width, a style other than `none` or `hidden`, shorthand included;
  it catches `border: 0 solid transparent` and `border-style: none`), and `CONTRAST_PAIRS` holds the edge on each of its `fills` at 3:1 or more. Every selector named is one
  of the stylesheet's.
- **Scenario: state-edges-draw-their-shape** — for each `STATE_EDGES` entry (Content's query term,
  present and absent; the tab's render-profile badge, needing a reload (dashed), failed (solid) and both
  (solid); Help's setup check not yet done, a 1px ring), in light and dark, the cascade over its `element` selectors resolves
  `border-color` to `var(<edge>)`, `border-style` to its `style` and `border-width` to its `width` (the
  shorthand and longhands alike; style and width also with the `@media (forced-colors: active)` rules
  read, where the shape is all that tells the states apart), and `CONTRAST_PAIRS` holds the edge on each of its `fills` at 3:1 or
  more (its `under` too: the badge on an inactive or hovered tab). An entry with `rest: 'canvas'` (the badge)
  resolves `border-color` to `Canvas` over its first selector alone with the forced-colours rules read: at
  rest it draws no edge there, so a solid state is not the rest's transparent border repainted. Every selector named is one of the stylesheet's.
- **Scenario: no-other-stylesheet-declares-root-tokens** — no other renderer stylesheet declares a
  custom property in a rule whose selector starts with `:root` or `html` (`html.x`,
  `:where(:root)`, … included).
- **Scenario: tokens-load-before-every-other-stylesheet** — `main.tsx` imports `tokens.css` first
  among stylesheets and before `App`, and `styles.css` after `App`; every guard entry's `loadsBefore` is
  `styles.css`, for a stylesheet `main.tsx` does not import (a feature's own, inside `App`). Every guard
  that resolves a cascade (`FORCED_COLOURS_*`, `TEXT_COLOUR_RULES`, `FOCUS_RING_RULES`, `DISABLED_CONTROLS`,
  `PRESSED_EDGES`) reads an entry's stylesheet and then its `loadsBefore` as one.
- **Scenario: surface-rules-read-signal-tokens** — for each `SIGNAL_SURFACES` entry, every rule of the
  surface in its stylesheet (any selector in its list names one of the surface's classes on a class
  boundary, at any nesting: `@media`, `@container`; or it is in the surface's `@keyframes`; an entry's
  listed `classes` each start with its prefix, an entry with no prefix lists its classes, and its
  `keyframes` come only with them) reads only
  Signal tokens, legacy aliases still declared (not `removed`) and component-scoped custom properties (declared in the same
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
- **Scenario: projects-sheet-stacks-by-its-own-width** — `PROJECTS_SHEET_NARROW`: the sheet declares
  `container: projects / inline-size`; the `.projects-body` rule setting `grid-template-columns:
  minmax(0, 1fr)` sits inside `@container projects (max-width: 640px)` (a `@media` query, or an unnamed
  `@container`, fails); every `@container` that holds a `.projects-*` rule in `styles.css` or `rankings.css`
  names `projects`; and `.projects-bulk-group` keeps `min-inline-size: 0`.
- **Scenario: narrow-panel-fits-resolve** — each `NARROW_PANEL_FITS` entry's declarations resolve on
  exactly its selector in its stylesheet: the last top-level one (`query` null), or the last inside its
  `@container` query, which comes after every declaration of that property on that selector at the top
  level or in a wider query of the same container (a larger `width <` bound) and names the container its
  `container` rule declares (`container: <name> / inline-size`); an `after` entry's declaration comes after
  every top-level one of those selectors setting the same property (`.seo-speed-bytes` after
  `.seo-speed-num`'s `nowrap`); and no top-level rule of the selector sets an `absent` property
  (`min-width` on Search Console's selects, `max-width` on "More ranges…"). Reverting any fix, or moving
  a rule above the one it overrides, fails it.
- **Scenario: hex-colours-do-not-grow** — the literal hex colours outside `tokens.css` (comments
  aside) stay at or under `HEX_COLOUR_RATCHET`.
- **Scenario: ring-edges-keep-a-forced-colours-border** (`apps/desktop/src/__tests__/edge-and-focus-styles.test.ts`; issue #25) — the
  command palette's card (`.palette`), its key hints (`.palette-kbd`) and Help's key hints (`.help-kbd`) draw
  their edge with `--e-ring`, a shadow forced colours drop, so each also has a `1px solid transparent` border
  (the edge forced colours draw, as the settings cards'); the box stays the size it was: the hints' 1px of
  padding the border takes comes off their horizontal padding (`calc(var(--space-2) - 1px)`) and, on Help's, the vertical 1px.
- **Scenario: agent-focus-shows-the-ring** (`apps/desktop/src/__tests__/edge-and-focus-styles.test.ts`; issue #25) — a focused
  attach-menu option (`.agent-attach-option`) and the agent's two focusable code blocks (`.agent-code`, `.agent-pre`) show
  focus as the app's ring, as the approval card's and its buttons': `--focus-ring` beside a transparent 2px outline forced
  colours draw (and the browser's own outline does not), not the option's faint `--accent-soft` fill alone.

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

## End to end, the panels at 300px (each in its panel's suite, at the default width and after Home on the separator)
- **Scenario: lcp-late-image-e2e** (`seo-speed.e2e.ts`) — every navigation phase is at least
  `NAVIGATION_PHASE_MIN_WIDTH` wide, in order, none starting before the one before it ends, inside the axis;
  no text in the requests by type or the tiles is cut, and the tiles have three columns at the default width
  and two at 300px.
- **Scenario: accessibility-check-reports-violations-e2e** (`seo-compliance.e2e.ts`) — no tally label is
  cut; the tally has four columns at the default width and two at 300px.
- **Scenario: snippet-editor-previews** (`seo-content.e2e.ts`) — at 300px each of the trail's three crumbs
  is on one line, no text in either preview or the width meters is cut, and the title's verdict reads
  `<n> px of about <n> px: cut` with no-break spaces.
- **Scenario: content-gsc-suggestion-sets-target** (`seo-content.e2e.ts`) — no query is cut; at 300px
  each row's clicks and button end at the row's end.
- **Scenario: serp-composition-and-ownership** (`serp.e2e.ts`) — the ownership table's wrap doesn't scroll,
  and at the default width it is the four-column table with each domain whole on one line;
  at 300px neither it nor the body does, no text in the table or the parameter grid is cut, its rows are
  grids, and the accessibility tree (CDP `Accessibility.queryAXTree`) holds 1 table, 4 column headers, 2
  row headers and 6 cells; in the 664px window (`NARROW_WINDOW`, a 280px sheet) its rows have three
  columns, and in a 544px chrome (a tiled window: the 160px sheet the old 588px minimum left beside the agent's
  rail) two; at each its wrap doesn't scroll, no header or cell is cut, and each count's cell has its header's edges; with
  `LONG_DOMAINS` (`?domains=long`) at the default width it is still four columns, nothing scrolls, no
  domain breaks except after a dot or a hyphen, and the fixture's two are on one line each.
- **Scenario: gsc-panel-country-device-filters** (`gsc-panel.e2e.ts`) — with "United Kingdom" and a
  device chosen, no control's label is cut (a select against a copy of it holding only its chosen option),
  and at 300px the body doesn't scroll sideways; then with every country (`GSC_COUNTRY_ALPHA3`), for "All
  countries", "United Kingdom", the longest name and "St. Vincent & Grenadines": at the default width the
  two selects on one line at the same width to 1px (1:1), at 300px each the row's width on its own line,
  "United Kingdom" whole at both, and every box (the selects, "Clear filters", the line under them) the
  same for every choice; a failure prints the widths.
`atNarrowestPanel` gives the panel back the width it found (keyboard steps, then a drag under a step), and
a failure in its body is the one reported even if giving the width back fails too.
The check (`cutText`, `e2e/helpers.ts`) reads the text itself: each box holding text of its own whose
`scrollWidth` passes its `clientWidth`, and each select narrower than its chosen option needs.

## Left for later
What the rollout leaves, each where it lives; none is fixed by the cleanup or the base face.
- **A disabled SEO rail item fades to 0.3** (`styles.css`, `.seo-rail-item:disabled`: a panel not yet
  available, labelled "Soon"): natively disabled, so it holds no focus a fade could dim, but it says
  disabled by opacity, not by the disabled colours the other controls take, and forced colours draw it
  only faded.
- **The canvas's features the app doesn't have** (the design canvas; each would need markup or behaviour,
  not tokens): the score on the SEO sidebar toggle, "Ask frost", click-to-edit on the tab, "More tabs",
  Overview's AI-readiness, Page and AI-judgment cards as the canvas draws them, the find icon and match
  count inside the find field, and a card per issue.
