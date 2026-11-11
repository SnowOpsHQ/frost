// Specs: specs/design-tokens.spec.ts (BUNDLED_FONTS), specs/security-policy.spec.ts (APP_CSP_DIRECTIVES: font-src 'self')
// Acceptance: specs/design-tokens.feature.md (End to end). The fonts are bundled but no rule uses them
// yet, so nothing loads them until `document.fonts.load()` asks.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ENTRY_URL } from '@app/specs/app-protocol.spec';
import { BUNDLED_FONTS } from '@app/specs/design-tokens.spec';
import { closeApp, launchApp } from './harness';

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  ({ app, page } = await launchApp());
});

test.afterAll(async () => {
  await closeApp(app);
});

test('geist-fonts-load', async () => {
  const consoleProblems: string[] = [];
  page.on('console', (message) => {
    if (/content.security.policy|refused to load/i.test(message.text())) consoleProblems.push(message.text());
  });

  const result = await page.evaluate(async (fonts) => {
    // Installed before any font is requested.
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
    const loaded: { family: string; weight: number; faces: { family: string; weight: string; style: string; status: string }[] }[] = [];
    for (const font of fonts) {
      const faces = await document.fonts.load(`${font.weight} 16px "${font.family}"`);
      loaded.push({ family: font.family, weight: font.weight, faces: faces.map((face) => ({ family: face.family, weight: face.weight, style: face.style, status: face.status })) });
    }
    // A violation event is dispatched asynchronously: give it a turn to arrive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const woff2 = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\.woff2(?:[?#]|$)/.test(name));
    return { violations, loaded, woff2 };
  }, BUNDLED_FONTS);

  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
  for (const { family, weight, faces } of result.loaded) {
    const match = faces.filter((face) => unquote(face.family) === family && face.weight === String(weight) && face.style === 'normal' && face.status === 'loaded');
    expect(match.length, `${family} ${weight}: ${JSON.stringify(faces)}`).toBeGreaterThanOrEqual(1);
  }
  // One woff2 per bundled face, each fetched from the app's own scheme (never a CDN, never data:).
  expect(result.woff2).toHaveLength(BUNDLED_FONTS.length);
  for (const url of result.woff2) expect(url.startsWith(APP_ENTRY_URL), url).toBe(true);
  expect(result.violations).toEqual([]);
  expect(consoleProblems).toEqual([]);
});
