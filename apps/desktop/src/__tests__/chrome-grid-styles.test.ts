// Layout regression guards. Context: specs/browser-chrome.feature.md (Layout: the chrome's rows), specs/help.feature.md and
// specs/account-settings.feature.md (sheets over the page column hide the find bar), specs/agent-data.feature.md
// (the chat list's and skill library's search fields), specs/data-sources.feature.md, specs/ai-answers.feature.md and
// specs/site-crawl.feature.md (screen-reader text inside the sheets' scroll boxes; AI answers' "Reach through" selects).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { ADDRESS_BASIS_PX, ADDRESS_MIN_WIDTH_PX, TAB_MIN_WIDTH_PX } from '@app/specs/tabs.spec';

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

test('chrome-row-is-one-fixed-track', () => {
  // specs/tabs.feature.md (The chrome row): the tab row and the toolbar are one --h-chrome row, the grid's first track.
  const tracks = rule('styles.css', '.chrome').match(/grid-template-rows:\s*([^;]+);/)![1]!.trim();
  expect(tracks.split(/\s+/)[0]).toBe('var(--h-chrome)');
  const app = read('App.tsx');
  const body = app.slice(app.indexOf('<div className="chrome">'));
  const first = body.split('\n').find((line) => /^ {6}<[A-Za-z]/.test(line));
  expect(first).toMatch(/^ {6}<ChromeRow\b/);
  const row = rule('styles.css', '.chrome-row');
  expect(row).toMatch(/display:\s*flex;/);
  expect(row).not.toMatch(/flex-wrap:\s*wrap/);
  // It clips: never a scroll container that focus could scroll.
  expect(row).toMatch(/overflow:\s*clip;/);
  expect(row).not.toMatch(/overflow(-x)?:\s*(hidden|auto|scroll);/);
  // The tools never shrink.
  for (const fixed of ['.nav-buttons', '.tool', '.new-tab']) expect(rule('styles.css', fixed), fixed).toMatch(/flex:\s*none;/);
  // Tabs shrink to their minimum, then the tablist scrolls; the address bar keeps its basis until only
  // one tab is left beside it, and never goes under its minimum.
  expect(row).toMatch(new RegExp(`--tab-min:\\s*${TAB_MIN_WIDTH_PX}px;`));
  expect(row).toMatch(new RegExp(`--address-basis:\\s*${ADDRESS_BASIS_PX}px;`));
  expect(row).toMatch(new RegExp(`--address-min:\\s*${ADDRESS_MIN_WIDTH_PX}px;`));
  expect(rule('styles.css', '.tab')).toMatch(/min-width:\s*var\(--tab-min\);/);
  const address = rule('styles.css', '.address');
  expect(address).toMatch(/flex:\s*1 1 var\(--address-basis\);/);
  expect(address).toMatch(/min-width:\s*clamp\(var\(--address-min\),\s*var\(--row-free\) - var\(--one-tab\),\s*var\(--address-basis\)\);/);
  // The room for the tablist and the address bar: the window less the row's padding, its six tools and seven gaps.
  expect(row).toMatch(/--row-free:\s*calc\(100vw - 2 \* var\(--space-4\) - 6 \* var\(--h-control\) - 7 \* var\(--space-1\)\);/);
  expect(row).toMatch(/--one-tab:\s*calc\(var\(--tab-min\) \+ 2 \* var\(--space-1\)\);/);
  const tablist = rule('styles.css', '.tabs');
  expect(tablist).toMatch(/overflow-x:\s*auto;/);
  expect(tablist).toMatch(/min-width:\s*var\(--one-tab\);/);
  // Room for a focused tab's 4px ring, also when focus scrolls a tab into view at either end.
  expect(tablist).toMatch(/padding:\s*var\(--space-1\);/);
  expect(tablist).toMatch(/scroll-padding-inline:\s*var\(--space-1\);/);
  // The two rows' classes are gone from every stylesheet.
  const stale = CSS_FILES.flatMap((file) =>
    rules(read(file))
      .filter(({ selector }) => /\.(tabstrip|toolbar)(?![\w-])/.test(selector))
      .map(({ selector }) => `${file}: ${selector}`),
  );
  expect(stale).toEqual([]);
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
  // where `flex: 1` would size their height from 0; the field keeps the height of the panel's selects,
  // Signal's --h-control (specs/design-tokens.feature.md, The agent panel).
  const shared = rule('components/agent/agent.css', '.agent-select,\n.agent-text-field');
  expect(shared).toMatch(/height:\s*var\(--h-control\);/);
  const field = rule('components/agent/agent.css', '.agent-text-field');
  expect(field).toMatch(/min-height:\s*var\(--h-control\);/);
  expect(field).toMatch(/max-height:\s*var\(--h-control\);/);
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

test('screen-reader-text-stays-inside-sheet-scroll-boxes', () => {
  // Text for screen readers only is absolutely positioned. With no positioned ancestor it is laid out
  // against the window, below the fold of a long sheet: the page itself became scrollable and Settings'
  // `scrollIntoView` moved the whole app up. Each sheet's scroll box is positioned, so it stays inside.
  expect(rule('settings.css', '.settings-content')).toMatch(/position:\s*relative;/);
  expect(rule('help.css', '.help-body')).toMatch(/position:\s*relative;/);
  expect(rule('styles.css', '.projects-list,\n.projects-main')).toMatch(/position:\s*relative;/);
  // One visually-hidden pattern for the renderer: 1 px, clipped, nothing showing past it.
  const hidden = rule('styles.css', '.visually-hidden');
  for (const declaration of [/position:\s*absolute;/, /width:\s*1px;/, /height:\s*1px;/, /overflow:\s*hidden;/, /clip:\s*rect\(0 0 0 0\);/, /white-space:\s*nowrap;/]) expect(hidden).toMatch(declaration);
  // Settings' own copy is gone: its sections use `.visually-hidden`.
  const sources = (readdirSync(RENDERER, { recursive: true }) as string[]).filter((name) => /\.(tsx?|css)$/.test(name) && !name.includes('__tests__'));
  expect(sources.filter((name) => read(name.replaceAll('\\', '/')).includes('settings-sr'))).toEqual([]);
  expect(read('settings-data-sources.tsx')).toContain('className="visually-hidden"');
});

test('ai-answers-reach-through-selects-share-one-width', () => {
  // Each engine's "Reach through" select sits in a fixed column (the Engine select's 280 px), not sized
  // by its label, so the rows' selects are one width.
  const row = rule('ai-answers.css', '.ai-answers-engine');
  expect(row).toMatch(/display:\s*grid;/);
  expect(row).toMatch(/grid-template-columns:\s*minmax\(0, 280px\) minmax\(0, 1fr\);/);
  expect(rule('ai-answers.css', '.ai-answers-form')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 280px\);/);
  // The Engine select's caveat sits under it, in its column.
  expect(rule('ai-answers.css', '.ai-answers-engine-caveat')).toMatch(/grid-column:\s*2;/);
});

test('crawl-run-state-wraps-a-long-pause-reason', () => {
  // A run's state can carry a long pause reason ("Paused: frost could not read the site's robots.txt.
  // Resume to try again."): in a narrow sheet it wraps under the start URL instead of overflowing the run card.
  expect(rule('crawl.css', '.crawl-run-head')).toMatch(/flex-wrap:\s*wrap/);
  const state = rule('crawl.css', '.crawl-run-state');
  expect(state).not.toMatch(/flex:\s*none/);
  expect(state).toMatch(/min-width:\s*0/);
  expect(state).toMatch(/overflow-wrap:\s*anywhere/);
});
