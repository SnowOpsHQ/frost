// Spec: specs/design-tokens.spec.ts (SIGNAL_TOKENS, LEGACY_TOKEN_MIGRATION, CONTRAST_PAIRS, SIGNAL_SURFACES, HEX_COLOUR_RATCHET)
// Acceptance: specs/design-tokens.feature.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  BUNDLED_FONTS,
  CONTRAST_PAIRS,
  FOCUS_RING_RULES,
  FORCED_COLOURS_BUSY,
  FORCED_COLOURS_KEPT,
  FORCED_COLOURS_PRESSED,
  FORCED_COLOURS_SYSTEM_COLOURS,
  HEX_COLOUR_RATCHET,
  KNOWN_CONTRAST_EXCEPTIONS,
  LEGACY_TOKEN_MIGRATION,
  SIGNAL_NAMES_WITH_LEGACY_VALUES,
  SIGNAL_SURFACES,
  SIGNAL_TOKENS,
  TAB_STRIP,
  TEXT_COLOUR_RULES,
  THEMED_SIGNAL_GROUPS,
  TOKENS_STYLESHEET,
  type ContrastException,
  type ContrastPair,
  type FocusRingRule,
  type ForcedColoursBusy,
  type LegacyTokenMigration,
  type SignalSurface,
  type TextColourRule,
  type SignalToken,
  type SignalTokenGroup,
} from '@app/specs/design-tokens.spec';
import { SIDEBAR_PANEL_WIDTH, SIDEBAR_RAIL_WIDTH } from '@app/specs/seo-sidebar.spec';

const RENDERER = fileURLToPath(new URL('../renderer/', import.meta.url));
const read = (relative: string) => readFileSync(`${RENDERER}${relative}`, 'utf8');

/** Every file under the renderer, relative to it. */
const RENDERER_FILES = (readdirSync(RENDERER, { recursive: true }) as string[]).map((name) => name.replaceAll('\\', '/')).sort();
/** Every stylesheet under the renderer, relative to it. */
const STYLESHEETS = RENDERER_FILES.filter((name) => name.endsWith('.css'));
/** The renderer's sources: its stylesheets, its scripts and its page (inline styles can read a token too). */
const RENDERER_SOURCES = RENDERER_FILES.filter((name) => /\.(css|tsx?|html)$/.test(name));
const MIGRATION: readonly LegacyTokenMigration[] = LEGACY_TOKEN_MIGRATION;
const REMOVED: readonly string[] = MIGRATION.filter((row) => row.removed === true).map((row) => row.legacy);

const DARK = '@media (prefers-color-scheme: dark)';
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** A source without its comments: block comments, `//` line comments in scripts (not `://`), HTML comments. */
const stripSourceComments = (name: string, text: string) => {
  const blockless = stripComments(text);
  if (/\.tsx?$/.test(name)) return blockless.replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (name.endsWith('.html')) return blockless.replace(/<!--[\s\S]*?-->/g, '');
  return blockless;
};

interface Declaration {
  /** The enclosing at-rule preludes and selectors, outermost first, whitespace collapsed. */
  readonly context: readonly string[];
  readonly property: string;
  readonly value: string;
  /** The index (in `blocks`) of the block that holds it. */
  readonly block: number;
}

/** The declarations of `css`, each with its context, and the context of every block. (The
 * renderer's CSS has no braces or semicolons inside strings, so a brace walk is enough.) */
function parse(css: string): { declarations: Declaration[]; blocks: string[][] } {
  const declarations: Declaration[] = [];
  const blocks: string[][] = [];
  const stack: string[] = [];
  const ids: number[] = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    const colon = text.indexOf(':');
    if (colon > 0) {
      declarations.push({ context: [...stack], property: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim().replace(/\s+/g, ' '), block: ids.at(-1) ?? -1 });
    }
    buffer = '';
  };
  for (const ch of stripComments(css)) {
    if (ch === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      ids.push(blocks.length);
      blocks.push([...stack]);
      buffer = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
      ids.pop();
    } else if (ch === ';') {
      flush();
    } else {
      buffer += ch;
    }
  }
  return { declarations, blocks };
}

const customProperties = (css: string) => parse(css).declarations.filter((d) => d.property.startsWith('--'));

/** Whether a selector list may target the document element: a selector that starts with `:root` or
 * `html` (`html.dark`, `:root[data-theme]`, `:where(:root)`, … too; a descendant of it counts as
 * well, which is stricter than needed). */
const onRoot = (selectors: string) =>
  selectors.split(',').some((s) => /^(?::(?:where|is)\(\s*)?(?::root|html)(?![\w-])/.test(s.trim()));

const TOKENS_CSS = parse(read(TOKENS_STYLESHEET));
const TOKENS = TOKENS_CSS.declarations;
const inContext = (context: readonly string[]) =>
  new Map(TOKENS.filter((d) => d.context.join(' > ') === context.join(' > ')).map((d) => [d.property, d.value]));
const LIGHT = inContext([':root']);
const DARK_VALUES = inContext([DARK, ':root']);
const GROUPS = Object.entries(SIGNAL_TOKENS) as [SignalTokenGroup, readonly SignalToken[]][];
const SIGNAL_NAMES = new Set<string>(GROUPS.flatMap(([, tokens]) => tokens.map((token) => token.name)));

/** An sRGB colour, channels 0–255, alpha 0–1. */
type Rgba = readonly [r: number, g: number, b: number, a: number];

/** `#rgb`, `#rrggbb` or `rgb(r g b / a)` (the notations `tokens.css` uses for colours). */
function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).concat(1) as unknown as Rgba;
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`not a colour: ${value}`);
}

/** `top` laid over the opaque `bottom` (source-over). */
const composite = (top: Rgba, bottom: Rgba): Rgba =>
  [0, 1, 2].map((i) => (top[i] ?? 0) * top[3] + (bottom[i] ?? 0) * (1 - top[3])).concat(1) as unknown as Rgba;

/** WCAG 2.x relative luminance of an opaque colour. */
function luminance([r, g, b]: Rgba): number {
  const lin = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio of two opaque colours (1–21). */
function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Each theme's declared values: dark is light with the dark block's overrides. */
const THEMES = { light: LIGHT, dark: new Map([...LIGHT, ...DARK_VALUES]) };
const THEME_NAMES = ['light', 'dark'] as const;

/** A token's colour in a theme, following `var()` references in the same theme. */
function colourIn(theme: keyof typeof THEMES, name: string): Rgba {
  const values = THEMES[theme];
  const seen = new Set<string>();
  for (let current = name; ; ) {
    if (seen.has(current)) throw new Error(`${name}: var() cycle through ${current} (${theme})`);
    seen.add(current);
    const raw = values.get(current);
    if (raw === undefined) throw new Error(`${name}: ${current} is not declared (${theme})`);
    const ref = /^var\((--[\w-]+)\)$/.exec(raw)?.[1];
    if (ref === undefined) return parseColour(raw);
    current = ref;
  }
}

test('tokens-stylesheet-holds-only-root-tokens', () => {
  expect(STYLESHEETS).toContain(TOKENS_STYLESHEET);
  // tokens.css has :root blocks only, light or dark (no other selector, no other at-rule), and they
  // hold custom properties only.
  for (const block of TOKENS_CSS.blocks) expect([[':root'], [DARK], [DARK, ':root']], block.join(' > ')).toContainEqual(block);
  for (const d of TOKENS) {
    expect(d.property, d.property).toMatch(/^--/);
    expect([[':root'], [DARK, ':root']], `${d.property} in ${d.context.join(' > ')}`).toContainEqual(d.context);
  }
  // Nothing declared twice in one context (a later duplicate would silently win).
  const seen = new Set<string>();
  for (const d of TOKENS) {
    const key = `${d.context.join(' > ')} ${d.property}`;
    expect(seen.has(key), key).toBe(false);
    seen.add(key);
  }
  // A dark value only ever overrides a light one.
  for (const name of DARK_VALUES.keys()) expect(LIGHT.has(name), name).toBe(true);
});

test('signal-tokens-are-defined', () => {
  const themed = new Set<SignalTokenGroup>(THEMED_SIGNAL_GROUPS);
  for (const [group, tokens] of GROUPS) {
    for (const token of tokens) {
      const label = `${group} ${token.name}`;
      expect(LIGHT.has(token.name), label).toBe(true);
      if (themed.has(group)) {
        expect(token.dark, label).toBeDefined();
        expect(DARK_VALUES.has(token.name), `${label} (dark)`).toBe(true);
      } else {
        expect(token.dark, label).toBeUndefined();
        expect(DARK_VALUES.has(token.name), `${label} (dark)`).toBe(false);
      }
      // Every Signal token carries exactly its Signal value, the shared names included.
      expect(LIGHT.get(token.name), label).toBe(token.light);
      if (token.dark !== undefined) expect(DARK_VALUES.get(token.name), `${label} (dark)`).toBe(token.dark);
    }
  }
  // The shared names are Signal tokens, and `--icon` stays a colour beside the `--icon-size` size.
  for (const name of SIGNAL_NAMES_WITH_LEGACY_VALUES) expect(SIGNAL_NAMES.has(name), name).toBe(true);
  expect(SIGNAL_NAMES.has('--icon')).toBe(false);
  expect(LIGHT.get('--icon')).toMatch(/^#[0-9a-f]{6}$/i);
});

test('legacy-tokens-are-defined', () => {
  const legacy: string[] = LEGACY_TOKEN_MIGRATION.map((row) => row.legacy);
  expect(legacy).toHaveLength(89);
  expect(new Set(legacy).size).toBe(legacy.length);
  for (const name of legacy) if (!REMOVED.includes(name)) expect(LIGHT.has(name), name).toBe(true);
  // tokens.css holds the legacy names and the Signal vocabulary, nothing else.
  for (const name of LIGHT.keys()) expect(legacy.includes(name) || SIGNAL_NAMES.has(name), name).toBe(true);
  // Every replacement named is a Signal token (`--text-*` is the type scale).
  for (const row of LEGACY_TOKEN_MIGRATION) {
    if (row.signal === null) continue;
    if (row.signal === '--text-*') expect(row.legacy).toBe('--font-ui');
    else expect(SIGNAL_NAMES.has(row.signal), `${row.legacy} -> ${row.signal}`).toBe(true);
  }
});

test('removed-legacy-tokens-are-gone', () => {
  for (const row of MIGRATION) if (row.removed === true) expect(row.kind, `${row.legacy} is removed, so retired`).toBe('retire');
  // The command palette's surface PR removed its retired names (the rollout only ever adds to this).
  expect(REMOVED).toEqual(expect.arrayContaining(['--palette-edge', '--palette-shadow', '--palette-sheet', '--palette-row-active', '--palette-hit', '--palette-kbd-bg', '--palette-kbd-edge']));
  // The new-tab view's surface PR.
  expect(REMOVED).toEqual(expect.arrayContaining(['--start-mark', '--start-glow', '--jump-tile-edge', '--jump-monogram-bg']));
  // So did the agent panel's.
  expect(REMOVED).toEqual(expect.arrayContaining(['--agent-edge', '--agent-user', '--agent-code-bg', '--agent-approval-edge', '--agent-approval-bg']));
  // And Settings and Help's.
  expect(REMOVED).toEqual(expect.arrayContaining(['--settings-switch-off']));
  // And the SEO sidebar's frame (its skeleton's names; the panels still read the other --seo-* names).
  expect(REMOVED).toEqual(expect.arrayContaining(['--seo-skeleton', '--seo-skeleton-shine']));
  for (const name of REMOVED) {
    expect(LIGHT.has(name), `${name} (light)`).toBe(false);
    expect(DARK_VALUES.has(name), `${name} (dark)`).toBe(false);
    // `--palette-sheet` must not match `--palette-sheet-height`.
    const mention = new RegExp(`${name}(?![\\w-])`);
    for (const file of RENDERER_SOURCES) expect(mention.test(stripSourceComments(file, read(file))), `${file} mentions ${name}`).toBe(false);
  }
});

test('legacy-token-values-are-pinned', () => {
  // Every change to a legacy value is on purpose: the foundation pinned main's values before Signal,
  // and the values step re-pointed the aliases and swapped the shared names (its diff lists each).
  const pick = (values: Map<string, string>) =>
    Object.fromEntries(LEGACY_TOKEN_MIGRATION.filter((row) => values.has(row.legacy)).map((row) => [row.legacy, values.get(row.legacy)]));
  expect({ light: pick(LIGHT), dark: pick(DARK_VALUES) }).toMatchSnapshot();
});

test('legacy-aliases-point-at-signal-tokens', () => {
  for (const row of LEGACY_TOKEN_MIGRATION) {
    if (row.kind !== 'alias' || row.signal === null) continue;
    if (row.signal === row.legacy) continue; // a self-alias: signal-tokens-are-defined checks its value
    // One light declaration, exactly var(<signal>); dark follows the Signal token's own dark value.
    expect(LIGHT.get(row.legacy), row.legacy).toBe(`var(${row.signal})`);
    expect(DARK_VALUES.has(row.legacy), `${row.legacy} (dark)`).toBe(false);
  }
  // The self-aliases are exactly the shared names.
  const selfAliases = LEGACY_TOKEN_MIGRATION.filter((row) => row.kind === 'alias' && row.signal === row.legacy).map((row) => row.legacy);
  expect([...selfAliases].sort()).toEqual([...SIGNAL_NAMES_WITH_LEGACY_VALUES].sort());
  // The sidebar's widths now come from Signal; they still match the layout constants in the sidebar spec.
  expect(LIGHT.get('--w-panel')).toBe(`${SIDEBAR_PANEL_WIDTH}px`);
  expect(LIGHT.get('--w-rail')).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
});

test('signal-contrast-meets-aa', () => {
  // The ratio helper against known values.
  expect(contrastRatio(parseColour('#000'), parseColour('#ffffff'))).toBeCloseTo(21, 5);
  expect(contrastRatio(parseColour('#777'), parseColour('#fff'))).toBeCloseTo(4.48, 2);
  expect(composite(parseColour('rgb(0 0 0 / 0.5)'), parseColour('#ffffff'))).toEqual([127.5, 127.5, 127.5, 1]);
  // A tint (color-mix with transparent) composites like the token at that opacity.
  expect(composite([0, 0, 0, 0.14], parseColour('#ffffff'))[0]).toBeCloseTo(219.3, 5);

  const pairs: readonly ContrastPair[] = CONTRAST_PAIRS;
  expect(pairs.length).toBeGreaterThan(0);
  for (const theme of THEME_NAMES) {
    const colour = (name: string) => colourIn(theme, name);
    for (const pair of pairs) {
      const label = `${pair.fg} on ${pair.bg}${pair.over ? ` over ${pair.over}` : ''} (${theme})`;
      let bg = colour(pair.bg);
      if (pair.alpha !== undefined) bg = [bg[0], bg[1], bg[2], bg[3] * pair.alpha];
      if (bg[3] < 1) {
        expect(pair.over, `${label}: a translucent background needs \`over\``).toBeDefined();
        const surface = colour(pair.over ?? pair.bg);
        expect(surface[3], `${label}: \`over\` must be opaque`).toBe(1);
        bg = composite(bg, surface);
      }
      const fg = composite(colour(pair.fg), bg);
      expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(pair.min);
    }
  }
});

test('known-contrast-exceptions-are-current', () => {
  const pairs: readonly { fg: string; bg: string; min: number }[] = CONTRAST_PAIRS;
  const exceptions: readonly ContrastException[] = KNOWN_CONTRAST_EXCEPTIONS;
  for (const exception of exceptions) {
    const label = `${exception.fg} on ${exception.bg}`;
    const ratios = THEME_NAMES.map((theme) => contrastRatio(colourIn(theme, exception.fg), colourIn(theme, exception.bg)));
    expect(Math.min(...ratios), `${label} still misses ${exception.min}:1 somewhere`).toBeLessThan(exception.min);
    expect(
      pairs.some((p) => p.fg === exception.fg && p.bg === exception.bg && p.min === exception.min),
      `${label} is not also a CONTRAST_PAIRS pair`,
    ).toBe(false);
    const uses = STYLESHEETS.flatMap((name) => parse(read(name)).declarations.filter((d) => d.property === 'color' && d.value === `var(${exception.fg})`));
    expect(uses.length, `${label}: rules drawing text in ${exception.fg}`).toBe(exception.rules);
  }
});

test('tab-strip-sets-tabs-off-the-strip', () => {
  for (const theme of THEME_NAMES) {
    const strip = colourIn(theme, TAB_STRIP.strip);
    expect(strip[3], `${TAB_STRIP.strip} is opaque (${theme})`).toBe(1);
    // Each tab's fill, composited over the strip (an inactive and a hovered tab's are translucent).
    const active = composite(colourIn(theme, TAB_STRIP.active), strip);
    const idle = composite(colourIn(theme, TAB_STRIP.idle), strip);
    const hover = composite(colourIn(theme, TAB_STRIP.hover), strip);
    expect(contrastRatio(active, strip), `active tab on the strip (${theme})`).toBeGreaterThanOrEqual(TAB_STRIP.minActiveOnStrip);
    expect(contrastRatio(idle, strip), `inactive tab on the strip (${theme})`).toBeGreaterThanOrEqual(TAB_STRIP.minIdleOnStrip);
    expect(contrastRatio(hover, strip), `hovered tab on the strip (${theme})`).toBeGreaterThanOrEqual(TAB_STRIP.minHoverOnStrip);
    // The active tab's cue that is not fill (WCAG 1.4.11): off its own fill, an inactive or hovered tab's,
    // and the strip under it.
    const indicator = composite(colourIn(theme, TAB_STRIP.activeIndicator), strip);
    for (const [fill, colour] of [['the active tab', active], ['an inactive tab', idle], ['a hovered tab', hover], ['the strip', strip]] as const) {
      // Soft: every pair that misses is reported, not only the first.
      expect.soft(contrastRatio(indicator, colour), `${TAB_STRIP.activeIndicator} on ${fill} (${theme})`).toBeGreaterThanOrEqual(TAB_STRIP.minIndicator);
    }
    // ... and the active tab really draws it, its whole term, also under the pointer.
    const css = read('styles.css');
    expect(TAB_STRIP.activeIndicatorShadow).toContain(`var(${TAB_STRIP.activeIndicator})`);
    for (const [state, element] of [['active', TAB_STRIP.activeTab], ['active and hovered', TAB_STRIP.activeTabHovered]] as const) {
      expect(resolveOnElement(css, element, 'box-shadow', theme), `the ${state} tab's box-shadow (${theme})`).toContain(TAB_STRIP.activeIndicatorShadow);
    }
  }
});

/** `text` without each `:where(…)` (parentheses balanced): it adds no specificity. */
function withoutWhere(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith(':where(', i)) {
      let depth = 0;
      let j = i + ':where'.length;
      do {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
        j += 1;
      } while (depth > 0 && j < text.length);
      i = j;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** A selector list split at its top-level commas (never inside `:not(a, b)` or `:where(…)`). */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  return [...parts, current];
}

/** `@media (forced-colors: active)`, as the parser writes the at-rule. */
const FORCED_COLOURS_MEDIA = /^@media\s*\(\s*forced-colors\s*:\s*active\s*\)$/;

/** A selector's specificity as one number (ids aside: the renderer's rules use none; `:where()` adds none). */
function specificity(raw: string): number {
  const selector = withoutWhere(raw);
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!not\(|is\(|where\()[\w-]+/g)?.length ?? 0;
  const types = selector.replace(/\[[^\]]+\]|\([^)]*\)/g, '').match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return classes * 1000 + types;
}

/**
 * The value `property` resolves to for an element matching exactly the selectors `element` in `css`:
 * rules whose selector list holds one of them (top level, or in the dark media block for dark),
 * ordered by specificity then source order; custom properties set by those rules followed through
 * `var()`. Returns the final value (a `var(--token)` that the element itself does not set).
 */
function resolveOnElement(css: string, element: readonly string[], property: string, theme: 'light' | 'dark', options: { readonly forced?: boolean } = {}): string {
  const wanted = new Set(element.map((s) => s.replace(/\s+/g, ' ').trim()));
  const matched: { order: number; spec: number; property: string; value: string }[] = [];
  parse(css).declarations.forEach((d, order) => {
    const outer = d.context.slice(0, -1);
    // Top level; the dark block in dark; and with `forced`, the forced-colours block (forced colours on).
    const applies = (level: string) => (theme === 'dark' && level === DARK) || (options.forced === true && FORCED_COLOURS_MEDIA.test(level));
    if (!(outer.length === 0 || (outer.length === 1 && applies(outer[0]!)))) return;
    const selectors = splitSelectors(d.context.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim());
    const hits = selectors.filter((s) => wanted.has(s));
    if (hits.length === 0) return;
    matched.push({ order, spec: Math.max(...hits.map(specificity)), property: d.property, value: d.value });
  });
  matched.sort((a, b) => a.spec - b.spec || a.order - b.order);
  const own = new Map<string, string>();
  for (const m of matched) {
    own.set(m.property, m.value);
    // A `border` shorthand sets `border-color` too (its colour is its last word here: `1px solid transparent`).
    if (m.property === 'border') own.set('border-color', m.value.split(' ').at(-1) ?? '');
  }
  let value = own.get(property);
  if (value === undefined) throw new Error(`${element.join(' + ')}: no ${property} (${theme})`);
  const seen = new Set<string>();
  for (let ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1]; ref !== undefined && own.has(ref); ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1]) {
    if (seen.has(ref)) throw new Error(`${element.join(' + ')}: var() cycle through ${ref}`);
    seen.add(ref);
    value = own.get(ref)!;
  }
  return value;
}

test('text-colour-rules-resolve', () => {
  // The resolver itself: specificity, then source order; a component property followed.
  const sample = `.a { color: var(--x); --t: var(--one); } .a[data-k='v'] { --t: var(--two); } .a { color: var(--t); }
    @media (prefers-color-scheme: dark) { .a { color: var(--three); } }`;
  expect(resolveOnElement(sample, ['.a'], 'color', 'light')).toBe('var(--one)');
  expect(resolveOnElement(sample, ['.a', ".a[data-k='v']"], 'color', 'light')).toBe('var(--two)');
  expect(resolveOnElement(sample, ['.a'], 'color', 'dark')).toBe('var(--three)');
  expect(specificity('.update-button.update-primary:hover:not(:disabled)')).toBe(4000);

  const pairs: readonly { fg: string; bg: string }[] = CONTRAST_PAIRS;
  const rules: readonly TextColourRule[] = TEXT_COLOUR_RULES;
  for (const rule of rules) {
    for (const theme of THEME_NAMES) {
      const css = read(rule.stylesheet);
      expect(resolveOnElement(css, rule.element, 'color', theme), `${rule.element.at(-1)} (${theme})`).toBe(`var(${rule.color})`);
      if (rule.background !== undefined) {
        expect(resolveOnElement(css, rule.element, 'background', theme), `${rule.element.at(-1)} background (${theme})`).toBe(`var(${rule.background})`);
      }
    }
    expect(
      pairs.some((pair) => pair.fg === rule.color && (rule.background === undefined || pair.bg === rule.background)),
      `${rule.color}${rule.background ? ` on ${rule.background}` : ''} has a CONTRAST_PAIRS entry`,
    ).toBe(true);
  }
});

test('focus-rings-outlast-hover-and-busy', () => {
  // The resolver: `:where()` adds nothing, and a comma inside it does not split the list.
  expect(specificity(".a:hover:where(:not([x], :disabled))")).toBe(2000);
  const sample = `.a:hover:where(:not([x], :disabled)), .b { box-shadow: none; } .a:focus-visible { box-shadow: var(--ring); }`;
  expect(resolveOnElement(sample, ['.a:hover:where(:not([x], :disabled))', '.a:focus-visible'], 'box-shadow', 'light')).toBe('var(--ring)');

  const rules: readonly FocusRingRule[] = FOCUS_RING_RULES;
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    const css = read(rule.stylesheet);
    // Every selector named is one of the stylesheet's (a typo would quietly drop out of the cascade).
    const selectors = new Set(parse(css).blocks.flatMap((block) => splitSelectors(block.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim())));
    for (const selector of rule.element) expect(selectors.has(selector), `${rule.stylesheet} has ${selector}`).toBe(true);
    for (const theme of THEME_NAMES) {
      expect(resolveOnElement(css, rule.element, 'box-shadow', theme), `${rule.why} (${theme})`).toBe('var(--focus-ring)');
      expect(resolveOnElement(css, rule.element, 'outline', theme), `${rule.why}: outline (${theme})`).toBe('2px solid transparent');
      // Nothing fades the ring: an opacity, if the element's rules set one, is 1 (only "no opacity" is swallowed).
      const faded = (() => {
        try {
          return resolveOnElement(css, rule.element, 'opacity', theme);
        } catch (error) {
          if (error instanceof Error && error.message.endsWith(`: no opacity (${theme})`)) return '1';
          throw error;
        }
      })();
      expect(faded, `${rule.why}: opacity (${theme})`).toBe('1');
    }
  }
});

test('busy-buttons-show-under-forced-colours', () => {
  // The resolver's forced mode: the forced-colours block joins the cascade, at its specificity and place;
  // a `border` shorthand counts as its colour.
  const sample = `.b { border: 1px solid transparent; color: var(--x); } @media (forced-colors: active) { .b[x] { color: GrayText; } } .b.p[x] { color: var(--y); }`;
  expect(resolveOnElement(sample, ['.b', '.b[x]'], 'color', 'light', { forced: true })).toBe('GrayText');
  expect(resolveOnElement(sample, ['.b', '.b[x]'], 'color', 'light')).toBe('var(--x)');
  expect(resolveOnElement(sample, ['.b', '.b[x]', '.b.p[x]'], 'color', 'light', { forced: true })).toBe('var(--y)');
  expect(resolveOnElement(sample, ['.b'], 'border-color', 'dark', { forced: true })).toBe('transparent');

  const entries: readonly ForcedColoursBusy[] = FORCED_COLOURS_BUSY;
  for (const entry of entries) {
    const css = read(entry.stylesheet);
    const selectors = new Set(parse(css).blocks.flatMap((block) => splitSelectors(block.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim())));
    for (const selector of entry.element) expect(selectors.has(selector), `${entry.stylesheet} has ${selector}`).toBe(true);
    for (const theme of THEME_NAMES) {
      for (const property of ['color', 'border-color']) {
        expect(resolveOnElement(css, entry.element, property, theme, { forced: true }).toLowerCase(), `${entry.why}: ${property} under forced colours (${theme})`).toBe('graytext');
      }
    }
  }
});

test('pressed-toggles-show-under-forced-colours', () => {
  const entries: readonly ForcedColoursBusy[] = FORCED_COLOURS_PRESSED;
  for (const entry of entries) {
    const css = read(entry.stylesheet);
    const selectors = new Set(parse(css).blocks.flatMap((block) => splitSelectors(block.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim())));
    for (const selector of entry.element) expect(selectors.has(selector), `${entry.stylesheet} has ${selector}`).toBe(true);
    for (const theme of THEME_NAMES) {
      expect(resolveOnElement(css, entry.element, 'border-color', theme, { forced: true }).toLowerCase(), `${entry.why}: border-color under forced colours (${theme})`).toBe('highlight');
    }
  }
});

test('status-marks-keep-their-colours-under-forced-colours', () => {
  // The resolver's forced mode reads the forced-colours block for any property.
  const sample = `.d { background: var(--x); } @media (forced-colors: active) { .d { forced-color-adjust: none; } }`;
  expect(resolveOnElement(sample, ['.d'], 'forced-color-adjust', 'light', { forced: true })).toBe('none');
  expect(() => resolveOnElement(sample, ['.d'], 'forced-color-adjust', 'light')).toThrow('no forced-color-adjust');

  const entries: readonly ForcedColoursBusy[] = FORCED_COLOURS_KEPT;
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const css = read(entry.stylesheet);
    const selectors = new Set(parse(css).blocks.flatMap((block) => splitSelectors(block.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim())));
    for (const selector of entry.element) expect(selectors.has(selector), `${entry.stylesheet} has ${selector}`).toBe(true);
    for (const theme of THEME_NAMES) {
      expect(resolveOnElement(css, entry.element, 'forced-color-adjust', theme, { forced: true }), `${entry.why}: forced-color-adjust (${theme})`).toBe('none');
    }
  }
});

test('no-other-stylesheet-declares-root-tokens', () => {
  for (const name of STYLESHEETS) {
    if (name === TOKENS_STYLESHEET) continue;
    for (const d of customProperties(read(name))) {
      expect(d.context.some(onRoot), `${name}: ${d.property} in ${d.context.join(' > ')}`).toBe(false);
    }
  }
});

test('tokens-load-before-every-other-stylesheet', () => {
  const main = read('main.tsx');
  const imports = [...main.matchAll(/^import\s+(?:[^'"\n]+from\s+)?'([^']+)';/gm)].map((m) => m[1] ?? '');
  // First stylesheet imported, and before `App`, whose components import the feature stylesheets.
  expect(imports.filter((path) => path.endsWith('.css'))[0]).toBe(`./${TOKENS_STYLESHEET}`);
  expect(imports.indexOf(`./${TOKENS_STYLESHEET}`)).toBeLessThan(imports.indexOf('./App'));
});

/** Keywords a colour-bearing value on a surface may hold besides `var()` of a Signal token or alias. */
const SURFACE_COLOUR_WORDS = new Set(['transparent', 'currentcolor', 'inherit', 'none', 'solid', 'dashed', 'dotted', 'double', 'inset', 'color-mix', 'in', 'srgb', 'calc', 'min', 'max', 'clamp']);
/** `text-decoration`'s line and style keywords: not colours (a colour in it still needs the allowlist). */
const TEXT_DECORATION_WORDS = new Set(['underline', 'overline', 'line-through', 'wavy']);
/** The CSS system colours, allowed in a surface rule only under `@media (forced-colors: active)`. */
const SYSTEM_COLOURS = new Set<string>(FORCED_COLOURS_SYSTEM_COLOURS);
/** A literal colour in any property: hex or a colour function. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
/** Properties whose value can carry a colour (these, and custom properties, get the colour allowlist). */
const COLOUR_PROPERTY = /^(?:color|background(?:-color|-image)?|border(?:-[a-z-]+)?|outline(?:-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?)$/;

/**
 * What breaks `surface`'s rules in `css` (design-tokens.feature.md, surface-rules-read-signal-tokens).
 * A rule is the surface's when any selector in any level of its context names one of the surface's
 * classes (`selectorPrefix` itself, or it followed by `-…`, on a class boundary: `.palette`,
 * `.chrome .palette-option`; never `.palettes` or `.x-palette`), or when it sits in a `@keyframes`
 * whose name is the prefix's stem or starts with it and `-` (`palette-in`). A surface that lists its
 * `classes` owns only those (each exact, or a `-*` family) and only its listed `keyframes`.
 */
function surfaceProblems(css: string, surface: SignalSurface): { problems: string[]; checked: number; typeRules: number } {
  const aliases = new Set<string>(MIGRATION.filter((row) => row.kind === 'alias').map((row) => row.legacy));
  const tracking = new Map<string, string>(SIGNAL_TOKENS.type.map((token) => [token.name, token.tracking]));
  // The weights BUNDLED_FONTS has per family, and each type token's family (its shorthand's first one).
  const weightsOf = (family: string) => new Set(BUNDLED_FONTS.filter((font) => font.family === family).map((font) => String(font.weight)));
  const familyOf = new Map<string, string>(
    SIGNAL_TOKENS.type.map((token) => [token.name, (/^\S+\s+\S+\s+(.*)$/.exec(token.light)?.[1] ?? '').split(',')[0]!.trim().replace(/^(['"])(.*)\1$/, '$2')]),
  );
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A surface with no prefix lists its classes, so the stem is used only with a prefix.
  const stem = escape((surface.selectorPrefix ?? '').replace(/^\./, ''));
  // Listed classes: `.x` exactly, or `.x-*` as `.x` and its `-…` family; otherwise the prefix's family.
  const pattern =
    surface.classes === undefined
      ? `\\.${stem}(?:-[\\w-]+)?`
      : `\\.(?:${surface.classes.map((name) => (name.endsWith('-*') ? `${escape(name.slice(1, -2))}(?:-[\\w-]+)?` : escape(name.slice(1)))).join('|')})`;
  const ownClass = new RegExp(`${pattern}(?![\\w-])`);
  const ownKeyframes =
    surface.classes === undefined
      ? new RegExp(`^@keyframes\\s+${stem}(?:-[\\w-]+)?$`)
      : new RegExp(`^@keyframes\\s+(?:${(surface.keyframes ?? []).map(escape).join('|') || '(?!)'})$`);
  const owns = (context: readonly string[]) =>
    context.some((level) => (level.startsWith('@') ? ownKeyframes.test(level) : level.split(',').some((selector) => ownClass.test(selector))));
  const all = parse(css).declarations;
  const own = all.filter((d) => owns(d.context));
  // A component-scoped custom property (`--tone-ink`): declared in this stylesheet, neither a Signal nor a legacy name.
  const legacy = new Set<string>(MIGRATION.map((row) => row.legacy));
  const reserved = (name: string) => SIGNAL_NAMES.has(name) || legacy.has(name);
  const components = new Set(all.filter((d) => d.property.startsWith('--') && !reserved(d.property)).map((d) => d.property));
  const problems: string[] = [];
  // A listed class or keyframes must still name a rule: a stale entry guards nothing.
  const { blocks } = parse(css);
  for (const name of surface.classes ?? []) {
    const one = new RegExp(`\\.${name.endsWith('-*') ? `${escape(name.slice(1, -2))}(?:-[\\w-]+)?` : escape(name.slice(1))}(?![\\w-])`);
    if (!blocks.some((context) => context.some((level) => !level.startsWith('@') && one.test(level)))) problems.push(`${surface.name}: listed class ${name} names no rule`);
  }
  for (const name of surface.keyframes ?? []) {
    if (!blocks.some((context) => context.some((level) => new RegExp(`^@keyframes\\s+${escape(name)}$`).test(level)))) problems.push(`${surface.name}: listed keyframes ${name} names no rule`);
  }
  // Only the status marks FORCED_COLOURS_KEPT names may opt out of forced colours.
  const kept = new Set<string>(
    (FORCED_COLOURS_KEPT as readonly ForcedColoursBusy[]).filter((entry) => entry.stylesheet === surface.stylesheet).flatMap((entry) => entry.element.map((s) => s.replace(/\s+/g, ' ').trim())),
  );
  const byBlock = new Map<number, Declaration[]>();
  for (const d of own) {
    if (d.property === 'forced-color-adjust') {
      const unnamed = splitSelectors(d.context.at(-1) ?? '').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => !kept.has(s));
      if (unnamed.length > 0) problems.push(`${surface.name}: ${unnamed.join(', ')} sets forced-color-adjust, but FORCED_COLOURS_KEPT does not name it`);
    }
    byBlock.set(d.block, [...(byBlock.get(d.block) ?? []), d]);
    const label = `${surface.name}: ${d.context.join(' > ')} { ${d.property}: ${d.value} }`;
    if (/var\(\s*--[\w-]+\s*,/.test(d.value)) problems.push(`${label}: a var() fallback`);
    for (const [, name] of d.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      if (!SIGNAL_NAMES.has(name!) && !aliases.has(name!) && !components.has(name!)) problems.push(`${label}: ${name} is neither a Signal token, an alias nor a component property`);
    }
    if (d.property.startsWith('--') && reserved(d.property)) problems.push(`${label}: ${d.property} is a token: only tokens.css declares it`);
    if (COLOUR_LITERAL.test(d.value)) problems.push(`${label}: a literal colour (hex or a colour function)`);
    if (COLOUR_PROPERTY.test(d.property) || d.property.startsWith('--')) {
      // Only var() of a token (no fallback), the keywords above, numbers and lengths.
      const rest = d.value.replace(/var\(\s*--[\w-]+\s*\)/g, ' ').toLowerCase();
      const words = rest.replace(/-?\d*\.?\d+[a-z%]*/g, ' ').match(/[a-z][\w-]*/g) ?? [];
      const decoration = d.property.startsWith('text-decoration');
      // Inside `@media (forced-colors: active)` only, the CSS system colours (GrayText for a busy button).
      const forced = d.context.some((level) => FORCED_COLOURS_MEDIA.test(level));
      const strays = words.filter(
        (word) => !SURFACE_COLOUR_WORDS.has(word) && !(decoration && TEXT_DECORATION_WORDS.has(word)) && !(forced && SYSTEM_COLOURS.has(word)),
      );
      if (rest.includes('#') || strays.length > 0) problems.push(`${label}: a literal colour (${rest.includes('#') ? '#' : strays.join(', ')})`);
    }
    if (['font-size', 'font-family', 'line-height'].includes(d.property)) problems.push(`${label}: type comes from a --text-* token`);
  }
  let typeRules = 0;
  for (const declarations of byBlock.values()) {
    const fonts = declarations.filter((d) => d.property === 'font');
    const spacing = declarations.filter((d) => d.property === 'letter-spacing').at(-1);
    const token = fonts.length === 0 ? undefined : /^var\((--text-[\w-]+)\)$/.exec(fonts.at(-1)!.value)?.[1];
    const label = `${surface.name}: ${declarations[0]!.context.join(' > ')}`;
    // A --focus-ring (a box-shadow, which forced colours drop) needs an outline they draw: a non-zero
    // width that isn't `none`, e.g. `outline: 2px solid transparent`.
    if (declarations.some((d) => d.property === 'box-shadow' && /var\(\s*--focus-ring\s*\)/.test(d.value))) {
      const outline = declarations.filter((d) => d.property === 'outline').at(-1)?.value ?? '';
      if (!/(?:^|\s)(?:\d*\.)?\d*[1-9]\d*(?:\.\d+)?(?:px|em|rem)?(?:\s|$)/.test(outline) || /(?:^|\s)none(?:\s|$)/.test(outline)) {
        problems.push(`${label}: --focus-ring needs an outline forced colours draw (outline: 2px solid transparent), not \`${outline || 'none set'}\``);
      }
    }
    // A weight must be one the rule's own type token's family is bundled in. A rule without its own
    // `font` is checked against Geist (what every surface rule inherits today), not its real inherited family.
    const weight = declarations.filter((d) => d.property === 'font-weight').at(-1);
    const ownToken = /^var\((--text-[\w-]+)\)$/.exec(declarations.filter((d) => d.property === 'font').at(-1)?.value ?? '')?.[1];
    const family = (ownToken !== undefined && familyOf.get(ownToken)) || 'Geist';
    if (weight !== undefined && !weightsOf(family).has(weight.value)) problems.push(`${label}: font-weight ${weight.value} is not bundled for ${family}`);
    if (fonts.length > 0 && (token === undefined || !tracking.has(token))) problems.push(`${label}: font is not a --text-* token (${fonts.at(-1)!.value})`);
    if (token !== undefined && tracking.has(token)) {
      typeRules += 1;
      const wanted = tracking.get(token)!;
      if (wanted !== '0' && spacing === undefined) problems.push(`${label}: ${token} needs letter-spacing: ${wanted} beside it`);
      if (spacing !== undefined && spacing.value !== wanted) problems.push(`${label}: letter-spacing ${spacing.value} is not ${token}'s ${wanted}`);
    } else if (spacing !== undefined) {
      problems.push(`${label}: letter-spacing without a --text-* font in the same rule`);
    }
  }
  return { problems, checked: own.length, typeRules };
}

test('surface-rules-read-signal-tokens', () => {
  const palette: SignalSurface = { name: 'fixture', stylesheet: 'n/a', selectorPrefix: '.palette' };
  const problemsIn = (css: string, surface = palette) => surfaceProblems(css, surface).problems;
  // The guard itself: each of these must be caught.
  const caught: Record<string, string> = {
    'mixed selector list': '.foo, .palette-option { color: #fff; }',
    'ancestor-qualified selector': '.chrome .palette-option { background: var(--bg-surface); color: red; }',
    'var( with a space': '.palette { border: 1px solid var( --palette-edge); }',
    'named colour': '.palette-hit { color: rebeccapurple; }',
    'colour in a palette keyframe': '@keyframes palette-in { from { background: #ffffff; } }',
    'caps without its letter-spacing': '.palette-group-label { font: var(--text-caps); }',
    'body with caps letter-spacing': '.palette-option { font: var(--text-body); letter-spacing: 0.06em; }',
    'a var() fallback': '.palette { color: var(--text, black); }',
    'a gradient background-image': '.palette-sheet { background-image: linear-gradient(red, blue); }',
    'a var() fallback outside colour': '.palette { padding: var(--space-4, 7px); }',
    'color: unset': '.palette-option { color: unset; }',
    'Geist Mono at 500': '.palette-kbd { font: var(--text-mono); font-weight: 500; }',
    'redeclaring a Signal token': '.palette { --bg-surface: tomato; }',
    'redeclaring a legacy name': '.palette { --palette-bg: red; background: var(--palette-bg); }',
    'a component property with a literal colour': '.palette { --x: rgb(1 2 3); }',
    'a colour function in filter': '.palette { filter: drop-shadow(0 0 2px rgb(255 0 0)); }',
    'hex in scrollbar-color': '.palette-list { scrollbar-color: #f00 #00f; }',
    'focus ring with outline: 0': '.palette-x:focus-visible { outline: 0; box-shadow: var(--focus-ring); }',
    'focus ring with no outline': '.palette-x:focus-visible { box-shadow: var(--focus-ring); }',
    'a system colour outside forced colours': ".palette-x[aria-disabled='true'] { color: GrayText; }",
    'a named colour inside forced colours': "@media (forced-colors: active) { .palette-x[aria-disabled='true'] { color: red; } }",
    'a system colour under another media query': "@media (prefers-contrast: more) { .palette-x { border-color: GrayText; } }",
    'forced-color-adjust on a selector FORCED_COLOURS_KEPT does not name': '.palette-x { forced-color-adjust: none; }',
  };
  for (const [name, css] of Object.entries(caught)) expect(problemsIn(css), name).not.toEqual([]);
  // ... and these pass: a token rule, a class-boundary miss, a caps rule with its tracking.
  expect(problemsIn('.palette-group-label { font: var(--text-caps); letter-spacing: 0.06em; color: var(--text-muted); }')).toEqual([]);
  expect(problemsIn('.palette { box-shadow: var(--e-ring), inset 0 0 0 100vmax var(--bg-hover); border: 0; }')).toEqual([]);
  // A component-scoped property (the values step's --tone-ink pattern), and text-decoration's keywords.
  expect(problemsIn('.palette { --tone-ink: var(--ok-ink); color: var(--tone-ink); }')).toEqual([]);
  expect(problemsIn('.palette-hit { text-decoration: underline; }')).toEqual([]);
  // A focus ring forced colours still draw (they drop box-shadows): a transparent outline beside it.
  expect(problemsIn('.palette-x:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: var(--focus-ring); }')).toEqual([]);
  // A busy state shown only by colour stays visible under forced colours: a system colour, in that block only.
  expect(problemsIn("@media (forced-colors: active) { .palette-x[aria-disabled='true'] { color: GrayText; border-color: GrayText; } }")).toEqual([]);
  // ... but a mark FORCED_COLOURS_KEPT names, in its stylesheet, may keep its colours.
  const rail: SignalSurface = { name: 'fixture rail', stylesheet: 'styles.css', selectorPrefix: '.seo', classes: ['.seo-rail-*'] };
  expect(surfaceProblems('.seo-rail-dot { forced-color-adjust: none; }', rail).problems).toEqual([]);
  expect(surfaceProblems('.seo-rail-dot, .seo-rail-x { forced-color-adjust: none; }', rail).problems.join()).toContain('.seo-rail-x sets forced-color-adjust');
  expect(surfaceProblems('.table-row { color: red; }', { name: 'tab', stylesheet: 'n/a', selectorPrefix: '.tab' }).checked).toBe(0);
  expect(surfaceProblems('.palettes, .x-palette { color: red; }', palette).checked).toBe(0);
  // A surface that lists its classes (the SEO sidebar's frame, under the `.seo` prefix every panel
  // shares) owns exactly those, a `-*` entry its family, and only its listed keyframes.
  const frame: SignalSurface = {
    name: 'fixture frame',
    stylesheet: 'n/a',
    selectorPrefix: '.seo',
    classes: ['.seo', '.seo-panel', '.seo-chip', '.seo-rail-*'],
    keyframes: ['seo-panel-in'],
  };
  const checkedIn = (css: string) => surfaceProblems(css, frame).checked;
  for (const own of ['.seo', '.seo-panel', '.seo-chip', '.seo-rail', '.seo-rail-item', '.seo-rail-dot[data-status=x]', '.x .seo-rail-tip']) {
    expect(checkedIn(`${own} { color: red; }`), own).toBe(1);
  }
  expect(checkedIn('@keyframes seo-panel-in { from { color: red; } }')).toBe(1);
  // Panel interiors share the prefix but are not the frame's: an exact class never takes its family.
  for (const panel of ['.seo-links', '.seo-panel-tools', '.seo-chip-button', '.seo-chips', '.seo-toggle', '.seo-railway', '.x-seo-rail', '.seos']) {
    expect(checkedIn(`${panel} { color: red; }`), panel).toBe(0);
  }
  expect(checkedIn('@keyframes seo-ring-fill { from { color: red; } }')).toBe(0);
  expect(checkedIn('@keyframes seo-panel-in-more { from { color: red; } }')).toBe(0);
  // Every listed class and keyframes names a rule: a stale one fails, a family needs only one member.
  const listed: SignalSurface = { ...frame, classes: ['.seo', '.seo-rail-*'], keyframes: ['seo-panel-in'] };
  const sheet = '.seo { color: var(--text); } .seo-rail-item { color: var(--text-muted); } @keyframes seo-panel-in { from { opacity: 0; } }';
  expect(surfaceProblems(sheet, listed).problems).toEqual([]);
  expect(surfaceProblems(sheet, { ...listed, classes: ['.seo', '.seo-rail-*', '.seo-gone'] }).problems.join()).toContain('.seo-gone names no rule');
  expect(surfaceProblems(sheet, { ...listed, classes: ['.seo', '.seo-rail'] }).problems.join()).toContain('.seo-rail names no rule');
  expect(surfaceProblems(sheet, { ...listed, classes: ['.seo', '.seo-rail-*', '.seo-absent-*'] }).problems.join()).toContain('.seo-absent-* names no rule');
  expect(surfaceProblems(sheet, { ...listed, keyframes: ['seo-panel-in', 'seo-gone-in'] }).problems.join()).toContain('seo-gone-in names no rule');
  // A surface whose classes share no prefix (the browser chrome) owns exactly its listed classes and keyframes.
  const chrome: SignalSurface = { name: 'fixture chrome', stylesheet: 'n/a', classes: ['.tabstrip', '.tab', '.address-*'], keyframes: ['tab-spin'] };
  const chromeChecks = (css: string) => surfaceProblems(css, chrome).checked;
  for (const own of ['.tabstrip', '.tab', ".tab[data-active='true']", '.tab:has(.tab-main:focus-visible)', '.address', '.address-input']) {
    expect(chromeChecks(`${own} { color: red; }`), own).toBe(1);
  }
  for (const other of ['.tabs', '.tab-profile', '.tabstrip-x', '.addressbook', '.x-tab']) expect(chromeChecks(`${other} { color: red; }`), other).toBe(0);
  expect(chromeChecks('@keyframes tab-spin { from { color: red; } }')).toBe(1);
  expect(chromeChecks('@keyframes tab-spin-more { from { color: red; } }')).toBe(0);

  const surfaces: readonly SignalSurface[] = SIGNAL_SURFACES;
  expect(surfaces.length).toBeGreaterThan(0);
  for (const surface of surfaces) {
    // Listed classes sit under the prefix (when there is one), keyframes come only with them, and a
    // surface with no prefix lists its classes.
    const prefix = surface.selectorPrefix;
    if (prefix === undefined) expect(surface.classes, `${surface.name}: no prefix, so its classes are listed`).toBeDefined();
    else for (const name of surface.classes ?? []) expect(name === prefix || name.startsWith(`${prefix}-`), `${surface.name}: ${name}`).toBe(true);
    if (surface.keyframes !== undefined) expect(surface.classes, `${surface.name}: keyframes need classes`).toBeDefined();
    const result = surfaceProblems(read(surface.stylesheet), surface);
    expect(result.checked, surface.name).toBeGreaterThan(0);
    expect(result.problems, surface.name).toEqual([]);
    expect(result.typeRules, `${surface.name} reads the --text-* tokens`).toBeGreaterThan(0);
  }
});

test('hex-colours-do-not-grow', () => {
  let count = 0;
  for (const name of STYLESHEETS) {
    if (name === TOKENS_STYLESHEET) continue;
    count += stripComments(read(name)).match(/#[0-9a-f]{3,8}\b/gi)?.length ?? 0;
  }
  expect(count).toBeLessThanOrEqual(HEX_COLOUR_RATCHET);
});
