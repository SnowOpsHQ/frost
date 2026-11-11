// Spec: specs/design-tokens.spec.ts (SIGNAL_TOKENS, LEGACY_TOKEN_MIGRATION, CONTRAST_PAIRS, HEX_COLOUR_RATCHET)
// Acceptance: specs/design-tokens.feature.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  CONTRAST_PAIRS,
  HEX_COLOUR_RATCHET,
  LEGACY_TOKEN_MIGRATION,
  SIGNAL_NAMES_WITH_LEGACY_VALUES,
  SIGNAL_TOKENS,
  THEMED_SIGNAL_GROUPS,
  TOKENS_STYLESHEET,
  type ContrastPair,
  type SignalToken,
  type SignalTokenGroup,
} from '@app/specs/design-tokens.spec';
import { SIDEBAR_PANEL_WIDTH, SIDEBAR_RAIL_WIDTH } from '@app/specs/seo-sidebar.spec';

const RENDERER = fileURLToPath(new URL('../renderer/', import.meta.url));
const read = (relative: string) => readFileSync(`${RENDERER}${relative}`, 'utf8');

/** Every stylesheet under the renderer, relative to it. */
const STYLESHEETS = (readdirSync(RENDERER, { recursive: true }) as string[])
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => name.endsWith('.css'))
  .sort();

const DARK = '@media (prefers-color-scheme: dark)';
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Declaration {
  /** The enclosing at-rule preludes and selectors, outermost first, whitespace collapsed. */
  readonly context: readonly string[];
  readonly property: string;
  readonly value: string;
}

/** The declarations of `css`, each with its context, and the context of every block. (The
 * renderer's CSS has no braces or semicolons inside strings, so a brace walk is enough.) */
function parse(css: string): { declarations: Declaration[]; blocks: string[][] } {
  const declarations: Declaration[] = [];
  const blocks: string[][] = [];
  const stack: string[] = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    const colon = text.indexOf(':');
    if (colon > 0) {
      declarations.push({ context: [...stack], property: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim().replace(/\s+/g, ' ') });
    }
    buffer = '';
  };
  for (const ch of stripComments(css)) {
    if (ch === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
      blocks.push([...stack]);
      buffer = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
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
  for (const name of legacy) expect(LIGHT.has(name), name).toBe(true);
  // tokens.css holds the legacy names and the Signal vocabulary, nothing else.
  for (const name of LIGHT.keys()) expect(legacy.includes(name) || SIGNAL_NAMES.has(name), name).toBe(true);
  // Every replacement named is a Signal token (`--text-*` is the type scale).
  for (const row of LEGACY_TOKEN_MIGRATION) {
    if (row.signal === null) continue;
    if (row.signal === '--text-*') expect(row.legacy).toBe('--font-ui');
    else expect(SIGNAL_NAMES.has(row.signal), `${row.legacy} -> ${row.signal}`).toBe(true);
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

  const themes = { light: LIGHT, dark: new Map([...LIGHT, ...DARK_VALUES]) };
  const pairs: readonly ContrastPair[] = CONTRAST_PAIRS;
  expect(pairs.length).toBeGreaterThan(0);
  for (const [theme, values] of Object.entries(themes)) {
    /** A token's colour in this theme, following `var()` references in the same theme. */
    const colour = (name: string): Rgba => {
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
    };
    for (const pair of pairs) {
      const label = `${pair.fg} on ${pair.bg}${pair.over ? ` over ${pair.over}` : ''} (${theme})`;
      let bg = colour(pair.bg);
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

test('hex-colours-do-not-grow', () => {
  let count = 0;
  for (const name of STYLESHEETS) {
    if (name === TOKENS_STYLESHEET) continue;
    count += stripComments(read(name)).match(/#[0-9a-f]{3,8}\b/gi)?.length ?? 0;
  }
  expect(count).toBeLessThanOrEqual(HEX_COLOUR_RATCHET);
});
