// Spec: specs/design-tokens.spec.ts (SIGNAL_TOKENS, LEGACY_TOKEN_MIGRATION, HEX_COLOUR_RATCHET)
// Acceptance: specs/design-tokens.feature.md
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  HEX_COLOUR_RATCHET,
  LEGACY_TOKEN_MIGRATION,
  SIGNAL_NAMES_WITH_LEGACY_VALUES,
  SIGNAL_TOKENS,
  THEMED_SIGNAL_GROUPS,
  TOKENS_STYLESHEET,
  type SignalToken,
  type SignalTokenGroup,
} from '@app/specs/design-tokens.spec';

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

/** The custom-property declarations of `css`, each with its context. (The renderer's CSS has no
 * braces or semicolons inside strings, so a brace walk is enough.) */
function customProperties(css: string): Declaration[] {
  const out: Declaration[] = [];
  const stack: string[] = [];
  let buffer = '';
  const flush = () => {
    const text = buffer.trim();
    const colon = text.indexOf(':');
    if (text.startsWith('--') && colon > 0) {
      out.push({ context: [...stack], property: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim().replace(/\s+/g, ' ') });
    }
    buffer = '';
  };
  for (const ch of stripComments(css)) {
    if (ch === '{') {
      stack.push(buffer.trim().replace(/\s+/g, ' '));
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
  return out;
}

/** Whether a selector list targets the document element (`:root…` or `html`). */
const onRoot = (selectors: string) => selectors.split(',').some((s) => /^(:root\b|html$)/.test(s.trim()));

const TOKENS = customProperties(read(TOKENS_STYLESHEET));
const inContext = (context: readonly string[]) =>
  new Map(TOKENS.filter((d) => d.context.join(' > ') === context.join(' > ')).map((d) => [d.property, d.value]));
const LIGHT = inContext([':root']);
const DARK_VALUES = inContext([DARK, ':root']);
const GROUPS = Object.entries(SIGNAL_TOKENS) as [SignalTokenGroup, readonly SignalToken[]][];
const SIGNAL_NAMES = new Set<string>(GROUPS.flatMap(([, tokens]) => tokens.map((token) => token.name)));
const KEEPS_LEGACY_VALUE = new Set<string>(SIGNAL_NAMES_WITH_LEGACY_VALUES);

test('tokens-stylesheet-holds-only-root-tokens', () => {
  expect(STYLESHEETS).toContain(TOKENS_STYLESHEET);
  // Every declaration in tokens.css is on :root, light or dark: no other selector, no other at-rule.
  for (const d of TOKENS) expect([[':root'], [DARK, ':root']], `${d.property} in ${d.context.join(' > ')}`).toContainEqual(d.context);
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
      // A Signal-only token carries its Signal value already; a shared name keeps today's until the values PR.
      if (!KEEPS_LEGACY_VALUE.has(token.name)) {
        expect(LIGHT.get(token.name), label).toBe(token.light);
        if (token.dark !== undefined) expect(DARK_VALUES.get(token.name), `${label} (dark)`).toBe(token.dark);
      }
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
