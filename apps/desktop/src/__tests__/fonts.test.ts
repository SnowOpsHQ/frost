// Spec: specs/design-tokens.spec.ts (BUNDLED_FONTS, FONTS_STYLESHEET, GEIST_PACKAGE, GEIST_FONTS_ALIAS,
// TEXT_BODY_EMPHASIS_WEIGHT, SIGNAL_TOKENS.type, TOKENS_STYLESHEET)
// Acceptance: specs/design-tokens.feature.md (Unit, fonts)
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  BUNDLED_FONTS,
  FONTS_STYLESHEET,
  GEIST_FONTS_ALIAS,
  GEIST_PACKAGE,
  SIGNAL_TOKENS,
  TEXT_BODY_EMPHASIS_WEIGHT,
  TOKENS_STYLESHEET,
} from '@app/specs/design-tokens.spec';
import { NOTICE_PACKAGES, packageDir } from '../../third-party-notices';
import rendererConfig from '../../vite.renderer.config';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RENDERER = path.join(APP, 'src/renderer');
const read = (relative: string) => readFileSync(path.join(RENDERER, relative), 'utf8');
/** The installed geist package's `dist/fonts/`. */
const fontsDir = () => path.join(packageDir(GEIST_PACKAGE.name, 'apps/desktop'), 'dist/fonts');

/** Vite inlines an asset smaller than this as a `data:` URI (its `build.assetsInlineLimit` default). */
const VITE_INLINE_LIMIT = 4096;

const key = (family: string, weight: number) => `${family} ${weight}`;
const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** A type token's weight and first family, from its `font` shorthand (`600 24px/1.15 Geist, …`). */
function shorthandFace(font: string): { family: string; weight: number } {
  const match = /^(\d+) \S+ ([^,]+),/.exec(font);
  if (!match) throw new Error(`not a font shorthand: ${font}`);
  return { family: unquote(match[2] ?? ''), weight: Number(match[1]) };
}

/** The top-level blocks of a stylesheet without nesting (comments dropped); throws on anything else. */
function blocks(css: string): { prelude: string; declarations: Map<string, string> }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { prelude: string; declarations: Map<string, string> }[] = [];
  const rest = text.replace(/([^{}]*)\{([^{}]*)\}/g, (_, prelude: string, body: string) => {
    const declarations = new Map<string, string>();
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (declaration.trim() === '') continue;
      const property = declaration.slice(0, colon).trim();
      expect(declarations.has(property), `${prelude.trim()}: ${property} twice`).toBe(false);
      declarations.set(property, declaration.slice(colon + 1).trim().replace(/\s+/g, ' '));
    }
    found.push({ prelude: prelude.trim(), declarations });
    return '';
  });
  expect(rest.trim(), 'nothing outside the blocks').toBe('');
  return found;
}

test('bundled-fonts-cover-the-type-scale', () => {
  const body = SIGNAL_TOKENS.type.find((token) => token.name === '--text-body');
  expect(body?.use).toMatch(new RegExp(`^${TEXT_BODY_EMPHASIS_WEIGHT} for emphasis`));
  const used = SIGNAL_TOKENS.type.map((token) => shorthandFace(token.light));
  const expected = new Set([...used.map((face) => key(face.family, face.weight)), key(shorthandFace(body!.light).family, TEXT_BODY_EMPHASIS_WEIGHT)]);
  const bundled = BUNDLED_FONTS.map((font) => key(font.family, font.weight));
  // Exactly those (family, weight) pairs, each once.
  expect(new Set(bundled)).toEqual(expected);
  expect(bundled).toHaveLength(expected.size);
  // Static, upright woff2 files only: no italic, variable ([wght] or -Variable) or Pixel file.
  for (const font of BUNDLED_FONTS) {
    expect(font.file, font.file).toMatch(/^geist-(?:sans|mono)\/[A-Za-z-]+\.woff2$/);
    expect(font.file, font.file).not.toMatch(/Italic|Variable|Pixel|\[/i);
  }
});

test('fonts-stylesheet-declares-bundled-fonts', () => {
  const css = read(FONTS_STYLESHEET);
  // Local only: no remote URL and no data: URI anywhere (the CSP's font-src is 'self').
  expect(css).not.toMatch(/https?:|data:|\/\//);
  const faces = blocks(css);
  for (const face of faces) expect(face.prelude).toBe('@font-face');
  expect(faces).toHaveLength(BUNDLED_FONTS.length);
  for (const font of BUNDLED_FONTS) {
    const matching = faces.filter((face) => unquote(face.declarations.get('font-family') ?? '') === font.family && face.declarations.get('font-weight') === String(font.weight));
    expect(matching, key(font.family, font.weight)).toHaveLength(1);
    const declarations = matching[0]!.declarations;
    expect([...declarations.keys()].sort(), key(font.family, font.weight)).toEqual(['font-display', 'font-family', 'font-style', 'font-weight', 'src']);
    expect(declarations.get('font-style')).toBe('normal');
    expect(declarations.get('font-display')).toBe('block');
    expect(declarations.get('src')).toBe(`url('${GEIST_FONTS_ALIAS}/${font.file}') format('woff2')`);
  }
  // The renderer's Vite config resolves the prefix to the installed package's dist/fonts/.
  const alias = (rendererConfig as { resolve?: { alias?: Record<string, string> } }).resolve?.alias;
  expect(alias?.[GEIST_FONTS_ALIAS]).toBe(fontsDir());
  // main.tsx imports fonts.css right after tokens.css.
  const imports = [...read('main.tsx').matchAll(/^import\s+(?:[^'"\n]+from\s+)?'([^']+)';/gm)].map((m) => m[1] ?? '');
  expect(imports.indexOf(`./${FONTS_STYLESHEET}`)).toBe(imports.indexOf(`./${TOKENS_STYLESHEET}`) + 1);
});

test('geist-is-pinned-and-installed', () => {
  const manifest = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  // Exactly the spec's version: no ^ or ~ range.
  expect({ ...manifest.dependencies, ...manifest.devDependencies }[GEIST_PACKAGE.name]).toBe(GEIST_PACKAGE.version);
  const dir = packageDir(GEIST_PACKAGE.name, 'apps/desktop');
  expect((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version).toBe(GEIST_PACKAGE.version);
  for (const font of BUNDLED_FONTS) {
    const file = path.join(fontsDir(), font.file);
    expect(existsSync(file), font.file).toBe(true);
    // Above Vite's inline limit, so the build emits a file rather than a data: URI.
    expect(statSync(file).size, font.file).toBeGreaterThan(VITE_INLINE_LIMIT);
    expect(readFileSync(file).subarray(0, 4).toString('latin1'), font.file).toBe('wOF2');
  }
  // OFL-1.1: the package's own licence file (its package.json says only "SIL OPEN FONT LICENSE").
  expect(GEIST_PACKAGE.license).toBe('OFL-1.1');
  expect(readFileSync(path.join(dir, 'LICENSE.txt'), 'utf8')).toContain('SIL Open Font License, Version 1.1');
  expect(NOTICE_PACKAGES.find((pkg) => pkg.name === GEIST_PACKAGE.name)?.from).toBe('apps/desktop');
});
