/**
 * Design tokens (the "Signal" design system; acceptance: `design-tokens.feature.md`). Plain data with
 * no imports, like the other `*.spec.ts` specs. Source of truth: the Signal token sheet
 * (`Tokens.dc.html`, its values and Migration table) and the round-2 council decisions.
 *
 * One stylesheet, `apps/desktop/src/renderer/tokens.css` (`TOKENS_STYLESHEET`), declares every
 * custom property that lives on `:root`, light and dark; `main.tsx` imports it before any other
 * stylesheet. It holds the legacy tokens (`LEGACY_TOKEN_MIGRATION`) and the Signal tokens
 * (`SIGNAL_TOKENS`, every one at its Signal value). A legacy alias is `var()` of its Signal token; a
 * retired name and a layout constant keep their pre-Signal values. The rollout:
 * 1. foundation (done): one token source and the full Signal vocabulary, no pixel changed;
 * 2. values (done, this step): the legacy aliases point at their Signal tokens and the names in
 *    `SIGNAL_NAMES_WITH_LEGACY_VALUES` take their Signal values; Geist and Geist Mono are bundled
 *    (`BUNDLED_FONTS`, declared in `FONTS_STYLESHEET`) but not yet applied;
 * 3. next, one PR per surface moves its rules onto Signal tokens and drops the retired names it used.
 */

/** The renderer stylesheet (relative to `apps/desktop/src/renderer/`) that declares every token. */
export const TOKENS_STYLESHEET = 'tokens.css';

export type TokenName = `--${string}`;

/**
 * One Signal token. `light` is its value in light mode, and in dark mode too unless `dark` is
 * given (only colours, states and elevations change with the theme).
 */
export interface SignalToken {
  readonly name: TokenName;
  readonly light: string;
  readonly dark?: string;
  /** What it is for, from the token sheet. */
  readonly use?: string;
}

/** A type-scale token: `light` is a `font` shorthand; letter-spacing can't ride in it. */
export interface SignalTypeToken extends SignalToken {
  /** The letter-spacing to set beside the `font` shorthand. */
  readonly tracking: string;
}

/** The token groups; every group but type, radius, space, size and motion has a dark value. */
export type SignalTokenGroup = 'colour' | 'state' | 'type' | 'radius' | 'space' | 'elevation' | 'size' | 'motion';

/** Every group's tokens; the type scale's carry their letter-spacing. */
export type SignalTokenSet = { readonly [G in SignalTokenGroup]: readonly (G extends 'type' ? SignalTypeToken : SignalToken)[] };

const SANS = 'Geist, system-ui, sans-serif';
const MONO = "'Geist Mono', ui-monospace, monospace";

/**
 * Every Signal token. Values follow `tokens.css` notation (`0.55`, not `.55`). `tokens.css` declares
 * each at exactly these values, the names in `SIGNAL_NAMES_WITH_LEGACY_VALUES` included.
 */
export const SIGNAL_TOKENS = {
  colour: [
    // Surfaces
    { name: '--bg-window', light: '#ececee', dark: '#0f0f11', use: 'the window behind the sheets and the page card' },
    { name: '--bg-sheet', light: '#fafafa', dark: '#161618', use: 'rail, sidebar, agent panel' },
    { name: '--bg-subtle', light: '#f4f4f5', dark: '#232326', use: 'quiet fills, skeletons, disabled controls' },
    { name: '--bg-surface', light: '#ffffff', dark: '#1c1c1f', use: 'cards, fields, the page card' },
    { name: '--bg-tab-idle', light: 'rgb(255 255 255 / 0.55)', dark: 'rgb(255 255 255 / 0.06)', use: 'an inactive tab' },
    { name: '--inverse', light: '#18181b', dark: '#f4f4f5', use: 'inverse buttons (Ask frost)' },
    { name: '--track', light: '#d4d4d8', dark: '#3f3f46', use: 'the empty part of score rings and meters' },
    { name: '--switch-off', light: '#8b8b94', dark: '#71717a', use: "a switch's off track (≥ 3:1 on its card)" },
    { name: '--knob', light: '#ffffff', dark: '#f4f4f5', use: 'the switch knob, both states' },
    // Text, on-colour, rules
    { name: '--text', light: '#18181b', dark: '#f4f4f5' },
    { name: '--text-muted', light: '#52525b', dark: '#a1a1aa' },
    { name: '--text-faint', light: '#68686f', dark: '#8b8b94', use: 'secondary text, 12px and up' },
    { name: '--on-accent', light: '#ffffff', dark: '#0f0f11' },
    { name: '--on-inverse', light: '#ffffff', dark: '#18181b' },
    { name: '--divider', light: 'rgb(24 24 27 / 0.08)', dark: 'rgb(255 255 255 / 0.08)', use: 'every 1px rule' },
    // Accent (fixed: no accent picker)
    { name: '--accent', light: '#4f46e5', dark: '#8b8cf8' },
    { name: '--accent-hover', light: '#4338ca', dark: '#a5a6fa' },
    { name: '--accent-soft', light: 'rgb(79 70 229 / 0.1)', dark: 'rgb(139 140 248 / 0.16)' },
    // Status: text on a -soft fill uses its -ink (≥ 4.5:1)
    { name: '--ok', light: '#16a34a', dark: '#4ade80' },
    { name: '--ok-soft', light: '#dcfce7', dark: 'rgb(74 222 128 / 0.12)' },
    { name: '--ok-ink', light: '#166534', dark: '#86efac' },
    { name: '--warn', light: '#b45309', dark: '#fbbf24', use: 'dots and graphics (≥ 3:1 on white and sheet)' },
    { name: '--warn-soft', light: '#fef3c7', dark: 'rgb(251 191 36 / 0.12)' },
    { name: '--warn-ink', light: '#92400e', dark: '#fcd34d' },
    { name: '--danger', light: '#dc2626', dark: '#f87171' },
    { name: '--danger-soft', light: '#fee2e2', dark: 'rgb(248 113 113 / 0.12)' },
    { name: '--danger-ink', light: '#b91c1c', dark: '#fca5a5' },
  ],
  state: [
    { name: '--bg-hover', light: 'rgb(24 24 27 / 0.05)', dark: 'rgb(255 255 255 / 0.06)', use: 'laid on a hovered control' },
    { name: '--bg-active', light: 'rgb(24 24 27 / 0.09)', dark: 'rgb(255 255 255 / 0.1)', use: 'laid on a pressed control' },
    { name: '--bg-active-inverse', light: 'rgb(255 255 255 / 0.1)', dark: 'rgb(24 24 27 / 0.09)', use: 'an inverse button pressed or open' },
    {
      name: '--focus-ring',
      light: '0 0 0 2px #ececee, 0 0 0 4px #4f46e5',
      dark: '0 0 0 2px #0f0f11, 0 0 0 4px #8b8cf8',
      use: ':focus-visible (fields :focus-within): a 2px gap in the window colour, then 2px of accent',
    },
  ],
  type: [
    { name: '--text-display', light: `600 24px/1.15 ${SANS}`, tracking: '-0.02em' },
    { name: '--text-title', light: `600 18px/1.3 ${SANS}`, tracking: '-0.01em' },
    { name: '--text-heading', light: `600 15px/1.35 ${SANS}`, tracking: '0' },
    { name: '--text-body', light: `400 13px/1.45 ${SANS}`, tracking: '0', use: '500 for emphasis' },
    { name: '--text-small', light: `400 12px/1.4 ${SANS}`, tracking: '0' },
    { name: '--text-micro', light: `600 11px/1.3 ${SANS}`, tracking: '0.01em' },
    { name: '--text-caps', light: `600 11px/1.45 ${SANS}`, tracking: '0.06em', use: 'uppercase labels' },
    { name: '--text-mono', light: `400 12px/1.4 ${MONO}`, tracking: '0' },
  ],
  radius: [
    { name: '--r-xs', light: '4px', use: 'tab glyphs, key hints, match highlight' },
    { name: '--r-sm', light: '8px', use: 'rows, inputs inside cards, swatches' },
    { name: '--r-md', light: '12px', use: 'cards, rail items, notices, bands' },
    { name: '--r-lg', light: '16px', use: 'sheets, rail, page card, palette' },
    { name: '--r-pill', light: '999px', use: 'tabs, address, buttons, chips' },
  ],
  space: [
    { name: '--space-1', light: '4px' },
    { name: '--space-2', light: '6px' },
    { name: '--space-3', light: '8px' },
    { name: '--space-4', light: '12px' },
    { name: '--space-5', light: '16px' },
    { name: '--space-6', light: '24px' },
    { name: '--space-7', light: '32px' },
    { name: '--space-8', light: '48px' },
  ],
  elevation: [
    {
      name: '--e-ring',
      light: '0 0 0 1px rgb(24 24 27 / 0.06)',
      dark: '0 0 0 1px rgb(255 255 255 / 0.1)',
      use: 'cards on a sheet, palette band',
    },
    {
      name: '--e-raised',
      light: '0 1px 2px rgb(24 24 27 / 0.08), 0 0 0 1px rgb(24 24 27 / 0.05)',
      dark: '0 0 0 1px rgb(255 255 255 / 0.1)',
      use: 'active tab, selected control, field outline',
    },
    {
      name: '--e-sheet',
      light: '0 0 0 1px rgb(24 24 27 / 0.05), 0 8px 24px -12px rgb(24 24 27 / 0.18)',
      dark: '0 0 0 1px rgb(255 255 255 / 0.1), 0 16px 32px -16px rgb(0 0 0 / 0.7)',
      use: 'rail, sidebar, agent panel',
    },
    {
      name: '--e-overlay',
      light: '0 0 0 1px rgb(24 24 27 / 0.06), 0 16px 40px -12px rgb(24 24 27 / 0.28)',
      dark: '0 0 0 1px rgb(255 255 255 / 0.1), 0 16px 40px -12px rgb(0 0 0 / 0.6)',
      use: 'menus and dialogs in the chrome (never over the page)',
    },
  ],
  size: [
    { name: '--h-badge', light: '22px', use: 'badges, key hints, switch' },
    { name: '--h-chip', light: '28px', use: 'chips, band buttons' },
    { name: '--h-status', light: '28px', use: 'status bar' },
    { name: '--h-control', light: '34px', use: 'buttons, tabs' },
    { name: '--h-field', light: '38px', use: 'fields, address, rail items' },
    { name: '--h-chrome', light: '56px', use: 'the tab row, fixed' },
    { name: '--w-rail', light: '48px', use: 'SEO rail (SIDEBAR_RAIL_WIDTH)' },
    { name: '--w-panel', light: '360px', use: 'SEO panel (SIDEBAR_PANEL_WIDTH)' },
    { name: '--icon-size', light: '18px', use: 'every icon' },
    { name: '--icon-stroke', light: '1.9', use: 'icon stroke width' },
    { name: '--icon-sm', light: '16px', use: 'icons in fields, chips, palette rows' },
  ],
  motion: [
    { name: '--dur-fast', light: '120ms', use: 'hover' },
    { name: '--dur-base', light: '200ms', use: 'open, close' },
    { name: '--dur-slow', light: '320ms', use: 'sheets' },
    { name: '--ease-out', light: 'cubic-bezier(0.2, 0.8, 0.2, 1)', use: 'all motion' },
  ],
} as const satisfies SignalTokenSet;

/** The groups whose every token has a dark value (`tokens.css` redefines them in dark mode). */
export const THEMED_SIGNAL_GROUPS = ['colour', 'state', 'elevation'] as const satisfies readonly SignalTokenGroup[];

/**
 * Signal names that existed before Signal with the same meaning (the Migration table's self-aliases).
 * The foundation kept their pre-Signal values; since the values step they carry their
 * `SIGNAL_TOKENS` values, light and dark (they can't be `var()` of themselves). The name is kept for
 * history. (`--icon` is not one: it is a colour, and the Signal icon size is `--icon-size`.)
 */
export const SIGNAL_NAMES_WITH_LEGACY_VALUES = [
  '--text',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-soft',
  '--accent-hover',
  '--on-accent',
  '--ok',
  '--warn',
  '--danger',
  '--bg-hover',
  '--bg-active',
] as const satisfies readonly TokenName[];

/**
 * A legacy custom property and its Signal replacement, from the token sheet's Migration table.
 * `alias`: same meaning; the old name stays and points at `signal` (`var(<signal>)` in light, no dark
 * override; a self-alias simply carries the Signal value).
 * `retire`: replaced by `signal`; the old name goes once no rule uses it. `signal` is null when
 * nothing replaces it (a layout constant that keeps its own name, or a style Signal drops), and
 * `--text-*` means the type scale. `was` is the sheet's description of the old light value.
 */
export interface LegacyTokenMigration {
  readonly legacy: TokenName;
  readonly kind: 'alias' | 'retire';
  readonly signal: TokenName | null;
  readonly was: string;
  readonly note: string;
}

/** Every custom property that was declared on `:root` before Signal: 89 names, each mapped. */
export const LEGACY_TOKEN_MIGRATION = [
  // Chrome sizes
  { legacy: '--tabstrip-height', kind: 'retire', signal: '--h-chrome', was: '40px', note: 'with --toolbar-height: one 56px row' },
  { legacy: '--toolbar-height', kind: 'retire', signal: '--h-chrome', was: '50px', note: 'buttons join the tab row' },
  { legacy: '--status-height', kind: 'retire', signal: '--h-status', was: '26px', note: '28px' },
  { legacy: '--find-height', kind: 'retire', signal: null, was: '40px', note: 'band slot: find is a band (≥ 44px)' },
  { legacy: '--radius-control', kind: 'retire', signal: '--r-pill', was: '9px', note: '' },
  { legacy: '--radius-field', kind: 'retire', signal: '--r-pill', was: '11px', note: '--r-sm inside cards' },
  { legacy: '--seo-panel-width', kind: 'alias', signal: '--w-panel', was: '360px', note: '' },
  { legacy: '--seo-rail-width', kind: 'alias', signal: '--w-rail', was: '48px', note: '' },
  // Layout constants: kept, no visual token
  { legacy: '--page-min-width', kind: 'alias', signal: null, was: '320px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--agent-panel-width', kind: 'alias', signal: null, was: '380px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--agent-rail-width', kind: 'alias', signal: null, was: '40px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--settings-width', kind: 'alias', signal: null, was: '820px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--settings-nav-width', kind: 'alias', signal: null, was: '168px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--history-width', kind: 'alias', signal: null, was: '760px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--projects-width', kind: 'alias', signal: null, was: '980px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--projects-run-band', kind: 'alias', signal: null, was: 'min(300px, 50%)', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-width', kind: 'alias', signal: null, was: '640px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-sheet-height', kind: 'alias', signal: null, was: '404px', note: 'layout constant: the name stays, no visual token; the palette band' },
  { legacy: '--palette-sheet-min-height', kind: 'alias', signal: null, was: '180px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-page-min-visible', kind: 'alias', signal: null, was: '96px', note: 'layout constant: the name stays, no visual token' },
  // Type and icons
  { legacy: '--font-ui', kind: 'retire', signal: '--text-*', was: 'system stack', note: 'Geist, system-ui; Geist Mono' },
  { legacy: '--icon', kind: 'retire', signal: '--text-muted', was: 'icon colour', note: 'name now means size: --icon-size' },
  { legacy: '--panel-art', kind: 'retire', signal: '--text-faint', was: '#6b7a90', note: '' },
  // Surfaces and edges
  { legacy: '--bg-chrome', kind: 'alias', signal: '--bg-window', was: '#f3f5f8', note: '' },
  { legacy: '--bg-strip', kind: 'retire', signal: '--bg-window', was: '#e4e8ee', note: 'no separate strip' },
  { legacy: '--bg-chrome-edge', kind: 'retire', signal: '--divider', was: '#e2e6ec', note: '' },
  { legacy: '--bg-page', kind: 'alias', signal: '--bg-surface', was: '#fbfcfd', note: 'the page card' },
  { legacy: '--bg-field', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--bg-field-hover', kind: 'retire', signal: '--bg-hover', was: '#ffffff', note: 'over --bg-surface' },
  { legacy: '--border-field', kind: 'retire', signal: '--e-raised', was: '#d7dce4', note: 'field outlines (ring shadow, no border); --track for scrollbar thumbs; --divider or --e-ring for other borders' },
  { legacy: '--shadow-field', kind: 'retire', signal: '--e-raised', was: 'shadow', note: '' },
  { legacy: '--shadow-card', kind: 'retire', signal: '--e-ring', was: 'shadow', note: '' },
  { legacy: '--bg-hover', kind: 'alias', signal: '--bg-hover', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-active', kind: 'alias', signal: '--bg-active', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-tab-hover', kind: 'retire', signal: '--bg-hover', was: 'overlay', note: '' },
  { legacy: '--bg-prompt', kind: 'retire', signal: '--accent-soft', was: '#ffffff', note: 'band slot fill' },
  { legacy: '--prompt-edge', kind: 'retire', signal: null, was: '#dfe4eb', note: 'none: bands have no edge' },
  { legacy: '--shadow-prompt', kind: 'retire', signal: null, was: 'shadow', note: 'none' },
  // Text, accent, status
  { legacy: '--text', kind: 'alias', signal: '--text', was: '#1b2230', note: '' },
  { legacy: '--text-muted', kind: 'alias', signal: '--text-muted', was: '#5f6b7d', note: '' },
  { legacy: '--text-faint', kind: 'alias', signal: '--text-faint', was: '#8d97a6', note: '#68686f, 12px and up' },
  { legacy: '--accent', kind: 'alias', signal: '--accent', was: '#2f6fe4', note: '#4f46e5 / #8b8cf8, fixed' },
  { legacy: '--accent-soft', kind: 'alias', signal: '--accent-soft', was: '.22 alpha', note: '' },
  { legacy: '--accent-hover', kind: 'alias', signal: '--accent-hover', was: '#2560cc', note: '' },
  { legacy: '--on-accent', kind: 'alias', signal: '--on-accent', was: '#ffffff', note: '' },
  { legacy: '--ok', kind: 'alias', signal: '--ok', was: '#1f9d63', note: '' },
  { legacy: '--warn', kind: 'alias', signal: '--warn', was: '#c2410c', note: 'ring shape' },
  { legacy: '--danger', kind: 'alias', signal: '--danger', was: '#d23f3f', note: '' },
  { legacy: '--caution', kind: 'retire', signal: '--warn', was: '#b7791f', note: 'fair band ring' },
  { legacy: '--info-tone', kind: 'retire', signal: '--accent', was: '#4b72b8', note: 'info = accent ring' },
  { legacy: '--start-mark', kind: 'retire', signal: '--accent', was: '#5b8def', note: 'FrostMark' },
  { legacy: '--start-glow', kind: 'retire', signal: null, was: 'glow', note: 'none: no gradient washes' },
  // SEO sidebar (--seo-*)
  { legacy: '--seo-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '' },
  { legacy: '--seo-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--seo-card-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: 'card outlines; --divider for separator borders and guide lines' },
  { legacy: '--seo-track', kind: 'alias', signal: '--track', was: '#e7ebf1', note: '' },
  { legacy: '--seo-skeleton', kind: 'retire', signal: '--bg-subtle', was: '#e9edf3', note: '' },
  { legacy: '--seo-skeleton-shine', kind: 'retire', signal: '--bg-sheet', was: '#f4f6f9', note: 'sweep over --bg-subtle' },
  // Command palette (--palette-*)
  { legacy: '--palette-bg', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--palette-edge', kind: 'retire', signal: '--e-ring', was: '#dfe4eb', note: 'outlines; --divider for separator borders' },
  { legacy: '--palette-shadow', kind: 'retire', signal: '--e-ring', was: 'shadow', note: 'a band, not a floating sheet' },
  { legacy: '--palette-sheet', kind: 'retire', signal: '--bg-window', was: 'gradient', note: 'no gradients' },
  { legacy: '--palette-row-active', kind: 'retire', signal: '--accent-soft', was: '.10 accent', note: '' },
  { legacy: '--palette-hit', kind: 'retire', signal: '--accent-soft', was: '.16 accent', note: 'match highlight, --r-xs; --bg-surface on the selected row' },
  { legacy: '--palette-kbd-bg', kind: 'retire', signal: '--bg-surface', was: '#f1f3f7', note: 'key hint, --h-badge' },
  { legacy: '--palette-kbd-edge', kind: 'retire', signal: '--e-ring', was: '#d7dce4', note: '' },
  // Feature colours
  { legacy: '--render-accent', kind: 'retire', signal: '--accent', was: '#7a4fe0', note: 'one accent: no second hue' },
  { legacy: '--render-soft', kind: 'retire', signal: '--accent-soft', was: '.13 violet', note: '' },
  { legacy: '--render-edge', kind: 'retire', signal: '--accent', was: '.55 violet', note: '' },
  { legacy: '--serp-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--serp-title', kind: 'retire', signal: '--accent', was: '#2450c8', note: 'Search preview title' },
  { legacy: '--serp-text', kind: 'alias', signal: '--text-muted', was: '#474e5c', note: '' },
  { legacy: '--serp-path', kind: 'retire', signal: '--text-muted', was: '#5d6573', note: 'URL crumbs' },
  { legacy: '--serp-glyph', kind: 'retire', signal: '--bg-subtle', was: '#e3e8f1', note: '' },
  { legacy: '--serp-glyph-mark', kind: 'retire', signal: '--text-muted', was: '#6b7a90', note: '' },
  { legacy: '--jump-tile-bg', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--jump-tile-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: '' },
  { legacy: '--jump-monogram-bg', kind: 'retire', signal: '--accent-soft', was: '.12 accent', note: '' },
  { legacy: '--gsc-line', kind: 'alias', signal: '--accent', was: 'accent', note: '' },
  { legacy: '--gsc-grid', kind: 'retire', signal: '--divider', was: '#e7ebf1', note: '' },
  { legacy: '--gsc-axis', kind: 'alias', signal: '--text-faint', was: 'faint', note: '' },
  { legacy: '--settings-switch-off', kind: 'retire', signal: '--switch-off', was: '#c9cfd9', note: '' },
  // Agent panel (--agent-*)
  { legacy: '--agent-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '' },
  { legacy: '--agent-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--agent-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: '--divider for rules' },
  { legacy: '--agent-user', kind: 'retire', signal: '--accent-soft', was: '#e6eefc', note: 'your messages' },
  { legacy: '--agent-code-bg', kind: 'retire', signal: '--bg-subtle', was: '#f1f3f7', note: '' },
  { legacy: '--agent-approval-edge', kind: 'retire', signal: '--warn', was: '#c98b16', note: '' },
  { legacy: '--agent-approval-bg', kind: 'retire', signal: '--warn-soft', was: '#fffaf0', note: '' },
] as const satisfies readonly LegacyTokenMigration[];

/**
 * The most literal hex colours (`#rgb`, `#rrggbb`, …, outside comments) the renderer's stylesheets
 * other than `TOKENS_STYLESHEET` may hold. A ratchet: lower it as surfaces move onto tokens, never
 * raise it. Counted when every `:root` token moved into `tokens.css`. It counts hex only: a colour
 * written as `rgb()`, `hsl()` or a keyword is for review to catch.
 */
export const HEX_COLOUR_RATCHET = 53;

/**
 * A foreground on a background that the Signal token sheet says must reach a WCAG 2.x contrast ratio
 * of `min` (4.5 for text, 3 for UI and graphics), in light and in dark. `over` is the opaque surface a
 * translucent `bg` (`--accent-soft`, a dark `-soft` fill) sits on, so the pair is composited first; a
 * translucent `fg` is composited over the (composited) `bg`. `alpha` makes `bg` a tint: the token at
 * that opacity, as `color-mix(in srgb, <bg> <alpha × 100>%, transparent)` draws it (then `over` is
 * needed). `why` cites the sheet.
 */
export interface ContrastPair {
  readonly fg: TokenName;
  readonly bg: TokenName;
  readonly min: 4.5 | 3;
  readonly over?: TokenName;
  readonly alpha?: number;
  readonly why: string;
}

const BODY = 'body text on every surface (4.5:1)';
const FAINT = '"--text-faint passes 4.5:1 on window, subtle and white, but stays for secondary text 12px and up."';
const RING = 'Score rings take their band colour: --ok, --warn, --danger (graphics, 3:1 on --bg-surface and --bg-sheet)';
const WARN = '"--warn: dots and graphics (≥ 3:1 on white and sheet)"; ' + RING;
const INK = '"Text on a soft status fill uses its -ink colour (≥ 4.5:1)"';

/**
 * The contrast pairs the Signal token sheet names, plus frost's own floor for body text, links and
 * on-colour buttons on every surface; checked against `tokens.css` in both themes.
 */
export const CONTRAST_PAIRS = [
  // Text
  { fg: '--text', bg: '--bg-window', min: 4.5, why: BODY },
  { fg: '--text', bg: '--bg-sheet', min: 4.5, why: BODY },
  { fg: '--text', bg: '--bg-subtle', min: 4.5, why: BODY },
  { fg: '--text', bg: '--bg-surface', min: 4.5, why: BODY },
  { fg: '--text-muted', bg: '--bg-window', min: 4.5, why: BODY },
  { fg: '--text-muted', bg: '--bg-sheet', min: 4.5, why: BODY },
  { fg: '--text-muted', bg: '--bg-subtle', min: 4.5, why: BODY },
  { fg: '--text-muted', bg: '--bg-surface', min: 4.5, why: BODY },
  { fg: '--text-faint', bg: '--bg-window', min: 4.5, why: FAINT },
  { fg: '--text-faint', bg: '--bg-subtle', min: 4.5, why: `${FAINT} "Disabled controls: --text-faint on --bg-subtle"` },
  { fg: '--text-faint', bg: '--bg-surface', min: 4.5, why: FAINT },
  { fg: '--accent', bg: '--bg-surface', min: 4.5, why: 'links: --accent as text on a card (4.5:1)' },
  { fg: '--accent', bg: '--bg-sheet', min: 4.5, why: 'links: --accent as text on a sheet (4.5:1)' },
  // On-colour
  { fg: '--on-accent', bg: '--accent', min: 4.5, why: 'accent buttons: --on-accent on --accent (4.5:1)' },
  { fg: '--on-accent', bg: '--accent-hover', min: 4.5, why: 'accent buttons, hovered: --on-accent on --accent-hover (4.5:1)' },
  { fg: '--on-inverse', bg: '--inverse', min: 4.5, why: 'inverse buttons (Ask frost): --on-inverse on --inverse (4.5:1)' },
  {
    fg: '--on-inverse',
    bg: '--bg-active-inverse',
    over: '--inverse',
    min: 4.5,
    why: '"An inverse button (Ask frost) uses --bg-active-inverse when pressed or open" (4.5:1)',
  },
  // Text on the accent tint
  { fg: '--text', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'the palette\'s active row (--palette-row-active → --accent-soft) (4.5:1)' },
  { fg: '--text', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'your messages in the agent panel (--agent-user → --accent-soft) (4.5:1)' },
  // Status text on a soft fill
  { fg: '--ok-ink', bg: '--ok-soft', over: '--bg-surface', min: 4.5, why: INK },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--bg-surface', min: 4.5, why: INK },
  { fg: '--danger-ink', bg: '--danger-soft', over: '--bg-surface', min: 4.5, why: INK },
  // UI and graphics
  { fg: '--switch-off', bg: '--bg-surface', min: 3, why: '"--switch-off is a switch\'s off track (≥ 3:1 against its card)"' },
  { fg: '--accent', bg: '--bg-window', min: 3, why: 'focus ring: "a 2px gap in the window colour, then 2px of accent"' },
  { fg: '--ok', bg: '--bg-surface', min: 3, why: RING },
  { fg: '--ok', bg: '--bg-sheet', min: 3, why: RING },
  { fg: '--warn', bg: '--bg-surface', min: 3, why: WARN },
  { fg: '--warn', bg: '--bg-sheet', min: 3, why: WARN },
  { fg: '--danger', bg: '--bg-surface', min: 3, why: RING },
  { fg: '--danger', bg: '--bg-sheet', min: 3, why: RING },
  // Rules the values step pinned (TEXT_COLOUR_RULES)
  { fg: '--warn-ink', bg: '--bg-chrome', min: 4.5, why: 'the status bar\'s notice (.status-notice) on --bg-chrome (4.5:1)' },
  {
    fg: '--accent-hover',
    bg: '--bg-field-hover',
    min: 4.5,
    why: 'the update bar\'s primary button, hovered (.update-primary on --bg-field-hover) (4.5:1)',
  },
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-surface', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill, .agent-chip; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does) (4.5:1)' },
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill, .agent-chip; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-surface', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill, .agent-chip; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill, .agent-chip; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does) (4.5:1)' },
] as const satisfies readonly ContrastPair[];

/**
 * Known contrast exceptions, left for the surface PRs: a token some rules still use in a way that
 * misses the pair's minimum. Each is recorded, not fixed, in the values step; a surface PR that moves
 * the rules off it removes its entry (the guard fails once the pair would pass, or once no rule uses
 * the token that way). Either `rules`, how many `color: var(<fg>)` declarations the renderer's
 * stylesheets hold today, or the one `element` (as in `TextColourRule`) whose text it is. `alpha` and
 * `over` composite a tinted `bg` as in `ContrastPair`.
 */
export interface ContrastException {
  readonly fg: TokenName;
  readonly bg: TokenName;
  readonly min: 4.5 | 3;
  readonly alpha?: number;
  readonly over?: TokenName;
  readonly rules?: number;
  readonly element?: { readonly stylesheet: string; readonly selectors: readonly string[] };
  readonly why: string;
}

export const KNOWN_CONTRAST_EXCEPTIONS = [
  {
    fg: '--ok',
    bg: '--bg-surface',
    min: 4.5,
    rules: 21,
    why: '--ok as body text ("Good length", passing counts, …) is 3.30:1 on a card in light (3.16 on the sheet); --ok is a graphics colour (3:1). The surface PRs move those rules to --ok-ink.',
  },
  {
    fg: '--danger-ink',
    bg: '--danger',
    alpha: 0.14,
    over: '--bg-chrome',
    min: 4.5,
    element: { stylesheet: 'styles.css', selectors: [".status-tab-overrides[data-status='failed']"] },
    why: 'the status bar\'s failed-overrides chip (11.5px): --danger-ink on the 14% danger tint over --bg-chrome is 4.46:1 in light (--danger was 3.33). Still under 4.5:1: the status bar\'s surface PR settles the fill (a 10% tint gives 4.73, --danger-soft 5.30).',
  },
] as const satisfies readonly ContrastException[];

/**
 * A rule whose text colour the values step pins to a token, because the Signal value of the token it
 * used left its text under 4.5:1 (found in review). `element` lists the selectors, in `stylesheet`
 * (relative to the renderer), that such an element matches; resolving the cascade over them
 * (specificity, then source order; light, or light then the dark media block; component custom
 * properties followed through `var()`) gives `color: var(<color>)`. Its pair is in `CONTRAST_PAIRS`.
 */
export interface TextColourRule {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly color: TokenName;
  readonly why: string;
}

const OK_TINT = '--ok as text on its own 14% tint is 2.82:1 in light (11px chips)';
const DANGER_TINT = '--danger as text on its own 14% tint is 3.88:1 in light (11px chips)';

export const TEXT_COLOUR_RULES = [
  {
    stylesheet: 'styles.css',
    element: ['.status-notice'],
    color: '--warn-ink',
    why: '--warn on --bg-chrome is 4.26:1 in light; the notice is 11.5px text',
  },
  {
    stylesheet: 'styles.css',
    element: ['.update-button', '.update-button:hover:not(:disabled)', '.update-button.update-primary', '.update-button.update-primary:hover:not(:disabled)'],
    color: '--accent-hover',
    why: '--accent on the hovered button (--bg-field-hover) is 4.23:1 in dark',
  },
  // 11px chips on their tone's tint: --ok text is 2.82:1 on its 14% tint and --danger 3.88:1 (light).
  // The tint and .seo-signal's dot keep the tone; .seo-signal draws no tone text, so it has no entry.
  { stylesheet: 'styles.css', element: ['.seo-pill', ".seo-pill[data-tone='ok']"], color: '--ok-ink', why: OK_TINT },
  { stylesheet: 'styles.css', element: ['.seo-pill', ".seo-pill[data-tone='error']"], color: '--danger-ink', why: DANGER_TINT },
  { stylesheet: 'styles.css', element: ['.seo-flag-chip', ".seo-flag-chip[data-tone='ok']"], color: '--ok-ink', why: OK_TINT },
  { stylesheet: 'styles.css', element: ['.seo-flag-chip', ".seo-flag-chip[data-tone='error']"], color: '--danger-ink', why: DANGER_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='ok']"], color: '--ok-ink', why: OK_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='denied']"], color: '--danger-ink', why: DANGER_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='failed']"], color: '--danger-ink', why: DANGER_TINT },
  // More danger text on its 14% tint (3.7–3.9:1 on a card, 3.33:1 on the status bar, light).
  {
    stylesheet: 'styles.css',
    element: [".status-tab-overrides[data-status='failed']"],
    color: '--danger-ink',
    why: 'the status bar\'s failed-overrides chip: 3.33:1 over --bg-chrome (a known exception at 4.46:1 with the ink)',
  },
  { stylesheet: 'styles.css', element: ['.seo-badge', ".seo-badge[data-severity='error']"], color: '--danger-ink', why: DANGER_TINT },
  { stylesheet: 'styles.css', element: ['.seo-block-status', ".seo-block-status[data-status='invalid']"], color: '--danger-ink', why: DANGER_TINT },
  {
    stylesheet: 'styles.css',
    element: ['.seo-hreflang-code', ".seo-hreflang-row[data-valid='false'] .seo-hreflang-code"],
    color: '--danger-ink',
    why: DANGER_TINT,
  },
  { stylesheet: 'styles.css', element: ['.changes-segment', ".changes-segment[data-op='del']"], color: '--danger-ink', why: DANGER_TINT },
] as const satisfies readonly TextColourRule[];

/**
 * The tab row until the chrome's surface PR rebuilds it as one row on `--bg-window`: the strip
 * (`--bg-strip`), a hovered inactive tab (`--bg-tab-hover`, laid over the strip) and the active tab
 * (`--bg-chrome`). The values step moved the active tab onto Signal (`--bg-chrome` is
 * `var(--bg-window)`), so the two retired names were retuned for the interim: in light and dark the
 * active tab stands off the strip by at least `minActiveOnStrip` (a contrast ratio), and a hovered
 * tab's luminance lies strictly between the strip's and the active tab's (hover previews the active
 * tab: lighter in light, darker in dark). The divider between inactive tabs (`--border-field`, retired)
 * stands at least `minDividerOnStrip` off the strip, so the strip's own value can't swallow it.
 */
export const TAB_STRIP = {
  strip: '--bg-strip',
  hover: '--bg-tab-hover',
  active: '--bg-chrome',
  minActiveOnStrip: 1.1,
  /** The hairline between inactive tabs (`.tab + .tab::before`), against the strip. */
  divider: '--border-field',
  minDividerOnStrip: 1.1,
} as const satisfies {
  readonly strip: TokenName;
  readonly hover: TokenName;
  readonly active: TokenName;
  readonly minActiveOnStrip: number;
  readonly divider: TokenName;
  readonly minDividerOnStrip: number;
};

// ---- Fonts (the values step: Geist bundled, not yet applied) ----

/**
 * The renderer stylesheet (relative to `apps/desktop/src/renderer/`) that declares the bundled
 * fonts: only `@font-face` rules, one per `BUNDLED_FONTS` entry. `main.tsx` imports it right after
 * `TOKENS_STYLESHEET`. It applies no font: `--font-ui` and every rule stay as they are until the
 * surface PRs move onto the `--text-*` type tokens.
 */
export const FONTS_STYLESHEET = 'fonts.css';

/**
 * Where Geist and Geist Mono come from: the official `geist` npm package, pinned exactly (in
 * `apps/desktop/package.json`) to a release at least two weeks old when it was chosen. Its fonts are
 * under the SIL Open Font License 1.1 (`LICENSE.txt` in the package; its package.json says
 * "SIL OPEN FONT LICENSE"), which `THIRD_PARTY_NOTICES` reproduces. Only its font files are bundled,
 * never its JavaScript (a `next/font` wrapper frost has no use for).
 */
export const GEIST_PACKAGE = { name: 'geist', version: '1.8.2', license: 'OFL-1.1' } as const;

/**
 * The module-path prefix `fonts.css` uses for the package's `dist/fonts/` directory, which its
 * `exports` map does not expose: the renderer's Vite config aliases it to the installed package's
 * `dist/fonts/`. Vite then emits each file into the renderer build as a hashed asset served from
 * `app://`, never a remote URL or a `data:` URI (`APP_CSP_DIRECTIVES` in `security-policy.spec.ts`
 * allows fonts from `'self'` only).
 */
export const GEIST_FONTS_ALIAS = '@geist-fonts';

/**
 * The weight `--text-body` takes for emphasis (its `use`, "500 for emphasis"): the one weight the
 * type scale needs that no `font` shorthand names.
 */
export const TEXT_BODY_EMPHASIS_WEIGHT = 500;

/** One bundled font face (always `font-style: normal`). */
export interface BundledFont {
  /** The `font-family` name the type tokens use. */
  readonly family: 'Geist' | 'Geist Mono';
  readonly weight: number;
  /** The static woff2 file, relative to the package's `dist/fonts/`. */
  readonly file: string;
}

/**
 * The fonts frost bundles: exactly the weights the `SIGNAL_TOKENS.type` shorthands use per family,
 * plus Geist at `TEXT_BODY_EMPHASIS_WEIGHT`. Static woff2 files only (every Chromium reads woff2,
 * and it is the smallest): no italics, no variable files, no Geist Pixel, no other weight. Local
 * only, from `app://` (see `GEIST_FONTS_ALIAS`).
 */
export const BUNDLED_FONTS = [
  { family: 'Geist', weight: 400, file: 'geist-sans/Geist-Regular.woff2' },
  { family: 'Geist', weight: 500, file: 'geist-sans/Geist-Medium.woff2' },
  { family: 'Geist', weight: 600, file: 'geist-sans/Geist-SemiBold.woff2' },
  { family: 'Geist Mono', weight: 400, file: 'geist-mono/GeistMono-Regular.woff2' },
] as const satisfies readonly BundledFont[];
