// Specs: specs/visual-baseline.feature.md (the surfaces, themes, hidden text, determinism rules and the baseline procedure)
// Acceptance: specs/visual-baseline.feature.md (End to end)
//
// The screenshot baseline: every main surface of the chrome page (`app://app/`), in light and dark,
// compared with `toHaveScreenshot` against `e2e/__screenshots__/visual.e2e.ts/<state>-<theme>.png`.
// Only the chrome is captured; a tab's page is a native view no page screenshot includes. Text that
// follows the clock or the date is drawn without glyphs by visual.css; CAPTURES lists every capture.
//
// Linux only, and the baselines come from CI only (`xvfb-run` on ubuntu-24.04): a local run writes
// missing images (`updateSnapshots: 'missing'`) for looking at, but they differ from CI's and are
// never committed. To add or update baselines, follow "Baseline procedure" in the spec: run CI on
// the branch, download the failed shard's `playwright-report-linux-<n>` artifact, copy each `*-actual.png` to its baseline
// path, review, commit.
import { X509Certificate, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT_SETTINGS_TEXT, SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { AGENT_E2E_SCRIPT_SWITCH } from '@app/specs/agent-session.spec';
import { HISTORY_MENU_ID, JUMP_BACK_IN_TITLE } from '@app/specs/browser-polish.spec';
import { COMMAND_PALETTE_MENU_ID } from '@app/specs/command-palette.spec';
import { DEVTOOLS_MENU_ID } from '@app/specs/devtools.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { GSC_PANEL_COPY } from '@app/specs/gsc-panel.spec';
import { PERMISSION_PROMPT_ACTIONS } from '@app/specs/permissions.spec';
import { AUDIT_DEBOUNCE_MS, EXTRACT_TIMEOUT_MS } from '@app/specs/seo-limits.spec';
import { UPDATE_FEED_SWITCH, UPDATE_PREFS_FILE, UPDATE_PUBLIC_KEY_SWITCH, UPDATE_TEST_CERT_SWITCH, updateAvailableText } from '@app/specs/update-client.spec';
import { updatePlatformKey } from '@app/specs/update-manifest.spec';
import { artifactBytes, manifestFor, sha256Hex, signEnvelope, startFakeFeed, testSigningKey, type FakeFeed } from '../src/main/update/__tests__/fake-feed';
import { accountHelpers, fakeAccountEnv } from './account-helpers';
import { startFakeBackend, type FakeBackend } from './fake-backend';
import { startFakeGoogle, type FakeGoogle } from './fake-google';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { selfSignedCertificate } from './tls';

test.skip(process.platform !== 'linux', 'The screenshot baseline is Linux-only (CI renders it under xvfb); macOS and Windows skip it.');

// Never retried (CI retries the other suites' failed tests: playwright.config.ts). A differing or
// missing image is a result, not a flake, and a baseline run renders each state once.
test.describe.configure({ retries: 0 });

/** The window's content size every capture is taken at (CSS px; `scale: 'css'`). */
const WINDOW = { width: 1280, height: 800 } as const;
const THEMES = ['light', 'dark'] as const;

/**
 * The fixture site's public-looking names (`--host-resolver-rules` maps them, port included, to the
 * loopback server): every URL the chrome shows is the same in every run, with no random port.
 * `PERM_HOST` is also treated as a secure origin (`--unsafely-treat-insecure-origin-as-secure`), so
 * a page on it may ask for a permission; `HOST`'s pages are the plain http pages they look like.
 */
const HOST = 'visual.frost-e2e.net';
const PERM_HOST = 'permissions.frost-e2e.net';
const ORIGIN = `http://${HOST}`;
const PERM_ORIGIN = `http://${PERM_HOST}`;
const AUDIT_WAIT = AUDIT_DEBOUNCE_MS + EXTRACT_TIMEOUT_MS + 5_000;

/** As seo-speed.e2e.ts: through X11 on Linux (some Wayland compositors give Chromium no paint timing). */
const PLATFORM_ARGS = process.platform === 'linux' && process.env['DISPLAY'] ? ['--ozone-platform=x11'] : [];

// ---------------------------------------------------------------------------------------------
// The fixture site: frost's own words, nothing that changes between runs.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
/**
 * `PNG` with a `tEXt` chunk of `padding` bytes after its header: a valid image of its own byte size.
 * Page Speed's "Largest requests" sorts by size and keeps equal sizes in load order, so the
 * guide's images each get a different size and the list's order never follows timing.
 */
function paddedPng(padding: number): Buffer {
  const data = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.alloc(padding, 0x2e)]);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write('tEXt', 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt', 'ascii'), data])) >>> 0, 0);
  const afterHeader = 8 + 25; // the signature, then IHDR (length, type, 13 bytes, CRC)
  return Buffer.concat([PNG.subarray(0, afterHeader), head, data, crc, PNG.subarray(afterHeader)]);
}
const IMAGES: Readonly<Record<string, Buffer>> = { '/img/jar.png': paddedPng(600), '/img/steps.png': paddedPng(200) };
const words = (n: number) => Array.from({ length: n }, (_, i) => ['cold', 'brew', 'coffee', 'water', 'grind', 'steep', 'filter', 'jar'][i % 8]).join(' ');
const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

/** The SEO surfaces' page (seo-sidebar.e2e.ts's good page, seo-schema.e2e.ts's structured data): a few findings, every panel filled. */
const GUIDE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Cold-brew coffee at home: a simple guide</title>
<meta name="description" content="How to make smooth cold-brew coffee at home: the ratio, the grind, steeping times and storage, with no special kit.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="${ORIGIN}/guide"><meta property="og:url" content="${ORIGIN}/guide">
<meta property="og:title" content="Cold-brew coffee at home"><meta property="og:description" content="The ratio, the grind and the steeping time.">
<meta property="og:image" content="${ORIGIN}/img/cover.png"><meta name="twitter:card" content="summary_large_image">
${ld({ '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#org`, name: 'Frost Test Kitchen', url: `${ORIGIN}/`, logo: `${ORIGIN}/img/logo.png` })}
${ld({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: ['Home', 'Guides', 'Cold brew'].map((name, i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${ORIGIN}/${['', 'guides', 'guide'][i]}` })) })}
${ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'Cold-brew jar', image: `${ORIGIN}/img/jar.png`, description: 'A one-litre jar with a fine filter.', sku: 'CB-1', brand: { '@type': 'Brand', name: 'Frost' }, offers: { '@type': 'Offer', price: '24.00', priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: `${ORIGIN}/guide` } })}
</head><body><header><nav aria-label="Site"><a href="/">Home</a> <a href="/guides/">Guides</a></nav></header>
<main><h1>Cold-brew coffee at home</h1><p>${words(420)}</p><h2>What you need</h2><h3>Grind</h3><h3>Ratio</h3><h2>Storing it</h2>
<img src="/img/jar.png" alt="A jar of cold brew" width="320" height="200"><img src="/img/steps.png" width="160" height="100"></main>
<footer><p>Written by the frost test kitchen.</p></footer>
<script>console.log('cold brew ready'); console.log('cold brew ready'); console.warn('steep for twelve hours');</script></body></html>`;

/** The Changes page's two versions (changes.e2e.ts): v2 edits the title, a paragraph and a navigation link. */
const VERSIONS = {
  1: { title: 'Cold brew at home: a starter guide', paragraph: 'Steep coarse ground coffee in cold water for twelve hours, then strain it through a paper filter.', nav: 'Pricing' },
  2: { title: 'Cold brew at home: the complete guide', paragraph: 'Steep coarse ground coffee in cold water for sixteen hours, then strain it through a paper filter.', nav: 'Plans and pricing' },
} as const;
const changesPage = (version: 1 | 2) => {
  const v = VERSIONS[version];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${v.title}</title>
<meta name="description" content="How to make cold brew coffee at home with coarse grounds, cold water and a paper filter.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><header><nav aria-label="Site"><a href="/pricing">${v.nav}</a> <a href="/about">About</a></nav></header>
<main><h1>Cold brew at home</h1><p>${v.paragraph}</p><p>Keep the concentrate in the fridge for up to a week and dilute it to taste.</p></main>
<footer><p>Written by the frost test kitchen.</p></footer></body></html>`;
};

/** projects.e2e.ts's pages. */
const projectPage = (name: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name} guide</title>
<meta name="description" content="The ${name} guide: how to brew it at home, step by step, with the gear you already have.">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><h1>The ${name} guide</h1><p>Grind the beans, heat the water, and pour slowly over the grounds for the ${name} method.</p></main></body></html>`;

async function startSite() {
  const state = { version: 1 as 1 | 2 };
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
    if (pathname === '/robots.txt') response.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
    else if (pathname === '/guide') html(GUIDE);
    else if (pathname === '/changes') html(changesPage(state.version));
    else if (pathname === '/alpha' || pathname === '/beta') html(projectPage(pathname.slice(1)));
    // browser-polish.e2e.ts's find page and titled history pages; agent.e2e.ts's start page.
    else if (pathname === '/find') html(`<!doctype html><html lang="en"><title>Find page</title><body><p>Green tea is calm.</p><p>Black TEA is bold.</p><p>White tea is light.</p></body></html>`);
    else if (pathname.startsWith('/h/')) {
      const name = pathname.slice(3);
      html(`<!doctype html><html lang="en"><title>${name.charAt(0).toUpperCase()}${name.slice(1)} page</title><p>${name}</p></html>`);
    } else if (pathname === '/start') html('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent start</title></head><body><h1>Agent start</h1><p>Where the agent begins.</p></body></html>');
    else if (pathname === '/notify') html('<!doctype html><html lang="en"><title>Page NOTIFY</title><h1>Page NOTIFY</h1></html>');
    // Never cached: Page Speed's request list says "cached" for a cached one, which would follow the order of the tests.
    else if (pathname.startsWith('/img/')) response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).end(IMAGES[pathname] ?? PNG);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let site: Awaited<ReturnType<typeof startSite>>;
/** The launch arguments that put the fixture site on its fixed names. */
const siteArgs = () => [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${site.port},MAP ${PERM_HOST} 127.0.0.1:${site.port}`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${HOST},${PERM_HOST}`];

test.beforeAll(async () => {
  site = await startSite();
});

test.afterAll(async () => {
  await site?.close();
});

// ---------------------------------------------------------------------------------------------
// The app under capture, and the helpers every state shares.

let app: ElectronApplication | undefined;
let page: Page;
const { go, contentsIdAt, menu, press, run, activeTab, closeAllTabs, chromeCaughtUp } = chromeHelpers(
  () => app!,
  () => page,
);

/** Launches the app (`PLATFORM_ARGS` first) and gives its window `WINDOW`'s content size. */
async function launch(args: readonly string[] = [], options: Parameters<typeof launchApp>[1] = {}): Promise<void> {
  ({ app, page } = await launchApp([...PLATFORM_ARGS, ...args], options));
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), WINDOW);
  if (process.env['CI']) {
    // CI (xvfb, no window manager): the window really has that size.
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(WINDOW);
  } else {
    // A tiling window manager (Hyprland) resizes the window when it likes, even after this: lay the
    // chrome out at WINDOW whatever the window's size (as seo-sidebar.e2e.ts's narrow-window test does).
    await page.setViewportSize(WINDOW);
  }
}

/**
 * Every capture's name: `capture()` takes only these, and 'every capture has a baseline' checks
 * the baseline directory against them (`<name>-light.png`, `<name>-dark.png`).
 */
const CAPTURES = [
  'new-tab',
  'new-tab-jump-back-in',
  'history',
  'seo-overview',
  'seo-on-page',
  'seo-links',
  'seo-images',
  'seo-social',
  'seo-schema',
  'seo-page-speed',
  'seo-page-speed-middle',
  'seo-page-speed-lower',
  'seo-search-console',
  'seo-search-console-lower',
  'seo-changes',
  'seo-changes-lower',
  'seo-content',
  'seo-content-lower',
  'seo-javascript',
  'seo-serp',
  'seo-visibility',
  'devtools-drawer',
  'find-bar',
  'command-palette',
  'settings',
  'settings-lower',
  'help-shortcuts',
  'projects',
  'projects-lower',
  'render-profile',
  'permission-bar',
  'page-error',
  'update-bar',
  'agent-empty',
  'agent-conversation',
] as const;
type CaptureName = (typeof CAPTURES)[number];
const baselineFiles = (): string[] => CAPTURES.flatMap((name) => THEMES.map((theme) => `${name}-${theme}.png`));

/**
 * The screenshot-only stylesheet: it hides the glyphs of text that follows the clock, the date or a
 * measured time, keeping its box (visual.css says which, and why each box is fixed). Inserted from
 * main (`webContents.insertCSS`) for the captures only: Playwright's own `stylePath` injects a
 * `<style>` element, which the chrome's strict CSP refuses without a word.
 */
const VISUAL_CSS = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'visual.css'), 'utf8');

/**
 * Text left out of `settled()`'s comparison: Page Speed's measured values, which its live updates
 * (every SPEED_POLL_MS) may rewrite while the state is otherwise still. visual.css hides each of them.
 */
const TICKING = [
  '.seo-speed-live-text',
  '[data-testid="seo-speed-metric-value"]',
  '[data-testid="seo-speed-navigation"] .seo-badge',
  '[data-testid="seo-speed-navigation"] dd',
  '[data-testid="seo-speed-large"] .seo-speed-num + .seo-speed-num',
];

/** What still says it is working: a busy region, a tab's spinner, the audit skeleton, or a "Loading…"-style line. */
const BUSY_SELECTORS = '[aria-busy="true"], [data-testid="tab-loading"], [data-testid="seo-pending"], [data-testid="gsc-loading"], [data-testid="changes-loading"]';
const BUSY_TEXT = /\b(Loading|Reading|Checking|Measuring|Waiting|Starting|Connecting|Saving|Capturing|Adding|Downloading)\b[^…]{0,40}…/;

/**
 * Waits until the chrome holds still: nothing on screen says it is still working, and its text
 * (bar `TICKING`), its state attributes and the audit's identity have not changed for 1.5 s (a
 * served-HTML fetch, the speed measurement or AI readiness can land after the first answer).
 */
async function settled(): Promise<void> {
  let last = '';
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(
          ({ ticking, busySelectors, busyText }) => {
            const shown = (el: Element) => el.getClientRects().length > 0;
            const busy = [...document.querySelectorAll(busySelectors)].filter(shown).map((el) => el.getAttribute('data-testid') ?? el.className);
            const texts: string[] = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const parent = node.parentElement;
              if (!parent || !shown(parent) || ticking.some((selector) => parent.closest(selector))) continue;
              const text = node.textContent?.trim() ?? '';
              if (text === '') continue;
              if (new RegExp(busyText).test(text)) busy.push(text);
              texts.push(text);
            }
            const states = [...document.querySelectorAll('[data-state], [data-status], [data-band], [data-outcome]')].map((el) =>
              ['data-state', 'data-status', 'data-band', 'data-outcome'].map((name) => el.getAttribute(name) ?? '').join(':'),
            );
            const audit = document.querySelector('[data-testid="seo-duration"]')?.getAttribute('data-ms') ?? '';
            return { busy, signature: [texts.join('␟'), states.join(','), audit].join('|') };
          },
          { ticking: TICKING, busySelectors: BUSY_SELECTORS, busyText: BUSY_TEXT.source },
        );
        const signature = now.busy.length > 0 ? `busy ${now.busy.join(', ')}` : now.signature;
        if (signature !== last || now.busy.length > 0) [last, since] = [signature, Date.now()];
        return now.busy.length > 0 ? `still busy: ${now.busy.join(', ')}` : Date.now() - since >= 1_500;
      },
      { timeout: 30_000, intervals: [250], message: 'the chrome settles (nothing busy, nothing changing for 1.5 s)' },
    )
    .toBe(true);
}

/**
 * `VISUAL_STRICT=1`: no counted pixel may differ (`maxDiffPixels: 0`; pixelmatch never counts pixels it
 * classifies as anti-aliasing, so this is not byte-for-byte), for a local run or an explicit
 * check of a change that must not move anything; by default up to 0.2 % may (playwright.config.ts).
 */
const STRICT = process.env['VISUAL_STRICT'] === '1' ? { maxDiffPixels: 0, maxDiffPixelRatio: 0 } : {};

/**
 * Captures the chrome page as `<name>-light.png` and `<name>-dark.png`, once it has `settled()`.
 * Focus leaves the chrome (unless `keepFocus`: the state is about a focused field) and the pointer
 * rests on the status bar, so no focus ring or hover depends on what the flow clicked last. The
 * theme is the chrome's emulated `prefers-color-scheme`; each capture checks the media query and
 * the body's colour really follow it. Soft: a different image fails the test but the other
 * captures run. A missing baseline is written (and its `*-actual.png` kept) by Playwright
 * (`updateSnapshots: 'missing'`); 'every capture has a baseline' fails for it in CI.
 */
async function capture(name: CaptureName, options: { readonly keepFocus?: boolean; readonly scroll?: Scroll } = {}): Promise<void> {
  if (!options.keepFocus) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(Math.round(WINDOW.width / 2), WINDOW.height - 4);
  await settled();
  const key = await app!.evaluate(({ BrowserWindow }, css) => BrowserWindow.getAllWindows()[0]!.webContents.insertCSS(css), VISUAL_CSS);
  try {
    // visual.css's marker: the sheet is in effect.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--frost-visual-css').trim())).toBe('on');
    // Scrolled with the sheet in effect (it removes or shortens content inside some scrollers), so
    // the position checked is the position captured.
    if (options.scroll) {
      await scrollTo(options.scroll);
      await settled();
    }
    const backgrounds: string[] = [];
    for (const scheme of THEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(scheme === 'dark');
      backgrounds.push(await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
      await expect.soft(page).toHaveScreenshot(`${name}-${scheme}.png`, STRICT);
    }
    expect(backgrounds[0], 'the dark theme repaints the chrome').not.toBe(backgrounds[1]);
  } finally {
    await app!.evaluate(({ BrowserWindow }, key) => BrowserWindow.getAllWindows()[0]!.webContents.removeInsertedCSS(key), key);
    await page.emulateMedia({ colorScheme: null });
  }
}

/**
 * Where a "-lower" capture looks: `selector`'s scroller (the SEO panel's `.seo-body`, the Settings
 * content, the Projects sheet) scrolled to its end (`'end'`), or to `top` px. Each capture is the
 * visible window only; the scroll brings what lies below it into view.
 */
type Scroll = { readonly selector: string; readonly to: 'end' } | { readonly selector: string; readonly top: number };

/** Scrolls `scroll.selector` (instantly) and checks it got there. */
async function scrollTo(scroll: Scroll): Promise<void> {
  const target = page.locator(scroll.selector);
  await expect(target).toHaveCount(1);
  const reached = await target.evaluate((el, top) => {
    const wanted = top ?? el.scrollHeight;
    el.scrollTo({ top: wanted, behavior: 'instant' });
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight, wanted };
  }, 'top' in scroll ? scroll.top : null);
  expect(reached.max, `${scroll.selector} has something below the fold`).toBeGreaterThan(0);
  // A fixed offset is really below the end: a shorter scroller would quietly capture its end instead.
  if ('top' in scroll) expect(reached.wanted, `${scroll.selector} reaches ${reached.wanted} px`).toBeLessThanOrEqual(reached.max);
  // Within a pixel: a fractional device scale (a local run) rounds the scroll position.
  expect(Math.abs(reached.top - Math.min(reached.wanted, reached.max)), `${scroll.selector} scrolled to ${reached.wanted}`).toBeLessThanOrEqual(1);
}

/** The scrollers a "-lower" capture moves: back to the top before each shared-app state. */
const SCROLLERS = ['.seo-body', '.settings-content', '.projects-main'];

const sidebar = () => page.getByTestId('seo-sidebar');
const railItem = (panel: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);

/** Opens the sidebar on `panel` (seo-sidebar.e2e.ts). */
async function showPanel(panel: string): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `pathname` of `origin` in the active tab and waits for its audit (On-Page shows its URL: seo-sidebar.e2e.ts). */
async function audit(pathname: string, origin = ORIGIN): Promise<number> {
  const url = `${origin}${pathname}`;
  await go(url);
  await showPanel('on-page');
  await expect(page.getByTestId('seo-fact-url')).toHaveText(url, { timeout: AUDIT_WAIT });
  return contentsIdAt(url);
}

// ---------------------------------------------------------------------------------------------
// One app for the states a loaded page shares: each test starts from one tab on the guide.

test.describe('page surfaces', () => {
  test.beforeAll(async () => {
    await launch([...siteArgs(), `--unsafely-treat-insecure-origin-as-secure=${PERM_ORIGIN}`]);
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
  });

  /** Back to one tab, every sheet, bar and drawer closed, the sidebar open (each state is independent of the order). */
  test.beforeEach(async () => {
    if ((await page.getByTestId('command-palette').count()) > 0) await page.getByTestId('command-palette-input').press('Escape');
    for (const sheet of ['settings', 'history', 'projects']) if ((await page.getByTestId(`${sheet}-view`).count()) > 0) await page.getByTestId(`${sheet}-close`).click();
    if ((await page.getByTestId('shortcuts-view').count()) > 0) await page.getByTestId('shortcuts-view-close').click();
    if ((await page.getByTestId('devtools').count()) > 0) await menu(DEVTOOLS_MENU_ID);
    if (await page.getByTestId('render-profile-bar').isVisible()) await page.getByTestId('render-profile-close').click();
    await closeAllTabs();
    if ((await sidebar().getAttribute('data-open')) !== 'true') await page.getByTestId('seo-toggle').click();
    await expect(sidebar()).toHaveAttribute('data-open', 'true');
    // A "-lower" capture left its scroller at the end.
    await page.evaluate((scrollers) => {
      for (const el of document.querySelectorAll(scrollers.join(', '))) el.scrollTo({ top: 0, behavior: 'instant' });
    }, SCROLLERS);
  });

  test('seo-overview', async () => {
    await audit('/guide');
    await showPanel('overview');
    await expect(page.getByTestId('seo-score')).toBeVisible();
    // AI readiness scores the page once its checks are in: 3 of 4 (the visibility probes never ran).
    await expect(page.getByTestId('ai-readiness-ring')).toHaveAttribute('data-state', 'partial', { timeout: AUDIT_WAIT });
    await capture('seo-overview');
  });

  test('seo-on-page', async () => {
    await audit('/guide');
    await showPanel('on-page');
    await expect(page.getByTestId('seo-heading')).toHaveCount(5);
    await capture('seo-on-page');
  });

  test('seo-links', async () => {
    await audit('/guide');
    await showPanel('links');
    await expect(page.getByTestId('seo-link-row')).toHaveCount(2);
    await capture('seo-links');
  });

  test('seo-images', async () => {
    await audit('/guide');
    await showPanel('images');
    await expect(page.getByTestId('seo-images-table').locator('.seo-table-row')).toHaveCount(2);
    await capture('seo-images');
  });

  test('seo-social', async () => {
    await audit('/guide');
    await showPanel('social');
    await expect(page.getByTestId('seo-social-card-large')).toBeVisible();
    await capture('seo-social');
  });

  test('seo-schema', async () => {
    await audit('/guide');
    await showPanel('schema');
    await expect(page.getByTestId('seo-schema-block')).toHaveCount(3);
    await capture('seo-schema');
  });

  test('seo-page-speed', async () => {
    // seo-speed.e2e.ts's `measure`: the panel's live measurement of this URL.
    await audit('/guide');
    await showPanel('speed');
    await expect(page.getByTestId('seo-audit-url')).toHaveAttribute('title', `⁨${ORIGIN}/guide⁩`, { timeout: AUDIT_WAIT });
    await expect(page.getByTestId('seo-speed')).toHaveAttribute('data-source', 'live', { timeout: AUDIT_WAIT });
    const metric = (name: string) => page.locator(`[data-testid="seo-speed-metric"][data-metric="${name}"]`);
    // Every vital the page can have without input is measured (INP needs an interaction): LCP, CLS, FCP, TTFB.
    for (const name of ['lcp', 'cls', 'fcp', 'ttfb']) await expect.poll(async () => (await metric(name).getAttribute('data-value')) ?? '', { timeout: 15_000, message: name }).not.toBe('');
    await expect(page.locator('[data-testid="seo-speed-type"][data-type="document"]')).toHaveAttribute('data-requests', '1');
    await expect(page.getByTestId('seo-speed-ttfb')).not.toHaveText('');
    await expect(page.getByTestId('seo-speed-load')).not.toHaveText('Not yet');
    // A slow machine fails here, by name, rather than as an image difference: every measured vital
    // and the verdict are in the good band (loopback pages, no throttling).
    for (const name of ['lcp', 'cls', 'fcp', 'ttfb']) await expect(metric(name), name).toHaveAttribute('data-band', 'good');
    await expect(page.getByTestId('seo-speed-verdict')).toHaveAttribute('data-band', 'good');
    // The measured times themselves are hidden by visual.css (their values, meter markers, the
    // Navigation card's numbers, the largest requests' durations, the "updated … ago" line).
    await capture('seo-page-speed');
    // Below the fold, almost three screens in all: one screen down (the vitals' end, Issues,
    // Navigation timing, Requests), then the end (Requests, Largest requests, Hosts, DOM).
    await capture('seo-page-speed-middle', { scroll: { selector: '.seo-body', top: 600 } });
    await capture('seo-page-speed-lower', { scroll: { selector: '.seo-body', to: 'end' } });
  });

  test('seo-changes', async () => {
    // changes.e2e.ts: a first capture, the page changes, a second capture shows the diff.
    const panel = page.getByTestId('changes');
    const captureButton = page.getByTestId('changes-capture');
    site.state.version = 1;
    try {
      await audit('/changes');
      await showPanel('changes');
      await expect(panel).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
      await expect(captureButton).toBeEnabled({ timeout: AUDIT_WAIT });
      await captureButton.click();
      await expect(page.getByTestId('changes-capture-status')).toHaveAttribute('data-outcome', 'first');
      site.state.version = 2;
      const before = await panel.getAttribute('data-audit-at');
      await page.getByTestId('reload').click();
      await expect(panel).not.toHaveAttribute('data-audit-at', before ?? '', { timeout: AUDIT_WAIT });
      await expect(panel).toHaveAttribute('data-audit', 'ready', { timeout: AUDIT_WAIT });
      await expect(captureButton).toBeEnabled({ timeout: AUDIT_WAIT });
      await captureButton.click();
      await expect(page.getByTestId('changes-capture-status')).toHaveAttribute('data-outcome', 'new');
      await expect(page.getByTestId('changes-diff')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('changes-version')).toHaveCount(2);
      // The versions' capture times (the history list, the diff's heading, its compare picker) are hidden by visual.css.
      await capture('seo-changes');
      // The rest of the diff (main content, navigation) and what follows it.
      await capture('seo-changes-lower', { scroll: { selector: '.seo-body', to: 'end' } });
    } finally {
      site.state.version = 1;
    }
  });

  test('seo-content', async () => {
    // seo-content.e2e.ts: the guide's result preview, its width meters and tools; then its end
    // (readability, the difficult sentences, the notes).
    await audit('/guide');
    await showPanel('content');
    await expect(page.getByTestId('seo-serp-desktop')).toBeVisible();
    await expect(page.getByTestId('seo-readability')).toHaveAttribute('data-status', 'ok');
    await expect(page.getByTestId('seo-query-input')).toBeEnabled();
    await capture('seo-content');
    await capture('seo-content-lower', { scroll: { selector: '.seo-body', to: 'end' } });
  });

  test('seo-javascript', async () => {
    // seo-javascript.e2e.ts: the guide served and rendered alike.
    await audit('/guide');
    await showPanel('javascript');
    await expect(page.getByTestId('seo-js-state')).not.toHaveAttribute('data-state', 'pending', { timeout: AUDIT_WAIT });
    await capture('seo-javascript');
  });

  test('seo-serp', async () => {
    // serp.e2e.ts serp-not-a-result-page: the guide is no result page (the bundled selectors).
    await audit('/guide');
    await showPanel('serp');
    await expect(page.getByTestId('serp-state')).toHaveAttribute('data-state', 'not-serp', { timeout: AUDIT_WAIT });
    await capture('seo-serp');
  });

  test('seo-visibility', async () => {
    // visibility.e2e.ts: before a run, the panel's end (the disclosure, Run visibility probes, the
    // query box), below the AI-readiness section.
    await audit('/guide');
    await showPanel('visibility');
    await expect(page.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'idle');
    await capture('seo-visibility', { scroll: { selector: '.seo-body', to: 'end' } });
  });

  test('devtools-drawer', async () => {
    // devtools.e2e.ts: the drawer from its menu item, on its Console tab.
    await audit('/guide');
    await menu(DEVTOOLS_MENU_ID);
    await expect(page.getByTestId('devtools')).toBeVisible();
    await page.locator('[data-testid="devtools-tab"][data-tab="console"]').click();
    await expect(page.getByTestId('devtools-panel')).toHaveAttribute('data-tab', 'console');
    await expect(page.getByTestId('devtools-console-row')).toHaveCount(2);
    await expect(page.getByTestId('devtools-console-count')).toHaveText('×2');
    await capture('devtools-drawer');
    await menu(DEVTOOLS_MENU_ID);
    await expect(page.getByTestId('devtools')).toHaveCount(0);
  });

  test('find-bar', async () => {
    // browser-polish.e2e.ts: Mod+F in the page, three matches.
    const id = await audit('/find');
    await app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.focus(), id);
    await press(id, 'F', ['mod']);
    await expect(page.getByTestId('find-bar')).toBeVisible();
    await expect(page.getByTestId('find-input')).toBeFocused();
    await page.getByTestId('find-input').fill('tea');
    await expect(page.getByTestId('find-count')).toHaveText('1 of 3');
    await capture('find-bar', { keepFocus: true });
    await page.getByTestId('find-input').press('Escape');
    await expect(page.getByTestId('find-bar')).toHaveCount(0);
  });

  test('command-palette', async () => {
    // command-palette.e2e.ts / update.e2e.ts: the menu item, then a query.
    await audit('/guide');
    await menu(COMMAND_PALETTE_MENU_ID);
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('command-palette-input').fill('zoom');
    await expect(page.getByTestId('command-palette-option').first()).toBeVisible();
    await expect(page.locator('[data-testid="command-palette-option"][aria-selected="true"]')).toHaveCount(1);
    await capture('command-palette', { keepFocus: true });
    await page.getByTestId('command-palette-input').press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
  });

  test('settings', async () => {
    // settings.e2e.ts: the Settings menu item.
    await audit('/guide');
    await menu(SETTINGS_MENU.id);
    await expect(page.getByTestId('settings-view')).toBeVisible();
    // Account, Search Console, Data sources and AI checks each say "Loading…" until main answers
    // (settings-account.tsx, settings-gsc.tsx, settings-data-sources.tsx, settings-ai-checks.tsx): every one has answered.
    await expect(page.getByTestId('settings-content')).not.toContainText('Loading…');
    await expect(page.getByTestId('settings-content')).toContainText(ACCOUNT_SETTINGS_TEXT.unconfigured);
    await capture('settings');
    // Lower down (Data sources sits between Search Console and AI checks): the rest of the sections.
    await capture('settings-lower', { scroll: { selector: '.settings-content', to: 'end' } });
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings-view')).toHaveCount(0);
  });

  test('help-shortcuts', async () => {
    // browser-polish.e2e.ts (help-shortcuts-sheet): Help › Keyboard Shortcuts, over an audited page.
    await audit('/guide');
    await menu('help-shortcuts');
    await expect(page.getByTestId('shortcuts-view')).toBeVisible();
    await capture('help-shortcuts');
    await page.getByTestId('shortcuts-view-close').click();
    await expect(page.getByTestId('shortcuts-view')).toHaveCount(0);
  });

  test('projects', async () => {
    // projects.e2e.ts: the sheet from the Changes panel, a project with two pages added.
    await audit('/alpha');
    await showPanel('changes');
    await page.getByTestId('changes-open-projects').click();
    const sheet = page.getByTestId('projects-view');
    await expect(sheet).toBeVisible();
    await page.getByTestId('projects-create-name').fill('Coffee site');
    await page.getByTestId('projects-create').click();
    await expect(page.getByTestId('projects-name')).toHaveText('Coffee site');
    for (const url of [`${ORIGIN}/alpha`, `${ORIGIN}/beta`]) {
      await page.getByTestId('projects-page-url').fill(url);
      await page.getByTestId('projects-page-add').click();
      await expect(page.getByTestId('projects-status')).toHaveText('Page added.');
    }
    await expect(page.getByTestId('projects-page')).toHaveCount(2);
    await expect(page.getByTestId('projects-page').first().getByTestId('projects-page-last')).toHaveText('Not captured yet');
    await capture('projects');
    // Search queries and Retention and disk usage (the database file's size hidden by visual.css).
    await capture('projects-lower', { scroll: { selector: '.projects-main', to: 'end' } });
    await page.getByTestId('projects-close').click();
    await expect(sheet).toHaveCount(0);
  });

  test('render-profile', async () => {
    // render-profile.e2e.ts: the phone preset and the mobile user agent, applied and reloaded; the editor bar open again.
    const id = await audit('/guide');
    await page.getByTestId('render-profile-toggle').click();
    const bar = page.getByTestId('render-profile-bar');
    await expect(bar).toBeVisible();
    await bar.getByTestId('render-device').selectOption('phone');
    await bar.getByTestId('render-user-agent').selectOption('mobile');
    await bar.getByTestId('render-apply').click();
    await page.getByTestId('render-profile-close').click();
    await expect(bar).toBeHidden();
    await expect(activeTab().getByTestId('tab-render-profile')).toHaveAttribute('data-status', 'active');
    await page.getByTestId('render-frame-reload').click();
    await expect(page.getByTestId('render-frame-reload')).toHaveCount(0);
    await expect.poll(() => app!.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
    await expect(page.getByTestId('render-frame-summary')).toHaveText('Phone 412×915 · Mobile browser');
    await page.getByTestId('render-profile-toggle').click();
    await expect(bar).toBeVisible();
    await capture('render-profile');
    await page.getByTestId('render-profile-close').click();
  });

  test('permission-bar', async () => {
    // permissions.e2e.ts: a page asks for notifications; the bar, armed.
    const id = await audit('/notify', PERM_ORIGIN);
    await expect(activeTab()).toHaveAttribute('title', 'Page NOTIFY');
    const asked = run(id, 'Notification.requestPermission()').catch(() => undefined);
    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible();
    await expect(page.getByTestId('permission-prompt-text')).toHaveText(`${PERM_HOST} wants to ${PERMISSION_PROMPT_ACTIONS.notifications}`);
    await expect(prompt).toHaveAttribute('data-armed', 'true');
    await capture('permission-bar');
    await page.getByTestId('permission-block').click();
    await expect(prompt).toHaveCount(0);
    await asked;
  });

  test('page-error', async () => {
    // browse-guard.e2e.ts: a load that fails shows the error panel in the page area. Chromium refuses
    // port 9 before any request (ERR_UNSAFE_PORT), so the URL, the message and the code never vary.
    await go('http://127.0.0.1:9/');
    await expect(page.getByTestId('page-error')).toBeVisible();
    await expect(page.getByTestId('page-error-detail')).toHaveText('ERR_UNSAFE_PORT');
    await capture('page-error');
  });
});

// ---------------------------------------------------------------------------------------------
// A fresh profile: the new tab before and after some browsing, and History.

test.describe('new tab and history', () => {
  test.beforeAll(async () => {
    await launch(siteArgs());
    await chromeCaughtUp();
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
  });

  test('new-tab', async () => {
    // A fresh profile's empty tab: the start view, no tiles yet, the sidebar's hint.
    await expect(page.getByTestId('start-view')).toBeVisible();
    await expect(page.getByTestId('seo-empty')).toBeVisible();
    await expect(page.getByTestId('jump-back-in')).toHaveCount(0);
    await capture('new-tab');
  });

  test('jump-back-in-and-history', async () => {
    // browser-polish.e2e.ts: some visits, then the new tab's "Jump back in" and the History sheet
    // (one test: both show the same visits).
    for (const name of ['kiwi', 'lime', 'kiwi', 'kiwi', 'mango']) {
      await go(`${ORIGIN}/h/${name}`);
      await contentsIdAt(`${ORIGIN}/h/${name}`);
      await expect(activeTab()).toHaveAttribute('title', `${name.charAt(0).toUpperCase()}${name.slice(1)} page`);
    }
    await menu('new-tab');
    await expect(page.getByTestId('jump-back-in')).toContainText(JUMP_BACK_IN_TITLE);
    await expect(page.getByTestId('jump-tile')).toHaveCount(3);
    await capture('new-tab-jump-back-in');

    await menu(HISTORY_MENU_ID);
    await expect(page.getByTestId('history-view')).toBeVisible();
    await expect(page.getByTestId('history-row')).toHaveCount(3);
    await capture('history');
  });
});

// ---------------------------------------------------------------------------------------------
// The agent panel on the scripted model seam (agent.e2e.ts): empty, then one turn with a tool call.

test.describe('agent panel', () => {
  let scripts: string;

  test.beforeAll(async () => {
    scripts = await mkdtemp(path.join(tmpdir(), 'frost-e2e-visual-agent-'));
    const file = path.join(scripts, 'script.json');
    await writeFile(file, JSON.stringify({ steps: [{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['The page says where the agent begins.'] }] }));
    await launch([...siteArgs(), `--${AGENT_E2E_SCRIPT_SWITCH}=${file}`, '--password-store=basic']);
    // agent.e2e.ts's `launchWith`: the page, the SEO sidebar's panel collapsed, the agent panel open.
    await go(`${ORIGIN}/start`);
    await contentsIdAt(`${ORIGIN}/start`);
    if ((await sidebar().getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
    await page.getByTestId('agent-toggle').click();
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('agent-input')).toBeFocused();
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
    if (scripts) await rm(scripts, { recursive: true, force: true });
  });

  test('agent-empty', async () => {
    await expect(page.getByTestId('agent-message')).toHaveCount(0);
    await capture('agent-empty');
  });

  test('agent-conversation', async () => {
    // agent.e2e.ts's agent-chat-export-and-restore turn: a read tool on a public page, then the answer.
    const input = page.getByTestId('agent-input');
    await expect(input).toBeEnabled();
    await input.fill('What does this page say?');
    await input.press('Enter');
    await expect(page.locator('[data-testid="agent-message"][data-kind="user"]').last()).toHaveText('What does this page say?');
    await expect(page.getByTestId('agent-tool-card').first()).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('agent-assistant-text').last()).toHaveText('The page says where the agent begins.');
    await expect(page.getByTestId('agent-send')).toBeVisible();
    await capture('agent-conversation');
  });
});

// ---------------------------------------------------------------------------------------------
// Search Console, connected to the fake Google (gsc-panel.e2e.ts).

test.describe('search console', () => {
  let backend: FakeBackend;
  let google: FakeGoogle;
  let profile: string;
  const { recordOpenExternal, connectInSettings } = accountHelpers(
    () => app!,
    () => page,
  );

  test.beforeAll(async () => {
    backend = await startFakeBackend();
    google = await startFakeGoogle();
    google.sites = [{ siteUrl: `${ORIGIN}/`, permissionLevel: 'siteOwner' }];
    profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-visual-gsc-'));
    await launch(siteArgs(), { userDataDir: profile, env: fakeAccountEnv(backend, google) });
    await recordOpenExternal();
    await chromeCaughtUp();
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
    await backend?.close();
    await google?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  test('seo-search-console', async () => {
    await audit('/guide');
    await showPanel('search-console');
    const panel = page.getByTestId('gsc-panel');
    await expect(panel).toHaveAttribute('data-state', 'not-connected');
    await expect(page.getByTestId('gsc-notice-title')).toHaveText(GSC_PANEL_COPY['not-connected'].title);
    // Connect from the panel's own button, in Settings.
    await page.getByTestId('gsc-action').click();
    await expect(page.getByTestId('settings-view')).toBeVisible();
    await connectInSettings();
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings-view')).toHaveCount(0);
    // This page, 28 days, the clicks chart: the fake's three days of rows.
    await page.locator('[data-testid="gsc-scope"][data-scope="page"]').click();
    await page.locator('[data-testid="gsc-range"][data-days="28"]').click();
    await expect(panel).toHaveAttribute('data-state', 'data');
    await expect(panel).toHaveAttribute('data-pending', 'false');
    const clicks = page.locator('[data-testid="gsc-tile"][data-metric="clicks"]');
    if ((await clicks.getAttribute('aria-pressed')) !== 'true') await clicks.click();
    await expect(page.getByTestId('gsc-total-clicks')).toHaveText('60');
    await expect(page.getByTestId('gsc-line')).toHaveCount(1);
    // The dates follow today's date: visual.css hides them (the ticks, "Through …", the freshness line).
    await capture('seo-search-console');
    // The top queries and the freshness line.
    await capture('seo-search-console-lower', { scroll: { selector: '.seo-body', to: 'end' } });
  });
});

// ---------------------------------------------------------------------------------------------
// The update bar offering a version (update.e2e.ts, its fake feed over TLS).

test.describe('update bar', () => {
  const UPDATE_HOST = 'updates.frost-e2e.net';
  const VERSION = '99.0.0';
  const KEY = testSigningKey('e2e-visual-update-key');
  const TLS = selfSignedCertificate();
  const PIN = new X509Certificate(TLS.cert).fingerprint256.replace(/:/g, '').toLowerCase();
  const PLATFORM = updatePlatformKey(process.platform, process.arch);
  const BYTES = artifactBytes(256 * 1024, 11);
  let feed: FakeFeed;
  let profile: string;

  test.beforeAll(async () => {
    test.skip(PLATFORM === null, 'no update artifact kind for this platform');
    feed = await startFakeFeed({ tls: TLS });
    const artifact = `https://${UPDATE_HOST}:${feed.port}/frost-artifact`;
    feed.route('/feed.json', { body: signEnvelope(manifestFor(VERSION, Date.now(), { [PLATFORM!]: { url: artifact, sha256: sha256Hex(BYTES), size: BYTES.length } }, { notes: 'frost 99.0.0\n\n- Fixes.' }), KEY) });
    // Automatic checks off: only the palette's "Check for Updates" checks.
    profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-visual-update-'));
    await writeFile(path.join(profile, UPDATE_PREFS_FILE), JSON.stringify({ format: 1, installId: randomUUID(), checks: 'off' }), { mode: 0o600 });
    await launch(
      [
        `--host-resolver-rules=MAP ${UPDATE_HOST} 127.0.0.1`,
        `--${E2E_PUBLIC_HOSTS_SWITCH}=${UPDATE_HOST}`,
        `--${UPDATE_PUBLIC_KEY_SWITCH}=${KEY.keyId}:${KEY.spki}`,
        `--${UPDATE_TEST_CERT_SWITCH}=${PIN}`,
        `--${UPDATE_FEED_SWITCH}=https://${UPDATE_HOST}:${feed.port}/feed.json`,
      ],
      { userDataDir: profile },
    );
    await expect(page.getByTestId('update-slot')).toHaveAttribute('data-update-status', 'off');
  });

  test.afterAll(async () => {
    await closeApp(app);
    app = undefined;
    await feed?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });

  test('update-bar', async () => {
    await menu(COMMAND_PALETTE_MENU_ID);
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.getByTestId('command-palette-input').fill('check for updates');
    await expect(page.locator('[data-testid="command-palette-option"][aria-selected="true"]')).toHaveAttribute('data-action', 'update.check');
    await page.getByTestId('command-palette-input').press('Enter');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await expect(page.getByTestId('update-bar')).toHaveAttribute('data-kind', 'available');
    await expect(page.getByTestId('update-text')).toContainText(updateAvailableText(VERSION));
    // The palette's own status pill says so for PALETTE_STATUS_MS: captured once it has gone.
    await expect(page.getByTestId('command-palette-status')).toHaveAttribute('data-shown', 'false');
    await capture('update-bar');
  });
});

// ---------------------------------------------------------------------------------------------
// The baseline directory against the registry (CAPTURES). Last, so a run's own captures came first.

test('every capture has a baseline', () => {
  // Every listed name is still captured somewhere in this file (a removed capture leaves its name).
  // A plain text search: it guards against leftover names, not against a call that is commented
  // out or skipped, and it expects the name on the same line as `capture(`.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  expect(CAPTURES.filter((name) => !source.includes(`capture('${name}'`)), 'CAPTURES entries no capture() call uses').toEqual([]);
  const expected = baselineFiles();
  const dir = path.dirname(test.info().snapshotPath(expected[0]!, { kind: 'screenshot' }));
  // No orphans (a renamed or removed state's images), here and in CI.
  let present: string[] = [];
  try {
    present = readdirSync(dir).filter((file) => file.endsWith('.png'));
  } catch {
    // No directory yet: nothing orphaned.
  }
  expect(present.filter((file) => !expected.includes(file)), `PNGs in ${dir} that no capture makes`).toEqual([]);
  // In CI, every capture's two images are committed. Not "on disk": `updateSnapshots: 'missing'` has
  // just written each missing one into CI's checkout (keeping its *-actual.png for the artifact).
  if (process.env['CI']) {
    const committed = execFileSync('git', ['ls-files', '--', dir], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((file) => path.basename(file));
    expect(
      expected.filter((file) => !committed.includes(file)),
      'captures without a committed baseline: adopt their *-actual.png from the playwright-report artifact of this shard (specs/visual-baseline.feature.md, Baseline procedure)',
    ).toEqual([]);
  }
});
