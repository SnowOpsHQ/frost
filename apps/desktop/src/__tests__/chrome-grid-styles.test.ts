// Layout regression guards. Context: specs/browser-chrome.feature.md (Layout: the chrome's rows), specs/help.feature.md and
// specs/account-settings.feature.md (sheets over the page column hide the find bar), specs/agent-data.feature.md
// (the chat list's and skill library's search fields).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const RENDERER = fileURLToPath(new URL('../renderer/', import.meta.url));
const read = (relative: string) => readFileSync(`${RENDERER}${relative}`, 'utf8');
const CSS_FILES = (readdirSync(RENDERER, { recursive: true }) as string[]).filter((name) => name.endsWith('.css')).map((name) => name.replaceAll('\\', '/'));

/** Every rule (selector list and declarations) of a stylesheet, comments stripped; nested `@media` rules included. */
function rules(css: string): { selector: string; body: string }[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

/** The declarations of the rule whose selector is exactly `selector` in `file`. */
function rule(file: string, selector: string): string {
  const found = rules(read(file)).find((r) => r.selector === selector);
  expect(found, `${file}: ${selector}`).toBeDefined();
  return found!.body;
}

test('chrome-grid-has-a-row-per-slot', () => {
  const tracks = rule('styles.css', '.chrome').match(/grid-template-rows:\s*([^;]+);/)![1]!;
  // Top-level tracks (a `minmax(…)` is one).
  const rows = tracks.replace(/\([^)]*\)/g, '()').trim().split(/\s+/);
  expect(rows.at(-2)).toBe('minmax()');
  expect(rows.at(-1)).toBe('var()');
  // App.tsx: the chrome's direct children (one JSX element per line at its children's indent).
  const app = read('App.tsx');
  const start = app.indexOf('<div className="chrome">');
  const body = app.slice(start, app.lastIndexOf('</div>'));
  const slots = body.split('\n').filter((line) => /^ {6}<[A-Za-z]/.test(line));
  expect(slots.length).toBe(rows.length);
  expect(slots.at(-2)).toContain('className="workspace-stack"');
  expect(slots.at(-1)).toContain('<StatusBar');
  // The only other child is the fullscreen notice, which is out of the grid's flow.
  const others = body.split('\n').filter((line) => /^ {6}\{(?!\/\*)/.test(line));
  expect(others).toEqual([expect.stringContaining('<FullscreenNotice')]);
  expect(rule('styles.css', '.fullscreen-notice')).toMatch(/position:\s*fixed;/);
  // The workspace and the status bar are pinned to the last two rows, counted from the end.
  expect(rule('styles.css', '.chrome > .workspace-stack')).toMatch(/grid-row:\s*-3;/);
  expect(rule('styles.css', '.chrome > .status-bar')).toMatch(/grid-row:\s*-2;/);
});

test('no-style-drops-a-chrome-slot', () => {
  // A slot that leaves the layout (display: none) moves every later child up one track: with a sheet
  // open, the status bar landed in the page's row and the workspace in an `auto` one. Sheets hide what
  // is inside a slot instead (`.find-slot > *`).
  expect(CSS_FILES.length).toBeGreaterThanOrEqual(5);
  const offenders: string[] = [];
  for (const file of CSS_FILES)
    for (const { selector, body } of rules(read(file))) {
      if (!/display:\s*none/.test(body)) continue;
      for (const one of selector.split(',')) if (/\.chrome\b[^>]*>\s*[^\s>]+$/.test(one.trim())) offenders.push(`${file}: ${one.trim()}`);
    }
  expect(offenders).toEqual([]);
  // The sheets that hide the find bar still do, by its content.
  expect(rule('help.css', '.chrome:has(.help-sheet) > .find-slot > *')).toMatch(/display:\s*none;/);
  expect(rule('settings.css', '.chrome:has(.settings-sheet) > .find-slot > *')).toMatch(/display:\s*none;/);
});

test('agent-text-fields-hold-their-height', () => {
  // The search fields (the composer's skills, the chat list, the skill library) sit in column flex boxes,
  // where `flex: 1` would size their height from 0; the field keeps the 30 px of the panel's selects.
  const shared = rule('components/agent/agent.css', '.agent-select,\n.agent-text-field');
  expect(shared).toMatch(/height:\s*30px;/);
  const field = rule('components/agent/agent.css', '.agent-text-field');
  expect(field).toMatch(/min-height:\s*30px;/);
  expect(field).toMatch(/max-height:\s*30px;/);
});

test('screenshot-swatch-has-no-button-face-and-keeps-its-outline', () => {
  // Council round 2 (specs/screenshot.feature.md, Editing): the swatch's colour is an SVG fill, so the
  // button paints no background of its own (no grey ButtonFace ring), and the outline that keeps a
  // light swatch visible is the circle's stroke, in a token colour (no literal colour here).
  const swatch = rules(read('styles.css')).filter((r) => r.selector === '.shot-editor-swatch').map((r) => r.body).join('\n');
  expect(swatch).toMatch(/background:\s*none;/);
  expect(swatch).toMatch(/color:\s*var\(--[a-z-]+\);/);
  const editor = readFileSync(`${RENDERER}components/changes/ScreenshotEditor.tsx`, 'utf8');
  expect(editor).toMatch(/<circle[^>]*fill=\{each\}[^>]*stroke="currentColor"/);
});
