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
 * retired name (`removed`), and an alias goes once no rule reads it (the cleanup). The rollout:
 * 1. foundation (done): one token source and the full Signal vocabulary, no pixel changed;
 * 2. values (done): the legacy aliases point at their Signal tokens and the names in
 *    `SIGNAL_NAMES_WITH_LEGACY_VALUES` take their Signal values; Geist and Geist Mono are bundled
 *    (`BUNDLED_FONTS`, declared in `FONTS_STYLESHEET`), applied per surface through the `--text-*`
 *    tokens from step 3 on (`--font-ui`, the body's face, stayed the system stack until step 5);
 * 3. next, one PR per surface moves its rules onto Signal tokens and drops the retired names it used
 *    (the command palette first: its retired `--palette-*` names are `removed`, and it is the first
 *    surface to read the `--text-*` type tokens, so the first to draw Geist; then the new-tab view,
 *    whose retired `--start-*` and `--jump-*` names are `removed`, the agent panel, whose retired
 *    `--agent-*` names are `removed`, Settings and Help, which retired `--settings-switch-off`, and
 *    the SEO sidebar's frame and shared parts, whose retired `--seo-skeleton` and
 *    `--seo-skeleton-shine` are `removed`, and the browser chrome's rows, which retired the rows'
 *    heights, `--bg-strip` and `--bg-tab-hover`, then merged the tab row and the toolbar into one
 *    `--h-chrome` row; then the SEO panels' interiors, Overview and On-Page first, which retired
 *    nothing: every retired name they read, later panels still read; and so on, panel by panel, to the
 *    Changes panel, Projects, Rankings, Inspector and the screenshot editor, which retired nothing either; then the panel stylesheets
 *    (Search Console, the AI cards, the Crawl and AI answers sheets, the location badge), which retired
 *    `--gsc-grid`);
 * 4. cleanup (done): the legacy names no rule read any more are `removed`, retired names
 *    and aliases alike, and the aliases read only by their own converted surface (`--bg-chrome`,
 *    `--palette-bg`, `--jump-tile-bg`, `--agent-card`) gave their readers to their Signal tokens and
 *    went too; the last `--ok`-as-text rule moved to `stroke` (`GRAPHICS_ONLY_COLOURS`);
 * 5. base face (done, this step): `body` sets `--text-body` (`BASE_TYPE`), so no text draws in the
 *    system stack; the texts that inherited it set their own type (`TEXT_TYPE_RULES`), and `--font-ui`
 *    went, with the three aliases the workspace's sheets read (`--bg-page`, `--agent-bg`,
 *    `--seo-rail-width`), whose readers took their Signal tokens. What the rollout leaves is in
 *    `design-tokens.feature.md`, Left for later.
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
    { name: '--h-chrome', light: '56px', use: 'the chrome row (tabs, address, tools), fixed' },
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
 * history. (`--icon` was not one: it was a colour, now `removed`; the Signal icon size is `--icon-size`.)
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
 * `removed`: `tokens.css` no longer declares the name (light or dark) and no renderer source (`.css`,
 * `.ts`, `.tsx`, `index.html` under `apps/desktop/src/renderer`) mentions it outside a comment (a
 * script's comments are found by a scanner that leaves string, template and regex literals whole). The
 * renderer is enough: the tokens live on its documents' `:root`, and nothing else reads one (no
 * `var(--…)` or legacy name in `src/main`, `src/preload`, `src/workers` or `e2e/visual.css`, the one
 * stylesheet main inserts, which sets only its own marker). A `retire` row is `removed` once its
 * surface PR moved every rule off it; an `alias` row once no rule reads it (the cleanup moved the last
 * readers of an alias read only by its own surface to its Signal token), but only an alias of another
 * Signal token: never a self-alias (a Signal token's own name) or a layout constant (`signal: null`),
 * which have no Signal token to take their place. The row stays as the record of its replacement.
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
 * not `removed` are declared in `tokens.css`: since the base face's PR, only the self-aliases (Signal
 * tokens), the layout constants and `--seo-panel-width` (the sidebar's resize sets it on the panel).
 */
export const LEGACY_TOKEN_MIGRATION = [
  // Chrome sizes: the chrome's surface PR sized its rows from --h-control, --h-field and --h-status and
  // dropped the three heights; the merged row's PR made the tab row and the toolbar one --h-chrome row;
  // the rest of the chrome's PR made the find bar a band (--find-height).
  { legacy: '--tabstrip-height', kind: 'retire', signal: '--h-chrome', was: '40px', note: 'with --toolbar-height: one 56px row', removed: true },
  { legacy: '--toolbar-height', kind: 'retire', signal: '--h-chrome', was: '50px', note: 'buttons join the tab row', removed: true },
  { legacy: '--status-height', kind: 'retire', signal: '--h-status', was: '26px', note: '28px', removed: true },
  { legacy: '--find-height', kind: 'retire', signal: null, was: '40px', note: 'band slot: find is a band (≥ 44px)', removed: true },
  { legacy: '--radius-control', kind: 'retire', signal: '--r-pill', was: '9px', note: '', removed: true },
  { legacy: '--radius-field', kind: 'retire', signal: '--r-pill', was: '11px', note: '--r-sm inside cards', removed: true },
  { legacy: '--seo-panel-width', kind: 'alias', signal: '--w-panel', was: '360px', note: '' },
  // The base face's PR moved the SEO rail's width to --w-rail (the last reader) and dropped --seo-rail-width.
  { legacy: '--seo-rail-width', kind: 'alias', signal: '--w-rail', was: '48px', note: '', removed: true },
  // Layout constants: kept, no visual token
  { legacy: '--page-min-width', kind: 'alias', signal: null, was: '320px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--agent-panel-width', kind: 'alias', signal: null, was: '380px', note: 'layout constant: the name stays, no visual token' },
  // The agent toggle's PR (agent-panel.feature.md, Toggle): the collapsed agent takes no room, so its rail's width went.
  { legacy: '--agent-rail-width', kind: 'retire', signal: null, was: '40px', note: 'none: the collapsed agent has no rail (its toggle is the chrome row\'s)', removed: true },
  { legacy: '--settings-width', kind: 'alias', signal: null, was: '820px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--settings-nav-width', kind: 'alias', signal: null, was: '168px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--history-width', kind: 'alias', signal: null, was: '760px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--projects-width', kind: 'alias', signal: null, was: '980px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--projects-run-band', kind: 'alias', signal: null, was: 'min(300px, 50%)', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-width', kind: 'alias', signal: null, was: '640px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-sheet-height', kind: 'alias', signal: null, was: '404px', note: 'layout constant: the name stays, no visual token; the palette band' },
  { legacy: '--palette-sheet-min-height', kind: 'alias', signal: null, was: '180px', note: 'layout constant: the name stays, no visual token' },
  { legacy: '--palette-page-min-visible', kind: 'alias', signal: null, was: '96px', note: 'layout constant: the name stays, no visual token' },
  // Type and icons: the base face's PR set the body in --text-body (BASE_TYPE) and dropped --font-ui; --icon had no reader.
  { legacy: '--font-ui', kind: 'retire', signal: '--text-*', was: 'system stack', note: 'Geist, system-ui; Geist Mono', removed: true },
  { legacy: '--icon', kind: 'retire', signal: '--text-muted', was: 'icon colour', note: 'name now means size: --icon-size', removed: true },
  { legacy: '--panel-art', kind: 'retire', signal: '--text-faint', was: '#6b7a90', note: '', removed: true },
  // Surfaces and edges
  { legacy: '--bg-chrome', kind: 'alias', signal: '--bg-window', was: '#f3f5f8', note: '', removed: true },
  { legacy: '--bg-strip', kind: 'retire', signal: '--bg-window', was: '#e4e8ee', note: 'no separate strip', removed: true },
  { legacy: '--bg-chrome-edge', kind: 'retire', signal: '--divider', was: '#e2e6ec', note: '', removed: true },
  { legacy: '--bg-page', kind: 'alias', signal: '--bg-surface', was: '#fbfcfd', note: 'the page card', removed: true },
  { legacy: '--bg-field', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
  { legacy: '--bg-field-hover', kind: 'retire', signal: '--bg-hover', was: '#ffffff', note: 'over --bg-surface', removed: true },
  { legacy: '--border-field', kind: 'retire', signal: '--e-raised', was: '#d7dce4', note: 'field outlines (ring shadow, no border); --track for scrollbar thumbs; --divider or --e-ring for other borders', removed: true },
  { legacy: '--shadow-field', kind: 'retire', signal: '--e-raised', was: 'shadow', note: '', removed: true },
  { legacy: '--shadow-card', kind: 'retire', signal: '--e-ring', was: 'shadow', note: '', removed: true },
  { legacy: '--bg-hover', kind: 'alias', signal: '--bg-hover', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-active', kind: 'alias', signal: '--bg-active', was: 'overlay', note: 'Signal value' },
  { legacy: '--bg-tab-hover', kind: 'retire', signal: '--bg-hover', was: 'overlay', note: '', removed: true },
  { legacy: '--bg-prompt', kind: 'retire', signal: '--accent-soft', was: '#ffffff', note: 'band slot fill', removed: true },
  { legacy: '--prompt-edge', kind: 'retire', signal: null, was: '#dfe4eb', note: 'none: bands have no edge', removed: true },
  { legacy: '--shadow-prompt', kind: 'retire', signal: null, was: 'shadow', note: 'none', removed: true },
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
  { legacy: '--caution', kind: 'retire', signal: '--warn', was: '#b7791f', note: 'fair band ring', removed: true },
  { legacy: '--info-tone', kind: 'retire', signal: '--accent', was: '#4b72b8', note: 'info = accent ring', removed: true },
  { legacy: '--start-mark', kind: 'retire', signal: '--accent', was: '#5b8def', note: 'FrostMark', removed: true },
  { legacy: '--start-glow', kind: 'retire', signal: null, was: 'glow', note: 'none: no gradient washes', removed: true },
  // SEO sidebar (--seo-*): the frame's surface PR dropped the skeleton's names; the cleanup the rest, unread.
  { legacy: '--seo-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '', removed: true },
  { legacy: '--seo-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
  { legacy: '--seo-card-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: 'card outlines; --divider for separator borders and guide lines', removed: true },
  { legacy: '--seo-track', kind: 'alias', signal: '--track', was: '#e7ebf1', note: '', removed: true },
  { legacy: '--seo-skeleton', kind: 'retire', signal: '--bg-subtle', was: '#e9edf3', note: '', removed: true },
  { legacy: '--seo-skeleton-shine', kind: 'retire', signal: '--bg-sheet', was: '#f4f6f9', note: 'sweep over --bg-subtle', removed: true },
  // Command palette (--palette-*): its surface PR moved every rule onto Signal and dropped the retired names;
  // the cleanup moved .palette's fill to --bg-surface and dropped --palette-bg.
  { legacy: '--palette-bg', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
  { legacy: '--palette-edge', kind: 'retire', signal: '--e-ring', was: '#dfe4eb', note: 'outlines; --divider for separator borders', removed: true },
  { legacy: '--palette-shadow', kind: 'retire', signal: '--e-ring', was: 'shadow', note: 'a band, not a floating sheet', removed: true },
  { legacy: '--palette-sheet', kind: 'retire', signal: '--bg-window', was: 'gradient', note: 'no gradients', removed: true },
  { legacy: '--palette-row-active', kind: 'retire', signal: '--accent-soft', was: '.10 accent', note: '', removed: true },
  { legacy: '--palette-hit', kind: 'retire', signal: '--accent-soft', was: '.16 accent', note: 'match highlight, --r-xs; --bg-surface on the selected row', removed: true },
  { legacy: '--palette-kbd-bg', kind: 'retire', signal: '--bg-surface', was: '#f1f3f7', note: 'key hint, --h-badge', removed: true },
  { legacy: '--palette-kbd-edge', kind: 'retire', signal: '--e-ring', was: '#d7dce4', note: '', removed: true },
  // Feature colours: the rest of the chrome's PR moved the render profile onto the one accent (--render-*).
  { legacy: '--render-accent', kind: 'retire', signal: '--accent', was: '#7a4fe0', note: 'one accent: no second hue', removed: true },
  { legacy: '--render-soft', kind: 'retire', signal: '--accent-soft', was: '.13 violet', note: '', removed: true },
  { legacy: '--render-edge', kind: 'retire', signal: '--accent', was: '.55 violet', note: '', removed: true },
  // Content's result preview (--serp-*): its surface PR moved every rule onto Signal and dropped the retired names;
  // the cleanup dropped the aliases, unread since.
  { legacy: '--serp-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
  { legacy: '--serp-title', kind: 'retire', signal: '--accent', was: '#2450c8', note: 'Search preview title', removed: true },
  { legacy: '--serp-text', kind: 'alias', signal: '--text-muted', was: '#474e5c', note: '', removed: true },
  { legacy: '--serp-path', kind: 'retire', signal: '--text-muted', was: '#5d6573', note: 'URL crumbs', removed: true },
  { legacy: '--serp-glyph', kind: 'retire', signal: '--bg-subtle', was: '#e3e8f1', note: '', removed: true },
  { legacy: '--serp-glyph-mark', kind: 'retire', signal: '--text-muted', was: '#6b7a90', note: '', removed: true },
  { legacy: '--jump-tile-bg', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
  { legacy: '--jump-tile-edge', kind: 'retire', signal: '--e-ring', was: '#e3e7ee', note: '', removed: true },
  { legacy: '--jump-monogram-bg', kind: 'retire', signal: '--accent-soft', was: '.12 accent', note: '', removed: true },
  { legacy: '--gsc-line', kind: 'alias', signal: '--accent', was: 'accent', note: '', removed: true },
  { legacy: '--gsc-grid', kind: 'retire', signal: '--divider', was: '#e7ebf1', note: 'the chart\'s grid lines', removed: true },
  { legacy: '--gsc-axis', kind: 'alias', signal: '--text-faint', was: 'faint', note: '', removed: true },
  { legacy: '--settings-switch-off', kind: 'retire', signal: '--switch-off', was: '#c9cfd9', note: '', removed: true },
  // Agent panel (--agent-*): its surface PR moved every rule onto Signal and dropped the retired names; the
  // cleanup moved the cards to --bg-surface (--agent-card), the base face's PR the agent sheet to --bg-sheet (--agent-bg).
  { legacy: '--agent-bg', kind: 'alias', signal: '--bg-sheet', was: '#f6f7fa', note: '', removed: true },
  { legacy: '--agent-card', kind: 'alias', signal: '--bg-surface', was: '#ffffff', note: '', removed: true },
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
 * legacy aliases still declared (not `removed`) and component-scoped custom properties (declared in the same stylesheet, e.g.
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
   * Omitted for a surface whose classes share no prefix (the browser chrome: `.chrome-row`, `.tab`,
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
 * The stylesheets, after an entry's `stylesheet`, whose rules its element also matches. A feature
 * stylesheet (`gsc-panel.css`, `crawl.css`, …) is imported by its component, so it loads before
 * `styles.css` (`main.tsx` imports `App` before it): a shared control's rule there (`.panel-button`,
 * `.seo-chip-button`, `.seo-select`) wins a tie of specificity. The guards that resolve a cascade
 * (`FORCED_COLOURS_*`, `TEXT_COLOUR_RULES`, `FOCUS_RING_RULES`, `DISABLED_CONTROLS`, `PRESSED_EDGES`)
 * read `stylesheet` and then each of these, in that order, as one stylesheet; every selector an entry
 * names must be in one of them.
 */
export interface LoadsBefore {
  readonly loadsBefore?: readonly string[];
}

/**
 * A state the cascade checks resolve in, besides light or dark and (for the `FORCED_COLOURS_*` checks and
 * `STATE_EDGES`) forced colours. The resolver reads a rule inside any at-rule the renderer's stylesheets use
 * (they hold `@media` and `@container` blocks, no `@supports` and no native nesting, but the resolver reads
 * those too), and whether a block applies follows from the state:
 * - `@media`: `(prefers-color-scheme: dark)` in dark (`light` in light); `(forced-colors: active)` when the
 *   check reads forced colours (`none` when it doesn't); `(prefers-reduced-motion: reduce)` when
 *   `reducedMotion` (`no-preference` when not); an upper-bound width (`max-width`, `width <`, `width <=`) when
 *   `narrow` names `viewport` or `*`; `screen` and `all` always; features joined by `and` must all hold;
 * - `@container <name> (<upper-bound width>)`: when `narrow` names the container or `*` (`not`, `and`, `or` and
 *   `none` are never a container's name);
 * - `@supports (<property>: <value>)`: always (the renderer runs in one engine, Electron's Chromium, which a
 *   feature query is written for); `@supports not (<property>: <value>)`: never;
 * - `@keyframes`: never (its blocks are keyframes, not elements);
 * - native nesting under one parent selector: a nested rule's selector is the parent's with each `&` replaced
 *   by it (or, with no `&`, a descendant of it), which has the specificity of `:is(<parent>)`; an at-rule
 *   nested in a rule applies its declarations to that rule's selector; an at-rule inside another applies when
 *   both do.
 * Anything else makes the check throw, so no rule is skipped unread: `@layer`, a lower-bound width, `not`, `or`
 * or a comma list in a `@media` query, an unknown media feature, an unnamed `@container` or one whose name is a
 * keyword, any other `@supports` condition (a `not` inside parentheses, `and`, `or`, `selector()`), and nesting
 * under a parent that is a list of selectors (its rules take the specificity of `:is()` of the whole list, and
 * an `&` there matches any of them; none is modelled) or an `&` inside a quoted string.
 */
export interface CascadeContext {
  readonly name: string;
  readonly reducedMotion?: boolean;
  /** The containers (by name; `viewport` for `@media` widths; `*` for all) narrower than every query on them. */
  readonly narrow?: readonly string[];
}

/**
 * The states every cascade check runs in (`TEXT_COLOUR_RULES`, `TEXT_TYPE_RULES`, `FOCUS_RING_RULES`,
 * `FORCED_COLOURS_BUSY`, `FORCED_COLOURS_PRESSED`, `FORCED_COLOURS_KEPT`, `DISABLED_CONTROLS`, `PRESSED_EDGES`,
 * `STATE_EDGES` and `TAB_STRIP`'s active tab), each in light and dark: the default window, where every container
 * is wider than its queries and motion is allowed; reduced motion; and the narrowest window (664px,
 * `workspace-layout.spec.ts` `NARROW_WINDOW`), where every width query the stylesheets hold (each an upper
 * bound) applies at once. A rule in a reduced-motion or width block that undid a guarded colour, ring, edge,
 * type or `forced-color-adjust` fails its check there.
 */
export const CASCADE_CONTEXTS = [
  { name: 'default' },
  { name: 'reduced motion', reducedMotion: true },
  { name: 'narrowest', narrow: ['viewport', '*'] },
] as const satisfies readonly CascadeContext[];

/**
 * Busy or disabled controls that show it only by colour (`FOCUS_RING_RULES`: fading would dim their
 * focus ring), and an empty count shown dimmed (Overview's zero-count pill). Forced colours replace those colours, so for each entry the cascade over its `element`
 * selectors in `stylesheet`, with the rules inside `@media (forced-colors: active)` read too (as the
 * dark block is in dark), resolves `color` and `border-color` to `GrayText` in light and dark: a later
 * rule of the control's own (the primary button's `--accent` text) must not win over it.
 */
export interface ForcedColoursBusy extends LoadsBefore {
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
  // Overview: a severity with no finding is a dimmed pill (--text-faint, where it faded); forced colours mark it GrayText, text and edge.
  { stylesheet: 'styles.css', element: ['.seo-count', ".seo-count[data-count='0']"], why: 'Overview\'s count pill for a severity with no finding ("0 errors")' },
  // The panels' shared controls (Links, Images, Social and Schema's PR): disabled, they are --text-faint
  // on --bg-subtle with no shadow (the token sheet's disabled control), where they faded.
  { stylesheet: 'styles.css', element: ['.seo-toggle', '.seo-toggle:disabled'], why: 'a panel toggle, disabled (Copy as CSV with no row, Broken only with nothing broken)' },
  { stylesheet: 'styles.css', element: ['.seo-action', '.seo-action:disabled'], why: 'a row action, disabled (Open in new tab for a mailto: link, Copy URL with no URL)' },
  { stylesheet: 'styles.css', element: ['.seo-segment', '.seo-segment:disabled'], why: 'a segment, disabled (Schema\'s Tree view of a block that did not parse)' },
  { stylesheet: 'styles.css', element: ['.seo-chip-button', '.seo-chip-button:disabled'], why: 'a filter chip, disabled' },
  { stylesheet: 'styles.css', element: ['.seo-icon-action', '.seo-icon-action:disabled'], why: 'Schema\'s open-URL icon button, disabled (a value that is not an http(s) URL)' },
  // The rest of the browser chrome: a disabled button is --text-faint on --bg-subtle with no shadow (it faded).
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button:disabled'], why: 'an error panel\'s button (and every panel\'s .panel-button), disabled or busy (Try again while it reloads)' },
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button-primary', '.panel-button:disabled'], why: 'a primary .panel-button, disabled or busy (its --accent fill must give way)' },
  // Later states: a .panel-button busy but still focusable (aria-disabled) took no state rule at all.
  { stylesheet: 'styles.css', element: ['.panel-button', ".panel-button[aria-disabled='true']"], why: 'the crawl sheet\'s Export CSV while it saves (aria-disabled, still focusable)' },
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', '.panel-button-primary', ".panel-button[aria-disabled='true']"],
    why: 'the crawl sheet\'s Start crawl and AI answers\' Ask while their run is under way (aria-disabled primary buttons)',
  },
  { stylesheet: 'styles.css', element: ['.update-button', '.update-button:disabled'], why: 'the update notice\'s Skip this version while its step runs' },
  { stylesheet: 'styles.css', element: ['.update-button', '.update-primary', '.update-button:disabled'], why: 'the update notice\'s Download or Show file while its step runs' },
  { stylesheet: 'styles.css', element: ['.find-tool', '.find-tool:disabled'], why: 'the find bar\'s Previous and Next with no match' },
  { stylesheet: 'styles.css', element: ['.render-chip', '.render-chip:disabled'], why: 'the editor bar\'s quick profiles with no tab' },
  // Later states: a checkbox label whose box is disabled faded to half; it takes DISABLED_INK, GrayText here
  // (a label draws no border, so its border-color is only what this check reads).
  { stylesheet: 'styles.css', element: ['.render-check', '.render-check:has(input:disabled)'], why: 'the editor bar\'s checkbox labels, their box disabled (Pin to this site with no page)' },
  {
    stylesheet: 'styles.css',
    element: ['.render-frame-button', '.render-bar .render-frame-button', '.render-bar .render-frame-primary', '.render-bar .render-frame-button:disabled'],
    why: 'the editor bar\'s Apply (a primary button) while its profile is invalid, and Reset with nothing to reset',
  },
  { stylesheet: 'styles.css', element: ['.devtools-button', '.devtools-button:disabled'], why: 'a DevTools drawer button with nothing to act on' },
  // Compliance (Indexability, Page Speed and Compliance's PR): an impact with no violated rule is a
  // dimmed tile (--text-faint, where its tinted edge and fill went), as Overview's zero-count pill.
  { stylesheet: 'styles.css', element: ['.seo-a11y-tally-item', ".seo-a11y-tally-item[data-count='0']"], why: 'the accessibility tally\'s tile for an impact with no violated rule ("0 Minor")' },
  // Content: a place an n-gram is not in is its letter dimmed (--text-faint at half strength) where a
  // place it is in is --accent on --accent-soft; forced colours replace both, so the dimmed one is GrayText.
  { stylesheet: 'styles.css', element: ['.seo-ngram-place', ".seo-ngram-place[data-present='false']"], why: 'Content: an n-gram\'s place mark (T, H1, D, U) for a place the phrase is not in' },
  // Projects (the Changes panel's surface PR): a sheet button is --text-faint on --bg-subtle with no shadow when disabled (it faded).
  { stylesheet: 'styles.css', element: ['.projects-small-button', '.projects-small-button:disabled'], why: 'a Projects sheet button, disabled (Add the current page with no page, Save while tags save)' },
  {
    stylesheet: 'styles.css',
    element: ['.projects-small-button', '.projects-danger', '.projects-small-button:disabled'],
    why: 'Delete project while the sheet is busy (its --danger-ink must give way)',
  },
  // Later states: a project's page or search row while a capture run is under way (disabled; it looked enabled).
  { stylesheet: 'styles.css', element: ['.projects-entry-open', '.projects-entry-open:disabled'], why: 'a Projects page or search row during a capture run' },
  {
    stylesheet: 'styles.css',
    element: ['.projects-entry-meta', '.projects-entry-open:disabled .projects-entry-meta'],
    why: 'that row\'s last-capture line (its own --text-muted must give way)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.projects-entry-label', '.projects-entry-open:hover .projects-entry-label', '.projects-entry-open:disabled .projects-entry-label'],
    why: 'that row\'s label under the pointer (its hover\'s --accent must give way)',
  },
  // The panel stylesheets (their surface PR): a busy chip, the calendar's arrows and the days out of range.
  {
    stylesheet: 'ai-checks.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', ".seo-chip-button.ai-judgment-action[aria-disabled='true']"],
    why: 'the AI judgment card\'s Check with AI while its call runs (aria-disabled, still focusable)',
  },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-nav', '.gsc-cal-nav:disabled'], why: 'the Search Console calendar\'s previous or next month at the end of the range' },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', ".gsc-cal-day[aria-disabled='true']"], why: 'a calendar day Search Console has no data for' },
] as const satisfies readonly ForcedColoursBusy[];

/**
 * A pressed or chosen item whose unchosen siblings draw no edge of their own under forced colours. Forced
 * colours paint a transparent border too (in `CanvasText`), so a row, tab or swatch whose chosen edge is a
 * recoloured transparent border resets it to the canvas when unchosen, or every item would draw the same
 * edge and the chosen one would differ by colour alone. `rest: 'canvas'`: the cascade over `element[0]`
 * alone (the item unchosen), forced colours read, resolves `border-color` to `Canvas`. `match:
 * 'canvastext'` (the Inspector's source): over `element[0]` and `element[1]` (a matching line that is not
 * the current one) it resolves to `CanvasText`.
 */
export interface ForcedColoursPressed extends ForcedColoursBusy {
  readonly rest?: 'canvas';
  readonly match?: 'canvastext';
}

/**
 * Toggle tools that show they are pressed by a fill and an edge colour (`aria-pressed`). Forced colours
 * replace both, so for each entry the cascade over its `element` selectors in `stylesheet`, with the
 * rules inside `@media (forced-colors: active)` read too, resolves `border-color` to `Highlight` in
 * light and dark: a later rule of the toggle's own (the render toggle's `--render-edge`) must not win
 * over it. An entry with `rest` (and `match`) also pins the unchosen item's edge (`ForcedColoursPressed`).
 */
export const FORCED_COLOURS_PRESSED = [
  { stylesheet: 'styles.css', element: ['.tool', ".sidebar-toggle[aria-pressed='true']"], why: 'the SEO sidebar\'s and the AI agent\'s toggles (both .sidebar-toggle), pressed (their panel open)' },
  { stylesheet: 'styles.css', element: ['.tool', ".render-toggle[aria-pressed='true']"], why: 'the render-profile toggle, pressed (its editor bar open)' },
  // The panels' shared controls (Links, Images, Social and Schema's PR): pressed is a fill (--accent-soft,
  // or the chosen segment's raised --bg-surface), which forced colours replace.
  { stylesheet: 'styles.css', element: ['.seo-toggle', ".seo-toggle[aria-pressed='true']"], why: 'a panel toggle, pressed (Highlight on page, Broken only)' },
  { stylesheet: 'styles.css', element: ['.seo-segment', ".seo-segment[aria-pressed='true']"], why: 'the chosen segment (Links\' type filter, Schema\'s Tree or Raw)' },
  { stylesheet: 'styles.css', element: ['.seo-chip-button', ".seo-chip-button[aria-pressed='true']"], why: 'a filter chip, pressed (Images\' filters)' },
  // The rest of the browser chrome: a pressed or selected item drawn as the canvas's segmented control's (--bg-surface, --e-raised).
  { stylesheet: 'styles.css', element: ['.find-tool', ".find-case[aria-pressed='true']"], why: 'the find bar\'s Match case, pressed' },
  { stylesheet: 'styles.css', element: ['.devtools-tab', ".devtools-tab[aria-selected='true']"], why: 'the DevTools drawer\'s selected tab' },
  { stylesheet: 'styles.css', element: ['.seo-ngram-highlight', ".seo-ngram-highlight[aria-pressed='true']"], why: 'Content: an n-gram row\'s highlight button, pressed (the page shows that phrase)' },
  // The Changes panel, Projects, Rankings, Inspector and the screenshot editor (their surface PR): a chosen
  // item drawn by its fill and an --accent edge (PRESSED_EDGES), or by an --accent line, which forced colours replace.
  { stylesheet: 'styles.css', element: ['.changes-version', ".changes-version[aria-pressed='true']"], rest: 'canvas', why: 'the Changes panel\'s chosen version (the one the diff shows)' },
  { stylesheet: 'styles.css', element: ['.projects-item', ".projects-item[data-selected='true']"], rest: 'canvas', why: 'the Projects sheet\'s chosen project' },
  { stylesheet: 'styles.css', element: ['.inspector-row', ".inspector-row[data-selected='true']"], rest: 'canvas', why: 'the Inspector\'s selected node' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-action', ".inspector-view-button[aria-pressed='true']"],
    why: 'the Inspector\'s chosen view (Tree, Rendered or Served)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.inspector-source-row', ".inspector-source-row[data-match='true']", ".inspector-source-row[aria-current='true']"],
    rest: 'canvas',
    match: 'canvastext',
    why: 'the source\'s current match (its --accent line; the other matches are CanvasText)',
  },
  { stylesheet: 'styles.css', element: ['.shot-editor-swatch', ".shot-editor-swatch[aria-pressed='true']"], rest: 'canvas', why: 'the screenshot editor\'s chosen colour (its --accent ring)' },
  { stylesheet: 'rankings.css', element: ['.projects-view-tab', ".projects-view-tab[aria-selected='true']"], rest: 'canvas', why: 'the Projects sheet\'s chosen view (its --accent underline)' },
  // The panel stylesheets (their surface PR): a chosen tile, filter, day, run, answer or view, and a watched domain.
  { stylesheet: 'gsc-panel.css', element: ['.gsc-tile', ".gsc-tile[aria-pressed='true']"], why: 'Search Console\'s total tile the chart shows (its --accent edge)' },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', ".seo-chip-button.gsc-dates[data-active='true']"],
    why: 'Search Console\'s custom dates, in force (--accent on --accent-soft, an --accent edge)',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', ".seo-chip-button.gsc-dates[aria-expanded='true']"],
    why: 'Search Console\'s custom dates, its calendar open',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-select', ".gsc .gsc-select[data-active='true']"],
    why: 'a Search Console filter in force (a month preset, a country, a device: an --accent edge and text)',
  },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', ".gsc-cal-day[aria-selected='true']"], why: 'a calendar day inside the chosen range (an --accent-soft band, its ends --accent)' },
  { stylesheet: 'crawl.css', element: ['.crawl-tab', ".crawl-tab[aria-pressed='true']"], why: 'the crawl sheet\'s chosen view (Pages or Site structure), a segment' },
  { stylesheet: 'crawl.css', element: ['.crawl-run', ".crawl-run[data-selected='true']"], why: 'the crawl run the sheet shows (--accent-soft, an --accent edge)' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answers-pick', ".ai-answers-pick[aria-pressed='true']"], why: 'the AI answer the sheet shows' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answer-domain', ".ai-answer-domain[data-watched='true']"], why: 'a cited domain that is the watched one' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answer-citation', ".ai-answer-citation[data-watched='true']"], why: 'a citation on the watched domain' },
] as const satisfies readonly ForcedColoursPressed[];

/**
 * Status marks drawn in a fill or a border colour, whose shape and colour together are the status (a
 * filled square, a ring, a disc, a hollow diamond). Forced colours would repaint every one the same
 * (a fill becomes the canvas, so a filled mark vanishes), so for each entry the cascade over its
 * `element` selectors in `stylesheet`, with the rules inside `@media (forced-colors: active)` read too,
 * resolves `forced-color-adjust` to `none` in light and dark: the mark keeps its own colours there, as
 * the SEO rail's dots do. (The score ring and the length meters are SVG strokes and fills, which
 * Chromium's forced colours leave as they are; their state is also in words beside them.) It is also
 * the only place anything may opt out of forced colours: `only-kept-marks-opt-out-of-forced-colours`
 * fails a rule of any renderer stylesheet that sets `forced-color-adjust` (any value: handing an
 * element back with `auto` is not supported yet) unless every selector of it, its nearest enclosing one
 * when nested in an at-rule, is named here for its stylesheet, and its value is `none`.
 */
export const FORCED_COLOURS_KEPT = [
  // A pass draws PASS_CHECK (a check glyph, Later states; it was an --ok disc) on its halo's disc.
  { stylesheet: 'styles.css', element: ['.seo-rail-dot', ".seo-rail-dot[data-status='pass']"], why: 'an SEO rail dot, pass (a check)' },
  { stylesheet: 'styles.css', element: ['.seo-rail-dot', ".seo-rail-dot[data-status='warn']"], why: 'an SEO rail dot, warning (a ring)' },
  { stylesheet: 'styles.css', element: ['.seo-rail-dot', ".seo-rail-dot[data-status='error']"], why: 'an SEO rail dot, error (a square)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-category-dot', ".seo-category[data-status='pass'] .seo-category-dot"],
    why: 'Overview\'s checks by category: a category that passed (a check)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-category-dot', ".seo-category[data-status='error'] .seo-category-dot"],
    why: 'Overview\'s checks by category: its worst finding an error (a square)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-category-dot', ".seo-category[data-status='warning'] .seo-category-dot"],
    why: 'Overview\'s checks by category: its worst finding a warning (a ring)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-category-dot', ".seo-category[data-status='info'] .seo-category-dot"],
    why: 'Overview\'s checks by category: its worst finding a notice (a hollow diamond)',
  },
  // Schema's summary mark, beside its verdict, shaped as the rail's dots.
  { stylesheet: 'styles.css', element: ['.seo-status-dot'], why: 'Schema\'s status mark: valid (a disc)' },
  { stylesheet: 'styles.css', element: ['.seo-status-dot', ".seo-status-dot[data-status='warn']"], why: 'Schema\'s status mark: warnings (a ring)' },
  { stylesheet: 'styles.css', element: ['.seo-status-dot', ".seo-status-dot[data-status='error']"], why: 'Schema\'s status mark: errors (a square)' },
  // Indexability's, Compliance's and JavaScript's signals under a verdict (Indexability, Page Speed and
  // Compliance's PR), shaped as the rail's dots, and a neutral one a dash (it was a disc in four hues).
  { stylesheet: 'styles.css', element: ['.seo-signal-dot'], why: 'a verdict\'s signal mark, neutral (a dash: "Unknown", "Not applicable")' },
  { stylesheet: 'styles.css', element: ['.seo-signal-dot', ".seo-signal[data-tone='ok'] .seo-signal-dot"], why: 'a verdict\'s signal mark, passing (a disc)' },
  { stylesheet: 'styles.css', element: ['.seo-signal-dot', ".seo-signal[data-tone='warn'] .seo-signal-dot"], why: 'a verdict\'s signal mark, a warning (a ring)' },
  { stylesheet: 'styles.css', element: ['.seo-signal-dot', ".seo-signal[data-tone='error'] .seo-signal-dot"], why: 'a verdict\'s signal mark, an error (a square)' },
  // Page Speed's live line: measuring or paused a --text-faint disc, live an --ok disc that pulses,
  // unavailable a --warn ring; the line's words say it too.
  { stylesheet: 'styles.css', element: ['.seo-speed-live-dot'], why: 'Page Speed\'s live line, measuring or paused (a --text-faint disc)' },
  { stylesheet: 'styles.css', element: ['.seo-speed-live-dot', ".seo-speed-live[data-state='live'] .seo-speed-live-dot"], why: 'Page Speed\'s live line, live (an --ok disc)' },
  { stylesheet: 'styles.css', element: ['.seo-speed-live-dot', ".seo-speed-live[data-state='unavailable'] .seo-speed-live-dot"], why: 'Page Speed\'s live line, unavailable (a --warn ring)' },
  // The navigation timing's legend: each phase's swatch is its bar's shade (SVG fills, which forced
  // colours leave as they are), so the key keeps it too.
  { stylesheet: 'styles.css', element: ['.seo-speed-swatch'], why: 'Page Speed\'s navigation timing legend: a phase\'s swatch, the shade of its bar' },
  // Later states (round 1): Help's setup checklist. Forced colours repainted the done step's --ok disc as the
  // canvas, so a step done and one not done were the same ring; the marks keep their colours there.
  { stylesheet: 'help.css', element: ['.setup-check'], why: 'Help\'s setup checklist: a step not done (a --switch-off ring)' },
  { stylesheet: 'help.css', element: ['.setup-check', ".setup-item[data-done='true'] .setup-check"], why: 'Help\'s setup checklist: a step done (an --ok disc)' },
  // UI polish round 2: the checklist's progress meter, a segment per item, filled --ok as its step's mark.
  { stylesheet: 'help.css', element: ['.setup-meter-step'], why: 'Help\'s setup checklist meter: a step not done (a --bg-active segment)' },
  { stylesheet: 'help.css', element: ['.setup-meter-step', ".setup-meter-step[data-done='true']"], why: 'Help\'s setup checklist meter: a step done (an --ok segment)' },
] as const satisfies readonly ForcedColoursBusy[];

/**
 * A passing status mark's glyph (Later states: a pass was a filled `--ok` disc, the canvas draws a check):
 * the SEO rail's pass dot (on the rail, in "More panels" and on its button) and Overview's checks by
 * category for a category that passed. `PassCheck` (`icons.tsx`) draws `d` in an inline SVG of `viewBox`,
 * and `selector` in `styles.css` sizes it to `size` and strokes it `--ok` at `strokeWidth`. It keeps that
 * colour under forced colours because it inherits `forced-color-adjust: none` from the dot it sits in
 * (`.seo-rail-dot`, `.seo-category-dot`: `FORCED_COLOURS_KEPT`); a `PassCheck` anywhere else would be
 * repainted. The ring, the square and the diamond are the other marks. At 1× the 2px stroke is two device
 * pixels wide: it stays solid (a 1px one would blur to a faint line at this size). It sits in the 8px
 * dot's box, 1px past each edge, so the rows and the rail keep their places.
 *
 * `backs`: what the check sits on, the cascade over `element` resolving `background` to `background` in
 * light and dark (and to `forced` with the forced-colours rules read): on the rail the dot's halo disc
 * (`--seo-dot-back`: the sheet, a selected item's card), in Overview nothing of its own (the card), and on
 * a hovered or focused "More panels" row a `--bg-surface` disc, where the row's tint takes the halo away
 * (`--ok` on that tint is 2.98:1 hovered and 2.84:1 focused in light; on `--bg-surface` 3.30:1). A green
 * disc under it would hide it.
 */
export const PASS_CHECK = {
  selector: '.seo-pass-check',
  viewBox: '0 0 10 10',
  d: 'M1.5 5.2l2.3 2.3L8.5 2.8',
  size: '10px',
  strokeWidth: '2px',
  backs: [
    { element: ['.seo-rail-dot', ".seo-rail-dot[data-status='pass']"], background: 'var(--seo-dot-back)', forced: 'transparent', why: 'the rail\'s pass dot: its halo disc (transparent under forced colours, as every halo)' },
    {
      element: ['.seo-category-dot', ".seo-category[data-status='pass'] .seo-category-dot"],
      background: 'transparent',
      forced: 'transparent',
      why: 'Overview\'s passing category: the card',
    },
    {
      element: ['.seo-rail-dot', ".seo-rail-dot[data-status='pass']", ".seo-more-item:is(:hover, :focus-visible) .seo-rail-dot[data-status='pass']"],
      background: 'var(--bg-surface)',
      forced: 'transparent',
      why: '"More panels", a hovered or focused row\'s pass dot: a --bg-surface disc on the tint (none under forced colours, as every halo)',
    },
  ],
} as const;

export const SIGNAL_SURFACES = [
  // `.palette`, `.palette-sheet`, `.palette-option`, … and `.palette-status` (specs/command-palette.spec.ts).
  { name: 'command palette', stylesheet: 'styles.css', selectorPrefix: '.palette' },
  // The new-tab view (specs/browser-chrome.feature.md, browser-polish.feature.md): `.start`, `.start-mark`,
  // `.start-wordmark`, `.start-search`, `.start-search-field`, `.start-search-input`, then "Jump back in": `.jump`, `.jump-title`, `.jump-tile`, `.jump-monogram`, ….
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
  // `.seo-panel-tools`, …: their own surface PRs), nor `.pane-separator`, which the agent panel shares
  // (the chrome's entry lists it, with the workspace's layout), nor `.seo-page-text`: it holds no colour or type of its own (isolation and wrapping), and the
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
      // A pass's check (PASS_CHECK), on the rail's dots and Overview's category marks
      '.seo-pass-check',
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
  // page-commands.feature.md; tabs.feature.md, The chrome row): the grid, the one chrome row (the tablist,
  // the address bar, the tools and its loading line), the permission prompt, the fullscreen notice, the page area's frame and the status bar. Its
  // classes share no prefix, so it lists them, with `.page-column` (the page area and the sheets above
  // it, layout only). Not the shared `.icon` and `.visually-hidden`, nor the new tab's view, the error
  // panels, the render profile's parts, the find bar, History and the update notice: their own entries
  // below. Some of their rules name a chrome class, so this entry checks those too:
  // `.status-render-profile + .status-zoom` and the `.page-column … > .page-area` rules of History,
  // Projects and the shot editor (layout only).
  {
    name: 'browser chrome',
    stylesheet: 'styles.css',
    classes: [
      // Layout and the page area's frame
      '.chrome',
      '.workspace-stack',
      '.workspace',
      '.page-column',
      '.page-area',
      // The panes' separators, in the gaps beside the page (specs/workspace-layout.feature.md)
      '.pane-separator',
      // The chrome row (the merged tab row and toolbar): its tablist, then the toolbar's parts
      '.chrome-row',
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
  // The SEO panels' interiors, one entry per panel, under the `.seo` prefix the frame and every panel
  // share, so each lists its classes. Overview (specs/seo-sidebar.feature.md, Sidebar: Overview): the
  // score card's interior (ring, value, eyebrow, band, summary, the not-indexable reasons), the partial
  // note, the counts by severity, the ranked issues (`Issue`, which Links, Images, Social and Page Speed
  // render too, collapsed and expanded: why, fix, facts, samples), the all-clear line, the search
  // preview, the checks by category, and the audit's render profile above it ("The audit's profile
  // (Overview)", in the render-profiles section). `.seo-eyebrow` is every panel's verdict label and the
  // ring is the AI-readiness tile's and Visibility's too: their rules move here, and look the same there.
  // Not the AI-readiness tile, the "Page" card or the AI judgment card (`.ai-*`, `.page-type-*`,
  // `.page-intent-*`), nor `.seo-panel-tools`, `.seo-toggle` and `.seo-flash` (shared controls,
  // their panels' PRs), nor `.seo-all-clear-line` (the panels' issue lists) or `.seo-preview-note`.
  {
    name: 'SEO panel: Overview',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-overview',
      // The score card's interior
      '.seo-ring-*',
      '.seo-score-text',
      '.seo-eyebrow',
      '.seo-band',
      '.seo-score-summary',
      '.seo-not-indexable',
      '.seo-partial',
      // Counts, issues, all clear
      '.seo-counts',
      '.seo-count-*',
      '.seo-issue-*',
      '.seo-chevron',
      '.seo-facts',
      '.seo-fact',
      '.seo-samples-*',
      '.seo-all-clear',
      // Search preview, checks by category
      '.seo-preview',
      '.seo-preview-url',
      '.seo-preview-title',
      '.seo-preview-description',
      '.seo-categories',
      '.seo-category-*',
      // The audit's render profile, drawn above Overview
      '.seo-audit-profile-*',
    ],
  },
  // On-Page (specs/seo-sidebar.feature.md, Sidebar: On-Page): the measured title and description with
  // their length meters (`LengthMeter`) and widths, the label and value rows (`FactRow`, which Indexability,
  // Social, JavaScript and the Search Console inspection render too), the heading counts and outline
  // with their tags (`.seo-tag`, Indexability's, Sitemaps' and Page Speed's too), and the stat tiles
  // (Links' and Images' too). Not `.seo-row-actions` (Links) or `.seo-stats-2`/`-3` of their own.
  {
    name: 'SEO panel: On-Page',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-onpage',
      '.seo-measured-*',
      '.seo-meter-*',
      '.seo-rows',
      '.seo-row',
      '.seo-row-label',
      '.seo-row-value',
      '.seo-heading-counts',
      '.seo-heading-count',
      '.seo-tag',
      '.seo-outline-*',
      '.seo-stats',
      '.seo-stats-1',
      '.seo-stat-*',
    ],
  },
  // The controls the panels share, defined beside Links, Images and Social (the first panels that draw
  // them; specs/seo-panels.feature.md): the tools row and its pill toggles (highlight, Copy as CSV),
  // the action toast, the filters (search field, segmented control, select, filter chips), the table of
  // rows (a link, an image), the small rel and loading flags, a row's actions and the all-clear line.
  // They also draw in Indexability, Page Speed, Compliance, Content, JavaScript, SERP, Visibility, Search
  // Console and Changes, whose own rules wait for their PRs. Not `.seo-flag-chip` (the link status chip
  // and its counts: a tone chip defined with Indexability's pills and signals, its PR's).
  {
    name: 'SEO panels: shared controls',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-panel-tools',
      '.seo-toggle',
      '.seo-flash',
      '.seo-filters',
      '.seo-search-*',
      '.seo-segmented',
      '.seo-segment-*',
      '.seo-select',
      '.seo-chips',
      '.seo-chip-button',
      '.seo-table-*',
      '.seo-flag',
      '.seo-row-actions',
      '.seo-action',
      '.seo-all-clear-line',
    ],
  },
  // Links (specs/seo-panels.feature.md, Links; seo-checks.feature.md, the link checks): the counts by rel,
  // a link's kind, and the link status section's notice, summary and counts (the notice and summary are
  // the sitemap checks' too, in Indexability). Its issue list, stat tiles and rows are the shared parts'.
  {
    name: 'SEO panel: Links',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: ['.seo-links', '.seo-stats-3', '.seo-rel-*', '.seo-kind', '.seo-checks-notice', '.seo-checks-summary', '.seo-checks-counts', '.seo-checks-count', '.seo-link-status'],
  },
  // Images (seo-panels.feature.md, Images): its two-column stat tiles, an image's alt badge and facts.
  {
    name: 'SEO panel: Images',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: ['.seo-images', '.seo-stats-2', '.seo-alt', '.seo-image-*'],
  },
  // Social (seo-panels.feature.md, Social): the share cards drawn from the tags, their placeholder art
  // and image facts. Its label and value rows are On-Page's.
  {
    name: 'SEO panel: Social',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: ['.seo-social', '.seo-social-field', '.seo-preview-note', '.seo-card-*', '.seo-placeholder-*'],
  },
  // Schema (specs/seo-schema.feature.md): the summary (its status mark, verdict, top-level types and
  // counts by severity), each block's status, view switch and tree (entities, properties, values,
  // references, a node's issues), the raw view with its error mark and invisible-character markers,
  // and "Show more". `.seo-raw` is also Indexability's robots.txt.
  {
    name: 'SEO panel: Schema',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-schema-*',
      '.seo-status-dot',
      '.seo-type-*',
      '.seo-block-*',
      '.seo-view-switch',
      '.seo-node-issues',
      '.seo-node-issue-*',
      '.seo-entity-*',
      '.seo-props',
      '.seo-prop-*',
      '.seo-value-*',
      '.seo-icon-action',
      '.seo-ref-*',
      '.seo-raw-*',
      '.seo-show-more',
    ],
  },
  // The rest of the browser chrome (specs/design-tokens.feature.md, The rest of the browser chrome).
  // The error and crash panels (specs/browser-chrome.feature.md, PagePanels.tsx); .panel-button is
  // every panel's secondary button too (Changes, Projects, Crawl, AI answers, SERP, …).
  { name: 'page panels: error and crash', stylesheet: 'styles.css', selectorPrefix: '.panel' },
  // The render profile (specs/render-profile.feature.md): the toolbar toggle's states, the editor bar (a
  // band), the page-area frame, the tab badge and the status bar's chips. Not "The audit's profile
  // (Overview)" (`.seo-audit-profile-*`, Overview's entry).
  {
    name: 'render profile',
    stylesheet: 'styles.css',
    classes: ['.render-*', '.tab-profile-*', '.status-render-profile-*', '.status-tab-overrides'],
  },
  // The SEO devtools drawer (specs/devtools.feature.md, components/devtools/).
  { name: 'DevTools drawer', stylesheet: 'styles.css', selectorPrefix: '.devtools' },
  // The find bar (specs/browser-polish.feature.md), a band.
  { name: 'find bar', stylesheet: 'styles.css', selectorPrefix: '.find' },
  // The History sheet (specs/browser-polish.feature.md).
  { name: 'History sheet', stylesheet: 'styles.css', selectorPrefix: '.history' },
  // The update notice (specs/update-client.feature.md, Chrome), a band.
  { name: 'update notice', stylesheet: 'styles.css', selectorPrefix: '.update' },
  // Indexability (specs/seo-indexability.feature.md, Panel; seo-checks.feature.md, the sitemap and
  // return-link checks): the verdict card with its reasons and signals, the tone pills and status chips
  // (`.seo-pill`, `.seo-flag-chip`: Compliance's, JavaScript's, Search Console's and the link checks' too),
  // the evidence cards (their titles, sub-heads and source note, the redirect chain, the kept headers,
  // the robots directives, robots.txt with its crawlers, sitemaps and pending state, the hreflang rows)
  // and the checks' samples and files. The verdict card and the signals are Compliance's and
  // JavaScript's too; JavaScript's own `.seo-js-state` rules (its verdicts' colours and tile fills) are its surface's.
  {
    name: 'SEO panel: Indexability',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-index',
      '.seo-index-*',
      '.seo-pill',
      '.seo-flag-chip',
      '.seo-verdict-*',
      '.seo-signals',
      '.seo-signal-*',
      '.seo-inline-icon',
      '.seo-chain-*',
      '.seo-headers',
      '.seo-header',
      '.seo-directives',
      '.seo-directive-*',
      '.seo-robots-*',
      '.seo-sitemaps',
      '.seo-sitemap',
      '.seo-hreflang-*',
      '.seo-checks',
      '.seo-checks-samples',
      '.seo-checks-file',
    ],
    keyframes: ['seo-robots-pulse'],
  },
  // Page Speed (specs/seo-speed.feature.md, Panel): the lab verdict and live line, the metric tiles and
  // their meters, the cards (navigation timing, requests by type, largest requests, hosts, DOM) and the
  // issue list's source badge. Its issue rows are Overview's, its tools row the shared controls'.
  { name: 'SEO panel: Page Speed', stylesheet: 'styles.css', selectorPrefix: '.seo', classes: ['.seo-speed-*'], keyframes: ['seo-speed-pulse'] },
  // Compliance (specs/seo-compliance.feature.md, Panel): the security verdict's colours (its card is
  // Indexability's), the security headers, the mixed content rows and the accessibility check (intro,
  // run button, progress, problems, the tally by impact, the groups, rules and elements).
  { name: 'SEO panel: Compliance', stylesheet: 'styles.css', selectorPrefix: '.seo', classes: ['.seo-sec-*', '.seo-mixed-*', '.seo-a11y-*'] },
  // Content (specs/seo-content.feature.md, Panel; Result preview facts): the section badges ("info
  // only"), the snippet editor (its source and variant chips' rows, the desktop and mobile result
  // previews and the rich variant cards, the width meters, the draft form's fields), the target query
  // (its clear button and checklist of places and terms), the n-grams (rows, bars, place marks and the
  // highlight button), readability and the sentences (the score, its scale and tiles, the difficult
  // sentences and their reason chips), the notes line and the danger toggle ("Delete draft", "Delete
  // all notes…"). The result preview draws a result as frost imagines one, in the panel's own tokens
  // (the Migration table's `--serp-*` rows). Not On-Page's `.seo-measured-width` (its section sits
  // here), the Search Console targets card (`gsc-targets.css`) or the AI checks' Quality row
  // (`ai-checks.css`).
  {
    name: 'SEO panel: Content',
    stylesheet: 'styles.css',
    selectorPrefix: '.seo',
    classes: [
      '.seo-content-*',
      '.seo-snippet-*',
      '.seo-serp-*',
      '.seo-width-*',
      '.seo-field-*',
      '.seo-query-*',
      '.seo-ngrams',
      '.seo-ngram-*',
      '.seo-readability-*',
      '.seo-sentences',
      '.seo-difficult-*',
      '.seo-notes-line',
      '.seo-toggle-danger',
    ],
  },
  // JavaScript (specs/seo-javascript.feature.md, Panel): the state card's verdict colour (the card
  // itself, its signals and pills are Indexability's `.seo-verdict-*`, `.seo-signal-*` and
  // `.seo-pill`), the notes, the compared fields with their served and rendered sides, and the lists
  // of what JavaScript added or removed.
  { name: 'SEO panel: JavaScript', stylesheet: 'styles.css', selectorPrefix: '.seo', classes: ['.seo-js-*'] },
  // SERP (specs/serp-panels.feature.md): every `.serp-*` rule: the search parameters, the search tools
  // (Edit search, Track this search…, "Open in"), the intent chip (Visibility's query box and
  // Overview's Page card draw it too), the composition bar and counts, the tables (Visibility's probe
  // table is one), the results, the selector pack line and the states that are not a reading.
  { name: 'SEO panel: SERP', stylesheet: 'styles.css', selectorPrefix: '.serp' },
  // Visibility (specs/serp-panels.feature.md, specs/visibility-probes.feature.md): the probe table's
  // own rules (its sticky fact column, a differing agent and cell), the disclosure, the robots.txt
  // notes and the query box. Its AI-readiness section is `ai-readiness.css`'s.
  { name: 'SEO panel: Visibility', stylesheet: 'styles.css', selectorPrefix: '.visibility' },
  // The Changes panel, Projects, Rankings, Inspector and the screenshot editor (what the components in
  // `components/changes/` render): one entry per prefix and stylesheet. The Changes panel
  // (specs/changes-panel.feature.md, changes-capture.feature.md; its screenshots, screenshot.feature.md):
  // Capture now and its project picker, the history of versions, the diff by region and the
  // screenshot controls and gallery; `.changes-shot-selecting` is the Inspector's pick hint too.
  { name: 'Changes panel', stylesheet: 'styles.css', selectorPrefix: '.changes' },
  // The Inspector (specs/inspector.feature.md): the tree, Pick element, the details, the search and the sources.
  { name: 'Inspector', stylesheet: 'styles.css', selectorPrefix: '.inspector' },
  // The screenshot editor (specs/screenshot.feature.md, Editing): a sheet over the page column.
  { name: 'screenshot editor', stylesheet: 'styles.css', selectorPrefix: '.shot-editor' },
  // The Projects sheet (specs/projects.feature.md) and a project's retention and disk usage
  // (specs/retention.feature.md); in rankings.css its views, star, tags, Settings (`.project-settings`,
  // no prefix of its own beside `.projects`), Bulk add and blocked runs.
  { name: 'Projects', stylesheet: 'styles.css', selectorPrefix: '.projects' },
  { name: 'Projects: retention', stylesheet: 'styles.css', selectorPrefix: '.retention' },
  { name: 'Projects: views, star, tags, Settings and Bulk add', stylesheet: 'rankings.css', classes: ['.projects-*', '.project-settings-*'] },
  // Rankings and Compare (specs/rankings.feature.md, The views): every other rule of rankings.css.
  { name: 'Rankings', stylesheet: 'rankings.css', selectorPrefix: '.rankings' },
  { name: 'Rankings: Compare', stylesheet: 'rankings.css', selectorPrefix: '.compare' },
  // The panel stylesheets (specs/design-tokens.feature.md, The panel stylesheets): every rule of each.
  // The Search Console panel (specs/gsc-panel.feature.md): controls, the calendar, notices, totals, the
  // chart, top queries and the pending and loading states.
  { name: 'Search Console panel', stylesheet: 'gsc-panel.css', selectorPrefix: '.gsc' },
  // Google's URL Inspection cards in Indexability and Schema (specs/gsc-inspection.feature.md, Card).
  { name: 'Search Console: URL Inspection cards', stylesheet: 'gsc-inspection.css', selectorPrefix: '.gsc-inspect' },
  // Content's Search Console targets (specs/seo-content.feature.md, Search Console targets).
  { name: "Search Console: Content's targets", stylesheet: 'gsc-targets.css', selectorPrefix: '.gsc-targets' },
  // Overview's AI judgment card and Content's Quality row (specs/ai-checks.feature.md, UI).
  { name: 'AI checks: the AI judgment card', stylesheet: 'ai-checks.css', selectorPrefix: '.ai-judgment' },
  // AI readiness (specs/ai-readiness.feature.md, AI readiness views: Visibility's, and Overview's tile) and
  // Overview's "Page" card (specs/page-type.feature.md); their classes share no prefix.
  { name: 'AI readiness and the Page card', stylesheet: 'ai-readiness.css', classes: ['.ai-*', '.page-type-*', '.page-intent-*'] },
  // The AI answers sheet in Help's frame (specs/ai-answers.feature.md, Renderer): the sheet's classes and an answer's.
  { name: 'AI answers sheet', stylesheet: 'ai-answers.css', classes: ['.ai-answers-*', '.ai-answer-*'] },
  // The site crawl sheet in Help's frame (specs/site-crawl.feature.md, Pages and Site structure).
  { name: 'site crawl sheet', stylesheet: 'crawl.css', selectorPrefix: '.crawl' },
  // A location tab's badge in the chrome row (specs/location-profiles.feature.md, location-badge-always-visible).
  { name: 'location badge', stylesheet: 'location.css', selectorPrefix: '.tab-location' },
] as const satisfies readonly SignalSurface[];

/**
 * The Projects sheet sits in the page column, so its width is not the window's: it is a named inline-size
 * container (`container`, on `sheet`), and its list stacks above the project by the sheet's own width
 * (`stack`: the rule inside `query`); every `@container` query of a Projects rule, in either stylesheet,
 * names that container, so one added inside the sheet later can't change what they measure. Bulk add's
 * fieldsets give up their min-content width (`shrink`), or the form widens the column past its scrollbar.
 * A viewport query never fired for a 327px sheet in a 776px window, which left the project a 29px column.
 */
export const PROJECTS_SHEET_NARROW = {
  stylesheet: 'styles.css',
  sheet: '.projects-sheet',
  container: 'projects / inline-size',
  query: '@container projects (max-width: 640px)',
  stack: { selector: '.projects-body', property: 'grid-template-columns', value: 'minmax(0, 1fr)' },
  stylesheets: ['styles.css', 'rankings.css'],
  shrink: { stylesheet: 'rankings.css', selector: '.projects-bulk-group', property: 'min-inline-size', value: '0' },
} as const;

/**
 * The panels' parts laid out for the SEO panel at its narrowest (`SIDEBAR_PANEL_WIDTH_RANGE.min`, 300px:
 * a card's content is about 226px there), where each was cut or scrolled sideways (Left for later, now
 * closed; `design-tokens.feature.md`, The panels at 300px). Each entry is declarations that must resolve on
 * exactly `selector` in `stylesheet`: at the top level (`query` null: at every width), or inside a named
 * container's `query`, written after every declaration of that property on that selector outside the
 * query (top level or a wider query: at the same weight the later rule wins) and on an element that
 * `container` declares. `after`: a top-level entry's declarations come after every top-level one of these
 * selectors setting the same property (same weight: `.seo-speed-bytes` moved above `.seo-speed-num` would
 * lose to its `nowrap`). `absent`: properties no top-level rule of the selector may set any more (a floor
 * or cap that cut the text). Not the `seo-panel` query
 * (`NARROW_PANEL_WRAPS`, under the panel's minimum only): these hold at 300px, so they key on the part's
 * own width, or on none.
 */
export interface NarrowPanelFit {
  readonly stylesheet: string;
  readonly selector: string;
  readonly query: string | null;
  readonly container?: { readonly selector: string; readonly value: string };
  readonly set: Readonly<Record<string, string>>;
  readonly absent?: readonly string[];
  readonly after?: readonly string[];
  readonly why: string;
}

const A11Y_RESULTS = { selector: '.seo-a11y-results', value: 'a11y-results / inline-size' } as const;
const SERP_TABLE = { selector: '.serp-table-wrap', value: 'serp-table / inline-size' } as const;
const SERP_TABLE_QUERY = '@container serp-table (width < 280px)';
const GSC = { selector: '.gsc', value: 'gsc / inline-size' } as const;
const SERP_TABLE_NARROWEST = '@container serp-table (width < 180px)';
const SPEED_CARD = { selector: '.seo-speed-card', value: 'speed-card / inline-size' } as const;
const SPEED_CARD_QUERY = '@container speed-card (width < 270px)';

export const NARROW_PANEL_FITS = [
  // Page Speed: a type's size in its 64px column.
  { stylesheet: 'styles.css', selector: '.seo-speed-bytes', query: null, set: { 'white-space': 'normal' }, after: ['.seo-speed-num'], why: 'Page Speed\'s requests by type: "size unavailable" takes two lines in the 64px column (one line ran 23px past it); a size ("123.4 kB") is narrower and stays on one' },
  // Page Speed: the timing and totals tiles.
  { stylesheet: 'styles.css', selector: '.seo-speed-milestones', query: SPEED_CARD_QUERY, container: SPEED_CARD, set: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' }, why: 'Page Speed\'s timing tiles: two columns where three can\'t hold "DOM ready" (13px short at 300px)' },
  { stylesheet: 'styles.css', selector: '.seo-speed-totals', query: SPEED_CARD_QUERY, container: SPEED_CARD, set: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' }, why: 'Page Speed\'s totals tiles: two columns where three can\'t hold "Page weight" and "Transferred" (14px and 8px short at 300px)' },
  // Compliance: the tally's tiles.
  { stylesheet: 'styles.css', selector: '.seo-a11y-tally', query: '@container a11y-results (width < 280px)', container: A11Y_RESULTS, set: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' }, why: 'Compliance\'s tally: two columns, two rows where four tiles can\'t hold "Moderate" (14px short in the 300px panel\'s 227px)' },
  // Content: the result preview's address line, crumb by crumb.
  { stylesheet: 'styles.css', selector: '.seo-serp-crumb', query: null, set: { display: 'inline-block', 'max-width': '100%' }, why: "Content's result preview: a crumb is one box, so the trail breaks between crumbs, never at a hyphen inside one (it did at 348px and 300px)" },
  // SERP: Who owns page 1.
  { stylesheet: 'styles.css', selector: '.serp-owners th:first-child', query: null, set: { 'padding-inline-start': '0' }, why: "SERP's ownership table: no inline padding at its outer edges, so at the default width the domain column holds \"brewguide.example\" (it was 0.5px short)" },
  { stylesheet: 'styles.css', selector: '.serp-owners td:last-child', query: null, set: { 'padding-inline-end': '0' }, why: "SERP's ownership table: no inline padding at its outer edges (the card has its own)" },
  { stylesheet: 'styles.css', selector: '.serp-owners .serp-domain .seo-page-text', query: null, set: { 'white-space': 'normal', 'overflow-wrap': 'break-word' }, why: "SERP's ownership table: a domain wraps (it was cut by an ellipsis) at its dots (a <wbr> after each) and hyphens, never inside a label: the page text's `anywhere` let the table's auto layout squeeze the column and break \"brewguide.exam|ple\" at the default width" },
  { stylesheet: 'styles.css', selector: '.serp-owners .serp-domain .seo-page-text', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { 'overflow-wrap': 'anywhere' }, why: "SERP's ownership table, stacked: the domain has the row, and a label wider than it breaks anywhere" },
  { stylesheet: 'styles.css', selector: '.serp-owners', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { display: 'block' }, why: "SERP's ownership table where four columns don't fit (under 280px: it scrolled 60px sideways at 300px; the default 360px's 287px keeps the four columns): its rows lay out as grids" },
  { stylesheet: 'styles.css', selector: '.serp-owners thead', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { display: 'block' }, why: "SERP's ownership table, stacked: the head is a block, so its row is the grid's width" },
  { stylesheet: 'styles.css', selector: '.serp-owners tbody', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { display: 'block' }, why: "SERP's ownership table, stacked: the body is a block, so each row is the grid's width" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { display: 'grid', 'grid-template-columns': 'repeat(3, minmax(0, 1fr))' }, why: "SERP's ownership table, stacked: a row's counts in three columns under their headers" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr > :first-child', query: SERP_TABLE_QUERY, container: SERP_TABLE, set: { 'grid-column': '1 / -1', 'max-width': 'none', 'border-bottom': '0' }, why: "SERP's ownership table, stacked: the domain (and the Domain header) across the row, above its counts, without the unstacked column's 150px cap" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr', query: SERP_TABLE_NARROWEST, container: SERP_TABLE, set: { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' }, why: "SERP's ownership table where three counts can't hold their headers (the 588px window's 111px, where \"Positions\" ran 22px past its column): Results and Share in two columns" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr > :last-child', query: SERP_TABLE_NARROWEST, container: SERP_TABLE, set: { 'grid-column': '1 / -1' }, why: "SERP's ownership table, narrowest: Positions (and its header) across the row, on a third line" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr > :nth-child(2)', query: SERP_TABLE_NARROWEST, container: SERP_TABLE, set: { 'border-bottom': '0' }, why: "SERP's ownership table, narrowest: only a row's last line draws its rule" },
  { stylesheet: 'styles.css', selector: '.serp-owners tr > :nth-child(3)', query: SERP_TABLE_NARROWEST, container: SERP_TABLE, set: { 'border-bottom': '0' }, why: "SERP's ownership table, narrowest: only a row's last line draws its rule" },
  // Search Console's controls.
  { stylesheet: 'gsc-panel.css', selector: '.gsc-range-row', query: null, set: { 'flex-wrap': 'wrap' }, why: 'Search Console\'s range row: "More ranges…" takes the next line where it doesn\'t fit beside the days (it was cut to "More range…", and the days 1–2px each)' },
  { stylesheet: 'gsc-panel.css', selector: '.gsc-filter-row', query: null, set: { display: 'grid', 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' }, why: 'Search Console\'s filters: two equal columns fixed by the stylesheet, whatever is chosen and on every OS (with the select\'s own width the row followed the choice and wrapped as it changed; the country was cut to "United…" beside "Clear filters")' },
  { stylesheet: 'gsc-panel.css', selector: '.gsc-filter-row', query: '@container gsc (width < 280px)', container: GSC, set: { 'grid-template-columns': 'minmax(0, 1fr)' }, why: 'Search Console\'s filters at 300px (256px): a line each, "United Kingdom" (125px) whole; two columns hold it from 258px, so 280px keeps 11px in hand' },
  { stylesheet: 'gsc-panel.css', selector: '.gsc-filter-row .gsc-clear', query: null, set: { 'grid-column': '1 / -1', 'justify-self': 'start' }, why: 'Search Console\'s "Clear filters": the line under the selects, so the selects keep their widths when it comes and goes' },
  { stylesheet: 'gsc-panel.css', selector: '.gsc .gsc-select', query: null, set: { 'max-width': '100%', 'text-overflow': 'ellipsis' }, absent: ['min-width'], why: "Search Console's selects: never narrower than the label they show (no `min-width: 0`), never wider than the row, a longer name ending in an ellipsis" },
  { stylesheet: 'gsc-panel.css', selector: '.gsc-filter-row .gsc-select', query: null, set: { 'min-width': '0' }, absent: ['field-sizing', 'flex'], why: 'Search Console\'s filters: a select is its column\'s width, never its longest option\'s ("South Georgia & South Sandwich Islands") or its chosen one\'s' },
  { stylesheet: 'gsc-panel.css', selector: '.gsc-range-row .gsc-select', query: null, set: { flex: '0 1 auto' }, absent: ['max-width'], why: 'Search Console\'s "More ranges…": its own width, not 45% of the row' },
  // Content's Search Console targets.
  { stylesheet: 'gsc-targets.css', selector: '.gsc-targets-row[data-target]', query: null, set: { 'flex-wrap': 'wrap' }, why: "Content's suggested queries: the clicks and \"Use as target\" go under a query that doesn't fit beside them (the query had about 40px at 300px)" },
  { stylesheet: 'gsc-targets.css', selector: '.gsc-targets-row[data-target] .gsc-targets-text', query: null, set: { 'white-space': 'normal' }, why: "Content's suggested queries: the whole query shows, on as many lines as it needs (it was cut, its tooltip out of the keyboard's reach)" },
  { stylesheet: 'gsc-targets.css', selector: '.gsc-targets-end', query: null, set: { flex: 'none', 'margin-inline-start': 'auto' }, why: "Content's suggested queries: the clicks and the button wrap together, at the row's end" },
  // The AI answers sheet (found by #55's review): a citation's button beside a long URL.
  { stylesheet: 'ai-answers.css', selector: '.ai-answer-citation .panel-button', query: null, set: { flex: 'none' }, why: 'AI answers: a citation\'s "Open in tab" keeps its one line; the URL beside it (`overflow-wrap: anywhere`) wraps instead (it asked for the whole row and squeezed the button onto two lines)' },
] as const satisfies readonly NarrowPanelFit[];

/**
 * The most literal hex colours (`#rgb`, `#rrggbb`, …, outside comments) the renderer's stylesheets
 * other than `TOKENS_STYLESHEET` may hold. A ratchet: lower it as surfaces move onto tokens, never
 * raise it. Counted when every `:root` token moved into `tokens.css`. It counts hex only: a colour
 * written as `rgb()`, `hsl()` or a keyword is for review to catch.
 */
export const HEX_COLOUR_RATCHET = 0;

/**
 * A foreground on a background that the Signal token sheet says must reach a WCAG 2.x contrast ratio
 * of `min` (4.5 for text, 3 for UI and graphics), in light and in dark. `over` is the opaque surface a
 * translucent `bg` (`--accent-soft`, a dark `-soft` fill) sits on, so the pair is composited first; a
 * translucent `fg` is composited over the (composited) `bg`. `alpha` makes `bg` a tint: the token at
 * that opacity, as `color-mix(in srgb, <bg> <alpha × 100>%, transparent)` draws it (then `over` is
 * needed). `under` is the opaque surface under a translucent `over` (both checked before compositing:
 * `under` opaque, `over` translucent, or the two layers swapped would pass unseen): a tinted badge in a hovered row
 * is `bg` over `--bg-hover` (`over`) over the card (`under`), composited in that order. `why` cites the sheet.
 */
export interface ContrastPair {
  readonly fg: TokenName;
  readonly bg: TokenName;
  readonly min: 4.5 | 3;
  readonly over?: TokenName;
  readonly under?: TokenName;
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
  // --bg-subtle). New with it: what drew --ok as text now draws --ok-ink.
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
  { fg: '--accent', bg: '--accent-soft', over: '--bg-window', min: 3, why: 'the toolbar\'s SEO sidebar toggle, pressed: its --accent icon on --accent-soft over the toolbar (--bg-window) (graphics, 3:1)' },
  // The SEO panels' Overview and On-Page (their surface PR). Already covered above: the score card's
  // value, band and summary on --bg-surface (--text, --text-muted), its ring (--ok, --warn, --danger on
  // --bg-surface), the eyebrow (--text-muted), the not-indexable reasons (--danger-ink), the partial note
  // (--text-muted on --warn-soft over the sheet), a count pill's number and word (--text, a zero
  // --text-faint, on --bg-subtle), an issue row and its meta and chevron, hovered too (--text and
  // --text-muted on --bg-hover over --bg-surface), its labels (--text-faint on a card), facts and samples
  // (--text, --text-muted and --text-faint on --bg-subtle), the all-clear line (--ok-ink, its icon --ok),
  // the preview (--accent and --text-muted on a card), the category dots (--ok, --warn, --danger,
  // --accent on a card), the render profile (--text and --text-muted on --accent-soft over the sheet),
  // a meter's verdict (--ok-ink, --warn-ink, --danger-ink on a card), a stat tile (--text, --text-muted
  // and --warn-ink on --bg-subtle) and an H1 tag (--accent on --accent-soft over a card). New with them:
  { fg: '--danger', bg: '--bg-subtle', min: 3, why: 'Overview\'s count pills: the errors pill\'s icon (--danger) on its --bg-subtle fill (graphics, 3:1)' },
  { fg: '--warn', bg: '--bg-subtle', min: 3, why: `${WARN}: Overview's warnings pill's icon on its --bg-subtle fill` },
  { fg: '--accent', bg: '--bg-subtle', min: 3, why: 'Overview\'s count pills: the notices pill\'s icon (--accent) on its --bg-subtle fill (graphics, 3:1)' },
  { fg: '--danger', bg: '--bg-hover', over: '--bg-surface', min: 3, why: 'an issue row, hovered: an error\'s icon (--danger) on --bg-hover over the card (graphics, 3:1)' },
  { fg: '--warn', bg: '--bg-hover', over: '--bg-surface', min: 3, why: `${WARN}: an issue row, hovered: a warning's icon on --bg-hover over the card` },
  { fg: '--accent', bg: '--bg-hover', over: '--bg-surface', min: 3, why: 'an issue row, hovered: a notice\'s icon (--accent) on --bg-hover over the card (graphics, 3:1)' },
  // The SEO panels' Links, Images, Social and Schema and their shared controls (their surface PR). Already
  // covered above: a toggle, a row action and a search field (--text on --bg-surface, hovered over
  // --bg-hover; --text-muted icons), a pressed toggle or chip (--accent on --accent-soft over a card), a
  // segmented control and a chip (--text-muted and --text on --bg-subtle, the chosen segment --text on
  // --bg-surface, its count --text-faint), a disabled control (--text-faint on --bg-subtle), the toast and
  // a card image's label (--on-inverse on --inverse), a row hovered or open (--text and --text-muted on
  // --bg-hover over a card), the badges (--text-muted on --bg-subtle, -ink on -soft and --accent on
  // --accent-soft over a card), the all-clear line (--ok-ink), the link status notice (--text-muted on
  // --bg-subtle), the share cards (--text, --text-muted, --text-faint on a card), Schema's status mark
  // (--ok, --warn, --danger on a card), a literal value and a URL (--accent on a card), the raw view
  // (--text on --bg-subtle), a node's warning and notice (--text and --text-muted on --warn-soft and
  // --accent-soft over a card, the notice's icon --accent on --accent-soft) and the error position
  // (--danger-ink on --danger-soft over a card). New with them:
  { fg: '--text', bg: '--danger-soft', over: '--bg-surface', min: 4.5, why: 'Schema: a node\'s error (its title) and the raw view\'s error line, on --danger-soft (a 9% --danger tint) inside a card (4.5:1)' },
  { fg: '--text-muted', bg: '--danger-soft', over: '--bg-surface', min: 4.5, why: 'Schema: a node\'s error, its detail (12px, --text-muted) on --danger-soft inside a card (4.5:1)' },
  { fg: '--danger', bg: '--danger-soft', over: '--bg-surface', min: 3, why: 'Schema: a node\'s error, its icon (--danger) on --danger-soft inside a card (graphics, 3:1)' },
  { fg: '--warn', bg: '--warn-soft', over: '--bg-surface', min: 3, why: `${WARN}: Schema: a node's warning, its icon on --warn-soft inside a card` },
  { fg: '--danger-ink', bg: '--danger-soft', over: '--bg-subtle', min: 4.5, why: `${INK}: Schema's raw view: the character where parsing failed (--danger-ink on --danger-soft, was white on --danger) on the view's --bg-subtle` },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--bg-subtle', min: 4.5, why: `${INK}: Schema's raw view: an invisible character's code point (11px, was --caution on its 14% tint) on the view's --bg-subtle` },
  { fg: '--accent', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'Schema\'s "Show more", hovered: its --accent text (12px) on --bg-hover over the card (4.5:1)' },
  { fg: '--warn-ink', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'Images: a missing width and height (--warn-ink, was --caution) in a row hovered or open (--bg-hover over the card) (4.5:1)' },
  // Council round 1 on PR #46: a tinted badge inside a row button lies over --bg-hover when the row is
  // hovered or open, so each pair is also checked composed over the hovered row. --accent on
  // --accent-soft there is 3.84:1 in dark, so the badges that drew it (a link's kind, Schema's types and
  // an entity's notice count) take --accent-hover: 6.19 light, 5.03 dark hovered; 6.80 and 5.96 at rest.
  { fg: '--accent-hover', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'an internal link\'s "int" badge, a Schema type badge and an entity\'s notice count (11px, --accent-hover on --accent-soft) in a row at rest (4.5:1)' },
  { fg: '--accent-hover', bg: '--accent-soft', over: '--bg-hover', under: '--bg-surface', min: 4.5, why: 'the same badges in a row hovered or open (--accent-soft over --bg-hover over the card) (4.5:1)' },
  { fg: '--ok-ink', bg: '--ok-soft', over: '--bg-hover', under: '--bg-surface', min: 4.5, why: `${INK}: Images' "Alt" badge, and a link's status chip ("OK"), in a row hovered or open` },
  {
    fg: '--warn-ink',
    bg: '--warn-soft',
    over: '--bg-hover',
    under: '--bg-surface',
    min: 4.5,
    why: `${INK}: Images' "Missing alt" badge and loading flags, an entity's warning count, and a link's status chip ("Redirect", "Temporary": --caution on its 13% tint there was 2.88:1 in light), in a row hovered or open`,
  },
  { fg: '--danger-ink', bg: '--danger-soft', over: '--bg-hover', under: '--bg-surface', min: 4.5, why: `${INK}: an entity's error count, and a link's status chip ("Broken"), in a row hovered or open` },
  // The SEO panels' Indexability, Page Speed and Compliance (their surface PR). Already covered above:
  // the verdict cards' text on a card (--text, --text-muted), their icon tiles (--warn, --danger and
  // --accent on their -soft fill over a card; a measurement with no band --text-faint on --bg-subtle),
  // the signal marks and the live line's dot (--ok, --warn, --danger, --text-faint on a card), the tone
  // pills, status chips, band and party badges and impact badges (-ink on -soft over a card, a link's
  // status chip over a hovered row too; neutral --text-muted on --bg-subtle; a minor impact
  // --accent-hover on --accent-soft), the source notes (--text-muted on --accent-soft over a card), the
  // warnings and problems (--text and the --warn icon on --warn-soft over a card), the lab note, timing
  // tiles and element samples (--text, --text-muted and --text-faint on --bg-subtle), a hreflang code
  // that is not valid (--danger-ink on --danger-soft over a card), a rule row hovered (--text and
  // --text-muted on --bg-hover over a card, its count --text-muted on --bg-subtle), Resume (--accent on
  // a card) and the tally's numbers for serious and moderate (--warn-ink on --bg-subtle), a zero
  // --text-faint. New with them:
  { fg: '--ok', bg: '--ok-soft', over: '--bg-surface', min: 3, why: 'an Indexability, Compliance or Page Speed verdict that passes: its icon (--ok) on its --ok-soft tile inside the card (graphics, 3:1)' },
  { fg: '--accent-hover', bg: '--bg-subtle', min: 4.5, why: 'Compliance\'s accessibility tally: the number of minor rules (18px, --accent-hover, was --info-tone) on its --bg-subtle tile (4.5:1)' },
  { fg: '--accent', bg: '--track', min: 3, why: 'Page Speed\'s requests by type and the accessibility check\'s progress: the --accent bar on its --track (graphics, 3:1)' },
  // Council round 2 on PR #48: the navigation timing's palest step, 55% of --accent in --track (a mix
  // composites as --accent at 0.55 over --track), against --bg-surface: the legend's palest swatch on the
  // card, and the boundary stroke beside the palest segment. 3.20:1 light, 3.40:1 dark; at 40% it would be
  // 2.56:1 in light, so the ramp starts at 55%.
  {
    fg: '--bg-surface',
    bg: '--accent',
    alpha: 0.55,
    over: '--track',
    min: 3,
    why: 'Page Speed\'s navigation timing: the palest step (redirect, 55% of --accent in --track) on the card as a legend swatch, and against the --bg-surface boundary beside it (graphics, 3:1)',
  },
  { fg: '--text', bg: '--track', min: 3, why: 'Page Speed\'s metric meters: the value\'s marker (--text) across the bar, its no-band --track included (graphics, 3:1)' },
  // The SEO panels' Content, JavaScript, SERP and Visibility (their surface PR). Already covered above:
  // the result preview on a card (--text, --accent title, --text-muted address and description,
  // --text-faint placeholder; its monogram, rich badge and video frame --text-muted on --bg-subtle; the
  // stars --warn), the width meters on a card (--text-muted labels, --ok-ink, --warn-ink and --text-faint
  // verdicts; --ok, --warn fills), the fields (--text on --bg-surface, the placeholder --text-faint), the
  // target query's clear button (--text-muted, hovered --text on --bg-hover over a card), its place
  // marks (--ok, --accent, --text-faint on a card) and terms (--text-muted, a present one --ok-ink on
  // --ok-soft), the n-gram highlight (--text-muted, hovered --text on --bg-hover, pressed --accent on
  // --accent-soft with an --accent edge) and place marks (--accent on --accent-soft), the readability
  // tiles and difficult sentences (--text, --text-muted, --text-faint on --bg-subtle; a reason chip
  // --text-muted on --bg-surface), JavaScript's notes (--text-muted, a warning --warn-ink) and sides
  // (--text, --text-muted), the SERP card and tables (--text, --text-muted, --text-faint on a card), the
  // intent chip (--accent on --accent-soft over the sheet or a card), the state icon (--accent on
  // --accent-soft, a problem --warn on --warn-soft, over a card) and Visibility's differing cells
  // (--warn-ink on --warn-soft over a card, --warn edge) and agents (--warn-ink, --warn underline). New with them:
  { fg: '--danger-ink', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'Content\'s "Delete draft" and "Delete all notes…", hovered: --danger-ink (was --danger) on the toggle\'s --bg-hover over the card (4.5:1)' },
  // The browser chrome's rows (its surface PR). Already covered above: the active tab's label and the
  // address on --bg-surface (--text; the placeholder, the address badge and the active tab's glyph
  // --text-faint and --text-muted), the toolbar's tools, the new-tab button and the status bar on
  // --bg-window (--text-muted; a disabled tool, the connection and its label --text-faint), the pressed
  // SEO sidebar toggle (--accent on --accent-soft over --bg-window), the permission prompt's buttons
  // (--text on --bg-surface, hovered over --bg-hover, disabled --text-faint), its icon (--accent on
  // --accent-soft over --bg-window), the address's secure and insecure badges (--ok, --warn on
  // --bg-surface), the loading line and the focus ring (--accent on --bg-window), the status notice
  // (--warn-ink on --bg-window) and the fullscreen notice (--on-inverse on --inverse). New with it:
  { fg: '--text-muted', bg: '--bg-tab-idle', over: '--bg-window', min: 4.5, why: 'an inactive tab: its label and glyph (--text-muted) on --bg-tab-idle over the tab row (4.5:1)' },
  { fg: '--text', bg: '--bg-hover', over: '--bg-window', min: 4.5, why: 'a hovered inactive tab: its label (--text) on --bg-hover over the tab row (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-window', min: 4.5, why: 'a hovered toolbar tool or new-tab button, and a hovered tab\'s glyph and close button: --text-muted on --bg-hover over --bg-window (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-active', over: '--bg-window', min: 4.5, why: 'a pressed toolbar tool or new-tab button: its --text-muted icon on --bg-active over --bg-window (4.5:1)' },
  { fg: '--warn', bg: '--bg-tab-idle', over: '--bg-window', min: 3, why: `${WARN}: an inactive tab's alert glyph (a crashed or failed page) on --bg-tab-idle` },
  { fg: '--accent', bg: '--bg-tab-idle', over: '--bg-window', min: 3, why: 'an inactive tab\'s FrostMark, spinner and permission ring (--accent) on --bg-tab-idle (graphics, 3:1)' },
  { fg: '--accent', bg: '--bg-hover', over: '--bg-window', min: 3, why: 'a hovered inactive tab\'s FrostMark, spinner and permission ring (--accent) on --bg-hover (graphics, 3:1)' },
  { fg: '--warn', bg: '--bg-hover', over: '--bg-window', min: 3, why: `${WARN}: a hovered inactive tab's alert glyph on --bg-hover` },
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
    over: '--bg-window',
    min: 4.5,
    why: `${INK}: the status bar's failed-overrides chip (11.5px), --danger-soft over --bg-window`,
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
  { fg: '--warn-ink', bg: '--bg-window', min: 4.5, why: 'the status bar\'s notice (.status-notice) on --bg-window (4.5:1)' },
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-surface', min: 4.5, why: 'text on its tone\'s 14% tint (no rule draws it since the SEO pills and status chips, .agent-chip and Changes\' inserted segment moved to -ink on -soft) (4.5:1)' },
  { fg: '--ok-ink', bg: '--ok', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: 'text on its tone\'s 14% tint (no rule draws it since the SEO pills and status chips, .agent-chip and Changes\' inserted segment moved to -ink on -soft) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-surface', min: 4.5, why: 'text on its tone\'s 14% tint (Changes\' deleted segment; the SEO pills and status chips, and .agent-chip, moved to -ink on -soft) (4.5:1)' },
  { fg: '--danger-ink', bg: '--danger', alpha: 0.14, over: '--bg-sheet', min: 4.5, why: 'text on its tone\'s 14% tint (Changes\' deleted segment; the SEO pills and status chips, and .agent-chip, moved to -ink on -soft) (4.5:1)' },
  // The rest of the browser chrome (its surface PR). Already covered above: text and icons on the
  // bands (--text, --text-muted, --accent on --accent-soft over --bg-window), the band buttons and the
  // .panel-button (--text on --bg-surface, hovered over --bg-hover; the primary --on-accent on --accent and
  // --accent-hover; disabled --text-faint on --bg-subtle), the drawer's text on --bg-sheet (--text,
  // --text-muted, --text-faint, --accent links, a selected row's --text on --accent-soft), History's on
  // --bg-surface, the status chips' failed state (--danger-ink on --danger-soft over --bg-window). New with it:
  { fg: '--danger-ink', bg: '--accent-soft', over: '--bg-window', min: 4.5, why: `the find bar's "no matches" count and the editor bar's errors (12px, were --danger) on a band (the canvas's band slot: --accent-soft over --bg-window) (4.5:1)` },
  { fg: '--text', bg: '--danger-soft', over: '--bg-window', min: 4.5, why: 'a failed update: the notice\'s headline on its --danger-soft band (4.5:1)' },
  { fg: '--text-muted', bg: '--danger-soft', over: '--bg-window', min: 4.5, why: 'a failed update: the notice\'s text on its --danger-soft band (4.5:1)' },
  { fg: '--danger', bg: '--danger-soft', over: '--bg-window', min: 3, why: 'a failed update: the notice\'s alert icon (--danger) on its band (graphics, 3:1)' },
  { fg: '--warn-ink', bg: '--warn-soft', over: '--bg-window', min: 4.5, why: `${INK}: the editor bar's notes (11.5px, were --text-muted on a 10% --caution tint) inside the band` },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-window', min: 4.5, why: 'the status bar\'s render-profile chip (--render-accent on --render-soft → --accent on --accent-soft, 12px) (4.5:1)' },
  { fg: '--on-accent', bg: '--danger', min: 4.5, why: 'the page-area frame\'s "Profile failed" tag (--danger, its text the header\'s --on-accent) (4.5:1)' },
  // Contrast is symmetric: --on-accent at 62% over the --accent header is the edge of the frame's tags and buttons.
  { fg: '--accent', bg: '--on-accent', alpha: 0.62, over: '--accent', min: 3, why: 'the page-area frame\'s tag and button edges (--on-accent at 62% on the --accent header: at 45% it was 2.48:1 in light, 2.38 in dark) (UI, 3:1)' },
  { fg: '--accent', bg: '--on-accent', min: 4.5, why: 'the page-area frame\'s Reload to apply (a white button with --render-accent text → --on-accent with --accent) (4.5:1)' },
  {
    fg: '--accent',
    bg: '--bg-hover',
    over: '--on-accent',
    min: 4.5,
    why: 'the page-area frame\'s Reload to apply, hovered (--bg-hover laid over its --on-accent fill) (4.5:1)',
  },
  { fg: '--text-faint', bg: '--text-faint', alpha: 0.1, over: '--bg-surface', min: 3, why: 'an error panel\'s art (--panel-art → --text-faint) on its badge, its tone at 10% over the page (graphics, 3:1)' },
  { fg: '--danger', bg: '--danger', alpha: 0.1, over: '--bg-surface', min: 3, why: 'a certificate error\'s art (--danger) on its badge (graphics, 3:1)' },
  { fg: '--warn', bg: '--warn', alpha: 0.1, over: '--bg-surface', min: 3, why: `${WARN}: a crashed page's art on its badge` },
  { fg: '--warn-ink', bg: '--bg-sheet', min: 4.5, why: 'the DevTools drawer\'s notices (12px, were --caution) on the drawer (4.5:1)' },
  { fg: '--ok-ink', bg: '--bg-subtle', min: 4.5, why: 'the DevTools drawer\'s 2xx status code (11px, was --ok) on its --bg-subtle pill (4.5:1)' },
  { fg: '--warn-ink', bg: '--bg-subtle', min: 4.5, why: 'the DevTools drawer\'s 3xx status code (11px, was --caution) on its --bg-subtle pill (4.5:1)' },
  { fg: '--danger-ink', bg: '--bg-subtle', min: 4.5, why: 'the DevTools drawer\'s 4xx and 5xx status codes (11px, were --danger) on their --bg-subtle pill, and Compliance\'s accessibility tally: the number of critical rules (18px, was --danger) on its --bg-subtle tile (4.5:1)' },
  { fg: '--danger-ink', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools drawer: a failed request\'s row, selected (--accent-soft) (4.5:1)' },
  { fg: '--danger-ink', bg: '--bg-hover', over: '--bg-sheet', min: 4.5, why: 'the DevTools drawer: a failed request\'s row, hovered (4.5:1)' },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-sheet', min: 3, why: 'the DevTools drawer: the resize edge under the pointer, focused --accent beside its --accent-soft (graphics, 3:1)' },
  { fg: '--text', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools console: a warning\'s message on its row (--warn-soft, was a literal 8% tint) (4.5:1)' },
  { fg: '--text', bg: '--danger-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools console: an error\'s message on its row (--danger-soft, was a literal 8% tint) (4.5:1)' },
  { fg: '--text-muted', bg: '--warn-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools console: a warning\'s source (12px, --text-muted) on its row (4.5:1)' },
  { fg: '--text-muted', bg: '--danger-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools console: an error\'s source (12px; --text-faint is 4.45:1 on --danger-soft in light) on its row (4.5:1)' },
  { fg: '--danger-ink', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'History\'s Clear button and the drawer\'s Clear site data (--danger-ink on --bg-surface), hovered (4.5:1)' },
  { fg: '--accent-hover', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'a History row\'s monogram and change count (11px, --accent-hover on --accent-soft) (4.5:1)' },
  {
    fg: '--accent-hover',
    bg: '--accent-soft',
    over: '--bg-hover',
    under: '--bg-surface',
    min: 4.5,
    why: 'a History row\'s monogram and change count on a hovered row (--accent-soft over --bg-hover over the sheet; --accent is 3.84:1 there in dark) (4.5:1)',
  },
  { fg: '--ok-ink', bg: '--bg-hover', over: '--bg-sheet', min: 4.5, why: 'the DevTools drawer: a request robots.txt allows, in a hovered row (4.5:1)' },
  { fg: '--ok-ink', bg: '--accent-soft', over: '--bg-sheet', min: 4.5, why: 'the DevTools drawer: a request robots.txt allows, in the selected row (4.5:1)' },
  { fg: '--text-muted', bg: '--bg-hover', over: '--bg-surface', min: 4.5, why: 'a History row, hovered: its time and host (12px, --text-muted: --text-faint is 4.2:1 on --bg-hover in dark), and a hovered .panel-button\'s icon (4.5:1)' },
  // The Changes panel, Projects, Rankings, Inspector and the screenshot editor (their surface PR). Already
  // covered above: their text on the panel's cards and the sheets (--text, --text-muted, --text-faint on
  // --bg-surface and --bg-sheet), status words (--ok-ink, --warn-ink, --danger-ink on a card or the sheet),
  // a change's kind and the diff's edits (-ink on -soft over a card), a version row hovered or chosen (--text
  // and --text-muted on --bg-hover or --accent-soft over a card, its --accent edge), the Inspector's tree (its
  // --accent tag on a hovered or selected row), the notices and the pick hint (--text on --accent-soft over a
  // card or the sheet), a disabled sheet button (--text-faint on --bg-subtle) and a swatch's outline
  // (--switch-off on --bg-surface). New with them:
  { fg: '--ok-ink', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'Rankings: a search that rose or is new ("+3", "New"; 12px, was --ok) in the selected row, and a domain that rose in Compare\'s row for your site (4.5:1)' },
  { fg: '--danger-ink', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'Rankings: a search that fell or was lost (12px, was --danger) in the selected row, and in Compare\'s row for your site (4.5:1)' },
  { fg: '--warn-ink', bg: '--accent-soft', over: '--bg-surface', min: 4.5, why: 'Rankings: the capped mark ("*", was --warn) in the selected row (4.5:1)' },
  {
    fg: '--text',
    bg: '--accent-soft',
    over: '--bg-hover',
    under: '--bg-surface',
    min: 4.5,
    why: 'Projects: a project\'s "Due" badge (11px, --text on --accent-soft) in a hovered row (--bg-hover over the sheet) (4.5:1)',
  },
  // The chosen project's name lays no hover over its row (--text-muted, Unfiled's, would be 4.30:1 there in dark).
  {
    fg: '--text-muted',
    bg: '--bg-hover',
    over: '--accent-soft',
    under: '--bg-surface',
    min: 3,
    why: 'Projects: the chosen project\'s star and Rename and Add here icons (--text-muted), hovered (--bg-hover over its --accent-soft row) (graphics, 3:1)',
  },
  {
    fg: '--accent',
    bg: '--bg-hover',
    over: '--accent-soft',
    under: '--bg-surface',
    min: 3,
    why: 'Projects: the chosen project\'s star, a favourite (--accent, filled), hovered (graphics, 3:1)',
  },
  {
    fg: '--text',
    bg: '--accent-soft',
    over: '--accent-soft',
    under: '--bg-surface',
    min: 4.5,
    why: 'Compare: the "Your site" badge (11px, --accent-soft) on the row for your site (--accent-soft too) (4.5:1)',
  },
  // The panel stylesheets (their surface PR). Already covered above: Search Console's text on the sheet
  // and its cards (--text, --text-muted, --text-faint), a tile hovered (--text and --text-muted on
  // --bg-hover over a card), the chosen tile's and filters' --accent edge and text (on --bg-surface and
  // the sheet), the custom dates in force (--accent on --accent-soft over the sheet), the calendar's
  // range (--accent on --accent-soft over its card) and its ends (--on-accent on --accent), the chart's
  // line and dots (--accent on a card, at 4.5:1 where 3:1 is needed), the notices' art (--accent on
  // --accent-soft, --warn-ink on --warn-soft, over a card); status text on a card (--ok-ink, --warn-ink,
  // --danger-ink: the inspection's groups, AI readiness's verdicts, the Page card's unsure confidence and
  // a disagreeing signal, whose wavy underline is --warn); the Crawl and AI answers sheets' text on the
  // page card, their fields, a chosen run or answer (--text and --text-muted on --accent-soft over
  // --bg-surface, its --accent edge), a row hovered, a destructive button (--danger-ink on --bg-surface,
  // hovered over --bg-hover) and a segment (--text-muted on --bg-subtle, chosen --text on --bg-surface).
  // New with them: a location tab's badge, which lies on every tab state.
  {
    fg: '--accent-hover',
    bg: '--accent-soft',
    over: '--bg-tab-idle',
    under: '--bg-window',
    min: 4.5,
    why: 'a location tab\'s badge (11px, --accent-hover on --accent-soft) on an inactive tab (--bg-tab-idle over the tab row) (4.5:1)',
  },
  {
    fg: '--accent-hover',
    bg: '--accent-soft',
    over: '--bg-hover',
    under: '--bg-window',
    min: 4.5,
    why: 'a location tab\'s badge on a hovered inactive tab (--bg-hover over the tab row): --accent there is 4.18:1 in light (4.5:1)',
  },
  // Later states. The length and width meters' fill is outlined by a 1px --bg-surface boundary (as Page
  // Speed's timing segments), so it meets the card's colour, not the --track: "fits" (--ok) is 2.23:1 on
  // --track in light. Every verdict's fill against that boundary (a missing or empty one draws no fill).
  { fg: '--bg-surface', bg: '--ok', min: 3, why: 'the meters\' "fits" fill (--ok) against its --bg-surface boundary (graphics, 3:1; 2.23:1 against --track in light)' },
  { fg: '--bg-surface', bg: '--warn', min: 3, why: 'the meters\' "too short", "too long" and "cut" fill (--warn) against its --bg-surface boundary (graphics, 3:1)' },
  { fg: '--bg-surface', bg: '--danger', min: 3, why: 'the length meter\'s "missing" fill (--danger, drawn at no width) against its --bg-surface boundary (graphics, 3:1)' },
  { fg: '--bg-surface', bg: '--text-faint', min: 3, why: 'the width meter\'s empty fill (--text-faint, drawn at no width) against its --bg-surface boundary (graphics, 3:1)' },
  // Later states (round 1): the pass check on a "More panels" row under the pointer or keyboard focus sits on a
  // --bg-surface disc (PASS_CHECK.backs): on the row's tint --ok was 2.98:1 hovered, 2.84:1 focused in light.
  { fg: '--ok', bg: '--bg-surface', min: 3, why: 'the pass check on a hovered "More panels" row, on its --bg-surface disc (graphics, 3:1; 2.98:1 on --bg-hover over the menu in light)' },
  { fg: '--ok', bg: '--bg-surface', min: 3, why: 'the pass check on a focused "More panels" row, on its --bg-surface disc (graphics, 3:1; 2.84:1 on --accent-soft over the menu in light)' },
  // Later states: the tab's render-profile badge (--accent-soft, edged --accent when the tab needs a reload,
  // dashed, or its profile failed, solid) on each tab state; the edge against the fill inside it and the
  // tab outside it. Already covered: on the active tab (--accent on --bg-surface, and on --accent-soft over it).
  { fg: '--accent', bg: '--bg-tab-idle', over: '--bg-window', min: 3, why: 'the tab badge\'s edge against an inactive tab (--bg-tab-idle over the tab row) (graphics, 3:1)' },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-tab-idle', under: '--bg-window', min: 3, why: 'the tab badge\'s edge against its own fill on an inactive tab (graphics, 3:1)' },
  { fg: '--accent', bg: '--bg-hover', over: '--bg-window', min: 3, why: 'the tab badge\'s edge against a hovered inactive tab (--bg-hover over the tab row) (graphics, 3:1)' },
  { fg: '--accent', bg: '--accent-soft', over: '--bg-hover', under: '--bg-window', min: 3, why: 'the tab badge\'s edge against its own fill on a hovered inactive tab (graphics, 3:1)' },
] as const satisfies readonly ContrastPair[];

/**
 * Status colours that are graphics only: under 4.5:1 as text on a card in at least one theme, so no rule
 * of a renderer stylesheet draws text in them. A rule draws text in one when its `color` or
 * `-webkit-text-fill-color` reads it anywhere in the value (`var(`, optional space, the name on a name
 * boundary: `!important`, `color-mix()` and the like count), or reads a custom property the same
 * stylesheet sets, anywhere, to a value that reads it (one level: `--verdict: var(--ok)` then
 * `color: var(--verdict)`); at any nesting (`@media`, `@supports`, native nesting). Text in their tone
 * takes its `-ink` (`--ok-ink`), and an icon draws the tone by `stroke` or `fill` on the icon itself.
 * `--ok` is 3.30:1 on a card in light (3.16 on the sheet): a graphics colour (3:1). The values step
 * recorded 21 rules drawing it as text (`KNOWN_CONTRAST_EXCEPTIONS`, a list of exceptions with their rule
 * counts); the surface PRs moved them to `--ok-ink`, and the cleanup PR the last, the address bar's secure
 * badge, an icon now drawn by `stroke`, so the list went and this rule took its place. Its first round of
 * review widened the match (it had read only an exact `color: var(--ok)`), which found two more rules
 * colouring an icon tile's icon through `color`: Indexability's, Compliance's and JavaScript's verdict icon
 * (`.seo-verdict-icon`, through `--verdict`) and Page Speed's (`.seo-speed-verdict-icon`, through
 * `--band`). They draw their icon's `stroke` now (the icons' only `currentColor`), the same pixels.
 *
 * Under forced colours a mark coloured by `stroke` keeps its token (Chromium leaves SVG strokes as they
 * are), where one coloured by `color` took `CanvasText`: the lock and the verdict icons keep `--ok` (and
 * the verdicts' `--warn`, `--danger`, `--accent`) on the forced `Canvas`. They stay above 3:1 there only
 * because Chromium makes `prefers-color-scheme` follow the contrast theme, so a light `Canvas` gets the
 * light `--ok` (about 3.2–3.3:1 on it) and a black one the dark `--ok` (about 12:1). Nothing verifies
 * this on Windows, where forced colours live.
 */
export const GRAPHICS_ONLY_COLOURS = ['--ok'] as const satisfies readonly TokenName[];

/**
 * A rule whose text colour the values step pins to a token, because the Signal value of the token it
 * used left its text under 4.5:1 (found in review). `element` lists the selectors, in `stylesheet`
 * (relative to the renderer), that such an element matches; resolving the cascade over them
 * (specificity, then source order; light, or light then the dark media block; component custom
 * properties followed through `var()`) gives `color: var(<color>)`. Its pair is in `CONTRAST_PAIRS`.
 */
export interface TextColourRule extends LoadsBefore {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly color: TokenName;
  /** The fill the text sits on, when the rule pins that too (resolved the same way). */
  readonly background?: TokenName;
  /** A disabled button shown by its colours: the cascade also gives no `opacity` under 1 (a fade would replace them). */
  readonly unfaded?: true;
  /** Further declarations the colour only works with (an SVG stroke in `currentColor`): each property resolves to exactly its value. */
  readonly drawn?: Readonly<Record<string, string>>;
  readonly why: string;
}

/** The update notice's buttons under the pointer (TEXT_COLOUR_RULES and FOCUS_RING_RULES). */
const UPDATE_BUTTON_HOVER = '.update-button:hover:where(:not(:disabled))';
const UPDATE_PRIMARY_HOVER = '.update-primary:hover:where(:not(:disabled))';
const OK_TINT = '--ok as text on its own 14% tint is 2.82:1 in light (11px chips)';
/** A shared control's hover in `styles.css` (TEXT_COLOUR_RULES, FOCUS_RING_RULES and DISABLED_CONTROLS of the panel stylesheets). */
const CHIP_HOVER = ".seo-chip-button:hover:where(:not(:disabled, [aria-pressed='true']))";
const PANEL_HOVER = '.panel-button:hover:where(:not(:disabled))';
const DANGER_TINT = '--danger as text on its own 14% tint is 3.88:1 in light (11px chips)';

export const TEXT_COLOUR_RULES = [
  {
    stylesheet: 'styles.css',
    element: ['.status-notice'],
    color: '--warn-ink',
    why: '--warn on --bg-window is 4.26:1 in light; the notice is 11.5px text',
  },
  // The update notice's Download and Show file: the canvas's primary band button (--on-accent on --accent,
  // --accent-hover hovered), where they were outlined --accent text whose hover (--bg-field-hover, removed)
  // left --accent at 4.23:1 in dark (then pinned to --accent-hover).
  {
    stylesheet: 'styles.css',
    element: ['.update-button', '.update-primary'],
    color: '--on-accent',
    background: '--accent',
    why: 'the update notice\'s primary button: --on-accent on --accent',
  },
  {
    stylesheet: 'styles.css',
    element: ['.update-button', UPDATE_BUTTON_HOVER, '.update-primary', UPDATE_PRIMARY_HOVER],
    color: '--on-accent',
    background: '--accent-hover',
    why: 'the update notice\'s primary button, hovered: --on-accent on --accent-hover (the secondary hover\'s overlay must not win)',
  },
  // 11px chips on their tone's tint: --ok text is 2.82:1 on its 14% tint and --danger 3.88:1 (light).
  // Indexability's PR put the pills and status chips on the sheet's -soft fills (badges), so the pair
  // is -ink on -soft, and the warn tone takes its -ink too (it drew --caution on its tint). The signal
  // marks keep the tone; .seo-signal draws no tone text, so it has no entry.
  { stylesheet: 'styles.css', element: ['.seo-pill', ".seo-pill[data-tone='ok']"], color: '--ok-ink', background: '--ok-soft', why: OK_TINT },
  {
    stylesheet: 'styles.css',
    element: ['.seo-pill', ".seo-pill[data-tone='warn']"],
    color: '--warn-ink',
    background: '--warn-soft',
    why: 'a warning pill ("Does not list itself", a redirect hop, a weak header; 11px, was --caution on its 14% tint)',
  },
  { stylesheet: 'styles.css', element: ['.seo-pill', ".seo-pill[data-tone='error']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  { stylesheet: 'styles.css', element: ['.seo-flag-chip', ".seo-flag-chip[data-tone='ok']"], color: '--ok-ink', background: '--ok-soft', why: OK_TINT },
  {
    stylesheet: 'styles.css',
    element: ['.seo-flag-chip', ".seo-flag-chip[data-tone='warn']"],
    color: '--warn-ink',
    background: '--warn-soft',
    why: 'a warning status chip (a link that redirects, an hreflang flag, passive mixed content; 11px): --caution on its 13% tint was 2.88:1 in light on a hovered link row',
  },
  { stylesheet: 'styles.css', element: ['.seo-flag-chip', ".seo-flag-chip[data-tone='error']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  // A link's status chip carries both classes, in a row button that can be hovered or open.
  {
    stylesheet: 'styles.css',
    element: ['.seo-flag-chip', '.seo-link-status', ".seo-flag-chip[data-tone='warn']"],
    color: '--warn-ink',
    background: '--warn-soft',
    why: 'Links: a link that redirects or answers "try later", its status chip in a row hovered or open (CONTRAST_PAIRS composes it over --bg-hover)',
  },
  // The agent panel's surface PR put its chips on the sheet's -soft fills, so the pair is -ink on -soft.
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='ok']"], color: '--ok-ink', background: '--ok-soft', why: OK_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='denied']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  { stylesheet: 'components/agent/agent.css', element: ['.agent-chip', ".agent-chip[data-tone='failed']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  // More danger text on its 14% tint (3.7–3.9:1 on a card, light). The status bar's chip was 3.33:1
  // over --bg-window, and still 4.46:1 with the ink on the tint: it takes --danger-soft as its fill.
  {
    stylesheet: 'styles.css',
    element: [".status-tab-overrides[data-status='failed']"],
    color: '--danger-ink',
    background: '--danger-soft',
    why: 'the status bar\'s failed-overrides chip: --danger on its 14% tint over --bg-window is 3.33:1 (light); -ink on -soft is 5.30',
  },
  { stylesheet: 'styles.css', element: ['.seo-badge', ".seo-badge[data-severity='error']"], color: '--danger-ink', why: DANGER_TINT },
  // Schema's PR put the block status on the sheet's -soft fills (a badge), so the pair is -ink on -soft.
  { stylesheet: 'styles.css', element: ['.seo-block-status', ".seo-block-status[data-status='invalid']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  // An hreflang code is a tag too (`seo-tag seo-hreflang-code`); an invalid one is a --danger-soft badge.
  {
    stylesheet: 'styles.css',
    element: ['.seo-tag', '.seo-hreflang-code', ".seo-hreflang-row[data-valid='false'] .seo-hreflang-code"],
    color: '--danger-ink',
    background: '--danger-soft',
    why: DANGER_TINT,
  },
  // The Changes panel's surface PR put the diff's edits on the -soft fills, so the pair is -ink on -soft (the
  // removed words' entry gained its fill on purpose: it was --danger-ink on a 14% --danger tint).
  { stylesheet: 'styles.css', element: ['.changes-segment', ".changes-segment[data-op='del']"], color: '--danger-ink', background: '--danger-soft', why: DANGER_TINT },
  // Overview and On-Page (their surface PR): status text on a card takes its -ink; the --ok, --warn and
  // --danger graphics (the meter's fill, the all-clear icon) keep the tone.
  { stylesheet: 'styles.css', element: ['.seo-all-clear'], color: '--ok-ink', why: 'Overview\'s "Every on-page check passed." (13px, was --ok: 3.30:1 on a card in light)' },
  { stylesheet: 'styles.css', element: ['.seo-meter-verdict'], color: '--ok-ink', why: 'On-Page\'s "Good length" (12px, was the meter\'s --ok: 3.30:1 on a card in light)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-meter-verdict', ".seo-meter[data-indicator='long'] .seo-meter-verdict"],
    color: '--warn-ink',
    why: 'On-Page\'s "Too long" (12px, was the meter\'s --caution): status text takes its -ink',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-meter-verdict', ".seo-meter[data-indicator='short'] .seo-meter-verdict"],
    color: '--warn-ink',
    why: 'On-Page\'s "Too short" (12px, was the meter\'s --caution): status text takes its -ink',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-meter-verdict', ".seo-meter[data-indicator='missing'] .seo-meter-verdict"],
    color: '--danger-ink',
    why: 'On-Page\'s "Missing" (12px, was the meter\'s --danger, 4.83:1 on a card in light): status text takes its -ink',
  },
  // The reasons are a summary line too (`.seo-score-summary.seo-not-indexable`): the summary's own colour must not win.
  { stylesheet: 'styles.css', element: ['.seo-score-summary', '.seo-not-indexable'], color: '--danger-ink', why: 'Overview\'s not-indexable reasons (12px, was --danger): status text takes its -ink' },
  // Links, Images, Social and Schema (their surface PR): status text takes its -ink, on its -soft fill
  // where it is a badge; a missing value in a row takes --text-muted, since --text-faint on a hovered
  // or open row (--bg-hover over a card) is 4.26:1 in dark.
  {
    stylesheet: 'styles.css',
    element: ['.seo-empty-line', '.seo-all-clear-line'],
    color: '--ok-ink',
    why: 'every panel\'s "No … issues found." (12px, was --ok: 3.30:1 on a card in light; Links, Images, Social, Page Speed, Compliance, JavaScript)',
  },
  { stylesheet: 'styles.css', element: ['.seo-block-status'], color: '--ok-ink', background: '--ok-soft', why: `Schema: a block that parsed, "Valid" (11px, was --ok on its 14% tint): ${OK_TINT}` },
  { stylesheet: 'styles.css', element: ['.seo-block-status', ".seo-block-status[data-status='cut']"], color: '--warn-ink', background: '--warn-soft', why: 'Schema: a block cut short, "Cut" (11px, was --caution on its 16% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-alt', ".seo-alt[data-alt='present']"], color: '--ok-ink', background: '--ok-soft', why: `Images: an alt text that is present, "alt" (11px, was --ok on its 14% tint): ${OK_TINT}` },
  { stylesheet: 'styles.css', element: ['.seo-alt', ".seo-alt[data-alt='missing']"], color: '--warn-ink', background: '--warn-soft', why: 'Images: no alt attribute, "no alt" (11px, was --caution on its 16% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-flag', ".seo-flag[data-flag='warn']"], color: '--warn-ink', background: '--warn-soft', why: 'Images: a loading problem ("oversized", "lazy, first screen"; 11px, was --caution on its 16% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-image-fact', ".seo-image-fact[data-missing='true']"], color: '--warn-ink', why: 'Images: an image with no width and height, its "Attrs" fact (12px, was --caution: 3.65:1 on a card in light)' },
  { stylesheet: 'styles.css', element: ['.seo-raw-error-at'], color: '--danger-ink', why: 'Schema: where a block stopped parsing, "Line 3, column 31" (12px, was --danger) on --danger-soft' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-missing', '.seo-table-title', '.seo-table-title.seo-missing'],
    color: '--text-muted',
    why: 'Links: "No anchor text" in a row, which is --bg-hover when hovered or open (--text-faint there is 4.26:1 in dark)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-missing', '.seo-table-sub', '.seo-table-sub.seo-missing'],
    color: '--text-muted',
    why: 'Links and Images: "No usable URL", "No source" in a row, hovered or open (--text-faint is 4.26:1 there in dark)',
  },
  // Council round 1 on PR #46: --accent text on --accent-soft is 3.84:1 in dark when its row is hovered
  // or open (the tint over --bg-hover); these badges sit in row buttons, so they take --accent-hover.
  { stylesheet: 'styles.css', element: ['.seo-kind', ".seo-kind[data-kind='internal']"], color: '--accent-hover', background: '--accent-soft', why: 'Links: an internal link\'s "int" badge, in a row that can be hovered or open' },
  { stylesheet: 'styles.css', element: ['.seo-page-text', '.seo-ellipsis', '.seo-type-badge'], color: '--accent-hover', background: '--accent-soft', why: 'Schema: a node\'s type badge, in an entity row that can be hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-badge', ".seo-badge[data-severity='info']", ".seo-entity-head .seo-badge[data-severity='info']"],
    color: '--accent-hover',
    background: '--accent-soft',
    why: 'Schema: an entity\'s issue count when its worst is a notice, in an entity row that can be hovered (the frame\'s info badge keeps --accent elsewhere)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-missing', '.seo-entity-name', '.seo-entity-name.seo-missing'],
    color: '--text-muted',
    why: 'Schema: a nameless entity\'s "No name", in a row that can be hovered (--text-faint there is 4.26:1 in dark)',
  },
  // The rest of the browser chrome (its surface PR): status text takes its -ink.
  { stylesheet: 'styles.css', element: ['.find-count', ".find-count[data-empty='true']"], color: '--danger-ink', why: 'the find bar\'s count with no match (12px, was --danger) on its band' },
  { stylesheet: 'styles.css', element: ['.render-bar-error'], color: '--danger-ink', why: 'the editor bar\'s errors (12px, were --danger) on its band' },
  { stylesheet: 'styles.css', element: ['.render-bar-note'], color: '--warn-ink', background: '--warn-soft', why: 'the editor bar\'s notes: -ink on -soft (they were --text-muted on a 10% --caution tint)' },
  {
    stylesheet: 'styles.css',
    element: ['.render-bar-note', '.render-overrides-failed'],
    color: '--danger-ink',
    background: '--danger-soft',
    why: 'the editor bar\'s "could not apply" note: -ink on -soft (it was --text on a 12% --danger tint); the note\'s own colours must not win',
  },
  { stylesheet: 'styles.css', element: ['.devtools-notice'], color: '--warn-ink', why: 'the DevTools drawer\'s notice (was --caution, 3.0:1 on the drawer in light)' },
  { stylesheet: 'styles.css', element: ['.devtools-notice-inline'], color: '--warn-ink', why: 'the DevTools drawer\'s inline notice (was --caution)' },
  { stylesheet: 'styles.css', element: ['.devtools-table td', '.devtools-row-failed td'], color: '--danger-ink', why: 'a failed request\'s row (was --danger)' },
  { stylesheet: 'styles.css', element: ['.devtools-robots-blocked'], color: '--danger-ink', why: 'a request robots.txt blocks (was --danger)' },
  { stylesheet: 'styles.css', element: ['.devtools-robots-allowed'], color: '--ok-ink', why: 'a request robots.txt allows (was --ok, 3.2:1 on the drawer in light)' },
  { stylesheet: 'styles.css', element: ['.devtools-status', '.devtools-status-2xx'], color: '--ok-ink', background: '--bg-subtle', why: 'a 2xx status code (was --ok on --bg-hover)' },
  { stylesheet: 'styles.css', element: ['.devtools-status', '.devtools-status-3xx'], color: '--warn-ink', background: '--bg-subtle', why: 'a 3xx status code (was --caution on --bg-hover)' },
  { stylesheet: 'styles.css', element: ['.devtools-status', '.devtools-status-4xx'], color: '--danger-ink', background: '--bg-subtle', why: 'a 4xx status code (was --danger on --bg-hover)' },
  { stylesheet: 'styles.css', element: ['.devtools-status', '.devtools-status-5xx'], color: '--danger-ink', background: '--bg-subtle', why: 'a 5xx status code (was --danger on --bg-hover)' },
  { stylesheet: 'styles.css', element: ['.devtools-button', '.devtools-danger'], color: '--danger-ink', why: 'the drawer\'s Clear site data (was --danger) on its button' },
  { stylesheet: 'styles.css', element: ['.history-clear'], color: '--danger-ink', why: 'History\'s Clear (was --danger) on its button' },
  // A History row's monogram and change count lie over --bg-hover on a hovered row: --accent-hover keeps 4.5:1 there.
  { stylesheet: 'styles.css', element: ['.history-monogram'], color: '--accent-hover', background: '--accent-soft', why: 'a History row\'s monogram (11px; --accent is 3.84:1 on a hovered row in dark)' },
  { stylesheet: 'styles.css', element: ['.history-changes'], color: '--accent-hover', background: '--accent-soft', why: 'a History row\'s change count (11px; --accent is 3.84:1 on a hovered row in dark)' },
  // Disabled is a colour, not a fade (the token sheet's "--text-faint on --bg-subtle, no shadow"): with a fade put back these fail.
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'a disabled .panel-button' },
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button-primary', '.panel-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'a disabled primary .panel-button' },
  // Later states: busy but focusable (aria-disabled), the same colours, hovered too (its hover's --bg-hover and
  // the primary's --accent-hover give way). The primary hover is FOCUS_RING_RULES' PANEL_PRIMARY_HOVER.
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', PANEL_HOVER, ".panel-button[aria-disabled='true']"],
    color: '--text-faint',
    background: '--bg-subtle',
    unfaded: true,
    why: 'the crawl sheet\'s Export CSV while it saves (aria-disabled), hovered too',
  },
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', PANEL_HOVER, '.panel-button-primary', '.panel-button-primary:hover:where(:not(:disabled))', ".panel-button[aria-disabled='true']"],
    color: '--text-faint',
    background: '--bg-subtle',
    unfaded: true,
    why: 'the crawl sheet\'s Start crawl and AI answers\' Ask while their run is under way (aria-disabled), hovered too',
  },
  { stylesheet: 'styles.css', element: ['.update-button', '.update-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'the update notice\'s Skip this version while its step runs' },
  { stylesheet: 'styles.css', element: ['.update-button', '.update-primary', '.update-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'the update notice\'s Download or Show file while its step runs' },
  { stylesheet: 'styles.css', element: ['.render-chip', '.render-chip:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'the editor bar\'s quick profiles with no tab' },
  { stylesheet: 'styles.css', element: ['.devtools-button', '.devtools-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'a DevTools drawer button with nothing to act on' },
  // Page Speed (Indexability, Page Speed and Compliance's PR): a band, a party and the measurement's
  // source are badges, -ink on -soft (they drew the tone on its tint: --ok 3.30:1 as text); the band is
  // set on the metric (`[data-band]`), whose tile the badge sits in.
  { stylesheet: 'styles.css', element: ['.seo-speed-metric-band', ".seo-speed [data-band='good']"], color: '--ok-ink', background: '--ok-soft', why: `Page Speed: a metric in the good band, "Good" (11px, was --ok): ${OK_TINT}` },
  {
    stylesheet: 'styles.css',
    element: ['.seo-speed-metric-band', ".seo-speed [data-band='needs-improvement']"],
    color: '--warn-ink',
    background: '--warn-soft',
    why: 'Page Speed: a metric that needs improvement (11px, was --caution: 3.65:1 on a card in light)',
  },
  { stylesheet: 'styles.css', element: ['.seo-speed-metric-band', ".seo-speed [data-band='poor']"], color: '--danger-ink', background: '--danger-soft', why: 'Page Speed: a poor metric (11px, was --danger: 4.83:1 on a card in light, under 4.5 on its tint)' },
  { stylesheet: 'styles.css', element: ['.seo-speed-flag', ".seo-speed-flag[data-party='third']"], color: '--warn-ink', background: '--warn-soft', why: 'Page Speed: a third-party request or host, "3rd party" (11px, was --caution on its 15% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-speed-source', ".seo-speed-source[data-source='live']"], color: '--ok-ink', background: '--ok-soft', why: `Page Speed: the issues come from the live measurement, "Live" (11px, was --ok on its 14% tint): ${OK_TINT}` },
  {
    stylesheet: 'styles.css',
    element: ['.seo-speed-type-label', ".seo-speed-type[data-empty='true'] .seo-speed-type-label"],
    color: '--text-faint',
    why: 'Page Speed: a resource type with no request, dimmed by colour (it faded to half: --text at 50% is under 4.5:1)',
  },
  // Compliance: an impact is a badge, -ink on -soft (critical --danger, serious and moderate --warn, minor
  // the accent's), and the tally's numbers take the -ink on their --bg-subtle tiles; the impact is set on
  // the tile (`[data-impact]`), whose number inherits it. A zero is --text-faint.
  { stylesheet: 'styles.css', element: ['.seo-a11y-impact', ".seo-a11y-impact[data-impact='critical']"], color: '--danger-ink', background: '--danger-soft', why: 'Compliance: a group of critical rules, "Critical" (11px, was --danger on its 15% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-a11y-impact', ".seo-a11y-impact[data-impact='serious']"], color: '--warn-ink', background: '--warn-soft', why: 'Compliance: a group of serious rules, "Serious" (11px, was --warn on its 15% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-a11y-impact', ".seo-a11y-impact[data-impact='moderate']"], color: '--warn-ink', background: '--warn-soft', why: 'Compliance: a group of moderate rules, "Moderate" (11px, was --caution on its 15% tint)' },
  { stylesheet: 'styles.css', element: ['.seo-a11y-impact'], color: '--accent-hover', background: '--accent-soft', why: 'Compliance: a group of minor rules, "Minor" (11px, was --info-tone on its 15% tint)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-a11y-tally-item', ".seo-a11y-tally-item[data-impact='critical']", '.seo-a11y-tally-value'],
    color: '--danger-ink',
    background: '--bg-subtle',
    why: 'Compliance: the tally\'s critical count (18px, was --danger on an 8% tint)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-a11y-tally-item', ".seo-a11y-tally-item[data-impact='serious']", '.seo-a11y-tally-value'],
    color: '--warn-ink',
    background: '--bg-subtle',
    why: 'Compliance: the tally\'s serious count (18px, was --warn on an 8% tint)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-a11y-tally-item', ".seo-a11y-tally-item[data-impact='moderate']", '.seo-a11y-tally-value'],
    color: '--warn-ink',
    background: '--bg-subtle',
    why: 'Compliance: the tally\'s moderate count (18px, was --caution: 3.65:1 on a card in light)',
  },
  { stylesheet: 'styles.css', element: ['.seo-a11y-tally-item', '.seo-a11y-tally-value'], color: '--accent-hover', background: '--bg-subtle', why: 'Compliance: the tally\'s minor count (18px, was --info-tone)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-a11y-tally-item', ".seo-a11y-tally-item[data-impact='critical']", ".seo-a11y-tally-item[data-count='0']", '.seo-a11y-tally-value', ".seo-a11y-tally-item[data-count='0'] .seo-a11y-tally-value"],
    color: '--text-faint',
    background: '--bg-subtle',
    why: 'Compliance: an impact with no violated rule, its count dimmed by colour (GrayText under forced colours, FORCED_COLOURS_BUSY)',
  },
  // Council round 1 on PR #48: colours chosen for contrast that no entry pinned. A verdict's label is
  // --text (the icon carries the verdict's colour: --ok text is 3.30:1 on a card in light); a rule row's
  // id and count line is --text-muted (--text-faint is 4.26:1 on the hovered row in dark).
  { stylesheet: 'styles.css', element: ['.seo-verdict-label'], color: '--text', why: 'Indexability\'s, Compliance\'s and JavaScript\'s verdict label (18px; it was the verdict\'s colour, --ok 3.30:1 in light)' },
  { stylesheet: 'styles.css', element: ['.seo-speed-verdict-label'], color: '--text', why: 'Page Speed\'s lab verdict label (18px; it was the band\'s colour, --ok 3.30:1 in light)' },
  { stylesheet: 'styles.css', element: ['.seo-a11y-rule-meta'], color: '--text-muted', why: 'Compliance: a rule row\'s id and element count (12px) in a row button that can be hovered (--text-faint there is 4.26:1 in dark)' },
  // The navigation timing's segments are steps of --accent in --track, too close to one another to tell
  // apart (1.2:1 between neighbours): each is outlined by a --bg-surface stroke (currentColor, set through
  // `color`; 2px, painted under the fill on whole pixels, so a solid 1px of it shows past each segment's
  // end), so a boundary separates every two. The steps start at 55% of --accent so the stroke is at least
  // 3:1 off each (CONTRAST_PAIRS: --bg-surface against 55% of --accent over --track, and --accent itself).
  // `drawn` pins the stroke as well as its colour: without `paint-order: stroke` it paints over a short
  // segment's fill.
  {
    stylesheet: 'styles.css',
    element: ['.seo-speed-phase'],
    color: '--bg-surface',
    drawn: { stroke: 'currentColor', 'stroke-width': '2px', 'paint-order': 'stroke' },
    why: 'Page Speed\'s navigation timing: the 1px boundary stroke around every phase\'s segment',
  },
  // Later states: the length and width meters' fill takes the same boundary (CONTRAST_PAIRS: --bg-surface
  // against each verdict's fill), so "fits" (--ok, 2.23:1 on --track in light) meets the card's colour; on
  // whole pixels, as the timing's: measured at 1×, an anti-aliased 1px boundary was two columns at about 2:1
  // off the fill, crispEdges one column at 3.30:1 in every row.
  {
    stylesheet: 'styles.css',
    element: ['.seo-meter-fill'],
    color: '--bg-surface',
    drawn: { stroke: 'currentColor', 'stroke-width': '2px', 'paint-order': 'stroke', 'shape-rendering': 'crispEdges', rx: '0' },
    why: 'On-Page\'s length meters: the 1px boundary stroke around the fill, on whole pixels (anti-aliased it split into two half-tones at about 2:1), square (crisp, its rx drew a staircase at each end; the bar\'s pill clip rounds the outer end)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-width-meter-fill'],
    color: '--bg-surface',
    drawn: { stroke: 'currentColor', 'stroke-width': '2px', 'paint-order': 'stroke', 'shape-rendering': 'crispEdges', rx: '0' },
    why: 'Content\'s width meters: the 1px boundary stroke around the fill, on whole pixels, square (as the length meters\')',
  },
  // Content, JavaScript, SERP and Visibility (their surface PR): status text takes its -ink, on its
  // -soft fill where it is a badge; no row in these panels is hoverable, so no badge lies over --bg-hover.
  {
    stylesheet: 'styles.css',
    element: ['.seo-query-term', ".seo-query-term[data-present='true']"],
    color: '--ok-ink',
    background: '--ok-soft',
    why: `Content: a target query's term found in a place (11px, was --ok on its 14% tint): ${OK_TINT}`,
  },
  { stylesheet: 'styles.css', element: ['.seo-width-meter-text'], color: '--ok-ink', why: 'Content: a width meter\'s "… px: fits" (12px, was the meter\'s --ok: 3.30:1 on a card in light)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-width-meter-text', ".seo-width-meter[data-state='over'] .seo-width-meter-text"],
    color: '--warn-ink',
    why: 'Content: a width meter\'s "… px: cut" (12px, was the meter\'s --caution): status text takes its -ink',
  },
  {
    stylesheet: 'styles.css',
    // The hover selectors are FOCUS_RING_RULES' SEO_TOGGLE_HOVER and SEO_TOGGLE_DANGER_HOVER (declared after this list).
    element: ['.seo-toggle', ".seo-toggle:hover:where(:not(:disabled, [aria-pressed='true']))", '.seo-toggle-danger', '.seo-toggle-danger:hover:where(:not(:disabled))'],
    color: '--danger-ink',
    why: 'Content: "Delete draft" and "Delete all notes…", hovered (was --danger: 4.37:1 on the hovered toggle in light)',
  },
  { stylesheet: 'styles.css', element: ['.seo-js-note', ".seo-js-note[data-tone='warn']"], color: '--warn-ink', why: 'JavaScript: the partial-comparison note (12px, was --caution: 3.65:1 on a card in light)' },
  {
    stylesheet: 'styles.css',
    element: [".visibility-table td[data-diff='true']"],
    color: '--warn-ink',
    background: '--warn-soft',
    why: 'Visibility: a cell that differs from the browser (12px, was --caution on its 13% tint); its --warn edge and weight say it without hue',
  },
  {
    stylesheet: 'styles.css',
    element: ['.serp-table thead th', ".visibility-table thead th[data-differs='true']"],
    color: '--warn-ink',
    why: 'Visibility: an agent told something the browser was not (11px caps, was --caution); its --warn underline says it without hue',
  },
  // The Changes panel, Projects, Rankings, Inspector and the screenshot editor (their surface PR). Capture now
  // and Pick element faded their disabled .panel-button by `opacity` on top of its disabled colours: they are
  // the colours alone now (`:disabled` is listed, so a fade put back on it fails).
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', '.panel-button-primary', '.changes-capture', '.panel-button:disabled', '.changes-capture:disabled'],
    color: '--text-faint',
    background: '--bg-subtle',
    unfaded: true,
    why: 'the Changes panel\'s Capture now, disabled (no page) or busy',
  },
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', '.panel-button-primary', '.inspector-pick', '.panel-button:disabled', '.inspector-pick:disabled'],
    color: '--text-faint',
    background: '--bg-subtle',
    unfaded: true,
    why: 'the Inspector\'s Pick element, disabled (picking, or no tree yet)',
  },
  { stylesheet: 'styles.css', element: ['.projects-small-button', '.projects-small-button:disabled'], color: '--text-faint', background: '--bg-subtle', unfaded: true, why: 'a disabled Projects sheet button (it faded to half)' },
  // Status text takes its -ink (it drew --ok, --caution, --warn or --danger); each says its state in words.
  { stylesheet: 'styles.css', element: ['.changes-note', ".changes-note[data-tone='warn']"], color: '--warn-ink', why: 'a Changes or Inspector note that warns ("Cut short", "Partial"; 12px, was --caution: 3.0:1 on a card in light)' },
  { stylesheet: 'styles.css', element: ['.changes-status', ".changes-status[data-outcome='refused']"], color: '--warn-ink', why: 'Capture now refused (12px, was --caution)' },
  { stylesheet: 'styles.css', element: ['.changes-status', ".changes-status[data-outcome='failed']"], color: '--warn-ink', why: 'Capture now failed (12px, was --caution)' },
  { stylesheet: 'styles.css', element: ['.changes-status', ".changes-status[data-outcome='first']"], color: '--ok-ink', why: 'the first version captured (12px, was --ok: 3.30:1 on a card in light)' },
  { stylesheet: 'styles.css', element: ['.changes-status', ".changes-status[data-outcome='new']"], color: '--ok-ink', why: 'a new version captured (12px, was --ok)' },
  { stylesheet: 'styles.css', element: ['.changes-status', ".changes-status[data-outcome='saved']"], color: '--ok-ink', why: 'a screenshot saved (12px, was --ok)' },
  // A change's kind: its word and mark (+, −, ~) on its -soft fill, -ink text (it was the tone on its own 14% tint).
  { stylesheet: 'styles.css', element: ['.changes-kind'], color: '--warn-ink', background: '--warn-soft', why: 'a change\'s kind, "Changed" (11px, was --caution on its 14% tint)' },
  { stylesheet: 'styles.css', element: ['.changes-kind', ".changes-kind[data-kind='added']"], color: '--ok-ink', background: '--ok-soft', why: `a change's kind, "Added": ${OK_TINT}` },
  { stylesheet: 'styles.css', element: ['.changes-kind', ".changes-kind[data-kind='removed']"], color: '--danger-ink', background: '--danger-soft', why: `a change's kind, "Removed": ${DANGER_TINT}` },
  { stylesheet: 'styles.css', element: ['.changes-segment', ".changes-segment[data-op='ins']"], color: '--ok-ink', background: '--ok-soft', why: `the diff's added words, underlined (was --ok on its 14% tint): ${OK_TINT}` },
  // In a row that can be hovered (--bg-hover over a card), --text-faint is 4.26:1 in dark: --text-muted.
  { stylesheet: 'styles.css', element: ['.changes-version-count'], color: '--text-muted', why: 'a version\'s change count, in its row (hovered or chosen)' },
  { stylesheet: 'styles.css', element: ['.changes-version-summary', ".changes-version-summary[data-first='true']"], color: '--text-muted', why: 'a first version\'s "First capture", in its row (hovered or chosen)' },
  { stylesheet: 'styles.css', element: ['.inspector-shadow'], color: '--text-muted', why: 'the Inspector\'s "#shadow-root" in a tree row (hovered or selected)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-action', '.inspector-view-button', ".inspector-view-button[aria-pressed='true']"],
    color: '--accent',
    background: '--accent-soft',
    why: 'the Inspector\'s chosen view (Tree, Rendered or Served), with an --accent edge (PRESSED_EDGES)',
  },
  { stylesheet: 'styles.css', element: ['.projects-small-button', '.projects-danger'], color: '--danger-ink', why: 'Delete project and Purge now (was --danger) on their buttons' },
  { stylesheet: 'styles.css', element: ['.projects-run-outcome', ".projects-run-target[data-outcome='captured'] .projects-run-outcome"], color: '--ok-ink', why: 'a capture run\'s target, "Captured" (12px, was --ok)' },
  { stylesheet: 'styles.css', element: ['.projects-run-outcome', ".projects-run-target[data-outcome='failed'] .projects-run-outcome"], color: '--danger-ink', why: 'a capture run\'s target, "Failed" (12px, was --danger)' },
  { stylesheet: 'styles.css', element: ['.projects-run-outcome', ".projects-run-target[data-outcome='timed-out'] .projects-run-outcome"], color: '--danger-ink', why: 'a capture run\'s target, "Timed out" (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: [".projects-run-target[data-outcome='blocked'] .projects-run-outcome"], color: '--warn-ink', why: 'a capture run\'s target, "Blocked" (12px, was --warn)' },
  { stylesheet: 'rankings.css', element: ['.projects-run-blocked-reason'], color: '--warn-ink', why: 'a blocked run\'s reason (13px, was --warn)' },
  {
    stylesheet: 'rankings.css',
    element: [".projects-bulk-outcome[data-outcome='invalid'] .projects-bulk-outcome-text"],
    color: '--danger-ink',
    why: 'Bulk add: a line that is not a search, "Invalid" (12px, was --danger)',
  },
  { stylesheet: 'rankings.css', element: [".projects-bulk-outcome[data-outcome='limit'] .projects-bulk-outcome-text"], color: '--danger-ink', why: 'Bulk add: a line over the plan\'s limit (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: ['.rankings-number', '.rankings-change', ".rankings-change[data-direction='up']"], color: '--ok-ink', why: 'Rankings: a search that rose, "+3" (12px, was --ok)' },
  { stylesheet: 'rankings.css', element: ['.rankings-number', '.rankings-change', ".rankings-change[data-direction='new']"], color: '--ok-ink', why: 'Rankings: a search new to the results, "New" (12px, was --ok)' },
  { stylesheet: 'rankings.css', element: ['.rankings-number', '.rankings-change', ".rankings-change[data-direction='down']"], color: '--danger-ink', why: 'Rankings: a search that fell, "−2" (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: ['.rankings-number', '.rankings-change', ".rankings-change[data-direction='lost']"], color: '--danger-ink', why: 'Rankings: a search out of the results, "Lost" (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: ['.compare-movement', ".compare-movement[data-movement='up']"], color: '--ok-ink', why: 'Compare: a domain that rose, "Up 2" (12px, was --ok)' },
  { stylesheet: 'rankings.css', element: ['.compare-movement', ".compare-movement[data-movement='new']"], color: '--ok-ink', why: 'Compare: a domain new on the later date, "New" (12px, was --ok)' },
  { stylesheet: 'rankings.css', element: ['.compare-movement', ".compare-movement[data-movement='down']"], color: '--danger-ink', why: 'Compare: a domain that fell, "Down 2" (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: ['.compare-movement', ".compare-movement[data-movement='gone']"], color: '--danger-ink', why: 'Compare: a domain gone on the later date, "Gone" (12px, was --danger)' },
  { stylesheet: 'rankings.css', element: ['.rankings-capped'], color: '--warn-ink', why: 'Rankings: the capped mark beside a trend ("*", was --warn)' },
  // The panel stylesheets (their surface PR). A destructive button in the Crawl and AI answers sheets is a
  // .panel-button whose own rule loaded first, so .panel-button's --text won and it never looked
  // destructive: its rule now outweighs .panel-button (two classes), whatever the order, hovered too.
  { stylesheet: 'crawl.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button.crawl-danger'], color: '--danger-ink', why: 'the crawl sheet\'s Delete this crawl, confirmed (was --danger, and lost to .panel-button\'s --text)' },
  { stylesheet: 'crawl.css', loadsBefore: ['styles.css'], element: ['.panel-button', PANEL_HOVER, '.panel-button.crawl-danger'], color: '--danger-ink', why: 'the crawl sheet\'s Delete this crawl, hovered' },
  { stylesheet: 'ai-answers.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button.ai-answers-danger'], color: '--danger-ink', why: 'the AI answers sheet\'s Delete, Delete all and shorter-retention confirmations (were --danger, and lost to .panel-button\'s --text)' },
  { stylesheet: 'ai-answers.css', loadsBefore: ['styles.css'], element: ['.panel-button', PANEL_HOVER, '.panel-button.ai-answers-danger'], color: '--danger-ink', why: 'the AI answers sheet\'s confirmations, hovered' },
  // Status text on a card takes its -ink (each also says its word).
  {
    stylesheet: 'gsc-inspection.css',
    element: ['.gsc-inspect-group-label', ".gsc-inspect-group[data-severity='ERROR'] .gsc-inspect-group-label"],
    color: '--danger-ink',
    why: 'the URL Inspection card\'s "Error" group label (was --danger)',
  },
  {
    stylesheet: 'gsc-inspection.css',
    element: ['.gsc-inspect-group-label', ".gsc-inspect-group[data-severity='WARNING'] .gsc-inspect-group-label"],
    color: '--warn-ink',
    why: 'the URL Inspection card\'s "Warning" group label (was --caution)',
  },
  { stylesheet: 'ai-readiness.css', element: ['.ai-status', ".ai-status[data-status='pass']"], color: '--ok-ink', why: 'AI readiness: a check that passed, its verdict and glyph (was --ok: 3.30:1 on a card in light)' },
  { stylesheet: 'ai-readiness.css', element: ['.ai-status', ".ai-status[data-status='warn']"], color: '--warn-ink', why: 'AI readiness: a check with a warning (was --caution)' },
  { stylesheet: 'ai-readiness.css', element: ['.ai-status', ".ai-status[data-status='fail']"], color: '--danger-ink', why: 'AI readiness: a check that failed (was --danger)' },
  { stylesheet: 'ai-readiness.css', element: ['.page-type-confidence', ".page-type-confidence[data-confidence='unsure']"], color: '--warn-ink', why: 'the Page card\'s "Unsure" (was --caution)' },
  {
    stylesheet: 'ai-readiness.css',
    element: ['.page-type-signal-type', ".page-type-signal[data-agrees='false'] .page-type-signal-type"],
    color: '--warn-ink',
    why: 'the Page card: a signal that disagrees, its type (was --caution; a wavy --warn underline says it without hue)',
  },
  // A chosen filter's text says it is in force: the shared controls' hover must not wash it out.
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', CHIP_HOVER, ".seo-chip-button.gsc-dates[data-active='true']"],
    color: '--accent',
    background: '--accent-soft',
    why: 'Search Console\'s custom dates in force, hovered too (the chip\'s hover is --text)',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-select', ".gsc .gsc-select[data-active='true']"],
    color: '--accent',
    background: '--bg-surface',
    why: 'a Search Console filter in force (a month preset, a country, a device)',
  },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', ".gsc-cal-day[aria-selected='true']"], color: '--accent', background: '--accent-soft', why: 'a calendar day inside the chosen range' },
  {
    stylesheet: 'gsc-panel.css',
    element: ['.gsc-cal-day', ".gsc-cal-day[aria-selected='true']", ".gsc-cal-day[data-edge='true']"],
    color: '--on-accent',
    background: '--accent',
    why: 'the chosen range\'s first and last day',
  },
  // On every tab state (an inactive tab is --bg-tab-idle, hovered --bg-hover, over the row): --accent is 4.18:1 on a hovered one in light.
  { stylesheet: 'location.css', element: ['.tab-location'], color: '--accent-hover', background: '--accent-soft', why: 'a location tab\'s badge (11px, was --accent)' },
] as const satisfies readonly TextColourRule[];

/**
 * A raised control whose hover lays `--bg-hover` over it (an inset box-shadow) and which can also be
 * pressed (`aria-pressed`, on an `--accent-soft` fill): the hover must skip a pressed one, since
 * `--accent` text on `--bg-hover` over `--accent-soft` is 3.78:1 in dark (council round 1 on PR #46: the
 * Inspector's Tree, Rendered and Served buttons are `.seo-action`s). Every rule of `stylesheet` with a
 * compound selector holding both `<control>` (on a class boundary) and `:hover`, in any order and after
 * any ancestor (`.seo-action.inspector-view-button:hover`, `.seo-action:not(:disabled):hover`,
 * `.seo-panel-tools .seo-toggle:hover`), that sets `box-shadow` or `background` names
 * `[aria-pressed='true']` in a `:not(…)` of that same compound.
 */
export interface HoverSkipsPressed {
  readonly stylesheet: string;
  readonly control: string;
  readonly why: string;
}

export const HOVER_OVERLAYS_SKIP_PRESSED = [
  { stylesheet: 'styles.css', control: '.seo-toggle', why: 'a panel toggle (Highlight on page, Broken only), pressed' },
  { stylesheet: 'styles.css', control: '.seo-action', why: 'the Inspector\'s Tree, Rendered and Served buttons (`seo-action inspector-view-button`), the chosen one pressed' },
  { stylesheet: 'styles.css', control: '.seo-ngram-highlight', why: 'Content: an n-gram row\'s highlight button, pressed while the page shows that phrase' },
  { stylesheet: 'styles.css', control: '.changes-version', why: 'a version in the Changes panel\'s history, the chosen one pressed (its --accent-soft fill and edge stay under the pointer)' },
  { stylesheet: 'gsc-panel.css', control: '.gsc-tile', why: 'Search Console\'s total tile the chart shows: its hover would replace the pressed edge\'s inner line' },
  { stylesheet: 'ai-answers.css', control: '.ai-answers-pick', why: 'the AI answer the sheet shows (--accent-soft): the hover would lay --bg-hover over it' },
] as const satisfies readonly HoverSkipsPressed[];

/**
 * A pressed control whose fill alone would say it (council round 1 on PR #46: a pressed filter chip's
 * `--accent-soft` is 1.06:1 off an unpressed chip's `--bg-subtle` in light): it also draws an `edge` on its
 * transparent border, not a box-shadow (which the focus ring replaces). For each entry the cascade over
 * `element` in `stylesheet` resolves `border-color` to `var(<edge>)` in light and dark, with a border that
 * draws (a non-zero `border-width` and a `border-style` other than `none` or `hidden`, from the
 * longhands or the `border` shorthand), and for each of
 * `fills` (the pressed fill, the card around it) `CONTRAST_PAIRS` holds `edge` on it at 3:1 or more.
 */
export interface PressedEdge extends LoadsBefore {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly edge: TokenName;
  readonly fills: readonly { readonly bg: TokenName; readonly over?: TokenName }[];
  readonly why: string;
}

/**
 * The colour a disabled control's text takes when only its text says it is disabled (its fill is the
 * same as when enabled): `--text-faint` at half strength, as the toolbar's disabled tool. Plain
 * `--text-faint` is 1.40:1 off the enabled `--text-muted` in light (1.32 in dark), too close to tell
 * (council round 2 on PR #46).
 */
export const DISABLED_INK = 'color-mix(in srgb, var(--text-faint) 50%, transparent)';

/**
 * Disabled controls on the same fill as their enabled selves (a filter chip on `--bg-subtle`, a segment
 * on its track): for each entry the cascade over `element` in `stylesheet` resolves `color` to
 * `DISABLED_INK` in light and dark, and gives no `opacity` under 1 (a fade would dim the colours that say
 * it, and a busy control's focus ring). (`GrayText` marks them under forced colours: `FORCED_COLOURS_BUSY`.)
 * Nor does any rule of the cascade whose subject names one of the classes `element` names (any state of
 * it) run an `animation` whose `@keyframes` set `opacity`: a pulse is a fade too (Later states: the busy
 * screenshot kind pulsed to 0.35 over its DISABLED_INK, the word "Saving…" with it; it is a disabled
 * segment, which says it is busy by its colours and its label, as the other busy controls do). Its limits:
 * it reads only rules whose subject is the control itself, so a pulse on a container around it (or an
 * opacity set on an ancestor any other way) passes unseen; and it reads every state of the class, so a
 * legitimate opacity entrance animation on a listed control would fail it (none exists).
 */
export interface DisabledControl extends LoadsBefore {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly why: string;
}

export const DISABLED_CONTROLS = [
  { stylesheet: 'styles.css', element: ['.seo-chip-button', '.seo-chip-button:disabled'], why: 'a filter chip, disabled (Changes\' screenshot kinds with no page, SERP\'s snippet sources, the AI card\'s targets)' },
  { stylesheet: 'styles.css', element: ['.seo-segment', '.seo-segment:disabled'], why: 'a segment, disabled (Schema\'s Tree for a block that did not parse)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-segment', '.seo-segment:disabled', '.changes-shot-kind-button:disabled'],
    why: 'the Changes panel\'s screenshot kinds, disabled (no page, or a screenshot under way; the busy one no longer pulses)',
  },
  // Later states: a checkbox label whose box is disabled (it faded to half; the native box keeps its own look),
  // and a Projects page or search row during a capture run (it looked enabled, and its hover tinted it).
  { stylesheet: 'styles.css', element: ['.render-check', '.render-check:has(input:disabled)'], why: 'the editor bar\'s checkbox labels, their box disabled' },
  { stylesheet: 'styles.css', element: ['.projects-entry-open', '.projects-entry-open:disabled'], why: 'a Projects page or search row during a capture run' },
  { stylesheet: 'styles.css', element: ['.projects-entry-meta', '.projects-entry-open:disabled .projects-entry-meta'], why: 'that row\'s last-capture line' },
  {
    stylesheet: 'styles.css',
    element: ['.projects-entry-label', '.projects-entry-open:hover .projects-entry-label', '.projects-entry-open:disabled .projects-entry-label'],
    why: 'that row\'s label under the pointer (the hover\'s --accent gives way)',
  },
  // The panel stylesheets (their surface PR): a busy chip (it faded to 0.6), the calendar's arrows and the
  // days out of range (they faded to 0.35 and 0.45), and Content's "Use as target" (it faded to half).
  {
    stylesheet: 'ai-checks.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', CHIP_HOVER, ".seo-chip-button.ai-judgment-action[aria-disabled='true']"],
    why: 'the AI judgment card\'s Check with AI while its call runs, hovered too (aria-disabled: still focusable)',
  },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-nav', '.gsc-cal-nav:disabled'], why: 'the calendar\'s previous or next month at the end of the range' },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', ".gsc-cal-day[aria-disabled='true']"], why: 'a calendar day Search Console has no data for' },
  {
    stylesheet: 'gsc-targets.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', '.seo-chip-button:disabled', '.gsc-targets-use', '.gsc-targets-use:disabled'],
    why: 'Content\'s "Use as target" while the page\'s notes load: its own disabled rule keeps the chip\'s colour, unfaded (it faded to half)',
  },
] as const satisfies readonly DisabledControl[];

/**
 * Stylesheets whose fades must spare focus: a region dimmed while it is re-read (Search Console's last
 * data, the URL Inspection card's last answer) holds focusable controls, and an `opacity` under 1 would
 * dim a focused one's ring. In each, every rule that sets `opacity` under 1 ends every selector of its
 * list with `:not(:focus-within)` (the region stays at full strength while focus is inside it, as a busy
 * switch in Settings fades only while it is not focused), and at least one such rule exists.
 */
export const FADES_SPARE_FOCUS = [
  { stylesheet: 'gsc-panel.css', why: 'Search Console\'s last data while another scope or range is read' },
  { stylesheet: 'gsc-inspection.css', why: 'a URL Inspection card\'s last answer while it is inspected again' },
] as const satisfies readonly { readonly stylesheet: string; readonly why: string }[];

export const PRESSED_EDGES = [
  {
    stylesheet: 'styles.css',
    element: ['.seo-chip-button', ".seo-chip-button[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'a filter chip, pressed (Images\' filters, Content\'s preview chips): an --accent edge beside its --accent-soft fill',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-ngram-highlight', ".seo-ngram-highlight[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'Content: an n-gram row\'s highlight button, pressed: an --accent edge beside its --accent-soft fill (it was a 50% --accent edge on a 14% tint)',
  },
  // The Changes panel, Projects, Inspector and the screenshot editor (their surface PR): a chosen item whose
  // --accent-soft fill alone would say it (or, for a swatch, nothing would).
  {
    stylesheet: 'styles.css',
    element: ['.changes-version', ".changes-version[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'the Changes panel\'s chosen version: an --accent edge beside its --accent-soft fill (it was a 40% --accent edge)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.projects-item', ".projects-item[data-selected='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'the Projects sheet\'s chosen project: an --accent edge beside its --accent-soft fill (it was the fill alone)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.inspector-row', ".inspector-row[data-selected='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'the Inspector\'s selected node: an --accent edge beside its --accent-soft fill (it was the fill alone)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-action', ".inspector-view-button[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-sheet' }, { bg: '--bg-sheet' }],
    why: 'the Inspector\'s chosen view: an --accent edge beside its --accent-soft fill, on the sheet',
  },
  {
    stylesheet: 'styles.css',
    element: ['.shot-editor-swatch', ".shot-editor-swatch[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--bg-surface' }],
    why: 'the screenshot editor\'s chosen colour: a 2px --accent ring on the editor\'s sheet',
  },
  // The panel stylesheets (their surface PR): what is chosen draws an --accent edge beside its fill.
  {
    stylesheet: 'gsc-panel.css',
    element: ['.gsc-tile', ".gsc-tile[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--bg-surface' }, { bg: '--bg-sheet' }],
    why: 'Search Console\'s total tile the chart shows: its fill stays --bg-surface, so the edge (and a line inside it) says it',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', ".seo-chip-button.gsc-dates[data-active='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-sheet' }, { bg: '--bg-sheet' }],
    why: 'Search Console\'s custom dates in force, as a pressed chip, on the panel\'s sheet',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', ".seo-chip-button.gsc-dates[aria-expanded='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-sheet' }, { bg: '--bg-sheet' }],
    why: 'Search Console\'s custom dates while the calendar is open',
  },
  {
    stylesheet: 'crawl.css',
    element: ['.crawl-run', ".crawl-run[data-selected='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'the crawl run the sheet shows, a card on the page card',
  },
  {
    stylesheet: 'ai-answers.css',
    element: ['.ai-answers-pick', ".ai-answers-pick[aria-pressed='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'the AI answer the sheet shows, a row on the page card',
  },
  {
    stylesheet: 'ai-answers.css',
    element: ['.ai-answer-domain', ".ai-answer-domain[data-watched='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'a cited domain that is the watched one (an unwatched one is a --bg-subtle chip)',
  },
  {
    stylesheet: 'ai-answers.css',
    element: ['.ai-answer-citation', ".ai-answer-citation[data-watched='true']"],
    edge: '--accent',
    fills: [{ bg: '--accent-soft', over: '--bg-surface' }, { bg: '--bg-surface' }],
    why: 'a citation on the watched domain',
  },
] as const satisfies readonly PressedEdge[];

/**
 * A state shown by an edge's shape as well as its colour (council round 1 on PR #49: Content's query
 * terms, present or absent, were told apart by a solid transparent edge and a dashed `--track` one,
 * 1.48:1 on the card, which only forced colours drew). For each entry the cascade over `element` in
 * `stylesheet` resolves `border-color` to `var(<edge>)`, `border-style` to `style` and `border-width` to
 * `width`, in light and dark and with the `@media (forced-colors: active)` rules read too, and for each of `fills` (what the edge sits on) `CONTRAST_PAIRS` holds
 * `edge` on it at 3:1 or more (a fill's `under` matched too). Forced colours keep the style, so the shape still says which. `rest: 'canvas'`
 * (Later states: the tab's render-profile badge): the cascade over `element[0]` alone, the item at rest,
 * with the forced-colours rules read, resolves `border-color` to `Canvas`, since forced colours paint a
 * transparent border and the rest would otherwise draw the same solid edge as a state. A `width` is a whole
 * pixel: Chromium draws a border on whole device pixels (a 1.5px one is 1px at 1×).
 */
export interface StateEdge {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly edge: TokenName;
  readonly style: 'solid' | 'dashed';
  readonly width: string;
  readonly fills: readonly { readonly bg: TokenName; readonly over?: TokenName; readonly under?: TokenName }[];
  readonly rest?: 'canvas';
  readonly why: string;
}

/** What the tab's render-profile badge's edge lies on: its own --accent-soft and the tab, on each tab state. */
const TAB_BADGE_FILLS = [
  { bg: '--bg-surface' },
  { bg: '--accent-soft', over: '--bg-surface' },
  { bg: '--bg-tab-idle', over: '--bg-window' },
  { bg: '--accent-soft', over: '--bg-tab-idle', under: '--bg-window' },
  { bg: '--bg-hover', over: '--bg-window' },
  { bg: '--accent-soft', over: '--bg-hover', under: '--bg-window' },
] as const satisfies StateEdge['fills'];

export const STATE_EDGES = [
  {
    stylesheet: 'styles.css',
    element: ['.seo-query-term', ".seo-query-term[data-present='true']"],
    edge: '--ok',
    style: 'solid',
    width: '1px',
    fills: [{ bg: '--bg-surface' }],
    why: 'Content: a target query\'s term found in a place, a solid --ok edge (3.30:1 on the card in light) round its --ok-soft fill',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-query-term'],
    edge: '--text-faint',
    style: 'dashed',
    width: '1px',
    fills: [{ bg: '--bg-surface' }],
    why: 'Content: a target query\'s term not found there, a dashed --text-faint edge (5.53:1 light, 5.03:1 dark on the card)',
  },
  // Later states: the tab's render-profile badge. At rest no edge (Canvas under forced colours); a tab that
  // needs a reload a dashed --accent edge; a profile that failed a solid one (failed wins when both hold, as
  // the status chip says "not applied" then). The edge lies on every tab state (TAB_STRIP: active, inactive,
  // hovered inactive), against the badge's own --accent-soft inside and the tab outside.
  {
    stylesheet: 'styles.css',
    element: ['.tab-profile', ".tab-profile[data-needs-reload='true']"],
    edge: '--accent',
    style: 'dashed',
    width: '1px',
    fills: TAB_BADGE_FILLS,
    rest: 'canvas',
    why: 'a profiled tab that needs a reload: a dashed --accent edge round its badge',
  },
  {
    stylesheet: 'styles.css',
    element: ['.tab-profile', ".tab-profile[data-status='failed']"],
    edge: '--accent',
    style: 'solid',
    width: '1px',
    fills: TAB_BADGE_FILLS,
    rest: 'canvas',
    why: 'a profiled tab whose profile failed: a solid --accent edge round its badge',
  },
  {
    stylesheet: 'styles.css',
    element: ['.tab-profile', ".tab-profile[data-needs-reload='true']", ".tab-profile[data-status='failed']"],
    edge: '--accent',
    style: 'solid',
    width: '1px',
    fills: TAB_BADGE_FILLS,
    rest: 'canvas',
    why: 'a profiled tab that needs a reload and whose profile failed: failed (solid) wins',
  },
  // Later states: Help's setup checklist, a step not done yet: a whole-pixel --switch-off ring (it was 1.5px,
  // which Chromium drew as 1px at 1× and 1.5px, three device pixels, at 2×); done, an --ok disc.
  {
    stylesheet: 'help.css',
    element: ['.setup-check'],
    edge: '--switch-off',
    style: 'solid',
    width: '1px',
    fills: [{ bg: '--bg-surface' }],
    why: 'Help\'s setup checklist: a step not done yet, a 1px --switch-off ring on its card',
  },
] as const satisfies readonly StateEdge[];

/**
 * A control whose keyboard focus must show `--focus-ring` (and the transparent 2px outline forced colours
 * draw) in every state it can be focused in: hovered, busy (`aria-disabled`, which stays focusable),
 * primary or not. `element` lists the selectors, in `stylesheet`, that such an element matches in that
 * state; resolving the cascade over them (as `TEXT_COLOUR_RULES`: specificity, `:where()` adding none,
 * then source order) gives `box-shadow: var(--focus-ring)` (or inset layers and then it: an inset line,
 * such as a pressed tile's inner edge, sits inside the element and never covers the ring; an outer
 * layer before or after it fails) and `outline: 2px solid transparent`, and no
 * `opacity` under 1 (it would dim the ring: at 0.55 it falls to about 2.4–2.8:1). So a hover's or a
 * primary button's own box-shadow never outranks the focus rule, and a busy button shows it is busy by
 * its colours, not by fading; a busy switch or choice fades only while it is not focused.
 */
export interface FocusRingRule extends LoadsBefore {
  readonly stylesheet: string;
  readonly element: readonly string[];
  /** Inset layers the focused element must keep before the ring (a pressed tile's inner edge): its
   * box-shadow is then exactly `<insetBefore>, var(--focus-ring)`, not the ring alone. */
  readonly insetBefore?: string;
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
const SEO_ISSUE_HOVER = '.seo-issue-head:hover';
const SEO_TOGGLE_HOVER = ".seo-toggle:hover:where(:not(:disabled, [aria-pressed='true']))";
const SEO_ACTION_HOVER = ".seo-action:hover:where(:not(:disabled, [aria-pressed='true']))";
const SEO_REF_HOVER = '.seo-ref-head:hover:where(:not(:disabled))';
const SEO_ICON_ACTION_HOVER = '.seo-icon-action:hover:where(:not(:disabled))';
const PANEL_BUTTON_HOVER = '.panel-button:hover:where(:not(:disabled))';
const PANEL_PRIMARY_HOVER = '.panel-button-primary:hover:where(:not(:disabled))';
const UPDATE_QUIET_HOVER = '.update-quiet:hover:where(:not(:disabled))';
const FIND_TOOL_HOVER = '.find-tool:hover:where(:not(:disabled))';
const RENDER_CHIP_HOVER = '.render-chip:hover:where(:not(:disabled))';
const RENDER_BAR_BUTTON = '.render-bar .render-frame-button';
const RENDER_BAR_BUTTON_HOVER = '.render-bar .render-frame-button:hover:where(:not(:disabled))';
const RENDER_BAR_PRIMARY_HOVER = '.render-bar .render-frame-primary:hover:where(:not(:disabled))';
const RENDER_FRAME_BUTTON_HOVER = '.render-frame-button:hover:where(:not(:disabled))';
const RENDER_FRAME_PRIMARY_HOVER = '.render-frame-primary:hover:where(:not(:disabled))';
const DEVTOOLS_TAB_HOVER = ".devtools-tab:hover:where(:not([aria-selected='true']))";
const DEVTOOLS_BUTTON_HOVER = '.devtools-button:hover:where(:not(:disabled))';
const SEO_TOGGLE_DANGER_HOVER = '.seo-toggle-danger:hover:where(:not(:disabled))';
const SEO_QUERY_CLEAR_HOVER = '.seo-query-clear:hover';
const SEO_NGRAM_HIGHLIGHT_HOVER = ".seo-ngram-highlight:hover:where(:not([aria-pressed='true']))";
const CHANGES_VERSION_HOVER = ".changes-version:hover:where(:not([aria-pressed='true']))";
const PROJECTS_BUTTON_HOVER = '.projects-small-button:hover:where(:not(:disabled))';
/** A project's row under the pointer: the chosen one lays no hover over its --accent-soft. */
const PROJECTS_ITEM_HOVER = ".projects-item:where(:not([data-selected='true'])) .projects-item-open:hover";
const GSC_TILE_HOVER = ".gsc-tile:hover:where(:not([aria-pressed='true']))";
const GSC_CAL_NAV_HOVER = '.gsc-cal-nav:hover:where(:not(:disabled))';
const GSC_CAL_DAY_HOVER = ".gsc-cal-day:hover:where(:not([aria-disabled='true'], [aria-selected='true']))";
const AI_ANSWERS_PICK_HOVER = ".ai-answers-pick:hover:where(:not([aria-pressed='true']))";
const CRAWL_TAB_HOVER = ".crawl-tab:hover:where(:not([aria-pressed='true']))";

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
  {
    stylesheet: 'help.css',
    element: ['.setup-dismiss', '.setup-dismiss:hover', '.setup-dismiss:focus-visible'],
    why: 'the setup checklist\'s "Hide this checklist", focused and hovered: its --bg-hover fill keeps the ring',
  },
  // The browser chrome (its surface PR): the shared `.tool` (the toolbar's, and the agent panel's and
  // SEO sidebar's header tools), the tabs, the new-tab button, the address bar and the permission prompt.
  { stylesheet: 'styles.css', element: ['.tool', TOOL_HOVER, '.tool:focus-visible'], why: 'a toolbar tool, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.tool', TOOL_HOVER, TOOL_PRESSED, '.tool:focus-visible'], why: 'a toolbar tool, focused and pressed' },
  {
    stylesheet: 'styles.css',
    element: ['.tool', TOOL_HOVER, ".render-toggle[aria-pressed='true']", '.tool:focus-visible'],
    why: 'the render-profile toggle, pressed (its editor bar open), focused and hovered: its pressed edge is the tool\'s border colour, not a box-shadow that would replace the ring',
  },
  {
    stylesheet: 'styles.css',
    element: ['.tool', TOOL_HOVER, ".sidebar-toggle[aria-pressed='true']", '.tool:focus-visible'],
    why: 'the SEO sidebar\'s and the AI agent\'s toggles (both .sidebar-toggle), pressed (their panel open), focused and hovered: the --accent-soft fill keeps the ring',
  },
  { stylesheet: 'styles.css', element: ['.tab', TAB_HOVER, TAB_FOCUS], why: 'an inactive tab, focused (the tablist\'s roving focus) and hovered' },
  { stylesheet: 'styles.css', element: ['.tab', ".tab[data-active='true']", TAB_FOCUS], why: 'the active tab, focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.new-tab', '.new-tab:hover', '.new-tab:active', '.new-tab:focus-visible'], why: 'the new-tab button, focused, hovered and pressed' },
  { stylesheet: 'styles.css', element: ['.address', '.address:focus-within'], why: 'the address bar, focused (:focus-within): its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.start-search-field', '.start-search-field:focus-within'], why: 'the new tab\'s search field, focused (:focus-within): its --e-raised edge gives way to --focus-ring, as the address bar\'s' },
  { stylesheet: 'styles.css', element: ['.prompt-button', PROMPT_BUTTON_HOVER, '.prompt-button:focus-visible'], why: 'the permission prompt\'s Allow or Block, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.prompt-dismiss', PROMPT_DISMISS_HOVER, '.prompt-dismiss:focus-visible'], why: 'the permission prompt\'s dismiss button, focused and hovered' },
  // Overview and On-Page (their surface PR): the focusable controls inside them that are their own. An
  // issue's heading row (Overview's, and the Links, Images, Social and Page Speed issue lists') and the
  // link button under a list ("Show all", the frame's shared part). Their highlight and Copy as CSV
  // toggles are `.seo-toggle`, a later panel's control.
  { stylesheet: 'styles.css', element: ['.seo-issue-head', SEO_ISSUE_HOVER, '.seo-issue-head:focus-visible'], why: 'an issue\'s heading row, focused (it expands the issue) and hovered: its --bg-hover fill keeps the ring' },
  { stylesheet: 'styles.css', element: ['.seo-link-button', '.seo-link-button:hover', '.seo-link-button:focus-visible'], why: 'Overview\'s "Show all" link button, focused and hovered' },
  // Links, Images, Social and Schema and the panels' shared controls (their surface PR): every control
  // they draw, in each state it can be focused in. A hover lays --bg-hover over a raised control by a
  // box-shadow, in `:where()`, so the plain `:focus-visible` rule after it wins.
  { stylesheet: 'styles.css', element: ['.seo-toggle', SEO_TOGGLE_HOVER, '.seo-toggle:focus-visible'], why: 'a panel toggle (Highlight on page, Copy as CSV, Check links), focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-toggle', ".seo-toggle[aria-pressed='true']", '.seo-toggle:focus-visible'],
    why: 'a panel toggle, pressed (its --accent-soft fill, no --e-raised), focused: the pressed rule sets box-shadow too',
  },
  { stylesheet: 'styles.css', element: ['.seo-action', SEO_ACTION_HOVER, '.seo-action:focus-visible'], why: 'a row action (Open in new tab, Copy URL), focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-segment', ".seo-segment[aria-pressed='true']", '.seo-segment:focus-visible'],
    why: 'the chosen segment, focused: its --e-raised edge gives way to --focus-ring',
  },
  { stylesheet: 'styles.css', element: ['.seo-chip-button', ".seo-chip-button[aria-pressed='true']", '.seo-chip-button:focus-visible'], why: 'a filter chip, pressed and focused' },
  { stylesheet: 'styles.css', element: ['.seo-select', '.seo-select:focus-visible'], why: 'the rel filter, focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.seo-search', '.seo-search:focus-within'], why: 'the search field, focused (:focus-within): its --e-raised edge gives way to --focus-ring' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-table-main', '.seo-table-main:hover', ".seo-table-row[data-open='true'] .seo-table-main", '.seo-table-main:focus-visible'],
    why: 'a link or image row, open, hovered and focused (it opens the row)',
  },
  { stylesheet: 'styles.css', element: ['.seo-entity-head', '.seo-entity-head:hover', '.seo-entity-head:focus-visible'], why: 'Schema: an entity\'s heading row, focused (it opens the entity) and hovered' },
  { stylesheet: 'styles.css', element: ['.seo-ref-head', SEO_REF_HOVER, '.seo-ref-head:focus-visible'], why: 'Schema: a reference by @id, focused (it opens the node) and hovered' },
  { stylesheet: 'styles.css', element: ['.seo-icon-action', SEO_ICON_ACTION_HOVER, '.seo-icon-action:focus-visible'], why: 'Schema: a URL value\'s open-in-tab button, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.seo-show-more', '.seo-show-more:hover', '.seo-show-more:focus-visible'], why: 'Schema: "Show more" under a long list, focused and hovered' },
  // The rest of the browser chrome (its surface PR).
  { stylesheet: 'styles.css', element: ['.panel-button', PANEL_BUTTON_HOVER, '.panel-button:focus-visible'], why: 'an error panel\'s button (every panel\'s .panel-button), focused and hovered: its hover lays --bg-hover in a box-shadow' },
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', PANEL_BUTTON_HOVER, '.panel-button-primary', PANEL_PRIMARY_HOVER, '.panel-button:focus-visible'],
    why: 'a primary .panel-button (Try again, Reload), focused and hovered: its hover sets box-shadow: none',
  },
  // Later states: busy but focusable (aria-disabled), a .panel-button keeps its ring at full strength.
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', PANEL_BUTTON_HOVER, ".panel-button[aria-disabled='true']", '.panel-button:focus-visible'],
    why: 'the crawl sheet\'s Export CSV while it saves (aria-disabled, still focusable), focused and hovered: its busy rule sets box-shadow: none',
  },
  {
    stylesheet: 'styles.css',
    element: ['.panel-button', PANEL_BUTTON_HOVER, '.panel-button-primary', PANEL_PRIMARY_HOVER, ".panel-button[aria-disabled='true']", '.panel-button:focus-visible'],
    why: 'the crawl sheet\'s Start crawl and AI answers\' Ask while their run is under way (aria-disabled), focused and hovered',
  },
  { stylesheet: 'styles.css', element: ['.update-button', UPDATE_BUTTON_HOVER, '.update-button:focus-visible'], why: 'the update notice\'s Skip this version, focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.update-button', UPDATE_BUTTON_HOVER, '.update-primary', UPDATE_PRIMARY_HOVER, '.update-button:focus-visible'],
    why: 'the update notice\'s Download or Show file, focused and hovered',
  },
  {
    stylesheet: 'styles.css',
    element: ['.update-button', UPDATE_BUTTON_HOVER, '.update-quiet', UPDATE_QUIET_HOVER, '.update-button:focus-visible'],
    why: 'the update notice\'s Release notes or Later, focused and hovered',
  },
  { stylesheet: 'styles.css', element: ['.update-dismiss', '.update-dismiss:hover', '.update-dismiss:focus-visible'], why: 'the update notice\'s Dismiss, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.find-input', '.find-input:focus-visible'], why: 'the find bar\'s field, focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.find-tool', FIND_TOOL_HOVER, '.find-tool:focus-visible'], why: 'a find bar tool, focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.find-tool', FIND_TOOL_HOVER, ".find-case[aria-pressed='true']", '.find-tool:focus-visible'],
    why: 'the find bar\'s Match case, pressed (--e-raised), focused and hovered',
  },
  { stylesheet: 'styles.css', element: ['.render-chip', RENDER_CHIP_HOVER, '.render-chip:focus-visible'], why: 'a quick profile in the editor bar, focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.render-frame-button', RENDER_BAR_BUTTON, RENDER_FRAME_BUTTON_HOVER, RENDER_BAR_BUTTON_HOVER, '.render-frame-button:focus-visible', '.render-bar .render-frame-button:focus-visible'],
    why: 'the editor bar\'s Reset, focused and hovered',
  },
  {
    stylesheet: 'styles.css',
    element: [
      '.render-frame-button',
      RENDER_BAR_BUTTON,
      RENDER_FRAME_BUTTON_HOVER,
      RENDER_BAR_BUTTON_HOVER,
      '.render-frame-primary',
      '.render-bar .render-frame-primary',
      RENDER_FRAME_PRIMARY_HOVER,
      RENDER_BAR_PRIMARY_HOVER,
      '.render-frame-button:focus-visible',
      '.render-bar .render-frame-button:focus-visible',
    ],
    why: 'the editor bar\'s Apply (primary), focused and hovered',
  },
  {
    stylesheet: 'styles.css',
    element: ['.render-frame-button', RENDER_FRAME_BUTTON_HOVER, '.render-frame-primary', RENDER_FRAME_PRIMARY_HOVER, '.render-frame-button:focus-visible'],
    why: 'the page-area frame\'s Reload to apply (primary), Edit and Reset, focused and hovered',
  },
  { stylesheet: 'styles.css', element: ['.render-field select', '.render-field select:focus-visible'], why: 'the editor bar\'s selects, focused' },
  { stylesheet: 'styles.css', element: ['.render-custom-ua', '.render-custom-ua:focus-visible'], why: 'the editor bar\'s user agent and location fields, focused' },
  { stylesheet: 'styles.css', element: ['.devtools-tab', DEVTOOLS_TAB_HOVER, '.devtools-tab:focus-visible'], why: 'a DevTools drawer tab, focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.devtools-tab', ".devtools-tab[aria-selected='true']", '.devtools-tab:focus-visible'],
    why: 'the selected DevTools drawer tab, focused: its --e-raised edge gives way to --focus-ring',
  },
  { stylesheet: 'styles.css', element: ['.devtools-button', DEVTOOLS_BUTTON_HOVER, '.devtools-button:focus-visible'], why: 'a DevTools drawer button, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.devtools-link', '.devtools-link:focus-visible'], why: 'a DevTools drawer link (a URL, a hop), focused' },
  { stylesheet: 'styles.css', element: ['.devtools-sort', '.devtools-sort:focus-visible'], why: 'a DevTools drawer column\'s sort button, focused' },
  { stylesheet: 'styles.css', element: ['.devtools-row-button', '.devtools-row-button:focus-visible'], why: 'a DevTools drawer row\'s button, focused' },
  { stylesheet: 'styles.css', element: ['.devtools-search', '.devtools-search:focus-visible'], why: 'the DevTools drawer\'s search, focused' },
  { stylesheet: 'styles.css', element: ['.devtools-toolbar select', '.devtools-toolbar select:focus-visible'], why: 'the DevTools drawer\'s filters, focused' },
  { stylesheet: 'styles.css', element: ['.history-search', '.history-search:focus-within'], why: 'History\'s search, focused (:focus-within): its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.history-clear', '.history-clear:hover', '.history-clear:focus-visible'], why: 'History\'s Clear, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.history-close', '.history-close:hover', '.history-close:focus-visible'], why: 'History\'s Close, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.history-action', '.history-action:hover', '.history-action:focus-visible'], why: 'a History row\'s action, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.history-open', '.history-open:focus-visible'], why: 'a History row\'s link, focused' },
  { stylesheet: 'styles.css', element: ['.history-more', '.history-more:hover', '.history-more:focus-visible'], why: 'History\'s Show more, focused and hovered' },
  { stylesheet: 'styles.css', element: ['.history-select', '.history-select:focus-visible'], why: 'History\'s project and range selects, focused' },
  // Indexability, Page Speed and Compliance (their surface PR): their own controls (the rest are the
  // shared toggles and row actions, the frame's link button and the chrome's tool and panel button).
  { stylesheet: 'styles.css', element: ['.seo-speed-resume', '.seo-speed-resume:hover', '.seo-speed-resume:focus-visible'], why: 'Page Speed: Resume on a paused live line, focused and hovered (it had a 2px --accent outline)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-a11y-rule-head', '.seo-a11y-rule-head:hover', '.seo-a11y-rule-head:focus-visible'],
    why: 'Compliance: an accessibility rule\'s row, focused (it opens the rule) and hovered: its --bg-hover fill keeps the ring (it had an inset 2px --accent outline)',
  },
  // Content, JavaScript, SERP and Visibility (their surface PR): the controls of their own (the panels'
  // toggles, actions, chips, segments, search fields and Settings-style buttons are the shared rules').
  {
    stylesheet: 'styles.css',
    element: ['.seo-toggle', SEO_TOGGLE_HOVER, SEO_TOGGLE_DANGER_HOVER, '.seo-toggle:focus-visible'],
    why: 'Content\'s "Delete draft" and "Delete all notes…", focused and hovered: the danger hover sets its edge and text only',
  },
  { stylesheet: 'styles.css', element: ['.seo-field-input', '.seo-field-input:focus-visible'], why: 'Content: a draft\'s title and description and the site-name field, focused: --e-raised gives way to --focus-ring (it was an --accent edge with a halo)' },
  { stylesheet: 'styles.css', element: ['.seo-query-clear', SEO_QUERY_CLEAR_HOVER, '.seo-query-clear:focus-visible'], why: 'Content: the target query\'s clear button, focused and hovered (it had no focus style of its own)' },
  {
    stylesheet: 'styles.css',
    element: ['.seo-ngram-highlight', SEO_NGRAM_HIGHLIGHT_HOVER, '.seo-ngram-highlight:focus-visible'],
    why: 'Content: an n-gram row\'s highlight button, focused and hovered (it was a 2px --accent outline)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-ngram-highlight', ".seo-ngram-highlight[aria-pressed='true']", '.seo-ngram-highlight:focus-visible'],
    why: 'Content: an n-gram row\'s highlight button, pressed and focused',
  },
  { stylesheet: 'styles.css', element: ['.serp-editor-select', '.serp-editor-select:focus-visible'], why: 'SERP: Edit search\'s and Track this search\'s selects, focused (they had no focus style of their own)' },
  // The Changes panel, Projects, Rankings, Inspector and the screenshot editor (their surface PR): every
  // control of their own (their .panel-button, .seo-action, .seo-segment and .seo-select are the shared ones'),
  // in each state it can be focused in. A row's ring is drawn above its neighbours, inside its box's padding.
  {
    stylesheet: 'styles.css',
    element: ['.changes-version', CHANGES_VERSION_HOVER, '.changes-version:focus-visible'],
    why: 'a version in the Changes panel\'s history, focused (it chooses the diff) and hovered',
  },
  {
    stylesheet: 'styles.css',
    element: ['.changes-version', ".changes-version[aria-pressed='true']", '.changes-version:focus-visible'],
    why: 'the chosen version, focused: its --accent edge is a border, so the ring stays',
  },
  { stylesheet: 'styles.css', element: ['.changes-project-select', '.changes-project-select:focus-visible'], why: 'the Changes panel\'s project picker, focused' },
  { stylesheet: 'styles.css', element: ['.projects-close', '.projects-close:hover', '.projects-close:focus-visible'], why: 'the Projects sheet\'s Close, focused and hovered' },
  {
    stylesheet: 'styles.css',
    element: ['.projects-icon-button', '.projects-icon-button:hover', '.projects-icon-button:focus-visible'],
    why: 'a project\'s star and a page\'s or search\'s Remove, focused and hovered',
  },
  { stylesheet: 'styles.css', element: ['.projects-item-open', PROJECTS_ITEM_HOVER, '.projects-item-open:focus-visible'], why: 'a project in the list, focused (it opens the project) and hovered' },
  { stylesheet: 'styles.css', element: ['.projects-input', '.projects-input:focus-visible'], why: 'a Projects field (and the Inspector\'s search and find), focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'styles.css', element: ['.projects-select', '.projects-select:focus-visible'], why: 'a Projects menu (and the Inspector\'s search mode), focused' },
  { stylesheet: 'styles.css', element: ['.projects-small-button', PROJECTS_BUTTON_HOVER, '.projects-small-button:focus-visible'], why: 'a Projects sheet button, focused and hovered: its hover lays --bg-hover in a box-shadow' },
  { stylesheet: 'styles.css', element: ['.projects-entry-open', '.projects-entry-open:focus-visible'], why: 'a page or search in a project, focused (it opens it)' },
  {
    stylesheet: 'rankings.css',
    element: ['.projects-view-tab', '.projects-view-tab:hover', ".projects-view-tab[aria-selected='true']", '.projects-view-tab:focus-visible'],
    why: 'the Projects sheet\'s chosen view, focused and hovered: its --accent underline is a border, so the ring stays',
  },
  { stylesheet: 'rankings.css', element: ['.projects-link-button', '.projects-link-button:hover', '.projects-link-button:focus-visible'], why: 'a page\'s Edit tags link button, focused and hovered' },
  { stylesheet: 'rankings.css', element: ['.rankings-row-open', '.rankings-row-open:focus-visible'], why: 'a search in the rank table, focused (it opens its history; under the pointer only its text turns --accent)' },
  {
    stylesheet: 'styles.css',
    element: ['.inspector-row', '.inspector-row:hover', '.inspector-item:focus-visible > .inspector-row'],
    why: 'a node in the Inspector\'s tree, focused (the tree\'s roving focus is on its item) and hovered',
  },
  {
    stylesheet: 'styles.css',
    element: ['.inspector-row', ".inspector-row[data-selected='true']", '.inspector-item:focus-visible > .inspector-row'],
    why: 'the selected node, focused: its --accent edge is a border, so the ring stays',
  },
  {
    stylesheet: 'styles.css',
    element: ['.inspector-row', '.inspector-match', '.inspector-row:hover', '.inspector-match:focus-visible'],
    why: 'a search match in the Inspector, focused and hovered (it was an inset --accent line)',
  },
  {
    stylesheet: 'styles.css',
    element: ['.seo-action', SEO_ACTION_HOVER, ".inspector-view-button[aria-pressed='true']", '.seo-action:focus-visible'],
    why: 'the Inspector\'s chosen view, focused: its pressed rule sets no box-shadow, so the shared ring stays',
  },
  {
    stylesheet: 'styles.css',
    element: ['.shot-editor-swatch', ".shot-editor-swatch[aria-pressed='true']", '.shot-editor-swatch:focus-visible'],
    why: 'the screenshot editor\'s chosen colour, focused (it had the browser\'s default outline)',
  },
  { stylesheet: 'styles.css', element: ['.shot-editor-text', '.shot-editor-text:focus-visible'], why: 'the screenshot editor\'s text field, focused' },
  // The panel stylesheets (their surface PR): every control of their own, in each state it can be focused in.
  { stylesheet: 'gsc-panel.css', element: ['.gsc-tile', GSC_TILE_HOVER, '.gsc-tile:focus-visible'], why: 'a Search Console total tile, focused and hovered' },
  {
    stylesheet: 'gsc-panel.css',
    element: ['.gsc-tile', ".gsc-tile[aria-pressed='true']", '.gsc-tile:focus-visible', ".gsc-tile[aria-pressed='true']:focus-visible"],
    insetBefore: 'inset 0 0 0 1px var(--accent)',
    why: 'the tile the chart shows, focused: --focus-ring after its pressed inner line, so both its edges stay',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', CHIP_HOVER, ".seo-chip-button.gsc-dates[data-active='true']", '.seo-chip-button:focus-visible'],
    why: 'Search Console\'s custom dates in force, focused and hovered',
  },
  {
    stylesheet: 'gsc-panel.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-select', ".gsc .gsc-select[data-active='true']", '.seo-select:focus-visible'],
    why: 'a Search Console filter in force, focused',
  },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-nav', GSC_CAL_NAV_HOVER, '.gsc-cal-nav:focus-visible'], why: 'the calendar\'s previous or next month, focused and hovered' },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', GSC_CAL_DAY_HOVER, '.gsc-cal-day:focus-visible'], why: 'a calendar day, focused (the grid\'s roving focus) and hovered' },
  { stylesheet: 'gsc-panel.css', element: ['.gsc-cal-day', ".gsc-cal-day[aria-selected='true']", '.gsc-cal-day:focus-visible'], why: 'a calendar day inside the chosen range, focused' },
  {
    stylesheet: 'gsc-panel.css',
    element: ['.gsc-cal-day', ".gsc-cal-day[aria-selected='true']", ".gsc-cal-day[data-edge='true']", '.gsc-cal-day:focus-visible'],
    why: 'the chosen range\'s first or last day, focused',
  },
  {
    stylesheet: 'ai-checks.css',
    loadsBefore: ['styles.css'],
    element: ['.seo-chip-button', CHIP_HOVER, ".seo-chip-button.ai-judgment-action[aria-disabled='true']", '.seo-chip-button:focus-visible'],
    why: 'the AI judgment card\'s Check with AI while its call runs (aria-disabled, still focusable), focused and hovered: it faded to 0.6, dimming the ring',
  },
  { stylesheet: 'ai-answers.css', element: ['.ai-answers-input', '.ai-answers-input:focus-visible'], why: 'the AI answers sheet\'s query and watched-domain fields, focused' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answers-select', '.ai-answers-select:focus-visible'], why: 'the AI answers sheet\'s engine, retention and "reach through" selects, focused' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answers-pick', AI_ANSWERS_PICK_HOVER, '.ai-answers-pick:focus-visible'], why: 'an AI answer in the list, focused and hovered' },
  { stylesheet: 'ai-answers.css', element: ['.ai-answers-pick', ".ai-answers-pick[aria-pressed='true']", '.ai-answers-pick:focus-visible'], why: 'the AI answer the sheet shows, focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-input', '.crawl-input:focus-visible'], why: 'a crawl field (start URL, page cap, include and exclude rules), focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-select', '.crawl-select:focus-visible'], why: 'a crawl select (scope, pace, the Pages filters and sort), focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-rules-more > summary', '.crawl-rules-more > summary:focus-visible'], why: 'the crawl rule set\'s "what is left out" disclosure, focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-run-pick', '.crawl-run-pick:focus-visible'], why: 'a crawl run\'s name (it shows the run), focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-tab', CRAWL_TAB_HOVER, '.crawl-tab:focus-visible'], why: 'the crawl sheet\'s Pages or Site structure, focused and hovered' },
  { stylesheet: 'crawl.css', element: ['.crawl-tab', ".crawl-tab[aria-pressed='true']", '.crawl-tab:focus-visible'], why: 'the chosen view, focused: its --e-raised edge gives way to --focus-ring' },
  { stylesheet: 'crawl.css', element: ['.crawl-tree-toggle', '.crawl-tree-toggle:focus-visible'], why: 'a folder in the site structure (it opens), focused' },
  { stylesheet: 'crawl.css', element: ['.crawl-link-button', '.crawl-link-button:hover', '.crawl-link-button:focus-visible'], why: 'a crawl page\'s Open in tab, focused and hovered' },
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
 * and `--bg-hover` are the same fill, and the active tab's is within 1.02:1 of it (`--e-raised` is about
 * 1.28:1 on the window), so fills cannot say which tab is active. The active tab carries a cue that
 * does not depend on fill: a 2px `activeIndicator` line along its foot (`activeIndicatorShadow`, an
 * inset box-shadow beside `--e-raised`), which stands at least `minIndicator` (3:1, WCAG 1.4.11) off the
 * active tab's fill, off an inactive and a hovered tab's and off the strip under it, in both themes.
 * `activeTab` lists the selectors the active tab matches in `styles.css`, and `activeTabHovered` those
 * it matches under the pointer: each cascade gives a `box-shadow` holding `activeIndicatorShadow`. A
 * focused active tab shows `--focus-ring` in its place (`FOCUS_RING_RULES`), and under forced colours,
 * which drop box-shadows, its 1px transparent outline marks it.
 */
export const TAB_STRIP = {
  strip: '--bg-window',
  idle: '--bg-tab-idle',
  hover: '--bg-hover',
  active: '--bg-surface',
  minActiveOnStrip: 1.1,
  minIdleOnStrip: 1.09,
  minHoverOnStrip: 1.1,
  activeIndicator: '--accent',
  activeIndicatorShadow: 'inset 0 -2px 0 var(--accent)',
  minIndicator: 3,
  activeTab: ['.tab', ".tab[data-active='true']"],
  /** The hover rule (`.tab:hover:where(:not([data-active='true']))`) never matches the active tab; these would. */
  activeTabHovered: ['.tab', ".tab[data-active='true']", '.tab:hover', ".tab[data-active='true']:hover"],
} as const satisfies {
  readonly strip: TokenName;
  readonly idle: TokenName;
  readonly hover: TokenName;
  readonly active: TokenName;
  readonly minActiveOnStrip: number;
  readonly minIdleOnStrip: number;
  readonly minHoverOnStrip: number;
  readonly activeIndicator: TokenName;
  readonly activeIndicatorShadow: string;
  readonly minIndicator: number;
  readonly activeTab: readonly string[];
  readonly activeTabHovered: readonly string[];
};

// ---- Fonts (bundled in the values step; applied per surface through the --text-* tokens) ----

/**
 * The renderer stylesheet (relative to `apps/desktop/src/renderer/`) that declares the bundled
 * fonts: only `@font-face` rules, one per `BUNDLED_FONTS` entry. `main.tsx` imports it right after
 * `TOKENS_STYLESHEET`. It applies no font itself: text draws Geist through the `--text-*` type tokens,
 * since the base face's PR the body's too (`BASE_TYPE`), so Geist 400 is drawn from launch.
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

// ---- The base face (the body, and the text that inherited it) ----

/**
 * The app's base type: in `stylesheet`, `selector`'s `font` is exactly `var(<font>)`, the canvas's base
 * (every board of the design canvas sets Geist 13px/1.45, `--text-body`, on its root, and its buttons
 * `font: inherit`). So text that sets no font of its own draws Geist at the body size, never the system
 * stack (`--font-ui`, `removed`). No other rule of a renderer stylesheet sets a font on `html`, `:root` or
 * `body`. Form controls draw the font of the element around them only where a rule says so (Chromium's
 * own stylesheet gives them a system font): the `inherit` elements take `font: inherit` in one rule
 * (`button, input`, as before), and a `select` or a `textarea` sets its own type through its class.
 */
export const BASE_TYPE = { stylesheet: 'styles.css', selector: 'body', font: '--text-body', inherit: ['button', 'input'] } as const;

/**
 * Text that drew in the body's face because nothing around it set a font: since the base face it sets its
 * own type, a `--text-*` token, rather than lean on `BASE_TYPE`. For each entry, in light and dark, the
 * cascade over `element` (each selector one of the stylesheets') in `stylesheet` (and each of its `loadsBefore`, read after it) resolves `font`
 * to `var(<font>)`, with a `font` shorthand resetting the weight and style set before it; then
 * `font-weight` to `weight` and `font-style` to `style` when the entry names them (a compound class's
 * italic or emphasis, which the shorthand would otherwise drop), and to nothing set when it doesn't.
 *
 * The SEO panels' wrapper (`.seo`) and `.panel-button` set no font, so before the base face six texts in
 * the visual baseline drew the system stack: the `.panel-button` labels Compliance's "Run accessibility
 * check", JavaScript's "Fetch again", SERP's "Check for selector updates", Visibility's "Enable on-device
 * intent" and "Classify", and JavaScript's "Not set". A `.panel-button` is the app's secondary button
 * (the canvas draws its label as body text at `TEXT_BODY_EMPHASIS_WEIGHT`), so it sets that itself in every
 * panel it sits in; a panel that wants another face for its button says so in a rule naming both classes
 * (`.panel-button.x`), which wins whatever the order of the stylesheets, as its colours do. A missing
 * value (`.seo-missing`, a modifier: its colour and italic) takes the type of the value it stands in
 * for: in a JavaScript field that is `.seo-js-value`'s `--text-small`.
 *
 * And three blocks whose text sets its own type but whose line box came from the body's line height (a
 * block's strut is its own font, so lines of smaller inline text were the body's 18.2px tall): the
 * computed-style comparison of every capture found them, grown 0.65px a line by the base face's 1.45.
 * Each takes the type of the text it holds, so its lines are that text's: Page Speed's "Since the page
 * loaded" header (its caps eyebrow), Content's result preview description row (its date and description,
 * `--text-small`: three lines are 50.4px, where they were 54.6) and Help's key hints (`--text-small`, as
 * its "or"; the hints' own boxes are taller, so nothing moves). Review found a fourth by rendering a state
 * no capture shows: JavaScript's "Served HTML unavailable" card, whose first line is its inline eyebrow.
 * There the eyebrow takes a line of its own (`display`: `block`), so the line is the eyebrow's `--text-micro`
 * (14.3px), as in the other verdict cards, whose eyebrows sit in a flex head. Not the card's `font`: a
 * `--text-micro` block needs its tracking beside it, which its summary, facts and button would inherit.
 * Only that state has an eyebrow directly in the card (`.seo-js-state > .seo-eyebrow`).
 *
 * `.panel-button` used to inherit its container's type, so a panel whose container set another size drew
 * its buttons in that: Rankings' API-check notice (`.rankings-notice`, `--text-small`), whose Send and
 * Cancel were 12px at 500. They are 13px now, as AI answers' Send and Cancel already were: a secondary
 * button is one size everywhere, and no exception rule keeps the old size.
 *
 * What the check cannot see: `resolveOnElement` reads only the rules whose selector names the element, so a
 * type an element used to inherit from its container is invisible to it. The changes inheritance made (the
 * Rankings notice's buttons, the JavaScript card) were found by rendering, not by `text-type-rules-resolve`.
 */
export interface TextTypeRule extends LoadsBefore {
  readonly stylesheet: string;
  readonly element: readonly string[];
  readonly font: TokenName;
  readonly weight?: string;
  readonly style?: 'italic';
  /** A `display` the element must also resolve to (an inline label given a line of its own). */
  readonly display?: 'block';
  readonly why: string;
}

const SECONDARY_BUTTON = "the app's secondary button: its label body text at the emphasis weight (the canvas's buttons), in every panel";

export const TEXT_TYPE_RULES = [
  { stylesheet: 'styles.css', element: ['.panel-button'], font: '--text-body', weight: '500', why: `${SECONDARY_BUTTON}: SERP's "Check for selector updates", Visibility's "Enable on-device intent" and "Classify" (system text before); in every other panel it inherited --text-body at 500 already, but Rankings' API-check notice, where it inherited the notice's --text-small (12px)` },
  { stylesheet: 'rankings.css', loadsBefore: ['styles.css'], element: ['.panel-button'], font: '--text-body', weight: '500', why: "Rankings' API-check notice's Send and Cancel: 13px now (12px before, from .rankings-notice's --text-small), as AI answers' Send and Cancel" },
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button-primary'], font: '--text-body', weight: '500', why: `${SECONDARY_BUTTON}, primary: Compliance's "Run accessibility check" (system text before; its .seo-a11y-run sets no type)` },
  { stylesheet: 'styles.css', element: ['.panel-button', '.seo-js-refetch'], font: '--text-body', weight: '500', why: `JavaScript's "Fetch again" (system text before)` },
  { stylesheet: 'styles.css', element: ['.panel-button', '.panel-button-primary', '.seo-hint-button'], font: '--text-body', weight: '500', why: "the SEO sidebar's Retry" },
  // The panel stylesheets' buttons: their own rules come first, styles.css after (loadsBefore).
  { stylesheet: 'ai-answers.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button.ai-answers-danger'], font: '--text-body', weight: '500', why: "AI answers' Delete" },
  { stylesheet: 'crawl.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button.crawl-danger'], font: '--text-body', weight: '500', why: "the crawl sheet's Delete" },
  { stylesheet: 'gsc-panel.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button-primary', '.gsc-notice-button'], font: '--text-body', weight: '500', why: "Search Console's notice button" },
  { stylesheet: 'rankings.css', loadsBefore: ['styles.css'], element: ['.panel-button', '.panel-button-primary', '.projects-bulk-form > .panel-button'], font: '--text-body', weight: '500', why: "Bulk add's Add" },
  // Blocks whose line box was the body's: each takes the type of the text it holds.
  { stylesheet: 'styles.css', element: ['.seo-speed-since'], font: '--text-caps', why: 'Page Speed\'s "Since the page loaded" header: its eyebrow\'s type' },
  { stylesheet: 'styles.css', element: ['.seo-serp-description-row'], font: '--text-small', why: "Content's result preview: the description row, its date's and description's type" },
  { stylesheet: 'help.css', element: ['.shortcuts-keys'], font: '--text-small', why: 'Help\'s keyboard shortcuts: a shortcut\'s key hints, the type of their "or"' },
  { stylesheet: 'styles.css', element: ['.seo-eyebrow', '.seo-js-state > .seo-eyebrow'], font: '--text-micro', display: 'block', why: 'JavaScript\'s "Served HTML unavailable" card: its eyebrow, the card\'s first line, on a line of its own' },
  // JavaScript's "Not set": a field's missing value, the type of the value beside it (.seo-js-value), italic.
  { stylesheet: 'styles.css', element: ['.seo-missing', '.seo-js-field .seo-missing'], font: '--text-small', style: 'italic', why: `JavaScript's "Not set" (system text before), where a field's value is --text-small` },
] as const satisfies readonly TextTypeRule[];
