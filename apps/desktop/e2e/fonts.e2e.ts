// Specs: specs/design-tokens.spec.ts (BUNDLED_FONTS), specs/security-policy.spec.ts (APP_CSP_DIRECTIVES: font-src 'self')
// Acceptance: specs/design-tokens.feature.md (End to end). Surfaces draw Geist (the command palette
// first), so a font can load whenever such text is drawn, before this test could watch the page's
// requests (and the chrome page can't be reloaded to start clean: its navigation guard aborts that).
// So the font requests and the console are recorded in main from launch (`font-request-log.cjs`),
// and the test reads them once every face has loaded, whenever that happened. Where the fonts may come
// from is read in the page: its `@font-face` sources, and its Resource Timing buffer (kept from
// navigation start, so no race).
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { BUNDLED_FONTS } from '@app/specs/design-tokens.spec';
import { APP_DIR, closeApp, launchApp } from './harness';

const FONT_REQUEST_LOG = path.join(APP_DIR, 'e2e', 'font-request-log.cjs');

interface FontRequest {
  readonly scheme: string;
  readonly url: string;
  readonly status: number;
  readonly type: string | null;
}

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp([], { mainPreload: [FONT_REQUEST_LOG] }));
});

test.afterAll(async () => {
  await closeApp(app);
});

const fontRequests = () => app.evaluate(() => [...((globalThis as { __frostFontRequests?: FontRequest[] }).__frostFontRequests ?? [])]);
interface ConsoleMessage {
  readonly url: string;
  readonly message: string;
}
const consoleMessages = () => app.evaluate(() => [...((globalThis as { __frostConsoleMessages?: ConsoleMessage[] }).__frostConsoleMessages ?? [])]);
const FONT_URL = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const APP_ASSETS = `${APP_ENTRY_URL}assets/`;

test('geist-fonts-load', async () => {
  // The log is in place (the preload ran before the app's own code).
  expect(await app.evaluate(() => Array.isArray((globalThis as { __frostFontRequests?: unknown }).__frostFontRequests))).toBe(true);

  // The stylesheets, and so their @font-face rules, are in place once the document has loaded:
  // document.fonts.load() asked earlier would find no face to load.
  await page.waitForLoadState('load');
  const result = await page.evaluate(async (fonts) => {
    // Installed before this test asks for any font (a face already loaded is not fetched again).
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
    const loaded: { family: string; weight: number; faces: { family: string; weight: string; style: string; status: string }[] }[] = [];
    for (const font of fonts) {
      const faces = await document.fonts.load(`${font.weight} 16px "${font.family}"`);
      loaded.push({ family: font.family, weight: font.weight, faces: faces.map((face) => ({ family: face.family, weight: face.weight, style: face.style, status: face.status })) });
    }
    // A violation event is dispatched asynchronously: give it a turn to arrive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    // Every @font-face source, resolved against its stylesheet.
    const sources: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      for (const rule of [...sheet.cssRules]) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        for (const [, , url] of rule.style.getPropertyValue('src').matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) sources.push(new URL(url!, sheet.href ?? document.baseURI).href);
      }
    }
    // Every font the page fetched since navigation start, wherever from (and every css-initiated fetch).
    const timed = performance
      .getEntriesByType('resource')
      .map((entry) => entry as PerformanceResourceTiming)
      .filter((entry) => entry.initiatorType === 'css' || /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(entry.name))
      .map((entry) => ({ name: entry.name, initiator: entry.initiatorType }));
    return { violations, loaded, sources, timed };
  }, BUNDLED_FONTS);

  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
  for (const { family, weight, faces } of result.loaded) {
    const match = faces.filter((face) => unquote(face.family) === family && face.weight === String(weight) && face.style === 'normal' && face.status === 'loaded');
    expect(match.length, `${family} ${weight}: ${JSON.stringify(faces)}`).toBeGreaterThanOrEqual(1);
  }
  // Where the fonts may come from: every @font-face source, one per bundled face, under app://app/assets/
  // (no CDN, no data:), and every font fetch in the page's Resource Timing buffer too. Chromium buffers
  // no entry for an app: fetch, so with every font local that list is empty; a font fetched over
  // http(s) from anywhere would be in it, and fail here.
  expect(result.sources).toHaveLength(BUNDLED_FONTS.length);
  for (const source of result.sources) expect(source.startsWith(APP_ASSETS), source).toBe(true);
  for (const entry of result.timed.filter((timed) => FONT_URL.test(timed.name))) expect(entry.name.startsWith(APP_ASSETS), entry.name).toBe(true);
  // Every woff2 the app served since launch, read once they name a URL per bundled face: one snapshot,
  // one URL per face, each from the app's own scheme and answered 200 font/woff2.
  let requests: FontRequest[] = [];
  await expect
    .poll(async () => {
      requests = await fontRequests();
      return new Set(requests.map((request) => request.url)).size;
    })
    .toBe(BUNDLED_FONTS.length);
  expect(new Set(requests.map((request) => request.url)).size).toBe(BUNDLED_FONTS.length);
  for (const request of requests) {
    expect(request.url.startsWith(APP_ASSETS), request.url).toBe(true);
    expect(request, request.url).toMatchObject({ scheme: 'app', status: 200, type: 'font/woff2' });
  }
  expect(result.violations).toEqual([]);
  // The console log records the chrome: a probe the chrome logs now arrives with its app: URL.
  await page.evaluate(() => console.log('frost-font-log-probe'));
  await expect.poll(async () => (await consoleMessages()).some((entry) => entry.message === 'frost-font-log-probe' && entry.url.startsWith(APP_ENTRY_URL))).toBe(true);
  // The app's own pages only: a tab's console (a dev-only CSP warning of its own) is not the chrome's.
  const cspMessages = (await consoleMessages()).filter((entry) => entry.url.startsWith('app:') && /content.security.policy|refused to load/i.test(entry.message));
  expect(cspMessages).toEqual([]);
});
