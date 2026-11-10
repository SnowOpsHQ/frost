// Specs: specs/ai-search.spec.ts (AI_SEARCH_ENGINE_LABELS, aiSearchRequestBody), specs/agent-session.spec.ts
// (AGENT_E2E_SCRIPT_SWITCH, runAiSearchApprovalNote), specs/ai-answers.spec.ts (AI_ANSWER_ORIGIN_LABELS,
// AI_ANSWERS_VIEW_TEXT), specs/data-sources.spec.ts (LEGAL_GATES_E2E_SWITCH, DATA_API_E2E_SWITCH,
// DATA_SOURCES_SETTINGS_TEXT, DATA_SPEND_NOTE), specs/account-settings.spec.ts (SETTINGS_MENU)
// Acceptance: specs/ai-search.feature.md (End to end: ai-search-agent-call-approved-end-to-end),
// specs/ai-answers.feature.md (End to end: ai-answers-agent-and-view-end-to-end). Plan phase-12 Task 11.
// The agent is the unpackaged build's scripted model (`--frost-e2e-agent-script=<file>`); Perplexity and
// OpenAI web search are `fake-data-api.ts` through the data API seam, their gates opened with the
// unpackaged-only switch. No request leaves the machine.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { AI_ANSWER_ORIGIN_LABELS, AI_ANSWERS_VIEW_TEXT } from '@app/specs/ai-answers.spec';
import { AI_SEARCH_ENGINE_LABELS, aiSearchRequestBody } from '@app/specs/ai-search.spec';
import { AGENT_E2E_SCRIPT_SWITCH, runAiSearchApprovalNote } from '@app/specs/agent-session.spec';
import { DATA_API_E2E_SWITCH, DATA_SOURCES_SETTINGS_TEXT, DATA_SPEND_NOTE, LEGAL_GATES_E2E_SWITCH, type DataProvider } from '@app/specs/data-sources.spec';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import { APP_DIR, closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { AI_FIXTURE_WATCHED_DOMAIN, OPENAI_FIXTURE, PERPLEXITY_FIXTURE } from './ai-answer-fixtures';
import { startFakeDataApi, type FakeDataApi } from './fake-data-api';

/** Linux only: a stand-in OS keychain, so keys can be stored under Playwright (see the file). */
const FAKE_KEYCHAIN = path.join(APP_DIR, 'e2e', 'fake-keychain.cjs');
const WAIT = 20_000;
const AGENT_QUERY = 'best green tea for beginners';
const VIEW_QUERY = 'how much matcha per cup';
const FINAL_TEXT = 'Perplexity cited three sources.';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let app: ElectronApplication | undefined;
let page: Page;
let fake: FakeDataApi;
let scripts: string;
/** What the app wrote to stdout and stderr (its log lines). */
const output: string[] = [];
const KEYS: Readonly<Partial<Record<DataProvider, string>>> = {
  perplexity: `e2e-perplexity-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  'openai-search': `e2e-openai-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
};
const h = chromeHelpers(
  () => app!,
  () => page,
);

const panel = () => page.getByTestId('agent-panel');
const approvalCard = () => page.getByTestId('agent-approval');
const aiCard = () => page.locator('[data-testid="agent-tool-card"][data-tool="run_ai_search"]');
const view = () => page.getByTestId('ai-answers-view');
const shown = () => page.getByTestId('ai-answer');

/** A procedure answered by main, from the chrome page. */
async function ipc(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: name, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

async function palette(actionId: string, query: string): Promise<void> {
  await h.press('chrome', 'K', ['mod']);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill(query);
  await page.locator(`[data-testid="command-palette-option"][data-action="${actionId}"]`).click();
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
}

const sentBody = (provider: DataProvider, index = 0): Record<string, unknown> => JSON.parse(fake.requestsTo(provider)[index]!.body) as Record<string, unknown>;

test.beforeAll(async () => {
  fake = await startFakeDataApi();
  scripts = await mkdtemp(path.join(tmpdir(), 'frost-e2e-ai-answers-'));
  const script = path.join(scripts, 'script.json');
  // The model asks once, without naming an engine (the default resolves), then answers.
  await writeFile(script, JSON.stringify({ steps: [{ toolCalls: [{ toolName: 'run_ai_search', input: { query: AGENT_QUERY } }] }, { text: [FINAL_TEXT] }] }));
  ({ app, page } = await launchApp([`--${LEGAL_GATES_E2E_SWITCH}=perplexity,openai-search`, `--${DATA_API_E2E_SWITCH}=${fake.seamFile}`, `--${AGENT_E2E_SCRIPT_SWITCH}=${script}`], { mainPreload: [FAKE_KEYCHAIN] }));
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  await page.waitForLoadState('domcontentloaded');
  await h.chromeCaughtUp();
});

test.afterAll(async () => {
  await closeApp(app);
  app = undefined;
  await fake?.close();
  if (scripts) await rm(scripts, { recursive: true, force: true });
});

test('ai-answers-keys-set-in-settings', async () => {
  await h.menu(SETTINGS_MENU.id);
  await expect(page.getByTestId('settings-view')).toBeVisible();
  await page.getByTestId('settings-nav-data-sources').click();
  for (const provider of ['perplexity', 'openai-search'] as const) {
    const row = page.locator(`[data-testid="data-source"][data-provider="${provider}"]`);
    await expect(row).toHaveAttribute('data-disabled', 'false', { timeout: WAIT });
    const input = row.getByTestId('data-source-input');
    await input.fill(KEYS[provider]!);
    await row.getByTestId('data-source-save').click();
    await expect(input).toHaveValue('');
    await expect(row.getByTestId('data-source-key-state')).toHaveText(DATA_SOURCES_SETTINGS_TEXT.keySet, { timeout: WAIT });
  }
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('settings-view')).toHaveCount(0);
  expect(fake.requests).toEqual([]);
});

test('ai-search-agent-call-approved-end-to-end', async () => {
  // The SEO sidebar's panel collapsed, so the agent panel has its full width.
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
  await page.getByTestId('agent-toggle').click();
  await expect(panel()).toHaveAttribute('data-open', 'true');
  const composer = page.getByTestId('agent-input');
  await expect(composer).toBeEnabled();
  await composer.fill('Ask an AI engine which green tea to start with');
  await composer.press('Enter');

  // The card: the exact query, the engine the default resolved to, its via, and the cost note.
  await expect(approvalCard()).toBeVisible({ timeout: WAIT });
  await expect(approvalCard()).toHaveAttribute('data-tool', 'run_ai_search');
  const approved = JSON.parse((await page.getByTestId('agent-approval-input').textContent()) ?? '') as Record<string, unknown>;
  expect(approved).toEqual({ query: AGENT_QUERY, engine: 'perplexity', via: 'api' });
  await expect(page.getByTestId('agent-approval-note')).toHaveText(runAiSearchApprovalNote('perplexity', 'api'));
  // Never grantable, and nothing is sent before the user allows it.
  await expect(page.getByTestId('agent-allow-always')).toHaveCount(0);
  expect(fake.requests).toEqual([]);

  await expect(page.getByTestId('agent-allow-once')).toBeEnabled({ timeout: WAIT });
  await page.getByTestId('agent-allow-once').click();
  await expect(approvalCard()).toHaveCount(0);

  // The answer in the chat, as text. (It reaches the model inside the untrusted wrapper, source
  // `search:ai-answer` (unit-tested: ai-search-result-is-untrusted); the card shows its data only, and
  // its untrusted chip is for MCP tools.)
  await expect(aiCard()).toHaveAttribute('data-status', 'done', { timeout: WAIT });
  const toolOutput = aiCard().getByTestId('agent-tool-output');
  await expect(toolOutput).toContainText('Sencha and genmaicha are gentle first green teas.');
  await expect(toolOutput).toContainText(PERPLEXITY_FIXTURE.citations[0]!.url);
  expect(await toolOutput.evaluate((element) => element.children.length)).toBe(0);
  await expect(page.getByTestId('agent-assistant-text').last()).toHaveText(FINAL_TEXT, { timeout: WAIT });
  expect(await panel().locator('b, a[href*="leafhouse"]').count()).toBe(0);

  // Exactly one request, to Perplexity, with the fixed body for the approved query and the user's key.
  expect(fake.requestsTo('perplexity')).toHaveLength(1);
  expect(fake.requests).toHaveLength(1);
  expect(sentBody('perplexity')).toEqual(aiSearchRequestBody('perplexity', AGENT_QUERY));
  expect(fake.requestsTo('perplexity')[0]!.headers.authorization).toBe(`Bearer ${KEYS.perplexity}`);
  expect(fake.refused).toEqual([]);
});

test('ai-answers-agent-and-view-end-to-end', async () => {
  // The agent's answer is kept and listed in the AI answers view.
  await palette('ai-answers.show', 'show ai answers');
  await expect(view()).toBeVisible();
  await expect(page.getByTestId('ai-answers-pick')).toHaveCount(1, { timeout: WAIT });
  await expect(shown()).toBeVisible({ timeout: WAIT });
  await expect(shown().getByTestId('ai-answer-query')).toHaveText(AGENT_QUERY);
  await expect(shown().getByTestId('ai-answer-meta')).toContainText(AI_SEARCH_ENGINE_LABELS.perplexity);
  await expect(shown().getByTestId('ai-answer-meta')).toContainText(AI_ANSWER_ORIGIN_LABELS.agent);
  // Inert: the markup in the answer is text, and no citation is a link.
  await expect(shown().getByTestId('ai-answer-text')).toHaveText(PERPLEXITY_FIXTURE.text);
  expect(await shown().locator('b, a').count()).toBe(0);
  await expect(shown().getByTestId('ai-answer-citation')).toHaveCount(PERPLEXITY_FIXTURE.citations.length);
  for (const [index, citation] of PERPLEXITY_FIXTURE.citations.entries()) await expect(shown().getByTestId('ai-answer-citation').nth(index)).toContainText(citation.url);
  // Cited domains grouped; the watched one marked.
  await page.getByTestId('ai-answers-watch').fill(AI_FIXTURE_WATCHED_DOMAIN);
  const domains = shown().getByTestId('ai-answer-domain');
  await expect(domains).toHaveCount(2);
  await expect(domains.first()).toContainText(`${AI_FIXTURE_WATCHED_DOMAIN} · 2`);
  await expect(domains.first()).toHaveAttribute('data-watched', 'true');
  await expect(domains.nth(1)).toContainText('example.org · 1');
  await expect(shown().locator('[data-testid="ai-answer-citation"][data-watched="true"]')).toHaveCount(2);

  // The view runs one query itself: the cost note first, then Send; no approval card.
  await page.getByTestId('ai-answers-query').fill(VIEW_QUERY);
  await page.getByTestId('ai-answers-engine').selectOption('chatgpt');
  await expect(page.getByTestId('ai-answers-cost-note')).toHaveText(AI_ANSWERS_VIEW_TEXT.costNote);
  await expect(page.getByTestId('ai-answers-ask')).toBeEnabled({ timeout: WAIT });
  await page.getByTestId('ai-answers-ask').click();
  const confirm = page.getByTestId('ai-answers-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(VIEW_QUERY);
  await expect(confirm).toContainText(DATA_SPEND_NOTE);
  expect(fake.requestsTo('openai-search')).toHaveLength(0);
  await page.getByTestId('ai-answers-send').click();
  await expect(shown().getByTestId('ai-answer-query')).toHaveText(VIEW_QUERY, { timeout: WAIT });
  await expect(approvalCard()).toHaveCount(0);
  await expect(shown().getByTestId('ai-answer-meta')).toContainText(AI_SEARCH_ENGINE_LABELS.chatgpt);
  await expect(shown().getByTestId('ai-answer-meta')).toContainText(AI_ANSWER_ORIGIN_LABELS.view);
  await expect(shown().getByTestId('ai-answer-text')).toHaveText(OPENAI_FIXTURE.text);
  await expect(shown().getByTestId('ai-answer-citation')).toHaveCount(OPENAI_FIXTURE.citations.length);
  await expect(page.getByTestId('ai-answers-pick')).toHaveCount(2, { timeout: WAIT });
  // One request to OpenAI web search: the fixed body for the query, the user's key.
  expect(fake.requestsTo('openai-search')).toHaveLength(1);
  expect(sentBody('openai-search')).toEqual(aiSearchRequestBody('openai-search', VIEW_QUERY));
  expect(fake.requestsTo('openai-search')[0]!.headers.authorization).toBe(`Bearer ${KEYS['openai-search']}`);
  expect(fake.requests).toHaveLength(2);
  expect(fake.refused).toEqual([]);
  // Main keeps both, newest first.
  const list = (await ipc('query', 'aiAnswers.list', { limit: 10 })) as { rows: { query: string; engine: string; origin: string }[]; total: number };
  expect(list.total).toBe(2);
  expect(list.rows.map((answer) => [answer.query, answer.engine, answer.origin])).toEqual([
    [VIEW_QUERY, 'chatgpt', 'view'],
    [AGENT_QUERY, 'perplexity', 'agent'],
  ]);

  // The keys reached the providers only: not the log, the page or main's answers.
  const log = output.join('');
  for (const key of Object.values(KEYS)) {
    expect(log).not.toContain(key);
    expect(await page.content()).not.toContain(key);
    expect(JSON.stringify(list)).not.toContain(key);
  }
});
