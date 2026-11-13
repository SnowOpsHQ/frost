/**
 * Design tokens (the "Signal" design system; acceptance: `design-tokens.feature.md`). Plain data with
 * no imports, like the other `*.spec.ts` specs. Source of truth: the Signal token sheet
 * (`Tokens.dc.html`, its values and Migration table) and the round-2 council decisions.
 *
 * One stylesheet, `apps/desktop/src/renderer/tokens.css` (`TOKENS_STYLESHEET`), declares every
 * custom property that lives on `:root`, light and dark; `main.tsx` imports it before any other
 * stylesheet. It holds the legacy tokens (`LEGACY_TOKEN_MIGRATION`) and the Signal tokens
 * (`SIGNAL_TOKENS`, every one at its Signal value). A legacy alias is `var()` of its Signal token; a
 * retired name and a layout constant keep their pre-Signal values until a surface PR drops the
 * retired name (`removed`). The rollout:
 * 1. foundation (done): one token source and the full Signal vocabulary, no pixel changed;
 * 2. values (done, this step): the legacy aliases point at their Signal tokens and the names in
 *    `SIGNAL_NAMES_WITH_LEGACY_VALUES` take their Signal values; Geist and Geist Mono are bundled
 *    (`BUNDLED_FONTS`, declared in `FONTS_STYLESHEET`), applied per surface through the `--text-*`
 *    tokens from step 3 on (`--font-ui` stays the system stack);
 * 3. next, one PR per surface moves its rules onto Signal tokens and drops the retired names it used
 *    (the command palette first: its retired `--palette-*` names are `removed`, and it is the first
 *    surface to read the `--text-*` type tokens, so the first to draw Geist; then the new-tab view,
 *    whose retired `--start-*` and `--jump-*` names are `removed`, the agent panel, whose retired
 *    `--agent-*` names are `removed`, Settings and Help, which retired `--settings-switch-off`, and
 *    the SEO sidebar's frame and shared parts, whose retired `--seo-skeleton` and
 *    `--seo-skeleton-shine` are `removed`, and the browser chrome's rows, which retired the rows'
 *    heights, `--bg-strip` and `--bg-tab-hover`).
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
 * `removed`: a `retire` row whose surface PR moved every rule off it, so `tokens.css` no longer declares
 * it (light or dark) and no renderer source reads it. The row stays as the record of its replacement.
 */
export interface LegacyTokenMigration {
  readonly legacy: TokenName;
  readonly kind: 'alias' | 'retire';
  readonly signal: TokenName | null;
  readonly was: string;
  readonly note: string;
  readonly removed?: true;
}

/**
 * Every custom property that was declared on `:root` before Signal: 89 names, each mapped. The ones
 * not `removed` are declared in `tokens.css`.
 */
export const LEGACY_TOKEN_MIGRATION = [
  // Chrome sizes: the chrome's surface PR sized its rows from --h-control, --h-field and --h-status (the
  // merged --h-chrome row is a markup change of its own) and dropped the three heights.
  { legacy: '--tabstrip-height', kind: 'retire', signal: '--h-chrome', was: '40px', note: 'with --toolbar-height: one 56px row', removed: true },
  { legacy: '--toolbar-height', kind: 'retire', signal: '--h-chrome', was: '50px', note: 'buttons join the tab row', removed: true },
  { legacy: '--status-height', kind: 'retire', signal: '--h-status', was: '26px', note: '28px', removed: true },
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
  { legacy: '--bg-strip', kind: 'retire', signal: '--bg-window', was: '#e4e8ee', note: 'no separate strip', removed: true },
  { legacy: '--bg-chrome-edge', kind: 'retire', signal: '--divider', was: '#e2e6ec', note: '' },
  { legacy: '--bg-page', kind: 'alias', signal: '--bg-surface', was: '#fbfcfd', note: 'the page card' },
  { legacy: '--bg-field', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--bg-field-hover', kind: 'retire', signal: '--bg-hover', was: '#ffffff', note: 'over --bg-surface' },
  { legacy: '--border-field', kind: 'retire', signal: '--e-raised', was: '#d7dce4', note: 'field outlines (ring shadow, no border); --track for scrollbar thumbs; --divider or --e-ring for other borders' },
  { legacy: '--shadow-field', kind: 'retire', signal: '--e-raised', was: 'shadow', note: '' },
  { legacy: '--shadow-card', kind: 'retire', signal: '--e-ring', was: 'shadow', note: '' },
  { legacy: '--bg-hover', kind: 'alias', signal: '--bg-hover', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-active', kind: 'alias', signal: '--bg-active', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-tab-hover', kind: 'retire', signal: '--bg-hover', was: 'overlay', note: '', removed: true },
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
  { legacy: '--start-mark', kind: 'retire', signal: '--accent', was: '#5b8def', note: 'FrostMark', removed: true },
  { legacy: '--start-glow', kind: 'retire', signal: null, was: 'glow', note: 'none: no gradient washes', removed: true },
  // SEO sidebar (--seo-*): the frame's surface PR dropped the skeleton's names; the panels still read the others.
  { legacy: '--seo-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '' },
  { legacy: '--seo-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--seo-card-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: 'card outlines; --divider for separator borders and guide lines' },
  { legacy: '--seo-track', kind: 'alias', signal: '--track', was: '#e7ebf1', note: '' },
  { legacy: '--seo-skeleton', kind: 'retire', signal: '--bg-subtle', was: '#e9edf3', note: '', removed: true },
  { legacy: '--seo-skeleton-shine', kind: 'retire', signal: '--bg-sheet', was: '#f4f6f9', note: 'sweep over --bg-subtle', removed: true },
  // Command palette (--palette-*): its surface PR moved every rule onto Signal and dropped the retired names.
  { legacy: '--palette-bg', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--palette-edge', kind: 'retire', signal: '--e-ring', was: '#dfe4eb', note: 'outlines; --divider for separator borders', removed: true },
  { legacy: '--palette-shadow', kind: 'retire', signal: '--e-ring', was: 'shadow', note: 'a band, not a floating sheet', removed: true },
  { legacy: '--palette-sheet', kind: 'retire', signal: '--bg-window', was: 'gradient', note: 'no gradients', removed: true },
  { legacy: '--palette-row-active', kind: 'retire', signal: '--accent-soft', was: '.10 accent', note: '', removed: true },
  { legacy: '--palette-hit', kind: 'retire', signal: '--accent-soft', was: '.16 accent', note: 'match highlight, --r-xs; --bg-surface on the selected row', removed: true },
  { legacy: '--palette-kbd-bg', kind: 'retire', signal: '--bg-surface', was: '#f1f3f7', note: 'key hint, --h-badge', removed: true },
  { legacy: '--palette-kbd-edge', kind: 'retire', signal: '--e-ring', was: '#d7dce4', note: '', removed: true },
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
  { legacy: '--jump-tile-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: '', removed: true },
  { legacy: '--jump-monogram-bg', kind: 'retire', signal: '--accent-soft', was: '.12 accent', note: '', removed: true },
  { legacy: '--gsc-line', kind: 'alias', signal: '--accent', was: 'accent', note: '' },
  { legacy: '--gsc-grid', kind: 'retire', signal: '--divider', was: '#e7ebf1', note: '' },
  { legacy: '--gsc-axis', kind: 'alias', signal: '--text-faint', was: 'faint', note: '' },
  { legacy: '--settings-switch-off', kind: 'retire', signal: '--switch-off', was: '#c9cfd9', note: '', removed: true },
  // Agent panel (--agent-*): its surface PR moved every rule onto Signal and dropped the retired names.
  { legacy: '--agent-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '' },
  { legacy: '--agent-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '' },
  { legacy: '--agent-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: '--divider for rules', removed: true },
  { legacy: '--agent-user', kind: 'retire', signal: '--accent-soft', was: '#e6eefc', note: 'your messages', removed: true },
  { legacy: '--agent-code-bg', kind: 'retire', signal: '--bg-subtle', was: '#f1f3f7', note: '', removed: true },
  { legacy: '--agent-approval-edge', kind: 'retire', signal: '--warn', was: '#c98b16', note: '', removed: true },
  { legacy: '--agent-approval-bg', kind: 'retire', signal: '--warn-soft', was: '#fffaf0', note: '', removed: true },
] as const satisfies readonly LegacyTokenMigration[];

/**
 * A surface whose rules a surface PR moved onto Signal (`surface-rules-read-signal-tokens`). The rollout
 * adds one entry per surface PR. A rule in `stylesheet` (relative to the renderer) is the surface's
 * when any selector in its list, at any nesting, names a class `selectorPrefix` or `selectorPrefix-…`
 * on a class boundary (`.palette` covers `.palette`, `.palette-option` and `.chrome .palette-hit`,
 * never `.palettes` or `.x-palette`; `.tab` would never cover `.table-row`), or when it sits in a
 * `@keyframes` named the prefix's stem or stem-… (`palette-in`). Such a rule reads only Signal tokens,
 * legacy aliases and component-scoped custom properties (declared in the same stylesheet, e.g.
 * `--tone-ink`) in `var()`, never with a fallback (in any property); it declares no Signal or legacy
 * name; no value of it holds a hex colour or a colour function; its colour-bearing values
 * (`background-image` and custom properties included) hold nothing else but `transparent`,
 * `currentColor`, `inherit`, `none`, lengths and `color-mix()` of those (plus `text-decoration`'s line
 * and style keywords, and, only inside an `@media (forced-colors: active)` block, the CSS system colours
 * in `FORCED_COLOURS_SYSTEM_COLOURS`); a rule whose `box-shadow` reads `--focus-ring` also sets an `outline` forced
 * colours draw (they drop box-shadows): a non-zero width, not `none`, e.g. `2px solid transparent`; its type comes from a `--text-*` token (`font: var(--text-*)`,
 * with that token's `tracking` as `letter-spacing` in the same rule when it isn't `0`); a
 * `font-weight` beside it is one `BUNDLED_FONTS` has for that token's family (Geist Mono: 400 only).
 */
export interface SignalSurface {
  readonly name: string;
  readonly stylesheet: string;
  /**
   * A class name with its dot (`.palette`): the surface's classes are it and it followed by `-…`.
   * Omitted for a surface whose classes share no prefix (the browser chrome: `.tabstrip`, `.toolbar`,
   * `.address`, …): it then lists every one in `classes`, and its `keyframes`.
   */
  readonly selectorPrefix?: string;
  /**
   * For a prefix other surfaces share (`.seo` names every SEO panel's classes): the surface's classes
   * are only these, in place of the prefix's whole family; for a surface with no prefix, all of them.
   * Each starts with `selectorPrefix` when there is one, and is
   * exact (`.seo-chip` is never `.seo-chip-button`), or ends in `-*` for a family (`.seo-rail-*`:
   * `.seo-rail`, `.seo-rail-item`, …), matched on a class boundary like the prefix. Each names at
   * least one rule of `stylesheet` (a stale name fails the guard).
   */
  readonly classes?: readonly string[];
  /** With `classes`: the surface's `@keyframes`, by exact name (in place of the prefix's stem); each is in `stylesheet`. */
  readonly keyframes?: readonly string[];
}

/**
 * The CSS system colours (CSS Color 4, lower-cased) a surface rule may name, only inside an
 * `@media (forced-colors: active)` block: there the page's own colours are replaced by these, so a
 * state shown only by colour (a busy button) names one of them (`GrayText`) to stay visible.
 */
export const FORCED_COLOURS_SYSTEM_COLOURS = [
  'accentcolor',
  'accentcolortext',
  'activetext',
  'buttonborder',
  'buttonface',
  'buttontext',
  'canvas',
  'canvastext',
  'field',
  'fieldtext',
  'graytext',
  'highlight',
  'highlighttext',
  'linktext',
  'mark',
  'marktext',
  'selecteditem',
  'selecteditemtext',
  'visitedtext',
] as const;

/**
 * Busy or disabled controls that show it only by colour (`FOCUS_RING_RULES`: fading would dim their
 * focus ring). Forced colours replace those colours, so for each entry the cascade over its `element`
 * selectors in `stylesheet`, with the rules inside `@media (forced-colors: active)` read too (as the
 * dark block is in dark), resolves `color` and `border-color` to `GrayText` in light and dark: a later
 * rule of the control's own (the primary button's `--accent` text) must not win over it.
 */
export interface ForcedColoursBusy {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly why: string;
}

export const FORCED_COLOURS_BUSY = [
  { stylesheet: 'settings.css', element: ['.settings-button', ".settings-button[aria-disabled='true']"], why: 'a Settings button while busy' },
  { stylesheet: 'settings.css', element: ['.settings-button', '.settings-button:disabled'], why: 'a disabled Settings button' },
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', '.settings-button-primary', ".settings-button[aria-disabled='true']", ".settings-button-primary[aria-disabled='true']"],
    why: 'a primary Settings button while busy (its --accent on --accent-soft must give way)',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', '.settings-button-primary', '.settings-button:disabled', '.settings-button-primary:disabled'],
    why: 'a disabled primary Settings button',
  },
  { stylesheet: 'help.css', element: ['.diagnostics-save', ".diagnostics-save[aria-disabled='true']"], why: 'Export Diagnostics\' Save… while it saves' },
  { stylesheet: 'help.css', element: ['.diagnostics-save', '.diagnostics-save:disabled'], why: 'Export Diagnostics\' Save…, disabled' },
  // The browser chrome: a disabled tool (Back, Forward, Reload with no page) is --text-faint at half strength, where it faded.
  { stylesheet: 'styles.css', element: ['.tool', '.tool:disabled'], why: 'a disabled toolbar tool (Back or Forward with nowhere to go)' },
  { stylesheet: 'styles.css', element: ['.prompt-button', '.prompt-button:disabled'], why: 'the permission prompt\'s Allow and Block before they arm, and once answered' },
] as const satisfies readonly ForcedColoursBusy[];

export const SIGNAL_SURFACES = [
  // `.palette`, `.palette-sheet`, `.palette-option`, … and `.palette-status` (specs/command-palette.spec.ts).
  { name: 'command palette', stylesheet: 'styles.css', selectorPrefix: '.palette' },
  // The new-tab view (specs/browser-chrome.feature.md, browser-polish.feature.md): `.start`, `.start-mark`,
  // `.start-wordmark`, `.start-hint`, then "Jump back in": `.jump`, `.jump-title`, `.jump-tile`, `.jump-monogram`, ….
  { name: 'new tab', stylesheet: 'styles.css', selectorPrefix: '.start' },
  { name: 'new tab: Jump back in', stylesheet: 'styles.css', selectorPrefix: '.jump' },
  // Every rule in the panel's own stylesheet (specs/agent-panel.feature.md, agent-styles-are-delimited).
  { name: 'agent panel', stylesheet: 'components/agent/agent.css', selectorPrefix: '.agent' },
  // Settings (specs/account-settings.feature.md and each section's spec): every rule of its four stylesheets.
  { name: 'Settings', stylesheet: 'settings.css', selectorPrefix: '.settings' },
  { name: 'Settings: AI checks', stylesheet: 'settings-ai-checks.css', selectorPrefix: '.settings' },
  { name: 'Settings: Data sources', stylesheet: 'settings-data-sources.css', selectorPrefix: '.settings' },
  { name: 'Settings: Locations', stylesheet: 'settings-locations.css', selectorPrefix: '.settings' },
  // Help (specs/help.feature.md, specs/diagnostics.feature.md): every rule of help.css. Its sheet frame
  // (`.help-*`) also holds the Crawl and AI answers sheets, whose own rules are their surfaces'.
  { name: 'Help', stylesheet: 'help.css', selectorPrefix: '.help' },
  { name: 'Help: keyboard shortcuts', stylesheet: 'help.css', selectorPrefix: '.shortcuts' },
  { name: "Help: What's New", stylesheet: 'help.css', selectorPrefix: '.whats-new' },
  { name: 'Help: the setup checklist', stylesheet: 'help.css', selectorPrefix: '.setup' },
  { name: 'Help: Export Diagnostics', stylesheet: 'help.css', selectorPrefix: '.diagnostics' },
  // The SEO sidebar's frame (specs/seo-sidebar.feature.md: the sidebar, its rail, "More panels", the
  // header, body and footer, the pin and collapse tools), the parts every panel shares (cards, section
  // heads, badges, page text, severity icons, the link button) and its states (the pending skeleton,
  // the unavailable and empty hints). Not the panels' interiors (`.seo-toggle`, `.seo-chip-button`,
  // `.seo-panel-tools`, …: their own surface PRs), nor `.pane-separator`, which the agent panel shares,
  // nor `.seo-page-text`: it holds no colour or type of its own (isolation and wrapping), and the
  // panels qualify it with theirs (`.seo-flag.seo-page-text`, Links).
  {
    name: 'SEO sidebar: frame and shared parts',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      // Frame
      '.seo',
      '.seo-separator',
      '.seo-panel',
      '.seo-head-*',
      '.seo-collapse-icon',
      '.seo-body',
      '.seo-foot',
      '.seo-rail-*',
      '.seo-more-*',
      '.seo-pin',
      // Shared parts
      '.seo-section-*',
      '.seo-score-card',
      '.seo-issues',
      '.seo-badge',
      '.seo-chip',
      '.seo-ellipsis',
      '.seo-clamp-2',
      '.seo-clamp-3',
      '.seo-mono',
      '.seo-missing',
      '.seo-note',
      '.seo-empty-line',
      '.seo-severity',
      '.seo-link-button',
      // States
      '.seo-skeleton-*',
      '.seo-hint-*',
    ],
    keyframes: ['seo-panel-in', 'seo-skeleton-sweep'],
  },
  // The browser chrome's rows (specs/browser-chrome.feature.md, Layout; permissions.feature.md;
  // page-commands.feature.md): the grid, the tab row, the toolbar with the address bar and its loading
  // line, the permission prompt, the fullscreen notice, the page area's frame and the status bar. Its
  // classes share no prefix, so it lists them. Not the shared `.icon` and `.visually-hidden`, the
  // new tab's view and the error panels (their own rules), nor the bars and badges later surface PRs
  // move: the render-profile editor bar and chips (`.tab-profile`, `.status-render-profile`,
  // `.status-tab-overrides`), the find bar, History and the update notice.
  {
    name: 'browser chrome',
    stylesheet: 'styles.css',
    classes: [
      // Layout and the page area's frame
      '.chrome',
      '.workspace-stack',
      '.workspace',
      '.page-area',
      // The tab row
      '.tabstrip',
      '.tabs',
      '.tab',
      '.tab-main',
      '.tab-glyph',
      '.tab-icon',
      '.tab-icon-alert',
      '.tab-mark',
      '.tab-attention-*',
      '.tab-spinner',
      '.tab-label',
      '.tab-close',
      '.new-tab',
      // The toolbar
      '.toolbar',
      '.nav-buttons',
      '.tool',
      '.sidebar-toggle',
      '.address-*',
      '.progress-*',
      // The permission prompt and the fullscreen notice
      '.prompt-*',
      '.fullscreen-notice-*',
      // The status bar
      '.status-bar',
      '.status-text',
      '.status-zoom',
      '.status-notice',
      '.connection-*',
    ],
    keyframes: ['tab-spin', 'progress-slide', 'prompt-in'],
  },
] as const satisfies readonly SignalSurface[];

/**
 * The most literal hex colours (`#rgb`, `#rrggbb`, …, outside comments) the renderer's stylesheets
 * other than `TOKENS_STYLESHEET` may hold. A ratchet: lower it as surfaces move onto tokens, never
 * raise it. Counted when every `:root` token moved into `tokens.css`. It counts hex only: a colour
 * written as `rgb()`, `hsl()` or a keyword is for review to catch.
 */
export const HEX_COLOUR_RATCHET = 50;

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
  {
    fg: '--text',
    bg: '--accent-soft',
    over: '--bg-surface',
    min: 4.5,
    why: 'the palette\'s selected row, and a match highlight on any other row (--palette-row-active, --palette-hit → --accent-soft) (4.5:1)',
  },
  { fg: '--text', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'your messages in the agent panel (--agent-user → --accent-soft) (4.5:1)' },
  // The command palette (its surface PR). Already covered above: body text on its card and footer
  // (--bg-surface, --bg-subtle), a match highlight on the selected row (--text on --bg-surface), a key
  // hint (--text-muted on --bg-surface), the selected row's icon (--on-accent on --accent) and its
  // status pill (--on-inverse on --inverse). New with it:
  {
    fg: '--text-muted',
    bg: '--accent-soft',
    over: '--bg-surface',
    min: 4.5,
    why: 'the palette\'s selected row: its detail line and group name (12px, --text-muted); the SEO sidebar\'s focused "More panels" item: its icon (4.5:1)',
  },
  { fg: '--warn-ink', bg: '--bg-surface', min: 4.5, why: 'the palette\'s confirm step: its caution note (12px, was --caution) on the card (4.5:1)' },
  {
    fg: '--text',
    bg: '--bg-hover',
    over: '--bg-subtle',
    min: 4.5,
    why: 'the palette\'s confirm step: its Back button (--bg-subtle fill, --e-ring edge), hovered (--bg-hover laid over the fill) (4.5:1)',
  },
  {
    fg: '--accent',
    bg: '--accent-soft',
    over: '--bg-surface',
    min: 3,
    why: 'the palette\'s confirm step: its icon (--accent on an --accent-soft tile) (graphics, 3:1)',
  },
  // The new-tab view (its surface PR). Already covered above: the wordmark, hint, "Jump back in" title,
  // a tile's label and host on --bg-surface (--text, --text-muted, --text-faint at 12px), the FrostMark
  // (--accent on --bg-surface) and a hovered tile's --accent ring. New with it:
  {
    fg: '--accent',
    bg: '--accent-soft',
    over: '--bg-surface',
    min: 4.5,
    why: 'a "Jump back in" tile\'s monogram: its letter (13px, --accent) on an --accent-soft tile (was --jump-monogram-bg) (4.5:1)',
  },
  // The agent panel (its surface PR). Already covered above: body and muted text on the sheet and on
  // its cards (--bg-sheet, --bg-surface), code on --bg-subtle, your messages (--text on --accent-soft
  // over --bg-sheet), a search match on the selected chat (--text-muted on --bg-surface), links on the
  // sheet, status chips (-ink on -soft over a card) and the risk note (--warn-ink on a card). New with it:
  { fg: '--text-faint', bg: '--bg-sheet', min: 4.5, why: `${FAINT} the agent panel's chat heading, context meter and plan line (12px) on the sheet` },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'the agent panel\'s running chip and a pressed catalogue chip (11px, --accent on --accent-soft) on a card (4.5:1)' },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'the agent panel\'s pressed chat filter chip (11px) and its header mark, on the sheet (4.5:1)' },
  { fg: '--text-muted', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'the agent panel\'s selected chat: its snippet (--text-muted), and a search match in any snippet (4.5:1)' },
  { fg: '--text', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: 'the agent panel\'s approval card and notice banner (--agent-approval-bg → --warn-soft) on the sheet (4.5:1)' },
  { fg: '--text-muted', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: 'the approval card\'s labels and page key (12px, --text-muted) (4.5:1)' },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: `${INK}: the approval card's note and its "More code below" hint (12px, was --caution)` },
  { fg: '--text', bg: '--warn-soft', over: '--bg-surface', min: 4.5, why: 'the agent settings\' revoke-all confirmation (--warn-soft) inside a card (4.5:1)' },
  { fg: '--text-muted', bg: '--warn-soft', over: '--bg-surface', min: 4.5, why: 'the revoke-all confirmation\'s muted text inside a card (4.5:1)' },
  { fg: '--text', bg: '--danger-soft', over: '--bg-sheet', min: 4.5, why: 'the agent panel\'s error banner (was a 13% --danger tint) on the sheet (4.5:1)' },
  { fg: '--accent', bg: '--danger-soft', over: '--bg-sheet', min: 4.5, why: 'a link in the agent panel\'s error banner (the plan failure\'s "Manage usage") (4.5:1)' },
  { fg: '--accent', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: 'a link in the agent panel\'s notice banner (4.5:1)' },
  { fg: '--danger-ink', bg: '--bg-surface', min: 4.5, why: 'the agent panel\'s field errors (12px, was --danger) in a settings card (4.5:1)' },
  { fg: '--danger-ink', bg: '--bg-sheet', min: 4.5, why: 'the agent panel\'s field errors (12px, was --danger) on the sheet (4.5:1)' },
  { fg: '--text', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'the agent panel\'s buttons, hovered (--bg-field-hover → --bg-hover over --bg-surface) (4.5:1)' },
  { fg: '--text', bg: '--bg-hover', over: '--bg-sheet', min: 4.5, why: 'the agent panel\'s chat rows, hovered (--bg-hover over the sheet) (4.5:1)' },
  { fg: '--text', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'the agent panel\'s attach menu: an option hovered or focused (--agent-user → --accent-soft) on the menu\'s card (4.5:1)' },
  { fg: '--warn-ink', bg: '--bg-subtle', min: 4.5, why: 'the agent panel\'s risk chip: --warn-ink (was the approval edge) on the chip\'s --bg-subtle fill (11px) (4.5:1)' },
  // Settings and Help (their surface PR). Already covered above: body, muted and faint text on the sheet
  // and on its cards, links, the nav's selected item (--text on --bg-surface) and its hovered ones (--text
  // on --bg-hover over the sheet), buttons hovered (over --bg-surface), a checked choice (--text and
  // --text-muted on --accent-soft over a card), the avatar (--accent on --accent-soft over a card), the
  // plan chip (--text-muted on --bg-subtle), notices (--warn-ink on --warn-soft over the sheet and a
  // card), errors (--danger-ink on the sheet and a card) and the diagnostics report (--text on
  // --bg-subtle). New with it: what drew --ok as text (KNOWN_CONTRAST_EXCEPTIONS) now draws --ok-ink.
  { fg: '--ok-ink', bg: '--bg-surface', min: 4.5, why: 'Settings\' key and plan status, the account\'s feature marks and the setup checklist\'s "Done" (12–13px, was --ok) on a card (4.5:1)' },
  { fg: '--ok-ink', bg: '--bg-sheet', min: 4.5, why: 'Settings\' Search Console headline when connected (15px, was --ok) on the Settings sheet (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-sheet', min: 3, why: 'Settings\' close button, hovered: its --text-muted icon on --bg-hover over the sheet (graphics, 3:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-surface', min: 3, why: 'Help\'s close button, hovered: its --text-muted icon on --bg-hover over the page card (graphics, 3:1)' },
  {
    fg: '--bg-surface',
    bg: '--accent',
    min: 3,
    why: 'a switch that is on: its knob\'s 1px edge (--bg-surface, the card it sits on) against the --accent track, since --knob on --accent is 2.65:1 in dark (graphics, 3:1)',
  },
  { fg: '--knob', bg: '--switch-off', min: 3, why: 'a switch that is off: its --knob on the --switch-off track (graphics, 3:1)' },
  // The SEO sidebar's frame and shared parts (its surface PR). Already covered above: the header's
  // title and host and the footer on the sheet (--text, --text-faint), cards' text and section titles
  // on --bg-surface, a selected rail item's --accent icon on --bg-surface, the pressed pin (--accent on
  // --accent-soft over the sheet), a count badge (--text-muted on --bg-subtle), severity badges and the
  // chip (-ink on -soft over a card, info --accent on --accent-soft), the rail tip and "More panels"
  // (--text on --bg-surface; a focused item --text on --accent-soft over it, a hovered one on
  // --bg-hover), the hints (--text and --text-muted on the sheet, art --accent on --accent-soft and
  // --warn-ink on --warn-soft over the sheet) and the dots and severity icons (--ok, --warn, --danger,
  // --accent on --bg-sheet and --bg-surface). New with it:
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-sheet', min: 4.5, why: 'a hovered SEO rail item: its icon (--text-muted, was --icon) on --bg-hover over the sheet (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-active', over: '--bg-sheet', min: 4.5, why: 'a pressed SEO rail item: its icon on --bg-active over the sheet (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'a hovered "More panels" item: its icon (--text-muted) on --bg-hover over the menu\'s --bg-surface (4.5:1)' },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-window', min: 3, why: 'the toolbar\'s SEO sidebar toggle, pressed: its --accent icon on --accent-soft over the toolbar (--bg-chrome → --bg-window) (graphics, 3:1)' },
  // The browser chrome's rows (its surface PR). Already covered above: the active tab's label and the
  // address on --bg-surface (--text; the placeholder, the address badge and the active tab's glyph
  // --text-faint and --text-muted), the toolbar's tools, the new-tab button and the status bar on
  // --bg-window (--text-muted; a disabled tool, the connection and its label --text-faint), the pressed
  // SEO sidebar toggle (--accent on --accent-soft over --bg-window), the permission prompt's buttons
  // (--text on --bg-surface, hovered over --bg-hover, disabled --text-faint), its icon (--accent on
  // --accent-soft over --bg-window), the address's secure and insecure badges (--ok, --warn on
  // --bg-surface), the loading line and the focus ring (--accent on --bg-window), the status notice
  // (--warn-ink on --bg-chrome) and the fullscreen notice (--on-inverse on --inverse). New with it:
  { fg: '--text-muted', bg: '--bg-tab-idle', over: '--bg-window', min: 4.5, why: 'an inactive tab: its label and glyph (--text-muted) on --bg-tab-idle over the tab row (4.5:1)' },
  { fg: '--text', bg: '--bg-hover', over: '--bg-window', min: 4.5, why: 'a hovered inactive tab: its label (--text) on --bg-hover over the tab row (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-window', min: 4.5, why: 'a hovered toolbar tool or new-tab button, and a hovered tab\'s glyph and close button: --text-muted on --bg-hover over --bg-window (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-active', over: '--bg-window', min: 4.5, why: 'a pressed toolbar tool or new-tab button: its --text-muted icon on --bg-active over --bg-window (4.5:1)' },
  { fg: '--warn', bg: '--bg-tab-idle', over: '--bg-window', min: 3, why: `${WARN}: an inactive tab's alert glyph (a crashed or failed page) on --bg-tab-idle` },
  { fg: '--accent', bg: '--bg-tab-idle', over: '--bg-window', min: 3, why: 'an inactive tab\'s FrostMark, spinner and permission ring (--accent) on --bg-tab-idle (graphics, 3:1)' },
  {
    fg: '--text',
    bg: '--bg-active',
    over: '--bg-surface',
    min: 3,
    why: 'a tab\'s close button, pressed: its --text icon on --bg-active over the active tab (graphics, 3:1; on a hovered inactive tab it lies over --bg-hover too, where --text keeps more than 10:1)',
  },
  {
    fg: '--text',
    bg: '--accent-soft',
    over: '--bg-window',
    min: 4.5,
    why: 'the permission prompt, a band (--bg-prompt → --accent-soft, "band slot fill") under the toolbar: the asking origin and the dismiss button hovered (--text; the hover\'s --bg-hover on the band keeps more than 10:1) (4.5:1)',
  },
  { fg: '--text-muted', bg: '--accent-soft', over: '--bg-window', min: 4.5, why: 'the permission prompt\'s question and its dismiss icon (--text-muted) on the band (4.5:1)' },
  // Status text on a soft fill
  { fg: '--ok-ink', bg: '--ok-soft', over: '--bg-surface', min: 4.5, why: INK },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--bg-surface', min: 4.5, why: INK },
  { fg: '--danger-ink', bg: '--danger-soft', over: '--bg-surface', min: 4.5, why: INK },
  {
    fg: '--danger-ink',
    bg: '--danger-soft',
    over: '--bg-chrome',
    min: 4.5,
    why: `${INK}: the status bar's failed-overrides chip (11.5px), --danger-soft over --bg-chrome`,
  },
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
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-surface', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does; .agent-chip moved to -ink on -soft) (4.5:1)' },
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does; .agent-chip moved to -ink on -soft) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-surface', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does; .agent-chip moved to -ink on -soft) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: '11px chips: text on its tone\'s 14% tint (.seo-pill; .seo-flag-chip\'s 13% tint is lighter in light, darker in dark, so it passes wherever 14% does; .agent-chip moved to -ink on -soft) (4.5:1)' },
] as const satisfies readonly ContrastPair[];

/**
 * Known contrast exceptions, left for the surface PRs: a token some rules still use in a way that
 * misses the pair's minimum. Each is recorded, not fixed, in the values step; a surface PR that moves
 * the rules off it removes its entry (the guard fails once the pair would pass, or once no rule uses
 * the token that way). `rules` is how many `color: var(<fg>)` declarations the renderer's stylesheets
 * hold today.
 */
export interface ContrastException {
  readonly fg: TokenName;
  readonly bg: TokenName;
  readonly min: 4.5 | 3;
  readonly rules: number;
  readonly why: string;
}

export const KNOWN_CONTRAST_EXCEPTIONS = [
  {
    fg: '--ok',
    bg: '--bg-surface',
    min: 4.5,
    rules: 17,
    why: '--ok as body text ("Good length", passing counts, …) is 3.30:1 on a card in light (3.16 on the sheet); --ok is a graphics colour (3:1). The surface PRs move those rules to --ok-ink (Settings and Help moved their 4).',
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
  /** The fill the text sits on, when the rule pins that too (resolved the same way). */
  readonly background?: TokenName;
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
  // The agent panel's surface PR put its chips on the sheet's -soft fills, so the pair is -ink on -soft.
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='ok']"], color: '--ok-ink', background: '--ok-soft', why: OK_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='denied']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='failed']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  // More danger text on its 14% tint (3.7–3.9:1 on a card, light). The status bar's chip was 3.33:1
  // over --bg-chrome, and still 4.46:1 with the ink on the tint: it takes --danger-soft as its fill.
  {
    stylesheet: 'styles.css',
    element: [".status-tab-overrides[data-status='failed']"],
    color: '--danger-ink',
    background: '--danger-soft',
    why: 'the status bar\'s failed-overrides chip: --danger on its 14% tint over --bg-chrome is 3.33:1 (light); -ink on -soft is 5.30',
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
 * A control whose keyboard focus must show `--focus-ring` (and the transparent 2px outline forced colours
 * draw) in every state it can be focused in: hovered, busy (`aria-disabled`, which stays focusable),
 * primary or not. `element` lists the selectors, in `stylesheet`, that such an element matches in that
 * state; resolving the cascade over them (as `TEXT_COLOUR_RULES`: specificity, `:where()` adding none,
 * then source order) gives `box-shadow: var(--focus-ring)` and `outline: 2px solid transparent`, and no
 * `opacity` under 1 (it would dim the ring: at 0.55 it falls to about 2.4–2.8:1). So a hover's or a
 * primary button's own box-shadow never outranks the focus rule, and a busy button shows it is busy by
 * its colours, not by fading; a busy switch or choice fades only while it is not focused.
 */
export interface FocusRingRule {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly why: string;
}

const SETTINGS_BUTTON_HOVER = ".settings-button:hover:where(:not([aria-disabled='true'], :disabled))";
const SETTINGS_PRIMARY_HOVER = ".settings-button-primary:hover:where(:not([aria-disabled='true'], :disabled))";
const DIAGNOSTICS_SAVE_HOVER = ".diagnostics-save:hover:where(:not(:disabled, [aria-disabled='true']))";
const TOOL_HOVER = '.tool:hover:where(:not(:disabled))';
const TOOL_PRESSED = '.tool:active:where(:not(:disabled))';
const TAB_HOVER = ".tab:hover:where(:not([data-active='true']))";
/** The tab's focusable part is its inner `role="tab"`; the ring goes around the whole tab. */
const TAB_FOCUS = '.tab:has(.tab-main:focus-visible)';
const PROMPT_BUTTON_HOVER = '.prompt-button:hover:where(:not(:disabled))';
const PROMPT_DISMISS_HOVER = '.prompt-dismiss:hover:where(:not(:disabled))';

export const FOCUS_RING_RULES = [
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', SETTINGS_BUTTON_HOVER, '.settings-button:focus-visible'],
    why: 'a Settings button, focused and hovered',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', SETTINGS_BUTTON_HOVER, '.settings-button-primary', SETTINGS_PRIMARY_HOVER, '.settings-button:focus-visible'],
    why: 'a primary Settings button (Sign in, Connect, Save), focused and hovered: its hover sets box-shadow: none',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', ".settings-button[aria-disabled='true']", '.settings-button:focus-visible'],
    why: 'a Settings button while its section is busy (aria-disabled, still focusable: Account, Search Console)',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-button', '.settings-button-primary', ".settings-button[aria-disabled='true']", ".settings-button-primary[aria-disabled='true']", '.settings-button:focus-visible'],
    why: 'a primary Settings button while busy, or a confirmation not yet armed (aria-disabled)',
  },
  {
    stylesheet: 'help.css',
    element: ['.diagnostics-save', DIAGNOSTICS_SAVE_HOVER, '.diagnostics-save:focus-visible'],
    why: 'Export Diagnostics\' Save…, focused and hovered',
  },
  {
    stylesheet: 'help.css',
    element: ['.diagnostics-save', ".diagnostics-save[aria-disabled='true']", '.diagnostics-save:focus-visible'],
    why: 'Export Diagnostics\' Save… while it saves (aria-disabled, still focusable)',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-switch', ".settings-switch[aria-checked='true']", '.settings-switch:focus-visible'],
    why: 'a Telemetry or History switch, on and focused',
  },
  {
    stylesheet: 'settings.css',
    element: ['.settings-switch', ".settings-switch[aria-disabled='true']", '.settings-switch:focus-visible'],
    why: 'a switch while its call runs (aria-disabled, still focusable), focused: it fades only while not focused',
  },
  {
    stylesheet: 'settings-ai-checks.css',
    element: ['.settings-choice', ".settings-choice[aria-checked='true']", '.settings-choice:focus-visible'],
    why: 'the chosen AI checks or History choice, focused: its --accent ring gives way to --focus-ring',
  },
  {
    stylesheet: 'settings-ai-checks.css',
    element: ['.settings-choice', ".settings-choice[aria-disabled='true']", '.settings-choice:focus-visible'],
    why: 'a choice while its call runs (aria-disabled, still focusable), focused: it fades only while not focused',
  },
  {
    stylesheet: 'help.css',
    element: ['.setup-action', '.setup-action:hover', '.setup-action:focus-visible'],
    why: 'a setup checklist action, focused and hovered',
  },
  // The browser chrome (its surface PR): the shared `.tool` (the toolbar's, and the agent panel's and
  // SEO sidebar's header tools), the tabs, the new-tab button, the address bar and the permission prompt.
  { stylesheet: 'styles.css', element: ['.tool', TOOL_HOVER, '.tool:focus-visible'], why: 'a toolbar tool, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.tool', TOOL_HOVER, TOOL_PRESSED, '.tool:focus-visible'], why: 'a toolbar tool, focused and pressed' },
  {
    stylesheet: 'styles.css',
    element: ['.tool', TOOL_HOVER, ".sidebar-toggle[aria-pressed='true']", '.tool:focus-visible'],
    why: 'the SEO sidebar toggle, pressed (the sidebar open), focused and hovered: its --accent-soft fill keeps the ring',
  },
  { stylesheet: 'styles.css', element: ['.tab', TAB_HOVER, TAB_FOCUS], why: 'an inactive tab, focused (the tablist\'s roving focus) and hovered' },
  { stylesheet: 'styles.css', element: ['.tab', ".tab[data-active='true']", TAB_FOCUS], why: 'the active tab, focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.new-tab', '.new-tab:hover', '.new-tab:active', '.new-tab:focus-visible'], why: 'the new-tab button, focused, hovered and pressed' },
  { stylesheet: 'styles.css', element: ['.address', '.address:focus-within'], why: 'the address bar, focused (:focus-within): its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.prompt-button', PROMPT_BUTTON_HOVER, '.prompt-button:focus-visible'], why: 'the permission prompt\'s Allow or Block, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.prompt-dismiss', PROMPT_DISMISS_HOVER, '.prompt-dismiss:focus-visible'], why: 'the permission prompt\'s dismiss button, focused and hovered' },
] as const satisfies readonly FocusRingRule[];

/**
 * The tab row, on Signal since the chrome's surface PR (the canvas's chrome row and its tab states):
 * no separate strip (`--bg-strip` → `--bg-window`, `removed`), each tab a pill, an inactive one on
 * `--bg-tab-idle`, a hovered one on `--bg-hover` in its place (`--bg-tab-hover` → `--bg-hover`,
 * `removed`), the active one on `--bg-surface` with `--e-raised`; the pills stand `--space-1` apart, so
 * the hairline between inactive tabs (`--border-field`) went. In light and dark (translucent fills
 * composited over the strip) the active tab stands off the strip by at least `minActiveOnStrip`, an
 * inactive one by `minIdleOnStrip` and a hovered one by `minHoverOnStrip` (contrast ratios). The
 * values-step pins changed on purpose: the hairline is gone, and a hovered tab no longer lies between
 * the strip and the active tab (in light `--bg-hover` darkens the strip while the tabs lighten it).
 * Signal's own values set the floors: an inactive tab is 1.097:1 off the strip in light (1.143 in
 * dark), the active one 1.180 (1.126 in dark), a hovered one 1.103 (1.143). In dark `--bg-tab-idle`
 * and `--bg-hover` are the same fill, and the active tab's is within 1.02:1 of it: there a hovered tab
 * shows by its label turning `--text` and its close button, the active one by its `--e-raised` edge,
 * its `--text` label at `--text-body`'s emphasis weight and its close button.
 */
export const TAB_STRIP = {
  strip: '--bg-window',
  idle: '--bg-tab-idle',
  hover: '--bg-hover',
  active: '--bg-surface',
  minActiveOnStrip: 1.1,
  minIdleOnStrip: 1.09,
  minHoverOnStrip: 1.1,
} as const satisfies {
  readonly strip: TokenName;
  readonly idle: TokenName;
  readonly hover: TokenName;
  readonly active: TokenName;
  readonly minActiveOnStrip: number;
  readonly minIdleOnStrip: number;
  readonly minHoverOnStrip: number;
};

// ---- Fonts (bundled in the values step; applied per surface through the --text-* tokens) ----

/**
 * The renderer stylesheet (relative to `apps/desktop/src/renderer/`) that declares the bundled
 * fonts: only `@font-face` rules, one per `BUNDLED_FONTS` entry. `main.tsx` imports it right after
 * `TOKENS_STYLESHEET`. It applies no font itself: a surface draws Geist once its rules read the
 * `--text-*` type tokens (the command palette first); `--font-ui`, the rest of the chrome's face,
 * stays the system stack until its own surface PR.
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
