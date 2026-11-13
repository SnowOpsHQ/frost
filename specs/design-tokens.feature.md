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
  `--bg-strip` and `--bg-tab-hover`, see Tab row), which moves every rule off them and drops them from
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
- **Tab row, interim.** The active tab follows `--bg-window`, so the retired `--bg-strip` and
  `--bg-tab-hover` were retuned (they would otherwise leave the active tab about 1.05:1 off the strip
  and a hovered tab past it): `TAB_STRIP` keeps the active tab at least 1.1:1 off the strip, a
  hovered tab's luminance between the two and the divider between inactive tabs at least 1.1:1 off
  the strip, in both themes, until the chrome's surface PR.
- **Known exceptions.** `KNOWN_CONTRAST_EXCEPTIONS` records what still misses its minimum, for the
  surface PRs: `--ok` as text (21 rules) is under 4.5:1 in light, and those rules move to `--ok-ink`
  (only the 11px chips moved in the values step; Settings and Help moved their 4, leaving 17).
- **Text the Signal values left too faint.** A few rules drew text in a token whose Signal value
  falls under 4.5:1 where they use it; the values step points them at a token that passes
  (`TEXT_COLOUR_RULES`), and each pair joins `CONTRAST_PAIRS`. The status bar's failed-overrides
  chip, at 4.46:1 with `--danger-ink` on its 14% tint over `--bg-chrome`, takes the sheet's
  -ink-on-soft pairing instead: `--danger-soft` fill (5.30:1 light, 8.68:1 dark).
- **Hex ratchet.** Literal hex colours in renderer stylesheets other than `tokens.css` never exceed
  `HEX_COLOUR_RATCHET`; each surface PR lowers it to its new count (the command palette's rules held
  no literal hex, their colours were all tokens, so it stayed at 53; the new-tab view's held none
  either, so it stays there, as it does for the SEO sidebar's frame; Settings' switch knob was its one, so it is 52).
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
  other surfaces share the prefix, the exact classes and `-*` families it lists with its keyframes; a
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
   `--info-tone` and `--bg-chrome-edge`). The palette is the first to apply Geist (a rule reading `--text-*`); a font can
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
  composited); the ratio helper matches known values (black on white 21:1, `#777` on white ≈ 4.48).
- **Scenario: known-contrast-exceptions-are-current** — each `KNOWN_CONTRAST_EXCEPTIONS` pair still
  misses its minimum in at least one theme, is not in `CONTRAST_PAIRS`, and exactly `rules`
  declarations in the renderer's stylesheets draw text in its `fg` (so fixing them removes the entry).
- **Scenario: tab-strip-orders-strip-hover-active** — in light and dark, the active tab
  (`TAB_STRIP.active`) against the strip reaches `TAB_STRIP.minActiveOnStrip`, and the hover fill
  composited over the strip has a luminance strictly between the strip's and the active tab's; the
  divider between inactive tabs (`TAB_STRIP.divider`) reaches `TAB_STRIP.minDividerOnStrip` against
  the strip.
- **Scenario: text-colour-rules-resolve** — for each `TEXT_COLOUR_RULES` entry, in light and dark,
  the cascade over its `element` selectors in its stylesheet resolves `color` to `var(<color>)` (and
  `background` to `var(<background>)` where the entry names one), and that pair is in
  `CONTRAST_PAIRS`.
- **Scenario: focus-rings-outlast-hover-and-busy** — for each `FOCUS_RING_RULES` entry, in light and
  dark, the cascade over its `element` selectors in its stylesheet (specificity, with `:where()` adding
  none and a selector list split only outside parentheses, then source order) resolves `box-shadow` to
  `var(--focus-ring)` and `outline` to `2px solid transparent`, and sets no `opacity` under 1: a focused
  button keeps its ring, at full strength, when hovered, when busy (`aria-disabled`) and when primary;
  so does a focused switch, and the chosen choice. The resolver itself scores
  `.a:hover:where(:not([x], :disabled))` as two classes.
- **Scenario: busy-buttons-show-under-forced-colours** — for each `FORCED_COLOURS_BUSY` entry (a
  Settings button, a primary one and Export Diagnostics' Save, each busy and disabled), in light and
  dark, the cascade over its `element` selectors with the `@media (forced-colors: active)` rules read
  too (a `border` shorthand counting as its colour) resolves `color` and `border-color` to `GrayText`:
  busy is shown by colour, which forced colours replace, and no later rule of the control's own wins
  over it. Every selector named is one of the stylesheet's.
- **Scenario: no-other-stylesheet-declares-root-tokens** — no other renderer stylesheet declares a
  custom property in a rule whose selector starts with `:root` or `html` (`html.x`,
  `:where(:root)`, … included).
- **Scenario: tokens-load-before-every-other-stylesheet** — `main.tsx` imports `tokens.css` first
  among stylesheets and before `App`.
- **Scenario: surface-rules-read-signal-tokens** — for each `SIGNAL_SURFACES` entry, every rule of the
  surface in its stylesheet (any selector in its list names one of the surface's classes on a class
  boundary, at any nesting: `@media`, `@container`; or it is in the surface's `@keyframes`; an entry's
  listed `classes` each start with its prefix, and its `keyframes` come only with them) reads only
  Signal tokens, legacy aliases and component-scoped custom properties (declared in the same
  stylesheet) in `var()` (whitespace allowed, no fallback in any property); declares no Signal or
  legacy name; holds no hex colour or colour function in any property; a colour-bearing value
  (`background-image` and custom properties included) holds only those, `transparent`,
  `currentColor`, `inherit`, `none`, lengths and `color-mix()` (so hex, `rgb()`, a gradient, `unset`,
  `initial`, any named colour fail; `text-decoration` may also name its line and style keywords, and
  a rule inside `@media (forced-colors: active)` the CSS system colours, `FORCED_COLOURS_SYSTEM_COLOURS`); a
  rule whose `box-shadow` reads `--focus-ring` sets an `outline` forced colours draw (non-zero width,
  not `none`: `outline: 2px solid transparent`); no `font-size`, `font-family` or `line-height`; `font` only `var(--text-*)`; a
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
  `.x-seo-rail`, `.seos` and any other keyframes (`seo-ring-fill`, `seo-panel-in-more`).
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
