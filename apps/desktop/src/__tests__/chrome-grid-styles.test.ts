// Layout regression guards. Context: specs/browser-chrome.feature.md (Layout: the chrome's rows), specs/help.feature.md and
// specs/account-settings.feature.md (sheets over the page column hide the find bar), specs/agent-data.feature.md
// (the chat list's and skill library's search fields), specs/data-sources.feature.md, specs/ai-answers.feature.md and
// specs/site-crawl.feature.md (screen-reader text inside the sheets' scroll boxes; AI answers' "Reach through" selects),
// specs/workspace-layout.feature.md (the workspace's floating sheets, its gaps and the page card).
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { AGENT_RAIL_WIDTH } from '@app/specs/agent-panel.spec';
import { SIGNAL_TOKENS } from '@app/specs/design-tokens.spec';
import { RENDER_FRAME } from '@app/specs/render-profile.spec';
import { SIDEBAR_RAIL_WIDTH } from '@app/specs/seo-sidebar.spec';
import { ADDRESS_BASIS_PX, CHROME_ROW, TAB_MIN_WIDTH_PX } from '@app/specs/tabs.spec';
import {
  ENTRANCE_FILL_EXCEPTIONS,
  PAGE_AREA_COLLAPSES,
  pageViewRadius,
  RENDER_DEVICE_OUTLINE_RADIUS,
  SHEET_RADIUS,
  WORKSPACE_GAP,
  WORKSPACE_SHEETS,
  workspaceRowChrome,
  workspaceRowWidth,
} from '@app/specs/workspace-layout.spec';

/** The row's tools (`CHROME_ROW` but the tablist and the address bar) and its gaps (between its items and inside the navigation group: one fewer than its controls). */
const ROW_TOOLS = CHROME_ROW.filter((id) => id !== 'tab-strip' && id !== 'address').length;
const ROW_GAPS = CHROME_ROW.length - 1;

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
  expect(rule('styles.css', '.tab')).toMatch(/min-width:\s*var\(--tab-min\);/);
  const address = rule('styles.css', '.address');
  expect(address).toMatch(/flex:\s*1 1 var\(--address-basis\);/);
  // The basis, or the room left beside one tab, whichever is less: below the window's minimum (a tiled
  // window) the address bar gives way before the tools.
  expect(address).toMatch(/min-width:\s*min\(var\(--address-basis\),\s*max\(0px,\s*var\(--row-free\) - var\(--one-tab\)\)\);/);
  // The room for the tablist and the address bar: the row's own content width (an inline-size
  // container) less its tools and gaps, counted from CHROME_ROW, so a new tool can't go uncounted.
  expect([ROW_TOOLS, ROW_GAPS]).toEqual([6, 7]);
  expect(row).toMatch(/container-type:\s*inline-size;/);
  const free = row.match(/--row-free:\s*calc\(100cqw - (\d+) \* var\(--h-control\) - (\d+) \* var\(--space-1\)\);/);
  expect(free, '--row-free').not.toBeNull();
  expect([Number(free![1]), Number(free![2])]).toEqual([ROW_TOOLS, ROW_GAPS]);
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

// ---- The workspace's layout (specs/workspace-layout.feature.md) ------------------------------------

/** Top-level rules only (comments and `@media` / `@supports` blocks dropped), in file order. */
function topRules(file: string): { selector: string; body: string }[] {
  let plain = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
  // Nested blocks: drop each at-rule's whole block, innermost first.
  for (let before = ''; before !== plain; ) {
    before = plain;
    plain = plain.replace(/@(?:media|supports)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  }
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

/** A selector list split on its top-level commas. */
function selectorsOf(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

/**
 * The declarations `selector` (exactly, in any rule's selector list) gets from `files`, in that order
 * (feature stylesheets load before styles.css, so styles.css goes last): the last one wins.
 */
function resolved(files: readonly string[], selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files)
    for (const { selector: list, body } of topRules(file)) {
      if (!selectorsOf(list).includes(selector)) continue;
      for (const [, property, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out.set(property!, value!.replace(/\s+/g, ' ').trim());
    }
  return out;
}

const GAP = `var(${WORKSPACE_GAP.token})`;

test('workspace-layout-values', () => {
  const token = (name: string) => Object.values(SIGNAL_TOKENS).flat().find((t) => t.name === name)?.light;
  expect(token(WORKSPACE_GAP.token)).toBe(`${WORKSPACE_GAP.px}px`);
  expect(token(SHEET_RADIUS.token)).toBe(`${SHEET_RADIUS.px}px`);
  expect(workspaceRowChrome({ sidebar: true, agent: false })).toBe(SIDEBAR_RAIL_WIDTH + AGENT_RAIL_WIDTH + 3 * WORKSPACE_GAP.px);
  expect(workspaceRowChrome({ sidebar: false, agent: false })).toBe(SIDEBAR_RAIL_WIDTH + AGENT_RAIL_WIDTH + 2 * WORKSPACE_GAP.px);
  expect(workspaceRowChrome({ sidebar: true, agent: true })).toBe(SIDEBAR_RAIL_WIDTH + 3 * WORKSPACE_GAP.px);
  expect(workspaceRowChrome({ sidebar: false, agent: true })).toBe(SIDEBAR_RAIL_WIDTH + 2 * WORKSPACE_GAP.px);
  expect(workspaceRowWidth(1280)).toBe(1280 - 2 * WORKSPACE_GAP.px);
  expect(pageViewRadius({ fullscreen: false, framed: false })).toBe(16);
  expect(pageViewRadius({ fullscreen: true, framed: false })).toBe(0);
  expect(pageViewRadius({ fullscreen: true, framed: true })).toBe(0);
  expect(pageViewRadius({ fullscreen: false, framed: true })).toBe(16 - RENDER_FRAME.inset);
  // A device preset's outline, one pixel outside the framed view, follows its corner.
  expect(RENDER_DEVICE_OUTLINE_RADIUS).toBe(13);
  expect(read('components/RenderProfile.tsx')).toMatch(/<rect className="render-frame-device"[^>]*rx=\{RENDER_DEVICE_OUTLINE_RADIUS\}/);
});

test('workspace-is-padded-and-gapped', () => {
  const stack = resolved(['styles.css'], '.workspace-stack');
  expect(stack.get('padding')).toBe(`0 ${GAP}`);
  // It clips its sheets' ink 1px outside itself: their rings show, their shadows stay out of the chrome row.
  expect(stack.get('overflow')).toBe('clip');
  expect(stack.get('overflow-clip-margin')).toBe('1px');
  const row = resolved(['styles.css'], '.workspace');
  expect(row.get('gap')).toBe(GAP);
  const seo = resolved(['styles.css'], '.seo');
  expect(seo.get('gap')).toBe(GAP);
  // The wrappers and the status bar draw nothing of their own, and the workspace never clips the sheets' edges.
  const plain: [string, string[]][] = [
    ['.workspace', ['styles.css']],
    ['.seo', ['styles.css']],
    ['.agent', ['components/agent/agent.css', 'styles.css']],
    ['.status-bar', ['styles.css']],
  ];
  expect([...stack.keys()].filter((property) => /^(border|background|box-shadow|outline)/.test(property))).toEqual([]);
  for (const [selector, files] of plain) {
    const own = resolved(files, selector);
    const drawn = [...own.keys()].filter((property) => /^(border|background|box-shadow|outline)/.test(property) || (/^overflow/.test(property) && own.get(property) !== 'visible'));
    expect(drawn, selector).toEqual([]);
  }
  // The gaps replace the rules: no --divider edge on a sheet or a wrapper.
  for (const selector of ['.workspace-stack', '.seo', '.seo-panel', '.seo-rail', '.agent', '.agent-main', '.agent-rail', '.status-bar', '.devtools', '.projects-sheet', ".projects-sheet[data-running='true']", '.palette-sheet'])
    for (const [property, value] of resolved(['components/agent/agent.css', 'styles.css'], selector))
      expect(/^border/.test(property) && value.includes('--divider'), `${selector} { ${property}: ${value} }`).toBe(false);
  // The command palette's band: the canvas's padding, the gap to the page card under the card.
  expect(resolved(['styles.css'], '.palette-sheet').get('padding')).toBe(`0 0 ${GAP}`);
  // A Projects run's band stands the gap off the page card under it; the DevTools drawer as far under the row.
  expect(resolved(['styles.css'], ".projects-sheet[data-running='true']").get('margin-bottom')).toBe(GAP);
  expect(resolved(['styles.css'], '.devtools').get('margin-top')).toBe(GAP);
  expect(resolved(['styles.css'], '.devtools').get('max-height')).toBe(`calc(100% - var(--devtools-page-min) - ${GAP})`);
});

test('sheets-are-rounded-and-raised', () => {
  expect(WORKSPACE_SHEETS.length).toBe(11);
  for (const sheet of WORKSPACE_SHEETS) {
    const files = sheet.stylesheet === 'styles.css' ? ['styles.css'] : [sheet.stylesheet, 'styles.css'];
    const own = resolved(files, sheet.selector);
    expect(own.get('border-radius'), sheet.name).toBe(`var(${SHEET_RADIUS.token})`);
    expect(own.get('background'), sheet.name).toBe(`var(${sheet.fill})`);
    expect(own.get('box-shadow'), sheet.name).toBe(`var(${sheet.elevation})`);
    // The edge forced colours draw: a whole-pixel transparent border inside the sheet, or an outline outside it.
    expect(own.get(sheet.edge), sheet.name).toBe('1px solid transparent');
    if (sheet.edge === 'outline') expect(own.has('border'), sheet.name).toBe(false);
    // It clips its content to its corners (`clip`, or the scroll box it already was); the agent rail
    // doesn't (its toggle's focus ring reaches past its content box).
    if ('clips' in sheet) expect(own.get('overflow') ?? 'visible', sheet.name).toBe('visible');
    else expect(['clip', 'hidden', 'auto'], sheet.name).toContain(own.get('overflow'));
  }
  // Each sheet's own rule is where its fill lives (the page column's sheets share one shape rule).
  for (const sheet of WORKSPACE_SHEETS) expect(resolved([sheet.stylesheet], sheet.selector).get('background'), sheet.name).toBe(`var(${sheet.fill})`);
  // A rail's items keep their place inside its border; the agent rail's badge is cut out of the sheet.
  expect(resolved(['styles.css'], '.seo-rail').get('padding')).toBe('calc(var(--space-3) - 1px) 0');
  expect(resolved(['components/agent/agent.css'], '.agent-rail').get('padding')).toBe('calc(var(--space-3) - 1px) 0');
  expect(resolved(['components/agent/agent.css'], '.agent-rail-badge').get('box-shadow')).toBe('0 0 0 2px var(--bg-sheet)');
  // The SEO sheet's body: the canvas's 16px in.
  expect(resolved(['styles.css'], '.seo-body').get('padding')).toBe('var(--space-5)');
});

test('page-area-collapses-hide-it', () => {
  const listed = new Set(PAGE_AREA_COLLAPSES.map((entry) => `${entry.stylesheet}: ${entry.selector}`));
  const found: string[] = [];
  for (const file of CSS_FILES)
    for (const { selector: list, body } of topRules(file))
      for (const selector of selectorsOf(list)) {
        if (!/\.page-area$/.test(selector) || !/(?:^|[\s;])height:\s*0;/.test(body)) continue;
        found.push(`${file}: ${selector}`);
        expect(body, `${file}: ${selector}`).toMatch(/visibility:\s*hidden;/);
      }
  expect(found.sort()).toEqual([...listed].sort());
  // A Projects run gives the page area back its height, and shows it again.
  const running = resolved(['styles.css'], ".page-column:has(> .projects-sheet[data-running='true']) > .page-area");
  expect(running.get('height')).toBe('auto');
  expect(running.get('visibility')).toBe('visible');
});

test('entrance-animations-end', () => {
  const kept = new Set(ENTRANCE_FILL_EXCEPTIONS.map((entry) => `${entry.stylesheet}: ${entry.selector}`));
  const lingering: string[] = [];
  for (const file of CSS_FILES)
    for (const { selector: list, body } of rules(read(file))) {
      const fills = [...body.matchAll(/animation(?:-fill-mode)?\s*:\s*([^;]+);/g)].some(([, value]) => /(?:^|[\s,])(both|forwards)(?:[\s,]|$)/.test(value!));
      if (!fills) continue;
      for (const selector of selectorsOf(list)) if (!kept.has(`${file}: ${selector}`)) lingering.push(`${file}: ${selector}`);
    }
  expect(lingering).toEqual([]);
  // Each exception still names a rule that fills so (a stale entry guards nothing).
  for (const entry of ENTRANCE_FILL_EXCEPTIONS) expect(resolved([entry.stylesheet], entry.selector).get('animation'), entry.selector).toMatch(/\bboth\b/);
});

test('separators-sit-in-the-gap', () => {
  const separator = resolved(['styles.css'], '.pane-separator');
  expect(separator.get('width')).toBe(GAP);
  const line = resolved(['styles.css'], '.pane-separator::after');
  expect(line.get('width')).toBe('2px');
  expect(line.get('left')).toBe('calc(50% - 1px)');
  expect(resolved(['styles.css'], '.seo-separator').get('right')).toBe(`calc(-1 * ${GAP})`);
  expect(resolved(['components/agent/agent.css'], '.agent-separator').get('left')).toBe(`calc(-1 * ${GAP})`);
  // The line is centred for both: neither pane moves it.
  expect(resolved(['styles.css', 'components/agent/agent.css'], '.seo-separator::after').size).toBe(0);
  expect(resolved(['styles.css', 'components/agent/agent.css'], '.agent-separator::after').size).toBe(0);
});
