// Specs: specs/visibility-probes.spec.ts (PROBE_AGENTS, PROBE_DISCLOSURE, PROBE_MODELLED_DIRECTIVES_NOTE,
// PROBE_ROBOTS_SERVED_NOTE, PROBE_LIMITS), specs/ai-readiness.spec.ts (AI_READINESS_COPY, aiReadinessScore,
// aiScoreBasis), specs/intent-classifier.spec.ts (INTENT_ENABLE_PROMPT, INTENT_MODEL,
// INTENT_DOWNLOAD_MB, INTENT_MODEL_DIR), specs/serp-selector-pack.spec.ts (the e2e pack seams), specs/fetcher.spec.ts (E2E_PUBLIC_HOSTS_SWITCH)
// Acceptance: specs/serp-panels.feature.md (End to end), specs/ai-readiness.feature.md (End to end); review
// focus probes-are-bounded. The site is `probe-site.ts` (robots.txt, `/llms.txt`, the pages).
import { readdir } from 'node:fs/promises';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AI_READINESS_COPY, aiReadinessScore, aiScoreBasis, type AiCheckStatus, type AiReadinessCheckId } from '@app/specs/ai-readiness.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { INTENT_DOWNLOAD_MB, INTENT_ENABLE_PROMPT, INTENT_MODEL, INTENT_MODEL_DIR, INTENT_STATE_MESSAGES } from '@app/specs/intent-classifier.spec';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH } from '@app/specs/serp-selector-pack.spec';
import { PROBE_AGENTS, PROBE_DISCLOSURE, PROBE_LIMITS, PROBE_MODELLED_DIRECTIVES_NOTE, PROBE_ROBOTS_SERVED_NOTE } from '@app/specs/visibility-probes.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { CRAWLER, LLMS_TXT_TITLE, SECOND_HOST, SITE_HOST, startProbeSite, type ProbeSite } from './probe-site';
import { PACK_PATH, PACK_VERSION, SEARCH_HOST, signedTestPack } from './serp-fixtures';

const RUN_WAIT = PROBE_LIMITS.timeoutMs * 2 + 10_000;
/** How long `/slow` keeps a crawler waiting (longer than a probe may wait, so Stop is what ends it). */
const SLOW_MS = PROBE_LIMITS.timeoutMs + 5_000;

let app: ElectronApplication;
let chrome: Page;
let site: ProbeSite;
const h = chromeHelpers(
  () => app,
  () => chrome,
);

const sidebar = () => chrome.getByTestId('seo-sidebar');
const railItem = (panel: string) => chrome.locator(`[data-testid="seo-rail-item"][data-panel="${panel}"]`);
const crawlerRequests = (path?: string) => site.seen.filter((entry) => CRAWLER.test(entry.userAgent) && (path === undefined || entry.path === path));
const cell = (fact: string, agent: string) => chrome.locator(`[data-testid="visibility-fact"][data-fact="${fact}"] [data-testid="visibility-cell"][data-agent="${agent}"]`);

async function openVisibility(): Promise<void> {
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) !== 'visibility') await railItem('visibility').click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'visibility');
}

async function load(url: string): Promise<number> {
  await h.go(url);
  const id = await h.contentsIdAt(url);
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)!.isLoading(), id)).toBe(false);
  return id;
}

test.beforeAll(async () => {
  const pack = signedTestPack();
  site = await startProbeSite({ pack, slowMs: SLOW_MS });
  // No intent fake here: on-device intent is off (the model is never downloaded by these tests).
  ({ app, page: chrome } = await launchApp([
    `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP ${SECOND_HOST} 127.0.0.1, MAP ${SEARCH_HOST} 127.0.0.1`,
    `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST},${SECOND_HOST},${SEARCH_HOST}`,
    `--${SERP_E2E_PACK_URL_SWITCH}=${site.searchOrigin}${PACK_PATH}`,
    `--${SERP_E2E_PACK_KEY_SWITCH}=${pack.spki}`,
  ]));
  await chrome.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  await site?.close();
});

test.beforeEach(async () => {
  await h.closeAllTabs();
});

test('visibility-probes-per-agent', async () => {
  await load(`${site.origin}/page`);
  await openVisibility();
  // The disclosure is there before anything runs, and nothing was asked as a crawler.
  await expect(chrome.getByTestId('visibility-disclosure')).toHaveText(PROBE_DISCLOSURE);
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'idle');
  await expect(chrome.getByTestId('visibility-table')).toHaveCount(0);
  expect(crawlerRequests()).toEqual([]);
  await chrome.getByTestId('visibility-run').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'done', { timeout: RUN_WAIT });
  // One column per agent, the browser first.
  const agents = await chrome.getByTestId('visibility-agent').evaluateAll((items) => items.map((item) => item.getAttribute('data-agent')));
  expect(agents).toEqual(PROBE_AGENTS.map((agent) => agent.id));
  // robots.txt disallows GPTBot only; Googlebot alone is told noindex; ClaudeBot's page is smaller.
  await expect(cell('robots', 'gptbot')).toContainText('Disallowed');
  await expect(cell('robots', 'gptbot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('robots', 'bingbot')).toContainText('Allowed');
  await expect(cell('robots', 'bingbot')).toHaveAttribute('data-diff', 'false');
  await expect(cell('noindex', 'googlebot')).toContainText('Yes');
  await expect(cell('noindex', 'googlebot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('noindex', 'browser')).toContainText('No');
  await expect(cell('noindex', 'bingbot')).toHaveAttribute('data-diff', 'false');
  await expect(cell('wordCount', 'claudebot')).toHaveAttribute('data-diff', 'true');
  await expect(cell('status', 'browser')).toHaveText('200');
  // The browser's column is the baseline: never marked.
  await expect(chrome.locator('[data-testid="visibility-cell"][data-agent="browser"][data-diff="true"]')).toHaveCount(0);
  // The notes.
  await expect(chrome.getByTestId('visibility-modelled-note')).toContainText(PROBE_MODELLED_DIRECTIVES_NOTE);
  await expect(chrome.getByTestId('visibility-robots-note')).toHaveText(PROBE_ROBOTS_SERVED_NOTE);
  // Bounded: one request per crawler (the browser's is frost's own user agent), robots.txt from main's cache.
  expect(crawlerRequests('/page')).toHaveLength(PROBE_AGENTS.length - 1);
  expect(crawlerRequests('/robots.txt')).toEqual([]);
  expect(site.seen.filter((entry) => entry.path === '/robots.txt').length).toBeLessThanOrEqual(1);
});

test('visibility-probes-stop', async () => {
  await load(`${site.origin}/slow`);
  await openVisibility();
  const before = crawlerRequests('/slow').length;
  await chrome.getByTestId('visibility-run').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'running', { timeout: RUN_WAIT });
  await expect(chrome.getByTestId('visibility-stop')).toBeVisible();
  // At most two at once: the crawlers wait on the slow answers.
  await expect.poll(() => crawlerRequests('/slow').length - before).toBeGreaterThan(0);
  expect(crawlerRequests('/slow').length - before).toBeLessThanOrEqual(PROBE_LIMITS.maxConcurrent);
  await chrome.getByTestId('visibility-stop').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'stopped');
  // What was found stays: the browser's own row.
  await expect(cell('status', 'browser')).toHaveText('200');
  await expect(chrome.locator('[data-testid="visibility-fact"][data-fact="status"] [data-testid="visibility-cell"]').filter({ hasText: 'Stopped' })).not.toHaveCount(0);
  await expect(chrome.getByTestId('visibility-run')).toBeVisible();
  // Nothing more is asked after Stop: by the time another page has loaded and the chrome caught up,
  // no crawler asked for `/slow` again.
  const after = crawlerRequests('/slow').length;
  await load(`${site.origin}/page`);
  await h.chromeCaughtUp();
  expect(crawlerRequests('/slow')).toHaveLength(after);
});

test('serp-intent-model-missing', async () => {
  await load(`${site.origin}/page`);
  await openVisibility();
  await chrome.getByTestId('visibility-query-input').fill('green tea price');
  await chrome.getByTestId('visibility-classify').click();
  await expect(chrome.getByTestId('visibility-intent-result')).toHaveAttribute('data-state', 'model-missing');
  // What "Enable" downloads is stated before any click: size, host and licence.
  const prompt = chrome.getByTestId('visibility-enable-intent-prompt');
  await expect(prompt).toHaveText(INTENT_ENABLE_PROMPT);
  await expect(prompt).toContainText(`${INTENT_DOWNLOAD_MB} MB`);
  await expect(prompt).toContainText(INTENT_MODEL.host);
  await expect(prompt).toContainText(INTENT_MODEL.licence);
  await expect(chrome.getByTestId('visibility-enable-intent-button')).toHaveText('Enable on-device intent');
});

test('serp-panel-intent-model-missing', async () => {
  // Install the test pack, as the user does, and load a synthetic result page.
  const url = `${site.searchOrigin}/search?q=green+tea+price`;
  await load(url);
  if ((await sidebar().getAttribute('data-open')) !== 'true' || (await chrome.getByTestId('seo-panel').getAttribute('data-panel')) !== 'serp') await railItem('serp').click();
  await expect(chrome.getByTestId('seo-panel')).toHaveAttribute('data-panel', 'serp');
  await chrome.getByTestId('serp-pack-update').click();
  await expect(chrome.getByTestId('serp-pack-status')).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: RUN_WAIT });
  await expect(chrome.getByTestId('serp-panel')).toHaveAttribute('data-state', 'ready', { timeout: RUN_WAIT });
  // The chip says intent is off and offers Enable, stating size, host and licence before any click.
  await expect(chrome.getByTestId('serp-intent')).toHaveAttribute('data-state', 'model-missing', { timeout: RUN_WAIT });
  await expect(chrome.getByTestId('serp-intent-message')).toHaveText(INTENT_STATE_MESSAGES['model-missing']);
  const prompt = chrome.getByTestId('serp-enable-intent-prompt');
  await expect(prompt).toHaveText(INTENT_ENABLE_PROMPT);
  await expect(prompt).toContainText(`${INTENT_DOWNLOAD_MB} MB`);
  await expect(prompt).toContainText(INTENT_MODEL.host);
  await expect(prompt).toContainText(INTENT_MODEL.licence);
  await expect(chrome.getByTestId('serp-enable-intent-button')).toHaveText('Enable on-device intent');
  // Showing it downloads nothing: the state stays model-missing (after a round trip through main),
  // and no model file is in the profile.
  await h.chromeCaughtUp();
  await expect(chrome.getByTestId('serp-intent')).toHaveAttribute('data-state', 'model-missing');
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const modelFiles = await readdir(`${userData}/${INTENT_MODEL_DIR}/${INTENT_MODEL.id}`).catch(() => [] as string[]);
  expect(modelFiles).toEqual([]);
});

// AI readiness (ai-readiness.feature.md, End to end) on `/ai/guide`: a plain, indexable article whose
// robots.txt disallows OAI-SearchBot on `/ai/` and GPTBot everywhere. On the site's second name, so the
// probe runs above (on `SITE_HOST`) left nothing cached for its origin.
const AI_PAGE = '/ai/guide';
const aiSeen = () => site.seen.filter((entry) => entry.host === SECOND_HOST);
const aiCheck = (id: AiReadinessCheckId) => chrome.locator(`[data-testid="ai-readiness"] [data-testid="ai-check"][data-check="${id}"]`);
const crawler = (token: string) => chrome.locator(`[data-testid="ai-readiness"] [data-testid="ai-crawler"][data-token="${token}"]`);
/** What the page's checks are before a probe run: one AI search crawler of several is blocked (warn). */
const STATIC_CHECKS: Partial<Record<AiReadinessCheckId, AiCheckStatus>> = {
  'search-indexable': 'pass',
  'ai-search-crawlers': 'warn',
  'served-content': 'pass',
  'live-fetch-agents': 'pass',
  'training-opt-outs': 'info',
};

/** Loads the AI page, opens Visibility and waits for its static checks (the served comparison settled). */
async function openAiReadiness(): Promise<void> {
  await load(`${site.secondOrigin}${AI_PAGE}`);
  await openVisibility();
  await expect(chrome.getByTestId('ai-readiness-ring')).toHaveAttribute('data-state', 'partial', { timeout: RUN_WAIT });
}

/** Runs the probes from the panel and waits for the run to finish. */
async function runProbes(): Promise<void> {
  await chrome.getByTestId('visibility-run').click();
  await expect(chrome.getByTestId('visibility-summary')).toHaveAttribute('data-status', 'done', { timeout: RUN_WAIT });
}

test('ai-readiness-static-score-before-probes', async () => {
  const before = aiSeen().length;
  await openAiReadiness();
  // The score from the static checks alone: weighted over the three that judge the page now.
  const score = aiReadinessScore(STATIC_CHECKS);
  expect(score).toEqual({ score: 81, checked: 3, total: 4 });
  await expect(chrome.getByTestId('ai-readiness-score')).toHaveText(String(score.score));
  await expect(chrome.getByTestId('ai-readiness-basis')).toHaveText(aiScoreBasis(score));
  await expect(chrome.getByTestId('ai-readiness-hint')).toHaveText(AI_READINESS_COPY.partialHint);
  for (const [id, status] of Object.entries(STATIC_CHECKS)) await expect(aiCheck(id as AiReadinessCheckId)).toHaveAttribute('data-status', status);
  await expect(aiCheck('agent-reachability')).toHaveAttribute('data-status', 'not-checked');
  await expect(aiCheck('llms-txt')).toHaveAttribute('data-status', 'not-checked');
  // The Overview's tile says the same.
  await railItem('overview').click();
  await expect(chrome.getByTestId('ai-readiness-tile').getByTestId('ai-readiness-score')).toHaveText(String(score.score));
  await expect(chrome.getByTestId('ai-readiness-tile').getByTestId('ai-readiness-basis')).toHaveText(aiScoreBasis(score));
  // Nothing was asked as a crawler, and no /llms.txt: only the page (the tab's load and its served
  // copy) and, unless main's cache still holds it, robots.txt.
  const asked = aiSeen().slice(before);
  expect(asked.filter((entry) => CRAWLER.test(entry.userAgent))).toEqual([]);
  expect(asked.filter((entry) => entry.path === '/llms.txt')).toEqual([]);
  expect(asked.filter((entry) => entry.path === AI_PAGE).length).toBeGreaterThan(0);
  expect(asked.filter((entry) => entry.path !== AI_PAGE && entry.path !== '/robots.txt')).toEqual([]);
});

test('ai-readiness-bot-verdicts', async () => {
  const before = crawlerRequests().length;
  await openAiReadiness();
  // From the robots.txt the audit already read, on the page's path, with no request of its own.
  await expect(crawler('OAI-SearchBot')).toHaveAttribute('data-verdict', 'disallowed');
  await expect(crawler('OAI-SearchBot').getByTestId('ai-crawler-rule')).toHaveText('/ai/');
  await expect(crawler('GPTBot')).toHaveAttribute('data-verdict', 'disallowed');
  await expect(crawler('GPTBot').getByTestId('ai-crawler-rule')).toHaveText('/');
  for (const token of ['PerplexityBot', 'ChatGPT-User', 'Claude-SearchBot', 'ClaudeBot', 'Googlebot', 'Bingbot']) {
    await expect(crawler(token), token).toHaveAttribute('data-verdict', 'allowed');
    await expect(crawler(token).getByTestId('ai-crawler-rule'), token).toHaveCount(0);
  }
  // Blocking one AI search crawler warns; the training opt-out (GPTBot) is shown neutral, never scored.
  await expect(aiCheck('ai-search-crawlers')).toHaveAttribute('data-status', 'warn');
  await expect(aiCheck('ai-search-crawlers')).toContainText('OAI-SearchBot');
  const training = aiCheck('training-opt-outs');
  await expect(training).toHaveAttribute('data-status', 'info');
  await expect(training).toHaveAttribute('data-scored', 'false');
  await expect(training.getByTestId('ai-check-status')).toHaveText(AI_READINESS_COPY.statuses.info);
  await expect(training.locator('.ai-status-glyph')).toHaveCount(1);
  await expect(training).toContainText(AI_READINESS_COPY.unscored);
  expect(crawlerRequests().slice(before)).toEqual([]);
});

test('probes-eight-agents-and-llms-txt', async () => {
  await openAiReadiness();
  const before = aiSeen().length;
  await runProbes();
  // One column per agent: the browser and seven crawlers, OAI-SearchBot and ChatGPT-User among them.
  const agents = await chrome.getByTestId('visibility-agent').evaluateAll((items) => items.map((item) => item.getAttribute('data-agent')));
  expect(agents).toEqual(PROBE_AGENTS.map((agent) => agent.id));
  expect(agents).toHaveLength(8);
  expect(agents).toEqual(expect.arrayContaining(['oai-searchbot', 'chatgpt-user']));
  await expect(cell('robots', 'oai-searchbot')).toContainText('Disallowed');
  await expect(cell('robots', 'chatgpt-user')).toContainText('Allowed');
  // /llms.txt once, after the agents, as frost (no crawler's user agent); its outcome and title shown.
  await expect(aiCheck('llms-txt')).toHaveAttribute('data-status', 'pass');
  await expect(aiCheck('llms-txt').getByTestId('ai-llms-title')).toHaveText(LLMS_TXT_TITLE);
  const asked = aiSeen().slice(before);
  const llms = asked.filter((entry) => entry.path === '/llms.txt');
  expect(llms).toHaveLength(1);
  expect(CRAWLER.test(llms[0]!.userAgent)).toBe(false);
  // After the agents' calls: it starts once one lane is free, so at most `maxConcurrent - 1` agents'
  // page requests can still reach the site after it (arrival order aside, stray browser requests too).
  const llmsAt = asked.findIndex((entry) => entry.path === '/llms.txt');
  const agentPagesBefore = asked.slice(0, llmsAt).filter((entry) => entry.path === AI_PAGE).length;
  expect(agentPagesBefore).toBeGreaterThanOrEqual(PROBE_AGENTS.length - (PROBE_LIMITS.maxConcurrent - 1));
  // Bounded: one request per crawler, and the whole run within PROBE_LIMITS.maxRunRequests (36).
  expect(PROBE_LIMITS.maxRunRequests).toBe(36);
  expect(asked.filter((entry) => CRAWLER.test(entry.userAgent) && entry.path === AI_PAGE)).toHaveLength(PROBE_AGENTS.length - 1);
  expect(asked.length).toBeLessThanOrEqual(PROBE_LIMITS.maxRunRequests);
});

test('score-includes-reachability-after-run', async () => {
  await openAiReadiness();
  await runProbes();
  // The run for this page adds the fourth weighted check: every AI search and live-fetch agent got the page.
  await expect(aiCheck('agent-reachability')).toHaveAttribute('data-status', 'pass');
  await expect(aiCheck('agent-reachability').getByTestId('ai-agent')).toHaveCount(3);
  const score = aiReadinessScore({ ...STATIC_CHECKS, 'agent-reachability': 'pass', 'llms-txt': 'pass' });
  expect(score).toEqual({ score: 85, checked: 4, total: 4 });
  await expect(chrome.getByTestId('ai-readiness-ring')).toHaveAttribute('data-state', 'full');
  await expect(chrome.getByTestId('ai-readiness-score')).toHaveText(String(score.score));
  await expect(chrome.getByTestId('ai-readiness-basis')).toHaveText(aiScoreBasis(score));
  await expect(chrome.getByTestId('ai-readiness-hint')).toHaveCount(0);
  // The Overview's tile follows.
  await railItem('overview').click();
  await expect(chrome.getByTestId('ai-readiness-tile').getByTestId('ai-readiness-score')).toHaveText(String(score.score));
});
