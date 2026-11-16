// Specs: specs/workspace-layout.spec.ts (WORKSPACE_GAP, pageViewRadius) · Acceptance: specs/workspace-layout.feature.md
// (page-view-matches-the-card, narrow-window-keeps-the-sheets-whole). It runs on Linux, Windows and macOS and
// proves, on each, the view's bounds against the page card and the radius main passed to setBorderRadius
// (a spy: Electron has no getter). It does not prove the corner is drawn rounded: that was shown by a
// screen capture on Linux CI only (workspace-layout.feature.md).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { COMMAND_PALETTE_MENU_ID } from '@app/specs/command-palette.spec';
import { DEVTOOLS_MENU_ID } from '@app/specs/devtools.spec';
import { fitRenderViewport } from '@app/specs/render-profile.spec';
import { AGENT_RAIL_WIDTH } from '@app/specs/agent-panel.spec';
import { PAGE_MIN_WIDTH } from '@app/specs/seo-sidebar.spec';
import { NARROW_WINDOW, pageViewRadius, TIGHT_WORKSPACE_BELOW, WORKSPACE_GAP, WORKSPACE_GAP_TIGHT, workspaceGap } from '@app/specs/workspace-layout.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';

let app: ElectronApplication;
let page: Page;
const { go, menu, press, realClick, run, contentsIdAt } = chromeHelpers(
  () => app,
  () => page,
);

const html = (title: string, body = '') => `<!doctype html><title>${title}</title><body style="margin:0"><button id="go" style="margin:24px" onclick="document.documentElement.requestFullscreen()">Fullscreen</button><h1>${title}</h1>${body}</body>`;
let server: ReturnType<typeof createServer>;
let origin = '';

test.beforeAll(async () => {
  server = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(html(new URL(request.url ?? '/', 'http://x').pathname === '/' ? 'Home' : 'Page')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ app, page } = await launchApp());
  await page.waitForLoadState('domcontentloaded');
  // Electron has no getter for a view's radius: a spy on the View prototype's setter records the last
  // value main passed for each view (installed before the first tab's view exists). That is the value
  // asked for on this OS, not proof that the compositor drew the corner rounded.
  const installed = await app.evaluate(({ WebContentsView }) => {
    let proto: object | null = WebContentsView.prototype;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'setBorderRadius')) proto = Object.getPrototypeOf(proto) as object | null;
    if (!proto) return false;
    const radii = new WeakMap<object, number>();
    (globalThis as { __frostRadii?: WeakMap<object, number> }).__frostRadii = radii;
    const host = proto as { setBorderRadius: (radius: number) => void };
    const original = host.setBorderRadius;
    host.setBorderRadius = function (this: object, radius: number) {
      radii.set(this, radius);
      return original.call(this, radius);
    };
    return true;
  });
  expect(installed).toBe(true);
});

test.afterAll(async () => {
  await closeApp(app);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Box = { x: number; y: number; width: number; height: number };

/** The attached view's bounds and the radius main last gave it, and the window's content size. */
const viewState = () =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const view = win.contentView.children[0] as Electron.WebContentsView | undefined;
    const radii = (globalThis as { __frostRadii?: WeakMap<object, number> }).__frostRadii;
    const [width = 0, height = 0] = win.getContentSize();
    return { content: { width, height }, bounds: view ? view.getBounds() : null, radius: view ? (radii?.get(view) ?? null) : null };
  });

const box = (selector: string) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);

const near = (a: number, b: number) => Math.abs(a - b) <= 1;
const sameBox = (a: Box, b: Box) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

/**
 * The page card and the view line up (each edge within 1px), the view has `radius`, and the sheets
 * beside the card stand WORKSPACE_GAP off it: the SEO sidebar's right edge on the left, the agent
 * panel's left edge on the right.
 */
async function cardMatches(radius: number, view: (card: Box) => Box = (card) => card): Promise<void> {
  await expect
    .poll(async () => {
      const [state, card, sidebar, agent, width] = await Promise.all([viewState(), box('.page-area'), box('.seo'), box('.agent'), page.evaluate(() => innerWidth)]);
      // The workspace's gap at this width: tight under TIGHT_WORKSPACE_BELOW.
      const gap = workspaceGap(width);
      if (!state.bounds || !card || !sidebar || !agent) return 'missing';
      const want = view(card);
      if (!sameBox(state.bounds, want)) return `view ${JSON.stringify(state.bounds)} card ${JSON.stringify(want)}`;
      if (state.radius !== radius) return `radius ${state.radius}`;
      if (!near(card.x - (sidebar.x + sidebar.width), gap)) return `left gap ${card.x - (sidebar.x + sidebar.width)}`;
      if (!near(agent.x - (card.x + card.width), gap)) return `right gap ${agent.x - (card.x + card.width)}`;
      return 'ok';
    })
    .toBe('ok');
}

const PLAIN = pageViewRadius({ fullscreen: false, framed: false });

test('page-view-matches-the-card', async () => {
  const url = `${origin}/page`;
  await go(url);
  const id = await contentsIdAt(url);
  const sidebarOpen = () => page.getByTestId('seo-sidebar').getAttribute('data-open');
  if ((await sidebarOpen()) !== 'true') await page.getByTestId('seo-toggle').click();
  await expect(page.getByTestId('seo-panel')).toBeVisible();
  await cardMatches(PLAIN);
  // Two more layouts, inside the window (main clamps the view to it): the chrome is laid out at a set
  // size, as the sidebar's suites do (a tiling window manager ignores the window's own size).
  const { content } = await viewState();
  for (const size of [
    { width: content.width - 60, height: content.height - 20 },
    { width: Math.max(700, content.width - 160), height: content.height - 60 },
  ]) {
    await page.setViewportSize(size);
    await cardMatches(PLAIN);
  }
  try {
    // The SEO sidebar at its narrowest and widest, then collapsed to its rail.
    const separator = page.getByTestId('seo-resize');
    await separator.focus();
    await page.keyboard.press('Home');
    await cardMatches(PLAIN);
    await page.keyboard.press('End');
    await cardMatches(PLAIN);
    await page.keyboard.press('Home');
    await page.getByTestId('seo-toggle').click();
    await expect(page.getByTestId('seo-panel')).toHaveCount(0);
    await cardMatches(PLAIN);
    // The agent panel open, then collapsed to its rail.
    await page.getByTestId('agent-toggle').click();
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'true');
    await cardMatches(PLAIN);
    await page.getByTestId('agent-collapse').click();
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'false');
    await page.getByTestId('seo-toggle').click();
    await expect(page.getByTestId('seo-panel')).toBeVisible();
    await cardMatches(PLAIN);
    // The bands above the workspace: the find bar, the render-profile editor bar, both.
    await press(id, 'F', ['mod']);
    await expect(page.getByTestId('find-bar')).toBeVisible();
    await cardMatches(PLAIN);
    await page.getByTestId('render-profile-toggle').click();
    await expect(page.getByTestId('render-profile-bar')).toBeVisible();
    await cardMatches(PLAIN);
    await page.getByTestId('find-close').click();
    await expect(page.getByTestId('find-bar')).toHaveCount(0);
    await cardMatches(PLAIN);
    // A render profile: the view sits in the page-area frame, its corner the card's less the inset.
    await page.getByTestId('render-quick-no-javascript').click();
    await page.getByTestId('render-profile-close').click();
    await expect(page.getByTestId('render-frame')).toBeVisible();
    await cardMatches(pageViewRadius({ fullscreen: false, framed: true }), (card) => {
      const { view } = fitRenderViewport(card, 'none');
      return { x: card.x + view.x, y: card.y + view.y, width: view.width, height: view.height };
    });
    await page.getByTestId('render-frame-reset').click();
    await expect(page.getByTestId('render-frame')).toHaveCount(0);
    await cardMatches(PLAIN);
    // The DevTools drawer under the row.
    await menu(DEVTOOLS_MENU_ID);
    await expect(page.getByTestId('devtools')).toBeVisible();
    await cardMatches(PLAIN);
    const [card, drawer] = await Promise.all([box('.page-area'), box('.devtools')]);
    expect(near(drawer!.y - (card!.y + card!.height), workspaceGap(await page.evaluate(() => innerWidth)))).toBe(true);
    await menu(DEVTOOLS_MENU_ID);
    await expect(page.getByTestId('devtools')).toHaveCount(0);
    // The command palette's band pushes the card down.
    await menu(COMMAND_PALETTE_MENU_ID);
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await cardMatches(PLAIN);
    // Measured once its opening animation (a slight scale) is over.
    await page.getByTestId('command-palette').evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const [band, below] = await Promise.all([box('[data-testid="command-palette"]'), box('.page-area')]);
    expect(near(below!.y - (band!.y + band!.height), WORKSPACE_GAP.px)).toBe(true);
    await page.getByTestId('command-palette-input').press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveCount(0);
    await cardMatches(PLAIN);
    // A chrome too narrow for both panels: the page is held at its minimum, so the agent panel opening
    // and collapsing beside the SEO sheet moves the card without resizing it, and the view follows.
    await page.setViewportSize({ width: 600, height: content.height - 60 });
    await cardMatches(PLAIN);
    await page.getByTestId('agent-toggle').click();
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'true');
    await cardMatches(PLAIN);
    await page.getByTestId('agent-collapse').click();
    await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'false');
    await cardMatches(PLAIN);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.disableDeviceEmulation());
  }
  // HTML fullscreen: the view fills the window, with no corner; leaving gives the card's back.
  await realClick(id, '#go');
  await expect.poll(() => run(id, 'document.fullscreenElement !== null')).toBe(true);
  await expect
    .poll(async () => {
      const { content, bounds, radius } = await viewState();
      return bounds !== null && bounds.x === 0 && bounds.width === content.width && bounds.y + bounds.height === content.height && radius === 0;
    })
    .toBe(true);
  await press(id, 'Escape');
  await expect.poll(() => run(id, 'document.fullscreenElement === null')).toBe(true);
  await cardMatches(PLAIN);
});

test('narrow-window-keeps-the-sheets-whole', async () => {
  // The chrome laid out at the window's minimum width (a tiling window manager ignores the window's own
  // size), the SEO sheet open on Overview, the agent collapsed (specs/workspace-layout.feature.md).
  await go(`${origin}/narrow`);
  await contentsIdAt(`${origin}/narrow`);
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true') await page.getByTestId('seo-toggle').click();
  if ((await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'overview') await page.locator('[data-testid="seo-rail-item"][data-panel="overview"]').click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'overview');
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'false');
  // The audit is in: Overview shows its score card.
  await expect(page.locator('.seo-score-card')).toBeVisible({ timeout: 30_000 });
  const padding = () => page.locator('.seo-body').evaluate((el) => getComputedStyle(el).paddingLeft);
  // Inside the window's own height (main clamps the view to the window; a tiling window manager sets it).
  const height = Math.min(700, (await viewState()).content.height);
  try {
    // A width the panel's minimum fits: the canvas's 16px.
    await page.setViewportSize({ width: 900, height });
    await expect.poll(padding).toBe('16px');
    await page.setViewportSize({ width: NARROW_WINDOW.width, height });
    // Each within a pixel: on a scaled display the chrome's width is a fraction off the one asked for.
    // Tight gaps everywhere: the window's edges and between every two sheets.
    const T = WORKSPACE_GAP_TIGHT.px;
    const want = { rail: AGENT_RAIL_WIDTH, railGap: T, leftEdge: T, railToSheet: T, sheetToCard: T, cardToAgent: T, panel: NARROW_WINDOW.seoSheet, card: PAGE_MIN_WIDTH };
    await expect
      .poll(async () => {
        const [width, rail, seoRail, panel, card] = await Promise.all([page.evaluate(() => innerWidth), box('.agent-rail'), box('.seo-rail'), box('.seo-panel'), box('.page-area')]);
        if (!rail || !seoRail || !panel || !card) return 'missing';
        const got = {
          rail: rail.width,
          railGap: width - (rail.x + rail.width),
          leftEdge: seoRail.x,
          railToSheet: panel.x - (seoRail.x + seoRail.width),
          sheetToCard: card.x - (panel.x + panel.width),
          cardToAgent: rail.x - (card.x + card.width),
          panel: panel.width,
          card: card.width,
        };
        return (Object.keys(want) as (keyof typeof want)[]).every((k) => Math.abs(got[k] - want[k]) <= 1) ? 'ok' : JSON.stringify(got);
      })
      .toBe('ok');
    // Under the panel's minimum the body gives its content the padding back, and Overview's first card fits it.
    await expect.poll(padding).toBe('4px');
    const fits = await page.locator('.seo-body').evaluate((body) => {
      const limit = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight);
      const card = body.querySelector('.seo-score-card')!;
      return [card, ...card.querySelectorAll('*')].every((el) => el.getBoundingClientRect().right <= limit + 0.5);
    });
    expect(fits).toBe(true);
    // The view still lines up with the card.
    await cardMatches(PLAIN);
    // The tight gaps apply exactly under the threshold, and not in a 776px (tiled) chrome.
    // The chrome's own (fractional) width decides; at a 1x scale (CI) it is exactly the width asked for,
    // on a fractional one it can land a little off, so the gap is checked against the width measured.
    const scale = await page.evaluate(() => devicePixelRatio);
    for (const [width, gap] of [
      [TIGHT_WORKSPACE_BELOW - 1, WORKSPACE_GAP_TIGHT.px],
      [TIGHT_WORKSPACE_BELOW, WORKSPACE_GAP.px],
      [776, WORKSPACE_GAP.px],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect.poll(async () => Math.abs((await box('.chrome'))!.width - width)).toBeLessThanOrEqual(1);
      const measured = (await box('.chrome'))!.width;
      if (scale === 1) expect(measured).toBe(width);
      const used = await page.locator('.workspace').evaluate((el) => getComputedStyle(el).columnGap);
      expect(used, `chrome ${measured}px`).toBe(`${workspaceGap(measured)}px`);
      if (scale === 1) expect(used).toBe(`${gap}px`);
    }
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.disableDeviceEmulation());
  }
});
