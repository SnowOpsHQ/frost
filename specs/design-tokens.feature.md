# Feature: Design tokens (Signal foundation)

Spec: `specs/design-tokens.spec.ts` (`TOKENS_STYLESHEET`, `SIGNAL_TOKENS`, `THEMED_SIGNAL_GROUPS`,
`SIGNAL_NAMES_WITH_LEGACY_VALUES`, `LEGACY_TOKEN_MIGRATION`, `HEX_COLOUR_RATCHET`). Source of truth:
the Signal token sheet (its values and its Migration table) and the round-2 council decisions.
Code: `apps/desktop/src/renderer/tokens.css`, imported by `main.tsx`. Each line maps to one named test.

## Decisions
- **One token source.** Every custom property that lives on `:root` is declared in `tokens.css`,
  light in a `:root` block and dark in a `@media (prefers-color-scheme: dark)` `:root` block that
  redefines only the names whose value changes. No other renderer stylesheet declares a custom
  property on `:root` (or `html`). Properties scoped to a component's own selector (`.seo-speed`,
  `.tab`, `.seo-ring`, `.devtools`, …) stay beside their rules.
- **Loaded first.** `main.tsx` imports `tokens.css` before any other stylesheet and before `App`
  (whose components import the feature stylesheets). No stylesheet is lazy-loaded.
- **Foundation: no visual change.** The legacy tokens moved into `tokens.css` with their names,
  values and order unchanged; a rule body anywhere else is untouched. `getComputedStyle` of the
  document element gives the same value for every legacy name, light and dark, as before.
- **The full Signal vocabulary.** Every `SIGNAL_TOKENS` name is defined: colour, state and elevation
  in light and dark; type (a `font` shorthand, with its letter-spacing in the spec), radius, space,
  size and motion once. Signal-only tokens carry their Signal values and nothing reads them yet.
- **Shared names keep today's values.** `--text`, `--text-muted`, `--text-faint`, `--accent`,
  `--accent-soft`, `--accent-hover`, `--on-accent`, `--ok`, `--warn`, `--danger`, `--bg-hover` and
  `--bg-active` already exist with the Signal meaning; they keep their current values until the
  values PR. `--icon` is a colour and stays one; the Signal icon size is `--icon-size`.
- **Migration map.** `LEGACY_TOKEN_MIGRATION` maps all 89 legacy names: `alias` (the name stays and,
  from the values PR on, points at its Signal token) or `retire` (replaced; removed once no rule
  uses it). The legacy names are not re-pointed in the foundation.
- **Hex ratchet.** Literal hex colours in renderer stylesheets other than `tokens.css` never exceed
  `HEX_COLOUR_RATCHET`; each surface PR lowers it.

## Rollout
1. Screenshot baseline (Playwright, light and dark).
2. Foundation (this spec).
3. Values: re-point the aliases, swap the shared names to their Signal values, bundle Geist.
4. One PR per surface: rules move onto Signal tokens, retired names go.

## Unit (`apps/desktop/src/__tests__/design-tokens.test.ts`)
- **Scenario: tokens-stylesheet-holds-only-root-tokens** — `tokens.css` declares only on `:root`
  (light) and the dark `:root`, never one name twice in a context, and a dark value only overrides
  a light one.
- **Scenario: signal-tokens-are-defined** — every Signal token is in light; every colour, state and
  elevation token is in dark too, and nothing else is; Signal-only tokens have exactly their spec
  values; `--icon` stays a colour.
- **Scenario: legacy-tokens-are-defined** — all 89 legacy names are in `tokens.css`, which holds
  nothing beyond legacy and Signal names, and every replacement named is a Signal token.
- **Scenario: no-other-stylesheet-declares-root-tokens** — no other renderer stylesheet declares a
  custom property in a `:root` or `html` rule.
- **Scenario: tokens-load-before-every-other-stylesheet** — `main.tsx` imports `tokens.css` first
  among stylesheets and before `App`.
- **Scenario: hex-colours-do-not-grow** — the literal hex colours outside `tokens.css` (comments
  aside) stay at or under `HEX_COLOUR_RATCHET`.
