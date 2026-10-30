// Specs: specs/agent-panel.spec.ts (AGENT_SET_KEY_MESSAGES, AGENT_TOOL_STATUS_LABELS, AGENT_APPROVAL_BUTTONS),
// specs/agent-session.spec.ts (AGENT_E2E_SCRIPT_SWITCH, APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE),
// specs/agent-e2e-script.schema.ts (the script format)
// specs/agent-data.spec.ts (AGENT_GRANTS_EXPLAINER, CHAT_EXPORT_MESSAGES, CHAT_EXPORT_UNTRUSTED_NOTE, SKILL_USER_LABEL, SKILL_LIBRARY_WORDS),
// specs/agent-mcp.spec.ts (MCP_NO_SANDBOX_SENTENCE)
// Acceptance: specs/agent-panel.feature.md (End to end), specs/skills.feature.md (agent-skill-narrows-tools, agent-skill-pack-listed),
// specs/agent-data.feature.md (End to end), specs/agent-mcp.feature.md (End to end)
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { AGENT_SET_KEY_MESSAGES, AGENT_TOOL_STATUS_LABELS } from '@app/specs/agent-panel.spec';
import { AGENT_GRANTS_EXPLAINER, CHAT_EXPORT_MESSAGES, CHAT_EXPORT_UNTRUSTED_NOTE, SKILL_LIBRARY_WORDS, SKILL_USER_LABEL } from '@app/specs/agent-data.spec';
import { BUILTIN_SKILL_CATEGORY, BUILTIN_SKILL_IDS, SKILL_CATEGORIES, SKILL_CATEGORY_LABELS, SKILL_USER_MARK } from '@app/specs/skills.spec';
import { MCP_NO_SANDBOX_SENTENCE } from '@app/specs/agent-mcp.spec';
import { AGENT_E2E_SCRIPT_SWITCH, APPROVAL_ENABLE_DELAY_MS, EXECUTE_JS_APPROVAL_NOTE } from '@app/specs/agent-session.spec';
import { BROWSE_PARTITION } from '@app/specs/browser.spec';
import { E2E_PUBLIC_HOSTS_SWITCH } from '@app/specs/fetcher.spec';
import { APP_DIR, closeApp, launchApp } from './harness';
import { chromeHelpers } from './helpers';
import { selfSignedCertificate } from './tls';
import { PACK_PATH, PACK_VERSION, SEARCH_HOST, engineAnswer, signedTestPack } from './serp-fixtures';
import { SERP_E2E_PACK_KEY_SWITCH, SERP_E2E_PACK_URL_SWITCH, packSignatureUrl } from '@app/specs/serp-selector-pack.spec';
import { INTENT_MODEL_DIR } from '@app/specs/intent-classifier.spec';
import { readdir } from 'node:fs/promises';

// The agent panel end to end, on the unpackaged build's scripted model seam
// (`--frost-e2e-agent-script=<file>`): the runtime plays a JSON script as its model, so no provider
// is called and no key is needed. Each test launches the app with its own script (the runtime
// keeps one cursor across turns). The site is a loopback server under a public-looking name
// (`--host-resolver-rules`), so read tools run on it without asking, as on the web.

const SITE_HOST = 'agent.frost-e2e.net';

/** `/start`, `/next`, and `/markup` (visible text that looks like HTML). */
async function startSite() {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://x').pathname;
    const html = (title: string, body: string) =>
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
    if (pathname === '/next') html('Agent next', '<h1>The next page</h1>');
    else if (pathname === '/markup') html('Agent markup', '<h1>Markup</h1><p>Look: &lt;img src=x onerror=window.__pwned=1&gt; and &lt;b&gt;bold&lt;/b&gt; text.</p>');
    else if (pathname === '/start') html('Agent start', '<h1>Agent start</h1><p>Where the agent begins.</p>');
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${SITE_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The same pages over https (a fresh self-signed certificate the browse session is told to trust
 * for `SITE_HOST` only): a standing grant needs a public `https:` origin.
 */
async function startTlsSite() {
  const server = createHttpsServer(selfSignedCertificate(), (request, response) => {
    const pathname = new URL(request.url ?? '/', 'https://x').pathname;
    const title = pathname === '/next' ? 'Secure next' : 'Secure start';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://${SITE_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Step = { text?: string[]; toolCalls?: { toolName: string; input: Record<string, unknown> }[]; usage?: { input: number; output: number } };

let app: ElectronApplication | undefined;
let page: Page;
let site: Awaited<ReturnType<typeof startSite>>;
let tlsSite: Awaited<ReturnType<typeof startTlsSite>>;
let scripts: string;
const { go, contentsIdAt, urlOf } = chromeHelpers(
  () => app!,
  () => page,
);

const panel = () => page.getByTestId('agent-panel');
const approvalCard = () => page.getByTestId('agent-approval');
const toolCards = () => page.getByTestId('agent-tool-card');
const assistantTexts = () => page.getByTestId('agent-assistant-text');

/** Launches the app playing `steps`, opens `start` in the tab, and opens the agent panel (`userDataDir`: a profile the caller keeps). */
async function launchWith(steps: Step[], start: string | null = '/start', options: { userDataDir?: string } = {}): Promise<number | null> {
  const file = path.join(scripts, `script-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ steps }));
  ({ app, page } = await launchApp(
    [
      `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1`,
      `--${E2E_PUBLIC_HOSTS_SWITCH}=${SITE_HOST}`,
      `--${AGENT_E2E_SCRIPT_SWITCH}=${file}`,
      // Chromium's fixed-key store: the key store answers `no-keychain` and never touches a real keychain.
      '--password-store=basic',
    ],
    options,
  ));
  // The https pages' certificate is trusted for the site's name only, in this app only.
  await app.evaluate(
    ({ session }, { partition, host }) => {
      session.fromPartition(partition).setCertificateVerifyProc((request, callback) => callback(request.hostname === host ? 0 : -3));
    },
    { partition: BROWSE_PARTITION, host: SITE_HOST },
  );
  await page.waitForLoadState('domcontentloaded');
  // The SEO sidebar's panel collapsed, so the agent panel has its full width whatever the window size.
  if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) === 'true') await page.getByTestId('seo-toggle').click();
  let id: number | null = null;
  if (start !== null) {
    await go(`${site.origin}${start}`);
    id = await contentsIdAt(`${site.origin}${start}`);
  }
  if (options.userDataDir === undefined) await expect(panel()).toHaveAttribute('data-open', 'false');
  // A kept profile remembers the panel open.
  if ((await panel().getAttribute('data-open')) !== 'true') {
    await page.getByTestId('agent-toggle').click();
    await expect(panel()).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('agent-input')).toBeFocused();
  }
  return id;
}

/** Sends `text` from the composer (Enter). */
async function send(text: string): Promise<void> {
  const input = page.getByTestId('agent-input');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press('Enter');
  await expect(page.locator('[data-testid="agent-message"][data-kind="user"]').last()).toHaveText(text);
}

type Arming = { appearedAt: number; disabledAtFirst: boolean; enabledAt: number | null };

/**
 * Records, in the chrome, for each approval card (by its id) when its "Allow once" first appears,
 * whether it was disabled then, and when it first became enabled.
 */
const watchArming = () =>
  page.evaluate(() => {
    const holder = window as unknown as { __arming: Record<string, Arming> };
    holder.__arming = {};
    const check = () => {
      const card = document.querySelector<HTMLElement>('[data-testid="agent-approval"]');
      const button = card?.querySelector<HTMLButtonElement>('[data-testid="agent-allow-once"]');
      const id = card?.dataset['approvalId'];
      if (!button || id === undefined) return;
      holder.__arming[id] ??= { appearedAt: performance.now(), disabledAtFirst: button.disabled, enabledAt: null };
      if (!button.disabled && holder.__arming[id].enabledAt === null) holder.__arming[id].enabledAt = performance.now();
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'data-approval-id'] });
  });
/** What `watchArming` saw for the card on screen now. */
const arming = async (): Promise<Arming | null> => {
  const id = await approvalCard().getAttribute('data-approval-id');
  return page.evaluate((id) => (window as unknown as { __arming: Record<string, Arming> }).__arming[id ?? ''] ?? null, id);
};

/** The attached tab view's bounds, as main laid it out. */
const viewBounds = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => child.getBounds())[0] ?? null);

test.beforeAll(async () => {
  site = await startSite();
  tlsSite = await startTlsSite();
  scripts = await mkdtemp(path.join(tmpdir(), 'frost-e2e-agent-'));
});

test.afterEach(async () => {
  await closeApp(app);
  app = undefined;
});

test.afterAll(async () => {
  await site?.close();
  await tlsSite?.close();
  await rm(scripts, { recursive: true, force: true });
});

test('agent-approval-flow', async () => {
  const next = `${site.origin}/next`;
  const id = await launchWith([{ text: ['I will open the next page.'], toolCalls: [{ toolName: 'navigate', input: { url: next } }] }, { text: ['Opened ', 'the next page ', 'for you.'], usage: { input: 1200, output: 40 } }]);
  await watchArming();
  await send('Open the next page');

  // The approval card names the destination's origin and the exact input.
  await expect(approvalCard()).toBeVisible();
  await expect(page.getByTestId('agent-approval-title')).toHaveText(`Allow navigation to ${site.origin}?`);
  await expect(page.getByTestId('agent-approval-input')).toHaveText(JSON.stringify({ url: next }));
  await expect(page.getByTestId('agent-approval-destination')).toHaveText(next);
  // A plain-http origin can't carry a standing grant: no "Always allow on this site".
  await expect(page.getByTestId('agent-allow-always')).toHaveCount(0);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'awaiting-approval');
  // Allow once was disabled when it appeared and stayed so for the delay.
  await expect.poll(async () => (await arming())?.enabledAt ?? null).not.toBeNull();
  const armed = (await arming())!;
  expect(armed.disabledAtFirst).toBe(true);
  expect(armed.enabledAt! - armed.appearedAt).toBeGreaterThanOrEqual(APPROVAL_ENABLE_DELAY_MS - 50);

  await page.getByTestId('agent-allow-once').click();
  await expect(approvalCard()).toHaveCount(0);
  // The tab navigates, and the scripted text streams into the chat.
  await expect.poll(() => urlOf(id!)).toBe(next);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'done');
  await expect(toolCards().last().getByTestId('agent-tool-status')).toHaveText(AGENT_TOOL_STATUS_LABELS.done);
  await expect(assistantTexts().last()).toHaveText('Opened the next page for you.');
  await expect(page.getByTestId('agent-send')).toBeVisible();
  // The context meter shows the last step's tokens against the model's window.
  await expect(page.getByTestId('agent-context-meter-text')).toHaveText('1.2k of 1M tokens (0%)');
});

test('agent-panel-keeps-the-page-view-clear', async () => {
  await launchWith([{ text: ['unused'] }]);
  // Open: the tab's view ends at or before the panel's left edge.
  const panelLeft = async () => (await panel().boundingBox())!.x;
  await expect.poll(async () => {
    const view = await viewBounds();
    return view !== null && view.x + view.width <= Math.ceil(await panelLeft());
  }).toBe(true);
  const openWidth = (await viewBounds())!.width;
  // Collapsed: the page widens again; the rail stays clear of it too.
  await page.getByTestId('agent-collapse').click();
  await expect(panel()).toHaveAttribute('data-open', 'false');
  await expect.poll(async () => (await viewBounds())!.width).toBeGreaterThan(openWidth);
  await expect.poll(async () => {
    const view = (await viewBounds())!;
    return view.x + view.width <= Math.ceil(await panelLeft());
  }).toBe(true);
});

test('agent-approval-deny', async () => {
  const id = await launchWith([{ toolCalls: [{ toolName: 'navigate', input: { url: `${site.origin}/next` } }] }, { text: ['Understood: ', 'I left the page as it is.'] }]);
  await send('Open the next page');
  await expect(approvalCard()).toBeVisible();
  await page.getByTestId('agent-deny').click();
  await expect(approvalCard()).toHaveCount(0);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'denied');
  await expect(toolCards().last().getByTestId('agent-tool-status')).toHaveText(AGENT_TOOL_STATUS_LABELS.denied);
  // The chat goes on with the scripted text; the tab never moved.
  await expect(assistantTexts().last()).toHaveText('Understood: I left the page as it is.');
  await expect(page.getByTestId('agent-send')).toBeVisible();
  expect(await urlOf(id!)).toBe(`${site.origin}/start`);
});

test('agent-stop', async () => {
  const id = await launchWith([{ text: ['Opening it now.'], toolCalls: [{ toolName: 'navigate', input: { url: `${site.origin}/next` } }] }, { text: ['This step is never reached.'] }]);
  await send('Open the next page');
  // The turn waits on the approval: running, with Stop in place of Send and the field disabled.
  await expect(approvalCard()).toBeVisible();
  await expect(page.getByTestId('agent-input')).toBeDisabled();
  await page.getByTestId('agent-stop').click();
  // The pending approval expires with the turn; the turn ends.
  await expect(approvalCard()).toHaveCount(0);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'expired');
  await expect(toolCards().last().getByTestId('agent-tool-status')).toHaveText(AGENT_TOOL_STATUS_LABELS.expired);
  await expect(page.getByTestId('agent-stop')).toHaveCount(0);
  await expect(page.getByTestId('agent-input')).toBeEnabled();
  await expect(page.getByText('This step is never reached.')).toHaveCount(0);
  expect(await urlOf(id!)).toBe(`${site.origin}/start`);
});

test('agent-execute-js-asks-every-time', async () => {
  // Longer than the code block shows (a hint says so), and a line padded far to the right.
  const first = ["const heading = document.querySelector('h1');", ...Array.from({ length: 30 }, (_, i) => `// step ${i + 1}`), 'heading ? heading.textContent : null'].join('\n');
  const second = `document.title;${' '.repeat(300)}fetch('/x')`;
  await launchWith([
    { toolCalls: [{ toolName: 'execute_javascript', input: { code: first } }] },
    { toolCalls: [{ toolName: 'execute_javascript', input: { code: second } }] },
    { text: ['Done with the page.'] },
  ]);
  await watchArming();
  await send('Read the heading');

  // The first run asks, showing the whole code and the note; it can't be allowed for the site.
  await expect(approvalCard()).toHaveAttribute('data-tool', 'execute_javascript');
  await expect(page.getByTestId('agent-approval-title')).toHaveText(`Run this JavaScript on ${site.origin}/start?`);
  await expect(page.getByTestId('agent-approval-code')).toHaveText(first);
  await expect(page.getByTestId('agent-approval-note')).toHaveText(EXECUTE_JS_APPROVAL_NOTE);
  await expect(page.getByTestId('agent-allow-always')).toHaveCount(0);
  await expect(page.getByTestId('agent-approval-code-more')).toBeVisible();
  const firstId = await approvalCard().getAttribute('data-approval-id');
  await page.getByTestId('agent-allow-once').click();
  await expect(toolCards().first()).toHaveAttribute('data-status', 'done');
  await expect(toolCards().first().getByTestId('agent-tool-output')).toContainText('Agent start');

  // Allowed once is not allowed again: the next run asks too. Escape in the card denies it.
  await expect(page.getByTestId('agent-approval-code')).toHaveText(second);
  // A new card: disarmed when it appeared, for a whole delay.
  expect(await approvalCard().getAttribute('data-approval-id')).not.toBe(firstId);
  await expect.poll(async () => (await arming())?.enabledAt ?? null).not.toBeNull();
  const armed = (await arming())!;
  expect(armed.disabledAtFirst).toBe(true);
  expect(armed.enabledAt! - armed.appearedAt).toBeGreaterThanOrEqual(APPROVAL_ENABLE_DELAY_MS - 50);
  // Nothing hides past the block's right edge: the padded call wraps into view.
  const layout = await page.getByTestId('agent-approval-code').evaluate((pre) => {
    const text = pre.querySelector('code')!.firstChild as Text;
    const at = text.data.indexOf('fetch');
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + 'fetch'.length);
    const word = range.getBoundingClientRect();
    const box = pre.getBoundingClientRect();
    return { overflowX: pre.scrollWidth - pre.clientWidth, inside: word.left >= box.left && word.right <= box.right };
  });
  expect(layout).toEqual({ overflowX: 0, inside: true });
  await page.getByTestId('agent-approval-title').click();
  await expect(approvalCard()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(approvalCard()).toHaveCount(0);
  await expect(toolCards().nth(1)).toHaveAttribute('data-status', 'denied');
  await expect(assistantTexts().last()).toHaveText('Done with the page.');
});

test('agent-settings-never-shows-key', async () => {
  const secret = 'e2e-secret-agent-key-7f3a9c0b1d';
  await launchWith([{ text: ['unused'] }], null);
  await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-settings')).toBeVisible();
  // Honest about isolation: no file sandbox is claimed on Electron 45.
  // (The runtime hasn't started in this test, so the line says so; it never claims more.)
  await expect(page.getByTestId('agent-isolation')).toContainText('Agent process:');
  for (const claim of ['File sandbox: in effect', 'file access limited', 'network access']) await expect(page.getByTestId('agent-isolation')).not.toContainText(claim);

  const row = page.locator('[data-testid="agent-key"][data-slot="gateway"]');
  const field = row.getByTestId('agent-key-input');
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(secret);
  await row.getByTestId('agent-key-save').click();
  const message = row.getByTestId('agent-key-message');
  if (process.platform === 'linux') {
    // `--password-store=basic`: only Chromium's fixed key, so frost refuses to store the key, and says why.
    await expect(message).toHaveText(AGENT_SET_KEY_MESSAGES['no-keychain']);
    await expect(row.getByTestId('agent-key-state')).toHaveText('No key');
    await expect(page.getByTestId('agent-protection')).toHaveText("No system keychain is available, so frost can't store a key here");
  } else {
    await expect(message).toHaveText(new RegExp(`^(${[AGENT_SET_KEY_MESSAGES.stored, AGENT_SET_KEY_MESSAGES['no-keychain']].map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`));
  }
  // The typed key is nowhere on the page: not in its text, its markup or any field's value.
  const leaks = await page.evaluate(
    (secret) => ({
      text: document.body.innerText.includes(secret),
      html: document.documentElement.outerHTML.includes(secret),
      values: [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].some((el) => el.value.includes(secret)),
    }),
    secret,
  );
  expect(leaks).toEqual({ text: false, html: false, values: false });
  await expect(field).toHaveValue('');
  // Off Linux the OS keychain may have taken it: remove it, so no test key is left behind.
  if ((await message.textContent()) === AGENT_SET_KEY_MESSAGES.stored) {
    await row.getByTestId('agent-key-clear').click();
    await expect(message).toHaveText('Key removed.');
  }
});

test('agent-renders-tool-output-as-text', async () => {
  await launchWith([{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['I read the page.'] }], '/markup');
  await send('What does this page say?');
  // A read tool on a public page runs without asking.
  const output = toolCards().first().getByTestId('agent-tool-output');
  await expect(toolCards().first()).toHaveAttribute('data-status', 'done');
  await expect(output).toContainText('<img src=x onerror=window.__pwned=1>');
  await expect(output).toContainText('<b>bold</b>');
  await expect(assistantTexts().last()).toHaveText('I read the page.');
  // Shown literally: no element was made from it, and nothing ran.
  expect(await output.evaluate((el) => el.children.length)).toBe(0);
  expect(await panel().locator('img, b, script').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('agent-skill-narrows-tools', async () => {
  // The model reaches for `navigate`, which the skill doesn't offer, then reads the page.
  const id = await launchWith([
    { text: ['Opening another page first.'], toolCalls: [{ toolName: 'navigate', input: { url: `${site.origin}/next` } }] },
    { toolCalls: [{ toolName: 'page_text', input: {} }] },
    { text: ['The page reads well.'] },
  ]);
  await page.getByTestId('agent-skill-picker').selectOption('audit-this-page');
  await expect(page.getByTestId('agent-input')).toHaveCount(0);
  const note = page.getByTestId('agent-skill-input-userNote');
  await note.fill('headings first');
  await note.press('Enter');

  // The chat shows the skill's name and the note, not its template.
  const user = page.locator('[data-testid="agent-message"][data-kind="user"]').last();
  await expect(user.getByTestId('agent-message-skill')).toHaveText('Skill: Audit this page');
  await expect(user).toContainText('headings first');
  await expect(user).not.toContainText('skill-inputs');
  await expect(page.getByTestId('agent-chat-heading')).toHaveText('Audit this page');
  await expect(assistantTexts().last()).toHaveText('The page reads well.');
  // The off-list call never reached main: no approval card, no tool card for it, the tab stayed.
  await expect(approvalCard()).toHaveCount(0);
  await expect(toolCards()).toHaveCount(1);
  await expect(toolCards().first()).toHaveAttribute('data-tool', 'page_text');
  await expect(toolCards().first()).toHaveAttribute('data-status', 'done');
  expect(await urlOf(id!)).toBe(`${site.origin}/start`);
  // Back to a message field once the run started.
  await expect(page.getByTestId('agent-input')).toBeVisible();
});

test('agent-skill-pack-listed', async () => {
  await launchWith([{ text: ['unused'] }]);
  // The fourteen built-ins, under their category headings in the picker's order.
  const groups = page.getByTestId('agent-skill-picker').locator('optgroup');
  const listed = await groups.evaluateAll((nodes) => nodes.map((node) => [(node as HTMLOptGroupElement).label, [...node.querySelectorAll('option')].map((option) => option.value)] as const));
  const expected = SKILL_CATEGORIES.map((category) => [SKILL_CATEGORY_LABELS[category], BUILTIN_SKILL_IDS.filter((id) => BUILTIN_SKILL_CATEGORY[id] === category)] as const);
  expect(listed).toEqual(expected);
  expect(listed.flatMap(([, ids]) => ids)).toHaveLength(14);
});

/** Opens a view reached from the settings (`agent-open-grants`, `agent-open-skills`). */
async function openFromSettings(button: 'agent-open-grants' | 'agent-open-skills'): Promise<void> {
  await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-settings')).toBeVisible();
  await page.getByTestId(button).click();
}

/** Back to the chat from a view reached from the settings. */
async function backToChat(): Promise<void> {
  await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-settings')).toBeVisible();
  await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-input')).toBeVisible();
}

test('agent-grants-revoke', async () => {
  const next = `${tlsSite.origin}/next`;
  const start = `${tlsSite.origin}/start`;
  const id = await launchWith([
    { toolCalls: [{ toolName: 'navigate', input: { url: next } }] },
    { text: ['Opened the next page.'] },
    { toolCalls: [{ toolName: 'navigate', input: { url: start } }] },
    { text: ['Back at the start.'] },
    { toolCalls: [{ toolName: 'navigate', input: { url: next } }] },
    { text: ['Not this time.'] },
  ]);
  await send('Open the secure next page');
  // A public https origin: "Always allow on this site" is offered.
  await expect(approvalCard()).toBeVisible();
  const always = page.getByTestId('agent-allow-always');
  await expect(always).toBeEnabled();
  await always.click();
  await expect(approvalCard()).toHaveCount(0);
  await expect.poll(() => urlOf(id!)).toBe(next);
  await expect(assistantTexts().last()).toHaveText('Opened the next page.');

  // The grant covers the next navigate on that site: it runs without asking.
  await send('Go back to the start');
  await expect(assistantTexts().last()).toHaveText('Back at the start.');
  await expect.poll(() => urlOf(id!)).toBe(start);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'done');

  // The grants page lists it, says what it means, and revokes it.
  await openFromSettings('agent-open-grants');
  await expect(page.getByTestId('agent-grants-explainer')).toHaveText(AGENT_GRANTS_EXPLAINER);
  const grant = page.getByTestId('agent-grant');
  await expect(grant).toHaveCount(1);
  await expect(grant).toHaveAttribute('data-tool', 'navigate');
  await expect(grant.getByTestId('agent-grant-origin')).toHaveText(tlsSite.origin);
  await grant.getByTestId('agent-grant-revoke').click();
  await expect(page.getByTestId('agent-grant')).toHaveCount(0);
  await expect(page.getByTestId('agent-grants-empty')).toBeVisible();

  // Revoked: the next navigate on that site asks again.
  await backToChat();
  await send('Open the secure next page again');
  await expect(approvalCard()).toBeVisible();
  await expect(page.getByTestId('agent-approval-title')).toHaveText(`Allow navigation to ${tlsSite.origin}?`);
  await page.getByTestId('agent-deny').click();
  await expect(assistantTexts().last()).toHaveText('Not this time.');
  expect(await urlOf(id!)).toBe(start);
});

test('agent-skill-editor-saves', async () => {
  await launchWith([{ text: ['unused'] }]);
  await openFromSettings('agent-open-skills');
  const builtin = page.locator('[data-testid="agent-skill-item"][data-skill-id="audit-this-page"]');
  await expect(builtin).toHaveAttribute('data-builtin', 'true');
  await expect(builtin.getByTestId('agent-skill-edit')).toHaveCount(0);
  // Duplicate a built-in, rename it, save it.
  await builtin.getByTestId('agent-skill-duplicate').click();
  const editor = page.getByTestId('agent-skill-editor');
  await expect(editor).toHaveAttribute('data-mode', 'update');
  await expect(page.getByTestId('agent-skill-field-id')).toHaveValue('audit-this-page-copy');
  await expect(page.getByTestId('agent-skill-tool-page_audit')).toBeChecked();
  await page.getByTestId('agent-skill-field-name').fill('My page audit');
  // A placeholder outside the allowlist is refused inline by main, and nothing is saved.
  const instructions = page.getByTestId('agent-skill-field-instructions');
  const original = await instructions.inputValue();
  await instructions.fill(`${original}\nAlso see {{url}}.`);
  await page.getByTestId('agent-skill-save').click();
  await expect(page.getByTestId('agent-skill-error-instructions')).toBeVisible();
  await instructions.fill(original);
  await page.getByTestId('agent-skill-save').click();
  await expect(editor).toHaveCount(0);
  const mine = page.locator('[data-testid="agent-skill-item"][data-skill-id="audit-this-page-copy"]');
  await expect(mine.getByTestId('agent-skill-name')).toHaveText('My page audit');
  await expect(mine.getByTestId('agent-skill-badge')).toHaveText(SKILL_USER_LABEL);

  // It appears in the composer's picker, marked as the user's own.
  await backToChat();
  const option = page.getByTestId('agent-skill-picker').locator('option[value="audit-this-page-copy"]');
  await expect(option).toHaveText(`My page audit (${SKILL_USER_MARK})`);
});

test('agent-skill-library-search-and-disable', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-agent-skills-'));
  const option = () => page.getByTestId('agent-skill-picker').locator('option[value="check-hreflang"]');
  const row = () => page.locator('[data-testid="agent-skill-item"][data-skill-id="check-hreflang"]');
  try {
    await launchWith([{ text: ['unused'] }], '/start', { userDataDir: profile });
    await expect(option()).toHaveCount(1);
    // The library lists every built-in; a search narrows it by name, description or id.
    await openFromSettings('agent-open-skills');
    await expect(page.getByTestId('agent-skill-item')).toHaveCount(BUILTIN_SKILL_IDS.length);
    const search = page.getByTestId('agent-skills-search');
    await search.fill('HREFLANG');
    await expect(page.getByTestId('agent-skill-item')).toHaveCount(1);
    await expect(row()).toBeVisible();
    // Switched off, it stays in the library with its switch off ...
    const toggle = row().getByTestId('agent-skill-switch');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(row().locator('label.agent-toggle')).toHaveText(SKILL_LIBRARY_WORDS.off);
    await search.fill('no such skill anywhere');
    await expect(page.getByTestId('agent-skills-no-match')).toHaveText(SKILL_LIBRARY_WORDS.noMatch);
    await search.fill('');
    await expect(row()).toBeVisible();
    // ... and is gone from the composer's picker.
    await backToChat();
    await expect(page.getByTestId('agent-skill-picker').locator('option')).toHaveCount(BUILTIN_SKILL_IDS.length);
    await expect(option()).toHaveCount(0);

    // Restarted on the same profile: still off.
    await closeApp(app);
    app = undefined;
    await launchWith([{ text: ['unused'] }], '/start', { userDataDir: profile });
    await expect(option()).toHaveCount(0);
    await openFromSettings('agent-open-skills');
    await expect(row().getByTestId('agent-skill-switch')).not.toBeChecked();
    // Switched on again, it comes back.
    await row().getByTestId('agent-skill-switch').click();
    await expect(row().getByTestId('agent-skill-switch')).toBeChecked();
    await expect(row().locator('label.agent-toggle')).toHaveText(SKILL_LIBRARY_WORDS.on);
    await backToChat();
    await expect(option()).toHaveCount(1);
  } finally {
    await closeApp(app);
    app = undefined;
    await rm(profile, { recursive: true, force: true });
  }
});

test('agent-chat-export-and-restore', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'frost-e2e-agent-profile-'));
  try {
    await launchWith([{ toolCalls: [{ toolName: 'page_text', input: {} }] }, { text: ['The page says where the agent begins.'] }], '/start', { userDataDir: profile });
    await send('What does this page say?');
    await expect(assistantTexts().last()).toHaveText('The page says where the agent begins.');

    // Export: main's save dialog (stubbed here, in main, to answer a file) decides where it goes.
    const file = path.join(scripts, `export-${Date.now()}.md`);
    await app!.evaluate(({ dialog }, target) => {
      const holder = dialog as unknown as { showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }> };
      holder.showSaveDialog = async () => (target === '' ? { canceled: true } : { canceled: false, filePath: target });
    }, '');
    await page.getByTestId('agent-chats-toggle').click();
    await page.getByTestId('agent-chat-export-toggle').first().click();
    await page.getByTestId('agent-export-markdown').click();
    await expect(page.getByTestId('agent-export-message')).toHaveText(CHAT_EXPORT_MESSAGES.cancelled);
    await app!.evaluate(({ dialog }, target) => {
      const holder = dialog as unknown as { showSaveDialog: (...args: unknown[]) => Promise<{ canceled: boolean; filePath?: string }> };
      holder.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, file);
    await page.getByTestId('agent-export-markdown').click();
    await expect(page.getByTestId('agent-export-message')).toHaveText(CHAT_EXPORT_MESSAGES.saved);
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('# What does this page say?\n')).toBe(true);
    expect(text).toContain(CHAT_EXPORT_UNTRUSTED_NOTE);
    expect(text).toContain('tool page_text (Done)');
    expect(text).toContain('Agent start');
    await closeApp(app);
    app = undefined;

    // Restarted on the same profile: the chat is listed again (the default retention keeps it).
    await launchWith([{ text: ['unused'] }], null, { userDataDir: profile });
    await page.getByTestId('agent-chats-toggle').click();
    const item = page.getByTestId('agent-chat-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('What does this page say?');
    await item.locator('.agent-chat-select').click();
    await expect(assistantTexts().last()).toHaveText('The page says where the agent begins.');
  } finally {
    await closeApp(app);
    app = undefined;
    await rm(profile, { recursive: true, force: true });
  }
});

// Task 10 (specs/agent-mcp.feature.md, End to end): a command MCP server configured in the
// settings, started after main's native dialog (answered here by replacing `dialog.showMessageBox`
// in main, test-only, so main's own code path runs), its tool called by the scripted model.
test('agent-mcp-tool-asks', async () => {
  const fixture = path.join(APP_DIR, 'src/main/agent/__tests__/fixtures/fake-mcp-server.mjs');
  const node = realpathSync(process.execPath);
  // Under a sandbox the server reads only what is listed: Node's install and the fixture's folder.
  const readPaths = [path.dirname(path.dirname(node)), path.dirname(fixture)];
  await launchWith([{ toolCalls: [{ toolName: 'mcp__faketools__echo', input: { text: 'from e2e' } }] }, { text: ['Echo done.'] }]);
  await app!.evaluate(({ dialog }) => {
    const holder = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<{ response: number; checkboxChecked: boolean }> };
    const seen: unknown[] = [];
    (globalThis as { __frostMcpDialogs?: unknown[] }).__frostMcpDialogs = seen;
    holder.showMessageBox = async (...args: unknown[]) => {
      const options = args.find((arg) => typeof arg === 'object' && arg !== null && 'buttons' in arg) as { buttons: string[] } | undefined;
      seen.push(options);
      return { response: options?.buttons.indexOf('Start server') ?? 0, checkboxChecked: false };
    };
  });
  await page.getByTestId('agent-settings-toggle').click();
  await expect(page.getByTestId('agent-mcp')).toBeVisible();
  await page.getByTestId('agent-mcp-field-name').fill('Fake Tools');
  await page.getByTestId('agent-mcp-field-command').fill(node);
  await page.getByTestId('agent-mcp-field-args').fill(fixture);
  await page.getByTestId('agent-mcp-field-read').fill(readPaths.join('\n'));
  await page.getByTestId('agent-mcp-save').click();
  const row = page.locator('[data-testid="agent-mcp-server"][data-server="faketools"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('agent-mcp-untrusted')).toHaveText('Untrusted');
  await expect(row.getByTestId('agent-mcp-status')).toHaveText('Stopped');
  // Off until the user turns it on.
  await expect(row.getByTestId('agent-mcp-start')).toBeDisabled();
  // The switch shows main's setting: it turns on once main has stored it.
  await row.getByTestId('agent-mcp-enabled').click();
  await expect(row.getByTestId('agent-mcp-enabled')).toBeChecked();
  await row.getByTestId('agent-mcp-start').click();
  await expect(row.getByTestId('agent-mcp-status')).toHaveText('Running');
  await expect(row.getByTestId('agent-mcp-tools')).toHaveText('5 tools');
  // The settings say plainly how it runs; never a sandbox that isn't there.
  const sandbox = await row.getByTestId('agent-mcp-sandbox').textContent();
  expect(sandbox === MCP_NO_SANDBOX_SENTENCE || sandbox!.includes('sandbox: it can')).toBe(true);
  test.info().annotations.push({ type: 'mcp-sandbox', description: (await row.getByTestId('agent-mcp-sandbox').getAttribute('data-unsandboxed')) === 'true' ? 'none' : sandbox! });
  // Main's dialog showed the exact command line, labelled untrusted.
  const dialogs = (await app!.evaluate(() => structuredClone((globalThis as { __frostMcpDialogs?: unknown[] }).__frostMcpDialogs ?? []))) as { title: string; message: string; detail: string }[];
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]!.title).toBe('Start an untrusted MCP server?');
  expect(dialogs[0]!.detail).toContain(`${node} ${fixture}`);
  expect(dialogs[0]!.detail).toContain(sandbox!);
  // Sandboxed, it lists every folder it may read (real paths) and the network setting; always every variable's name.
  if (sandbox !== MCP_NO_SANDBOX_SENTENCE) {
    expect(dialogs[0]!.detail).toContain(`Folders it may read: ${readPaths.map((folder) => realpathSync(folder)).join(', ')}`);
    expect(dialogs[0]!.detail).toContain('Network: not allowed');
  }
  expect(dialogs[0]!.detail).toContain('Environment variables it gets besides PATH and HOME: none');

  await page.getByTestId('agent-settings-toggle').click();
  await send('Echo something');
  await expect(approvalCard()).toBeVisible();
  await expect(approvalCard()).toHaveAttribute('data-untrusted', 'true');
  await expect(page.getByTestId('agent-approval-title')).toHaveText('Untrusted tool from Fake Tools: allow "echo"?');
  await expect(page.getByTestId('agent-approval-input')).toHaveText(JSON.stringify({ text: 'from e2e' }));
  // Never for the whole site.
  await expect(page.getByTestId('agent-allow-always')).toHaveCount(0);
  await expect(page.getByTestId('agent-allow-once')).toBeEnabled();
  await page.getByTestId('agent-allow-once').click();
  await expect(approvalCard()).toHaveCount(0);
  await expect(toolCards().last()).toHaveAttribute('data-status', 'done');
  await expect(toolCards().last().getByTestId('agent-tool-untrusted')).toHaveText('Untrusted');
  await expect(toolCards().last().getByTestId('agent-tool-output')).toContainText('echo: from e2e');
  await expect(assistantTexts().last()).toHaveText('Echo done.');
});

test('agent-serp-tools-read-the-serp-service', async () => {
  // Phase 3's synthetic engine (serp-fixtures.ts) and its signed test pack; no intent fake, so the
  // on-device classifier has no model and must say so without downloading one.
  const pack = signedTestPack();
  const engineRequests: { path: string; userAgent: string }[] = [];
  const engine = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    // Only what the app sent counts (it asks for the engine by name; a stray local request elsewhere
    // in this worker reaching a reused port would name 127.0.0.1).
    if ((request.headers.host ?? '').split(':')[0] === SEARCH_HOST) engineRequests.push({ path: url.pathname, userAgent: request.headers['user-agent'] ?? '' });
    const answer = engineAnswer(url, pack);
    if (answer) response.writeHead(answer.status, { 'Content-Type': answer.type }).end(answer.body);
    else response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not here');
  });
  await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const origin = `http://${SEARCH_HOST}:${(engine.address() as AddressInfo).port}`;
  try {
    const file = path.join(scripts, `script-serp-${Date.now()}.json`);
    await writeFile(file, JSON.stringify({ steps: [{ toolCalls: [{ toolName: 'serp_results', input: { query: 'green tea' } }, { toolName: 'search_intent', input: { query: 'green tea' } }] }, { text: ['Read the results.'] }] }));
    ({ app, page } = await launchApp([
      `--host-resolver-rules=MAP ${SEARCH_HOST} 127.0.0.1`,
      `--${E2E_PUBLIC_HOSTS_SWITCH}=${SEARCH_HOST}`,
      `--${SERP_E2E_PACK_URL_SWITCH}=${origin}${PACK_PATH}`,
      `--${SERP_E2E_PACK_KEY_SWITCH}=${pack.spki}`,
      `--${AGENT_E2E_SCRIPT_SWITCH}=${file}`,
      '--password-store=basic',
    ]));
    await page.waitForLoadState('domcontentloaded');
    const searchUrl = `${origin}/search?q=green+tea`;
    await go(searchUrl);
    await contentsIdAt(searchUrl);
    // The user installs the test pack (the only thing that requests one); the tab is then read.
    if ((await page.getByTestId('seo-sidebar').getAttribute('data-open')) !== 'true' || (await page.getByTestId('seo-panel').getAttribute('data-panel')) !== 'serp') {
      await page.locator('[data-testid="seo-rail-item"][data-panel="serp"]').click();
    }
    await page.getByTestId('serp-pack-update').click();
    await expect(page.getByTestId('serp-pack-status')).toHaveAttribute('data-version', String(PACK_VERSION), { timeout: 20_000 });
    await expect(page.getByTestId('serp-panel')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await page.getByTestId('seo-toggle').click();

    await page.getByTestId('agent-toggle').click();
    await expect(panel()).toHaveAttribute('data-open', 'true');
    await send('Who ranks for green tea?');
    await expect(assistantTexts().last()).toHaveText('Read the results.');
    // serp_results answered from the SERP service's reading of the tab: the fixture's organic results.
    const serpCard = page.locator('[data-testid="agent-tool-card"][data-tool="serp_results"]');
    await expect(serpCard).toHaveAttribute('data-status', 'done');
    const serpOutput = serpCard.getByTestId('agent-tool-output');
    await expect(serpOutput).toContainText('A guide to green tea');
    await expect(serpOutput).toContainText('https://brewguide.example/guide');
    await expect(serpOutput).toContainText('"query":"green tea"');
    // search_intent: the classifier's own state, unchanged; no model was downloaded.
    const intentCard = page.locator('[data-testid="agent-tool-card"][data-tool="search_intent"]');
    await expect(intentCard).toHaveAttribute('data-status', 'done');
    await expect(intentCard.getByTestId('agent-tool-output')).toContainText('"state":"model-missing"');
    // Nothing downloaded the model: its directory under the profile is still absent or empty.
    const userData = await app!.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    expect(await readdir(path.join(userData, INTENT_MODEL_DIR)).catch(() => [])).toEqual([]);
    // Reading the SERP requested nothing: the engine saw only the user's own loads (the page, its
    // robots.txt for the audit, the pack the user asked for), and nothing as a crawler.
    const expected = [PACK_PATH, packSignatureUrl(PACK_PATH), '/search', '/robots.txt', '/favicon.ico'];
    expect(engineRequests.filter((entry) => !expected.includes(entry.path))).toEqual([]);
    expect(engineRequests.filter((entry) => /bot\b|crawler/i.test(entry.userAgent))).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => {
      engine.closeAllConnections();
      engine.close(() => resolve());
    });
  }
});

