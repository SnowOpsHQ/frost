# Feature: Design tokens (Signal foundation and values)

Spec: `specs/design-tokens.spec.ts` (`TOKENS_STYLESHEET`, `SIGNAL_TOKENS`, `THEMED_SIGNAL_GROUPS`,
`SIGNAL_NAMES_WITH_LEGACY_VALUES`, `LEGACY_TOKEN_MIGRATION`, `CONTRAST_PAIRS`, `HEX_COLOUR_RATCHET`,
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
  `--bg-strip` and `--bg-tab-hover`, see Tab row);
  layout constants (aliases with `signal: null`) keep theirs. No rule outside `tokens.css` changes.
  A retired value that reads an alias moves with it: `--palette-sheet`'s gradient starts at
  `var(--bg-chrome)`, so its first stop is now `--bg-window` (its second stays a literal until the
  palette's surface PR).
- **Contrast.** Every pair in `CONTRAST_PAIRS` (the text/background and UI/background pairs the
  token sheet names, plus body text, links and on-colour buttons on every surface) reaches its
  WCAG 2.x minimum, 4.5:1 for text and 3:1 for UI, in light and dark, computed from the values in
  `tokens.css` (a translucent fill composited over its opaque surface).
- **Tab row, interim.** The active tab follows `--bg-window`, so the retired `--bg-strip` and
  `--bg-tab-hover` were retuned (they would otherwise leave the active tab about 1.05:1 off the strip
  and a hovered tab past it): `TAB_STRIP` keeps the active tab at least 1.1:1 off the strip and a
  hovered tab's luminance between the two, in both themes, until the chrome's surface PR.
- **Hex ratchet.** Literal hex colours in renderer stylesheets other than `tokens.css` never exceed
  `HEX_COLOUR_RATCHET`; each surface PR lowers it.
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
  `tokens.css`. The fonts are available, not applied: `--font-ui` and every rule are unchanged until
  the surface PRs adopt the `--text-*` tokens.

## Rollout
1. Screenshot baseline (Playwright, light and dark).
2. Foundation (done).
3. Values (done): re-point the aliases and swap the shared names to their Signal values; Geist is
   bundled (done, its own change) but not yet applied.
4. Next, one PR per surface: rules move onto Signal tokens, retired names go. The first one that
   applies Geist (a rule reading `--text-*`) makes the fonts load at startup, before
   `geist-fonts-load` starts watching requests: that PR reworks the scenario.

## Unit (`apps/desktop/src/__tests__/design-tokens.test.ts`)
- **Scenario: tokens-stylesheet-holds-only-root-tokens** — `tokens.css` has only `:root` blocks
  (light, and dark under the media query) holding only custom properties, never one name twice in a context, and a dark value only overrides
  a light one.
- **Scenario: signal-tokens-are-defined** — every Signal token is in light; every colour, state and
  elevation token is in dark too, and nothing else is; every Signal token, shared names included,
  has exactly its spec values; `--icon` stays a colour.
- **Scenario: legacy-tokens-are-defined** — all 89 legacy names are in `tokens.css`, which holds
  nothing beyond legacy and Signal names, and every replacement named is a Signal token.
- **Scenario: legacy-token-values-are-pinned** — the 89 legacy names' light and dark values match a
  committed snapshot (the values step updated it on purpose: the aliases became `var()`, their dark
  entries went, and the shared names took their Signal values).
- **Scenario: legacy-aliases-point-at-signal-tokens** — every alias whose Signal token has another
  name is exactly `var(<signal>)` in light and has no dark override; the self-aliases are exactly
  the shared names; `--w-panel` and `--w-rail` equal `SIDEBAR_PANEL_WIDTH` / `SIDEBAR_RAIL_WIDTH`
  (`specs/seo-sidebar.spec.ts`).
- **Scenario: signal-contrast-meets-aa** — every `CONTRAST_PAIRS` pair reaches its minimum WCAG 2.x
  contrast ratio in light and in dark, read from `tokens.css` (`var()` resolved, translucent colours
  composited); the ratio helper matches known values (black on white 21:1, `#777` on white ≈ 4.48).
- **Scenario: tab-strip-orders-strip-hover-active** — in light and dark, the active tab
  (`TAB_STRIP.active`) against the strip reaches `TAB_STRIP.minActiveOnStrip`, and the hover fill
  composited over the strip has a luminance strictly between the strip's and the active tab's.
- **Scenario: no-other-stylesheet-declares-root-tokens** — no other renderer stylesheet declares a
  custom property in a rule whose selector starts with `:root` or `html` (`html.x`,
  `:where(:root)`, … included).
- **Scenario: tokens-load-before-every-other-stylesheet** — `main.tsx` imports `tokens.css` first
  among stylesheets and before `App`.
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
- **Scenario: geist-fonts-load** — in the chrome (`app://app/`), with a `securitypolicyviolation`
  listener installed first, `document.fonts.load()` of each `BUNDLED_FONTS` face resolves to a
  loaded `FontFace` of that family and weight; every woff2 request the page made was to `app://`
  (200, `font/woff2`), one per bundled face; and no CSP violation was reported (no event, no console
  message).
