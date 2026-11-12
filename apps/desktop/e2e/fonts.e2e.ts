// Specs: specs/design-tokens.spec.ts (BUNDLED_FONTS), specs/security-policy.spec.ts (APP_CSP_DIRECTIVES: font-src 'self')
// Acceptance: specs/design-tokens.feature.md (End to end). Surfaces draw Geist (the command palette
// first), so a font can load whenever such text is drawn, before this test could watch the page's
// requests (and the chrome page can't be reloaded to start clean: its navigation guard aborts that).
// So the font requests and the console are recorded in main from launch (`font-request-log.cjs`),
// and the test reads them once every face has loaded, whenever that happened.
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
const consoleMessages = () => app.evaluate(() => [...((globalThis as { __frostConsoleMessages?: string[] }).__frostConsoleMessages ?? [])]);

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
    return { violations, loaded };
  }, BUNDLED_FONTS);

  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
  for (const { family, weight, faces } of result.loaded) {
    const match = faces.filter((face) => unquote(face.family) === family && face.weight === String(weight) && face.style === 'normal' && face.status === 'loaded');
    expect(match.length, `${family} ${weight}: ${JSON.stringify(faces)}`).toBeGreaterThanOrEqual(1);
  }
  // Every woff2 the app served since launch: one URL per bundled face, each from the app's own scheme
  // (never a CDN, never data:: those would not reach the app: handler, and the faces would not load).
  await expect.poll(async () => new Set((await fontRequests()).map((request) => request.url)).size).toBe(BUNDLED_FONTS.length);
  const requests = await fontRequests();
  for (const request of requests) {
    expect(request.url.startsWith(`${APP_ENTRY_URL}assets/`), request.url).toBe(true);
    expect(request, request.url).toMatchObject({ scheme: 'app', status: 200, type: 'font/woff2' });
  }
  expect(result.violations).toEqual([]);
  expect((await consoleMessages()).filter((message) => /content.security.policy|refused to load/i.test(message))).toEqual([]);
});
