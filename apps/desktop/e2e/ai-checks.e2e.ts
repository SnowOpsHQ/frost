// Specs: specs/ai-checks.spec.ts (AI_CHECKS_COPY, AI_CHECKS_ENABLE_PROMPT), specs/ai-checks.schema.ts
// (AiCheckOutputSchema), specs/agent-chatgpt-e2e.schema.ts (CHATGPT_E2E_SWITCH, the seam file),
// specs/agent-chatgpt.spec.ts (CHATGPT_FORBIDDEN_BODY_FIELDS), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH),
// specs/intent-classifier.spec.ts (INTENT_LABEL_NAMES), specs/page-type.spec.ts (PAGE_TYPE_LABELS)
// Acceptance: specs/ai-checks.feature.md (End to end)
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ConsoleMessage, type ElectronApplication, type Page } from '@playwright/test';
import { CHATGPT_E2E_SWITCH, type ChatgptE2eSeam } from '@app/specs/agent-chatgpt-e2e.schema';
import { CHATGPT_FORBIDDEN_BODY_FIELDS } from '@app/specs/agent-chatgpt.spec';
import type { AiCheckOutput } from '@app/specs/ai-checks.schema';
import { AI_CHECKS_COPY, AI_CHECKS_ENABLE_PROMPT } from '@app/specs/ai-checks.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { INTENT_LABEL_NAMES } from '@app/specs/intent-classifier.spec';
import { PAGE_TYPE_LABELS } from '@app/specs/page-type.spec';
import { startFakeChatgpt, type FakeChatgpt } from './fake-chatgpt';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { CLUB, SITE_HOST, startProbeSite, type ProbeSite } from './probe-site';

// AI checks end to end on the ChatGPT plan route's fake (`fake-chatgpt.ts`, through the unpackaged
// seam `--frost-e2e-chatgpt=<file>`), not the scripted agent model: a check is a real request from the
// runtime's OpenAI provider through main's model proxy, so the fake's record of every Responses request
// (a count and the bodies) is what frost sent. The page is the loopback probe site under a
// public-looking name (`probe-site.ts`): `/club` serves a member's page with its cookie and the public
// one without. Main's message boxes (the consent dialog, Clear Browsing Data) are answered by a stub.
// One app for the file, serial: signed in to the plan, then off, on request, again and cleared.

test.describe.configure({ mode: 'serial' });

/** What the fake answers a check: JSON text, as `AI_CHECK_TASK` asks for. */
const FIRST: AiCheckOutput = { pageType: 'landing', intent: 'transactional', quality: 'adequate', qualityReason: 'A clear offer with little detail on the teas.', suggestedTarget: 'loose leaf tea club' };
const SECOND: AiCheckOutput = { pageType: 'landing', intent: 'commercial', quality: 'strong', qualityReason: 'The offer and its price are plain.', suggestedTarget: 'monthly tea subscription' };

let app: ElectronApplication | undefined;
let page: Page;
let fake: FakeChatgpt;
let site: ProbeSite;
let dir: string;
const cspErrors: string[] = [];
const { go, contentsIdAt, run, menu, press, chromeCaughtUp } = chromeHelpers(
  () => app!,
  () => page,
);

const clubUrl = () => `${site.origin}/club`;
const railItem = (id: string) => page.locator(`[data-testid="seo-rail-item"][data-panel="${id}"]`);
const card = () => page.getByTestId('ai-checks-card');
const quality = () => page.getByTestId('ai-checks-quality');
/** The fake's Responses requests: chat turns and checks (no chat runs in this file, so every one is a check). */
const requests = () => fake.responsesRequests;

/** Opens `panel` in the sidebar. */
async function openPanel(panel: 'overview' | 'content'): Promise<void> {
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true') await page.getByTestId('seo-toggle').click();
  if ((await page.getByTestId('seo-panel').getAttribute('data-panel')) !== panel) await railItem(panel).click();
  await expect(page.getByTestId('seo-panel')).toHaveAttribute('data-panel', panel);
}

/** Loads `url` and waits for its ready audit (the Overview's dot). */
async function load(url: string): Promise<void> {
  await go(url);
  await contentsIdAt(url);
  await expect(railItem('overview')).toHaveAttribute('data-status', /^(pass|warn|error)$/, { timeout: 20_000 });
}

/** Main's message boxes answer `{ response: 0 }` (Turn On; Clear) and each one's message is kept. */
async function answerMessageBoxes(): Promise<void> {
  await app!.evaluate(({ dialog }) => {
    const holder = globalThis as unknown as { __aiBoxes: { message: string; detail: string }[] };
    holder.__aiBoxes = [];
    Object.assign(dialog, {
      showMessageBox: async (...args: unknown[]) => {
        const options = (args.length > 1 ? args[1] : args[0]) as { message?: string; detail?: string };
        holder.__aiBoxes.push({ message: options.message ?? '', detail: options.detail ?? '' });
        return { response: 0, checkboxChecked: false };
      },
    });
  });
}
const messageBoxes = () => app!.evaluate(() => (globalThis as unknown as { __aiBoxes: { message: string; detail: string }[] }).__aiBoxes);

/** Signs in to the ChatGPT plan in the agent panel (a real click), which then names the plan's first model. */
async function signInToPlan(): Promise<void> {
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
  await page.getByTestId('agent-toggle').click();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'true');
  if (!(await page.getByTestId('agent-settings').isVisible())) await page.getByTestId('agent-settings-toggle').click();
  await page.getByTestId('agent-route').selectOption('chatgpt');
  await page.getByTestId('agent-chatgpt-sign-in').click();
  await expect(page.getByTestId('agent-chatgpt')).toHaveAttribute('data-state', 'signed-in', { timeout: 20_000 });
  await expect(page.getByTestId('agent-model')).toHaveValue('chatgpt/gpt-e2e');
  await page.getByTestId('agent-collapse').click();
  await expect(page.getByTestId('agent-panel')).toHaveAttribute('data-open', 'false');
}

test.beforeAll(async () => {
  fake = await startFakeChatgpt();
  site = await startProbeSite();
  dir = await mkdtemp(path.join(tmpdir(), 'frost-e2e-ai-checks-'));
  // Linux under Playwright has no keychain (`--password-store=basic`): the sign-in is kept in memory there.
  const seam: ChatgptE2eSeam = { endpoints: fake.endpoints, store: process.platform === 'linux' ? 'memory' : 'keychain' };
  const file = path.join(dir, 'seam.json');
  await writeFile(file, JSON.stringify(seam));
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST}`, `--${CHATGPT_E2E_SWITCH}=${file}`]));
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => undefined;
  });
  // The chrome's own CSP and Trusted Types: anything they refuse is reported on the console.
  page.on('console', (message: ConsoleMessage) => {
    if (/Content Security Policy|Trusted Type/i.test(message.text())) cspErrors.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');
  await answerMessageBoxes();
  await chromeCaughtUp();
});

test.afterAll(async () => {
  await closeApp(app);
  app = undefined;
  await fake?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('ai-checks-off-sends-nothing', async () => {
  // A model set up (the plan), so only the mode keeps checks from running.
  await signInToPlan();
  // Browsing while off: a plain page, then the club signed in (its cookie set by /club/login).
  await load(`${site.origin}/ai/guide`);
  await openPanel('overview');
  await expect(card()).toHaveAttribute('data-state', 'off');
  await expect(card().getByTestId('ai-checks-off')).toContainText(AI_CHECKS_COPY.offLine);
  await expect(card().getByTestId('ai-checks-open-settings')).toHaveText(AI_CHECKS_COPY.openSettings);
  await go(`${site.origin}/club/login`);
  await load(clubUrl());
  const tab = await contentsIdAt(clubUrl());
  expect(await run(tab, 'document.body.innerText')).toContain(CLUB.member.text);
  await openPanel('content');
  await expect(quality()).toHaveAttribute('data-state', 'off');
  await openPanel('overview');
  await expect(card()).toHaveAttribute('data-state', 'off');
  // The palette offers no check while off.
  await press('chrome', 'K', ['mod']);
  await page.getByTestId('command-palette-input').fill('AI checks');
  await expect(page.locator('[data-testid="command-palette-option"][data-action="ai-checks.mode"]')).toBeVisible();
  await expect(page.locator('[data-testid="command-palette-option"][data-action="ai-checks.check-page"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  // Main's watch looks at the tab once a second, but only while checks are on: nothing was sent.
  await chromeCaughtUp();
  expect(requests()).toEqual([]);
  expect(fake.refused).toEqual([]);
});

test('enable-via-consent-then-check-runs', async () => {
  await load(clubUrl());
  await openPanel('overview');
  // "Settings" opens the AI checks section; choosing "Only when I ask" asks main, which shows its dialog.
  await card().getByTestId('ai-checks-open-settings').click();
  const section = page.getByTestId('ai-checks-section');
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute('data-mode', 'off');
  await expect(page.getByTestId('ai-checks-settings-cost')).toContainText('GPT E2E');
  await section.locator('[data-testid="ai-checks-mode"][data-mode="on-request"]').click();
  await expect(section.locator('[data-testid="ai-checks-mode"][data-mode="on-request"]')).toHaveAttribute('aria-checked', 'true');
  await expect(section).toHaveAttribute('data-mode', 'on-request');
  const boxes = await messageBoxes();
  expect(boxes).toEqual([{ message: AI_CHECKS_ENABLE_PROMPT.dialog.message, detail: AI_CHECKS_ENABLE_PROMPT.dialog.detail }]);
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);

  // On request: the ready audit sends nothing by itself.
  await expect(card()).toHaveAttribute('data-state', 'idle');
  await expect(card().getByTestId('ai-checks-message')).toHaveText(AI_CHECKS_COPY.idle);
  await chromeCaughtUp();
  expect(requests()).toEqual([]);

  // "Check this page": exactly one request.
  fake.responses.push({ kind: 'text', text: JSON.stringify(FIRST) });
  await card().getByTestId('ai-checks-check').click();
  await expect(card()).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  expect(requests()).toHaveLength(1);
  const { body } = requests()[0]!;
  // Tool-less, streamed, stored nowhere, on the plan's model; nothing the plan refuses.
  expect(body).toMatchObject({ model: 'gpt-e2e', store: false, stream: true });
  expect(body).not.toHaveProperty('tools');
  for (const field of CHATGPT_FORBIDDEN_BODY_FIELDS) expect(body, field).not.toHaveProperty(field);
  // Its input is the page as served without cookies: the public title and text, none of the member's.
  const sent = JSON.stringify(body);
  expect(sent).toContain(CLUB.visitor.title);
  expect(sent).toContain(CLUB.visitor.text);
  expect(sent).not.toContain(CLUB.member.title);
  expect(sent).not.toContain('MEMBER-ONLY-ORDER-7731');
  // The site saw that cookieless fetch beside the tab's own (with the cookie).
  expect(site.seen.filter((entry) => entry.path === '/club').map((entry) => entry.cookie)).toEqual(expect.arrayContaining([true, false]));

  // The ready card under the chrome's real CSP: the answer under its label, as text.
  await expect(card().getByTestId('ai-judgment-label')).toHaveText(AI_CHECKS_COPY.label);
  await expect(card().getByTestId('ai-page-type')).toHaveText(PAGE_TYPE_LABELS.landing);
  await expect(card().getByTestId('ai-intent')).toHaveText(INTENT_LABEL_NAMES.transactional);
  await expect(card().getByTestId('ai-quality')).toHaveAttribute('data-rating', 'adequate');
  await expect(card().getByTestId('ai-quality')).toHaveText(AI_CHECKS_COPY.qualities.adequate);
  await expect(card().getByTestId('ai-quality-reason')).toHaveText(FIRST.qualityReason);
  await expect(card().getByTestId('ai-suggested-target')).toHaveText(FIRST.suggestedTarget!);
  await expect(card().getByTestId('ai-checked-by')).toContainText('GPT E2E');
  await expect(card().getByTestId('ai-checks-check')).toHaveText(AI_CHECKS_COPY.checkAgain);
  expect(await card().evaluate((root) => ({ styled: root.querySelectorAll('[style]').length, links: root.querySelectorAll('a, [href]').length }))).toEqual({ styled: 0, links: 0 });

  // The Content panel's Quality row: "Use as target" saves the suggested query, on the click only.
  await openPanel('content');
  await expect(quality()).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
  const use = quality().getByTestId('ai-use-as-target');
  await expect(use).toHaveText(AI_CHECKS_COPY.useAsTarget);
  await use.click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue(FIRST.suggestedTarget!);
  await expect(quality().getByTestId('ai-target-current')).toHaveText(AI_CHECKS_COPY.currentTarget);
  // Saved in main: opened again, the panel reads it back.
  await railItem('overview').click();
  await railItem('content').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue(FIRST.suggestedTarget!);
  expect(requests()).toHaveLength(1);
  expect(cspErrors).toEqual([]);
});

test('check-again', async () => {
  // The same page in a new tab: the stored answer for this URL and input, without a request.
  await menu('close-tab');
  await press('chrome', 'T', ['mod']);
  await load(clubUrl());
  await openPanel('overview');
  await expect(card()).toHaveAttribute('data-state', 'ready');
  await expect(card().getByTestId('ai-cached')).toHaveText(AI_CHECKS_COPY.cached);
  await expect(card().getByTestId('ai-quality')).toHaveAttribute('data-rating', 'adequate');
  expect(requests()).toHaveLength(1);
  // "Check again": one more request, and its answer replaces the first.
  fake.responses.push({ kind: 'text', text: JSON.stringify(SECOND) });
  await card().getByTestId('ai-checks-check').click();
  await expect(card().getByTestId('ai-quality')).toHaveAttribute('data-rating', 'strong', { timeout: 20_000 });
  await expect(card()).toHaveAttribute('data-state', 'ready');
  expect(requests()).toHaveLength(2);
  expect(JSON.stringify(requests()[1]!.body)).toContain(CLUB.visitor.title);
  await expect(card().getByTestId('ai-intent')).toHaveText(INTENT_LABEL_NAMES.commercial);
  await expect(card().getByTestId('ai-suggested-target')).toHaveText(SECOND.suggestedTarget!);
  await expect(card().getByTestId('ai-cached')).toHaveCount(0);
  // The Quality row follows; the target saved before is not this suggestion, so it is offered.
  await openPanel('content');
  await expect(quality().getByTestId('ai-suggested-target')).toHaveText(SECOND.suggestedTarget!);
  await expect(quality().getByTestId('ai-use-as-target')).toBeVisible();
  await expect(page.getByTestId('seo-query-input')).toHaveValue(FIRST.suggestedTarget!);
  expect(cspErrors).toEqual([]);
});

test('clear-browsing-data-removes-results', async () => {
  await load(clubUrl());
  await openPanel('overview');
  await expect(card()).toHaveAttribute('data-state', 'ready');
  const before = (await messageBoxes()).length;
  await menu('clear-browsing-data');
  // The dialog names the AI checks' results among what it clears.
  await expect.poll(async () => (await messageBoxes()).length).toBe(before + 1);
  expect((await messageBoxes()).at(-1)!.detail).toContain('the results of AI checks');
  // The open card drops the answer at once: not checked yet.
  await expect(card()).toHaveAttribute('data-state', 'idle');
  await expect(card().getByTestId('ai-judgment')).toHaveCount(0);
  // Loaded again, nothing comes back from the store, and nothing is asked.
  await load(clubUrl());
  await openPanel('overview');
  await expect(card()).toHaveAttribute('data-state', 'idle');
  await chromeCaughtUp();
  await expect(card()).toHaveAttribute('data-state', 'idle');
  await expect(card().getByTestId('ai-judgment')).toHaveCount(0);
  expect(requests()).toHaveLength(2);
  // The mode is a setting, not browsing data: still on request. Leaves the target query empty.
  await openPanel('content');
  await expect(quality()).toHaveAttribute('data-state', 'idle');
  await page.getByTestId('seo-query-clear').click();
  await expect(page.getByTestId('seo-query-input')).toHaveValue('');
});
