// Spec: specs/agent-chatgpt-e2e.schema.ts (CHATGPT_E2E_SWITCH, ChatgptE2eSeamSchema, isChatgptE2eUrl,
// CHATGPT_E2E_SEAM_MAX_CHARS), specs/security-policy.spec.ts (PACKAGED_FORBIDDEN_SWITCHES),
// specs/agent-chatgpt.spec.ts (CHATGPT_ENDPOINTS, isChatgptAuthorizeUrl), specs/agent-tools.spec.ts (MODEL_REQUESTS.chatgpt)
// Acceptance: specs/agent-chatgpt.feature.md (End to end) · plan docs/plans/agent-chatgpt-plan.md, Task 6
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHATGPT_E2E_SEAM_MAX_CHARS, CHATGPT_E2E_SWITCH, isChatgptE2eUrl, parseChatgptE2eSeam } from '@app/specs/agent-chatgpt-e2e.schema';
import { CHATGPT_ENDPOINTS, CHATGPT_TOOL_NAMESPACE, type ChatgptModelView } from '@app/specs/agent-chatgpt.spec';
import { EMPTY_CHATGPT_STATE } from '@app/specs/agent-chatgpt.schema';
import { MODEL_REQUESTS } from '@app/specs/agent-tools.spec';
import { PACKAGED_DEBUG_REFUSAL, PACKAGED_FORBIDDEN_SWITCHES } from '@app/specs/security-policy.spec';
import type { MainToRuntimeMessage } from '@app/specs/agent-protocol.schema';
import { remoteDebuggingRefusal } from '../../../security/policy';
import type { AgentFetchEvent } from '../../host';
import { createModelProxy, type ProxyFetchFunction } from '../../model-proxy';
import { chatgptE2eSeamFrom, createMemoryChatgptStore, e2eBrowser } from '../e2e-seam';
import { chatgptBrowserOpener } from '../opener';

const ORIGIN = 'http://127.0.0.1:41234';
const ENDPOINTS = {
  issuer: ORIGIN,
  authorize: `${ORIGIN}/api/accounts/authorize`,
  token: `${ORIGIN}/api/accounts/oauth/token`,
  revoke: `${ORIGIN}/api/accounts/oauth/revoke`,
  jwks: `${ORIGIN}/.well-known/jwks.json`,
  models: `${ORIGIN}/v1/models`,
  responses: `${ORIGIN}/v1/responses`,
};
const SEAM = { endpoints: ENDPOINTS, store: 'memory' };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('ChatGPT e2e seam', () => {
  test('chatgpt-e2e-seam-unpackaged-only (a valid file is read unpackaged)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'frost-chatgpt-seam-'));
    try {
      const file = path.join(dir, 'seam.json');
      writeFileSync(file, JSON.stringify(SEAM));
      const log = vi.fn();
      expect(chatgptE2eSeamFrom({ packaged: false, switchValue: file, log })).toEqual(SEAM);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('unpackaged'));
      // `store` defaults to the keychain.
      writeFileSync(file, JSON.stringify({ endpoints: ENDPOINTS }));
      expect(chatgptE2eSeamFrom({ packaged: false, switchValue: file })).toEqual({ endpoints: ENDPOINTS, store: 'keychain' });
      // Not JSON, an unknown key, a missing endpoint, too long, missing: the seam stays off.
      const { revoke: _revoke, ...missing } = ENDPOINTS;
      for (const content of ['nope', JSON.stringify({ ...SEAM, extra: 1 }), JSON.stringify({ endpoints: missing }), JSON.stringify({ ...SEAM, pad: 'x'.repeat(CHATGPT_E2E_SEAM_MAX_CHARS) })]) {
        writeFileSync(file, content);
        expect(chatgptE2eSeamFrom({ packaged: false, switchValue: file })).toBeNull();
      }
      expect(chatgptE2eSeamFrom({ packaged: false, switchValue: path.join(dir, 'missing.json') })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('chatgpt-e2e-seam-unpackaged-only (only loopback http URLs)', () => {
    for (const url of [ORIGIN, `${ORIGIN}/`, `${ORIGIN}/v1/responses`]) expect(isChatgptE2eUrl(url), url).toBe(true);
    for (const url of [
      CHATGPT_ENDPOINTS.responses,
      'https://127.0.0.1:41234/v1/responses',
      'http://localhost:41234/v1/responses',
      'http://127.0.0.2:41234/v1/responses',
      'http://127.0.0.1/v1/responses',
      `${ORIGIN}/v1/responses?x=1`,
      `${ORIGIN}/v1/responses#x`,
      'http://user:pw@127.0.0.1:41234/v1/responses',
      `${ORIGIN}/v1/../v1/responses`,
      'http://0x7f.0.0.1:41234/v1/responses',
      42,
    ]) {
      expect(isChatgptE2eUrl(url), String(url)).toBe(false);
      expect(parseChatgptE2eSeam(JSON.stringify({ endpoints: { ...ENDPOINTS, responses: url } }))).toBeNull();
    }
  });

  test('chatgpt-e2e-seam-unpackaged-only (refused when packaged)', () => {
    const readFile = vi.fn(() => JSON.stringify(SEAM));
    // A packaged build never reads the file …
    expect(chatgptE2eSeamFrom({ packaged: true, switchValue: '/tmp/seam.json', readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    expect(chatgptE2eSeamFrom({ packaged: false, switchValue: '', readFile })).toBeNull();
    expect(readFile).not.toHaveBeenCalled();
    // … and refuses to start with the switch at all.
    expect(PACKAGED_FORBIDDEN_SWITCHES).toContain(CHATGPT_E2E_SWITCH);
    expect(remoteDebuggingRefusal({ isPackaged: true, hasSwitch: (name) => name === CHATGPT_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBe(`${PACKAGED_DEBUG_REFUSAL} (${CHATGPT_E2E_SWITCH})`);
    expect(remoteDebuggingRefusal({ isPackaged: false, hasSwitch: (name) => name === CHATGPT_E2E_SWITCH, argv: ['/opt/frost/frost'] })).toBeNull();
  });

  test('chatgpt-e2e-browser (follows the one redirect to the loopback callback, on a gesture only)', async () => {
    const callbacks: string[] = [];
    const callback = await serve((request, response) => {
      callbacks.push(request.url ?? '');
      response.end('ok');
    });
    let redirectTo = `${callback}/auth/callback?code=c1&state=s1`;
    const fake = await serve((_request, response) => response.writeHead(302, { Location: redirectTo }).end());
    const authorize = `${fake}/api/accounts/authorize`;
    let visited: ((ok: boolean) => void) | null = null;
    const next = () => new Promise<boolean>((resolve) => (visited = resolve));
    const open = chatgptBrowserOpener(e2eBrowser({ onDone: (ok) => visited?.(ok) }), authorize);

    // No gesture, another page, the real authorize page: nothing is visited.
    expect(open(`${authorize}?state=s1`, false)).toBe(false);
    expect(open(`${fake}/elsewhere?state=s1`, true)).toBe(false);
    expect(open(`${CHATGPT_ENDPOINTS.authorize}?state=s1`, true)).toBe(false);
    expect(callbacks).toEqual([]);

    let done = next();
    expect(open(`${authorize}?state=s1`, true)).toBe(true);
    expect(await done).toBe(true);
    expect(callbacks).toEqual(['/auth/callback?code=c1&state=s1']);

    // A redirect anywhere but the loopback callback is not followed.
    for (const target of [`${callback}/elsewhere?code=c1`, `http://localhost:${new URL(callback).port}/auth/callback?code=c1`]) {
      redirectTo = target;
      done = next();
      expect(open(`${authorize}?state=s2`, true)).toBe(true);
      expect(await done).toBe(false);
    }
    expect(callbacks).toHaveLength(1);
    // Not a loopback URL at all: not visited.
    expect(e2eBrowser()('https://example.com/authorize?x=1', true)).toBe(false);
  });

  test('chatgpt-e2e-memory-store (validated like the real store, never on disk)', async () => {
    const store = createMemoryChatgptStore();
    expect(await store.protection()).toBe('os');
    expect(await store.read()).toBeNull();
    const state = { ...EMPTY_CHATGPT_STATE, clientId: 'oaiapp_e2e', acknowledged: true };
    expect(await store.write(state)).toBe(true);
    expect(await store.read()).toEqual(state);
    expect(await store.write({ ...state, clientId: 'dynamic_agent_client' })).toBe(false);
    expect(await store.read()).toEqual(state);
    expect(await store.clear()).toBe(true);
    expect(await store.read()).toBeNull();
  });

  test('chatgpt-e2e-proxy-destination (checked against the allowlist, sent to the fake)', async () => {
    const MODEL = 'chatgpt/gpt-5' as const;
    const listed: readonly ChatgptModelView[] = [{ id: MODEL, label: 'GPT-5' }];
    const body = JSON.stringify({
      model: 'gpt-5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
      store: false,
      stream: true,
      tools: [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE.name, description: CHATGPT_TOOL_NAMESPACE.description, tools: [{ type: 'function', name: 'page_text', description: 'Read', parameters: { type: 'object' }, strict: false }] }],
    });
    const run = async (chatgptResponsesUrl: string | undefined, url: string) => {
      const sent: MainToRuntimeMessage[] = [];
      let listener: ((event: AgentFetchEvent) => void) | null = null;
      const fetch = vi.fn<ProxyFetchFunction>(async () => new Response('data: {"type":"response.completed","response":{}}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const proxy = createModelProxy({
        host: { strike: vi.fn(), activeChats: () => ['chat-1'], onChat: () => () => undefined, send: (message) => (sent.push(message), true), onFetch: (l) => ((listener = l), () => undefined), onStatus: () => () => undefined },
        credentials: { withKey: async () => ({ ok: false, reason: 'no-key' }) },
        settings: { current: () => ({ route: 'chatgpt', modelId: MODEL }), load: async () => undefined, chatgptModels: () => listed },
        chatgpt: { withAccessToken: async (fn) => ({ ok: true, value: await fn('fake-access-token') }), report: vi.fn() },
        fetch,
        ...(chatgptResponsesUrl === undefined ? {} : { chatgptResponsesUrl }),
      });
      listener!({ type: 'fetch.request', requestId: 'r1', url, method: 'POST', headers: [['content-type', 'application/json']], body });
      await vi.waitFor(() => expect(sent.some((m) => m.type === 'fetch.end' || m.type === 'fetch.error')).toBe(true));
      proxy.dispose();
      return { fetch, sent };
    };
    const real = MODEL_REQUESTS.chatgpt[0]!.url;
    // Under the seam: the runtime's request for the real URL is sent to the fake.
    const seam = await run(ENDPOINTS.responses, real);
    expect(seam.fetch.mock.calls.map(([url]) => url)).toEqual([ENDPOINTS.responses]);
    // The runtime can't name the fake itself: refused before anything is sent.
    const named = await run(ENDPOINTS.responses, ENDPOINTS.responses);
    expect(named.fetch).not.toHaveBeenCalled();
    expect(named.sent.find((m) => m.type === 'fetch.error')).toMatchObject({ code: 'refused' });
    // Without the seam: the real URL.
    const plain = await run(undefined, real);
    expect(plain.fetch.mock.calls.map(([url]) => url)).toEqual([CHATGPT_ENDPOINTS.responses]);
  });
});
