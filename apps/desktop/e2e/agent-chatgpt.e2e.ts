// Specs: specs/agent-chatgpt-e2e.schema.ts (CHATGPT_E2E_SWITCH, the seam file), specs/agent-chatgpt.spec.ts
// (CHATGPT_UI, CHATGPT_ERROR_MESSAGES, CHATGPT_USAGE_URL, CHATGPT_DYNAMIC_CLIENT_ID, CHATGPT_AGENT_NAME,
// CHATGPT_TOOL_NAMESPACE, CHATGPT_FORBIDDEN_BODY_FIELDS), specs/agent-tools.spec.ts (MODEL_REQUESTS.chatgpt)
// Acceptance: specs/agent-chatgpt.feature.md (End to end) · plan docs/plans/agent-chatgpt-plan.md, Task 6
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { CHATGPT_E2E_SWITCH, type ChatgptE2eSeam } from '@app/specs/agent-chatgpt-e2e.schema';
import {
  CHATGPT_AGENT_NAME,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_ERROR_MESSAGES,
  CHATGPT_FORBIDDEN_BODY_FIELDS,
  CHATGPT_TOOL_NAMESPACE,
  CHATGPT_UI,
  CHATGPT_USAGE_URL,
} from '@app/specs/agent-chatgpt.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { IPC_BRIDGE_KEY } from '@app/specs/ipc-transport.spec';
import { closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { startFakeChatgpt, type FakeChatgpt } from './fake-chatgpt';

// The ChatGPT plan route end to end, on the unpackaged seam `--frost-e2e-chatgpt=<file>`: the
// sign-in's endpoints and the plan's Responses requests go to a local fake (`fake-chatgpt.ts`), and
// the authorize page is "opened" by main's stand-in browser (an HTTP GET that follows the fake's
// redirect to the loopback callback). The runtime's real OpenAI provider makes the requests; only
// the fake's scripted answers stand in for the model. Sign-in needs a live gesture, so every
// sign-in is a real click. One app for the whole file (its state carries from test to test).
// `shell.openExternal` is stubbed to record: no real browser opens, and the sign-in never uses it.

test.describe.configure({ mode: 'serial' });

const SITE_HOST = 'chatgpt.frost-e2e.net';
const START_TEXT = 'Where the agent begins on the plan.';

let app: ElectronApplication | undefined;
let page: Page;
let fake: FakeChatgpt;
let site: { origin: string; close(): Promise<void> };
let dir: string;
const output: string[] = [];
const answers: string[] = [];
const { go, contentsIdAt } = chromeHelpers(
  () => app!,
  () => page,
);

const panel = () => page.getByTestId('agent-panel');
const section = () => page.getByTestId('agent-chatgpt');
const assistantTexts = () => page.getByTestId('agent-assistant-text');

async function startSite() {
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://x').pathname !== '/start') return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan start</title></head><body><h1>Plan start</h1><p>${START_TEXT}</p></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://${SITE_HOST}:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Calls a procedure from the chrome page, as the renderer would (no click: no gesture). */
async function call(type: 'query' | 'mutation', name: string, input?: unknown): Promise<unknown> {
  const response = (await page.evaluate(
    ([key, envelope]) => (window as unknown as Record<string, { invoke(e: unknown): Promise<unknown> }>)[key as string]!.invoke(envelope),
    [IPC_BRIDGE_KEY, { type, path: name, input }] as const,
  )) as { result?: { data: unknown }; error?: unknown };
  answers.push(JSON.stringify(response));
  if (!response.result) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
  return response.result.data;
}

const openedExternally = (): Promise<string[]> => app!.evaluate(() => [...(globalThis as unknown as { __frostOpened: string[] }).__frostOpened]);

async function send(text: string): Promise<void> {
  const input = page.getByTestId('agent-input');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('[data-testid="agent-message"][data-kind="user"]').last()).toHaveText(text);
}

async function openSettings(): Promise<void> {
  if (!(await page.getByTestId('agent-settings').isVisible())) await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-settings')).toBeVisible();
}

async function openChat(): Promise<void> {
  if (await page.getByTestId('agent-settings').isVisible()) await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-input')).toBeVisible();
}

/** Every token the fake issued: none may reach the chrome (its DOM, its storage, its agent state). */
async function expectNoTokenInChrome(): Promise<void> {
  const secrets = [...fake.issued.access, ...fake.issued.refresh, ...fake.issued.id];
  expect(secrets.length).toBeGreaterThan(0);
  const state = JSON.stringify(await call('query', 'agent.watch', { sinceVersion: 0 }));
  const chrome = await page.evaluate(() =>
    [
      document.documentElement.outerHTML,
      document.body.innerText,
      ...[...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')].map((el) => el.value),
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
    ].join('\n'),
  );
  for (const secret of secrets) {
    expect(chrome.includes(secret), 'a token in the chrome').toBe(false);
    expect(state.includes(secret), 'a token in the agent state').toBe(false);
  }
}

test.beforeAll(async () => {
  fake = await startFakeChatgpt();
  site = await startSite();
  dir = await mkdtemp(path.join(tmpdir(), 'frost-e2e-chatgpt-'));
  // Linux under Playwright has no keychain (`--password-store=basic`): the sign-in is kept in memory there.
  const seam: ChatgptE2eSeam = { endpoints: fake.endpoints, store: process.platform === 'linux' ? 'memory' : 'keychain' };
  const file = path.join(dir, 'seam.json');
  await writeFile(file, JSON.stringify(seam));
  ({ app, page } = await launchApp([`--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`, `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST}`, `--${CHATGPT_E2E_SWITCH}=${file}`]));
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as unknown as { __frostOpened: string[] }).__frostOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await closeApp(app);
  app = undefined;
  await fake?.close();
  await site?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
  // Nothing main printed and no answer the chrome got carried a token.
  const seen = `${output.join('')}\n${answers.join('\n')}`;
  for (const secret of [...(fake?.issued.access ?? []), ...(fake?.issued.refresh ?? []), ...(fake?.issued.id ?? [])]) expect(seen.includes(secret)).toBe(false);
});

test('chatgpt-e2e-sign-in-needs-a-gesture', async () => {
  // Before any click: the sign-in answers needs-gesture and nothing is opened.
  expect(await call('mutation', 'agent.chatgptSignIn', {})).toBe('needs-gesture');
  expect(fake.authorizeRequests).toEqual([]);
});

test('chatgpt-e2e-sign-in-turn', async () => {
  await go(`${site.origin}/start`);
  await contentsIdAt(`${site.origin}/start`);
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
  await page.getByTestId('agent-toggle').click();
  await expect(panel()).toHaveAttribute('data-open', 'true');
  await openSettings();
  await page.getByTestId('agent-route').selectOption('chatgpt');
  await expect(section()).toHaveAttribute('data-state', 'signed-out');
  await expect(page.getByTestId('agent-model-none')).toHaveText(CHATGPT_UI.signInToChooseModel);

  // A real click: the first registration (`dynamic_agent_client` and the name hint), then the issued client.
  const signIn = page.getByTestId('agent-chatgpt-sign-in');
  await expect(signIn).toHaveText(CHATGPT_UI.continueButton);
  await signIn.click();
  await expect(section()).toHaveAttribute('data-state', 'signed-in', { timeout: 20_000 });
  await expect(page.getByTestId('agent-chatgpt-account')).toHaveText(`${CHATGPT_UI.signedInAs} ada@example.com`);
  await expect(page.getByTestId('agent-chatgpt-status')).toHaveText(CHATGPT_UI.planUsageOn);
  expect(fake.authorizeRequests).toHaveLength(1);
  expect(fake.authorizeRequests[0]!.clientId).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
  expect(fake.authorizeRequests[0]!.params.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME);
  const issuedClient = fake.tokenRequests[0]!.get('client_id')!;
  expect(issuedClient).toMatch(/^oaiapp_e2e/);
  expect(fake.tokenRequests.map((form) => form.get('grant_type'))).toEqual(['authorization_code']);
  expect(fake.refused).toEqual([]);
  // The stand-in browser did the sign-in: the system browser was never asked.
  expect(await openedExternally()).toEqual([]);

  // The account's listed models (not the hidden one), the first one chosen.
  const models = page.getByTestId('agent-model');
  await expect(models).toBeVisible();
  await expect(models.locator('option')).toHaveText(['GPT E2E', 'GPT E2E Mini']);
  await expect(models).toHaveValue('chatgpt/gpt-e2e');

  // The one-time notice, dismissed with "Got it"; the in-use line stays.
  await openChat();
  await expect(page.getByTestId('agent-chatgpt-notice')).toContainText(CHATGPT_UI.noticeTitle);
  await page.getByTestId('agent-chatgpt-got-it').click();
  await expect(page.getByTestId('agent-chatgpt-notice')).toHaveCount(0);
  await expect(page.getByTestId('agent-chatgpt-inuse')).toContainText(CHATGPT_UI.inUse);

  // A turn: the model calls frost's `page_text` in the `frost` namespace, then answers.
  fake.responses.push({ kind: 'call', name: 'page_text', args: {} }, { kind: 'text', text: 'The page says where the agent begins.' });
  await send('What does this page say?');
  await expect(assistantTexts().last()).toHaveText('The page says where the agent begins.', { timeout: 20_000 });
  const card = page.locator('[data-testid="agent-tool-card"][data-tool="page_text"]');
  await expect(card).toHaveAttribute('data-status', 'done');
  expect(fake.responsesRequests).toHaveLength(2);

  const access = fake.issued.access.at(-1)!;
  for (const { headers, body } of fake.responsesRequests) {
    // The plan's shape: stored nowhere, streamed, every tool in the `frost` namespace.
    expect(body).toMatchObject({ model: 'gpt-e2e', store: false, stream: true });
    for (const field of CHATGPT_FORBIDDEN_BODY_FIELDS) expect(body, field).not.toHaveProperty(field);
    const tools = body.tools as { type: string; name: string; tools: { type: string; name: string }[] }[];
    expect(tools.map((tool) => [tool.type, tool.name])).toEqual([['namespace', CHATGPT_TOOL_NAMESPACE.name]]);
    expect(tools[0]!.tools.map((tool) => tool.name)).toContain('page_text');
    expect(tools[0]!.tools.every((tool) => tool.type === 'function')).toBe(true);
    // Main's credential only: the sign-in's access token, and no API key, organisation, project or cookie.
    expect(headers.authorization).toBe(`Bearer ${access}`);
    for (const name of ['x-api-key', 'openai-organization', 'openai-project', 'cookie']) expect(headers, name).not.toHaveProperty(name);
  }
  // The call went back with its namespace, followed by the tool's output (the page's text).
  const input = fake.responsesRequests[1]!.body.input as Record<string, unknown>[];
  const at = input.findIndex((item) => item.type === 'function_call');
  expect(input[at]).toMatchObject({ type: 'function_call', name: 'page_text', namespace: CHATGPT_TOOL_NAMESPACE.name });
  expect(input[at + 1]).toMatchObject({ type: 'function_call_output', call_id: input[at]!.call_id });
  expect(JSON.stringify(input[at + 1])).toContain(START_TEXT);

  await expectNoTokenInChrome();
});

test('chatgpt-e2e-usage-limit', async () => {
  await openChat();
  const before = fake.responsesRequests.length;
  fake.responses.push({ kind: 'error', status: 429, code: 'subscription_sharing_usage_limit_exceeded' });
  await send('One more, please');
  const banner = page.locator('[data-testid="agent-error"][data-reason="usage-limit"]');
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(banner.getByTestId('agent-chatgpt-error-title')).toHaveText(CHATGPT_UI.usageLimitTitle);
  await expect(banner).toContainText(CHATGPT_ERROR_MESSAGES['usage-limit']);
  // "Manage usage" is the primary action, to ChatGPT's usage settings (not clicked: it opens the system browser).
  const recovery = banner.getByTestId('agent-chatgpt-recovery');
  await expect(recovery).toHaveText(CHATGPT_UI.manageUsage);
  await expect(recovery).toHaveClass(/agent-button-primary/);
  await expect(recovery).toHaveAttribute('href', CHATGPT_USAGE_URL);
  // The plan paused: the provider's retries never reached the fake.
  expect(fake.responsesRequests.length - before).toBe(1);

  // The next turn runs again.
  fake.responses.push({ kind: 'text', text: 'Back on the plan.' });
  await send('And now?');
  await expect(assistantTexts().last()).toHaveText('Back on the plan.', { timeout: 20_000 });
  await expectNoTokenInChrome();
});

test('chatgpt-e2e-sign-out-and-switch', async () => {
  await openSettings();
  const refresh = fake.issued.refresh.at(-1)!;
  const client = fake.tokenRequests[0]!.get('client_id')!;
  await page.getByTestId('agent-chatgpt-sign-out').click();
  await expect(section()).toHaveAttribute('data-state', 'signed-out');
  await expect(page.getByTestId('agent-chatgpt-message')).toHaveText(CHATGPT_UI.signedOut);
  // The refresh token was revoked at the fake.
  expect(fake.revoked.map((form) => Object.fromEntries(form))).toEqual([{ token: refresh, token_type_hint: 'refresh_token', client_id: client }]);

  // Signing in again reuses the registration (the issued client, no name hint) and the same account.
  await page.getByTestId('agent-chatgpt-sign-in').click();
  await expect(section()).toHaveAttribute('data-state', 'signed-in', { timeout: 20_000 });
  expect(fake.authorizeRequests.at(-1)!.clientId).toBe(client);
  expect(fake.authorizeRequests.at(-1)!.params.has('agent_name_hint')).toBe(false);
  await expect(page.getByTestId('agent-chatgpt-account')).toHaveText(`${CHATGPT_UI.signedInAs} ada@example.com`);

  // "Use a different account": revokes, forgets the registration, registers fresh as whoever signs in.
  const held = fake.issued.refresh.at(-1)!;
  fake.account = { sub: 'e2e-user-2', email: 'grace@example.com' };
  await page.getByTestId('agent-chatgpt-different-account').click();
  await expect(page.getByTestId('agent-chatgpt-account')).toHaveText(`${CHATGPT_UI.signedInAs} grace@example.com`, { timeout: 20_000 });
  await expect(section()).toHaveAttribute('data-state', 'signed-in');
  expect(fake.revoked.at(-1)!.get('token')).toBe(held);
  expect(fake.authorizeRequests.at(-1)!.clientId).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
  expect(fake.authorizeRequests.at(-1)!.params.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME);
  expect(fake.tokenRequests.at(-1)!.get('client_id')).not.toBe(client);
  // The forgotten registration took the notice flag with it: the notice shows again.
  await openChat();
  await expect(page.getByTestId('agent-chatgpt-notice')).toBeVisible();

  expect(fake.refused).toEqual([]);
  expect(await openedExternally()).toEqual([]);
  await expectNoTokenInChrome();
});
