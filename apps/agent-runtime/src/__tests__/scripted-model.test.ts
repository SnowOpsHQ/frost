// Spec: specs/agent-e2e-script.schema.ts (AgentE2eScriptSchema, AGENT_E2E_SCRIPT_END_TEXT) ·
// specs/agent-session.spec.ts (AGENT_E2E_SCRIPT_ENV, AGENT_E2E_SCRIPT_MAX_CHARS)
// Acceptance: specs/agent-session.feature.md (E2e seam)
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AGENT_E2E_SCRIPT_END_TEXT, AgentE2eScriptSchema, parseAgentE2eScript, type AgentE2eScript } from '@app/specs/agent-e2e-script.schema';
import { AGENT_E2E_SCRIPT_ENV, AGENT_E2E_SCRIPT_MAX_CHARS } from '@app/specs/agent-session.spec';
import { createScriptedModelFactory, scriptedModelFactoryFromEnv } from '../scripted-model';
import { chatStart, startHarness, stubNetworkGlobals } from './harness';

const SCRIPT: AgentE2eScript = AgentE2eScriptSchema.parse({
  steps: [
    { text: ['Reading ', 'the page.'], toolCalls: [{ toolName: 'page_text', input: { maxChars: 500 } }], usage: { input: 1200, output: 30 } },
    { text: ['It sells tea.'] },
    { toolCalls: [{ toolName: 'navigate', input: { url: 'https://example.com/next' } }] },
    { text: ['Opened it.'], usage: { input: 2000, output: 12 } },
  ],
});

const ok = { ok: true as const, output: { untrusted: true as const, source: 'page_text https://example.com/', data: { text: 'Tea' } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scripted model', () => {
  test('scripted-model-plays-steps-across-turns', async () => {
    stubNetworkGlobals();
    const h = startHarness({ modelFactory: createScriptedModelFactory(SCRIPT) });
    h.onMessage((message) => {
      if (message.type === 'tool.invoke') h.send({ type: 'tool.result', chatId: message.chatId, callId: message.callId, result: ok });
    });
    h.send(chatStart());
    const first = await h.next('chat.finish');
    expect(first).toMatchObject({ finishReason: 'stop', steps: 2, usage: { input: 1300, output: 40 } });
    expect(
      h
        .of('chat.delta')
        .map((delta) => delta.text)
        .join(''),
    ).toBe('Reading the page.It sells tea.');
    expect(h.of('tool.invoke').map((invoke) => [invoke.callId, invoke.toolName, invoke.input])).toEqual([['e2e-call-1', 'page_text', { maxChars: 500 }]]);
    expect(h.of('chat.step').map((step) => step.usage)).toEqual([
      { input: 1200, output: 30 },
      { input: 100, output: 10 },
    ]);

    // The next turn goes on from the next step (one cursor per runtime).
    h.send(chatStart({ allowedTools: ['navigate'], messages: [{ role: 'user', content: 'Open the next page.' }] }));
    await h.next('chat.finish', (message) => message !== first);
    expect(h.of('tool.invoke').at(-1)).toMatchObject({ callId: 'e2e-call-2', toolName: 'navigate', input: { url: 'https://example.com/next' } });

    // Past the end: a fixed reply.
    h.send(chatStart({ messages: [{ role: 'user', content: 'More?' }] }));
    await vi.waitFor(() => expect(h.of('chat.finish').length).toBe(3));
    expect(h.of('chat.step').at(-1)?.text).toBe(AGENT_E2E_SCRIPT_END_TEXT);
    // No model request was made at all.
    expect(h.of('fetch.request')).toEqual([]);
  });

  test('scripted-model-from-env', async () => {
    expect(scriptedModelFactoryFromEnv({})).toBeNull();
    const valid = scriptedModelFactoryFromEnv({ [AGENT_E2E_SCRIPT_ENV]: JSON.stringify({ steps: [{ text: ['Hi'] }] }) });
    expect(valid).not.toBeNull();
    const h = startHarness({ modelFactory: valid! });
    h.send(chatStart());
    await h.next('chat.finish');
    expect(h.of('chat.delta').map((delta) => delta.text)).toEqual(['Hi']);

    // A variable that isn't a script fails every turn (never falls back to a provider).
    for (const bad of ['', 'not json', '{"steps":[]}', JSON.stringify({ steps: [{ text: ['x'] }], extra: 1 }), JSON.stringify({ steps: [{ toolCalls: [{ toolName: 'shell', input: {} }] }] })]) {
      const failing = scriptedModelFactoryFromEnv({ [AGENT_E2E_SCRIPT_ENV]: bad });
      expect(failing, bad).not.toBeNull();
      const run = startHarness({ modelFactory: failing! });
      run.send(chatStart());
      await run.next('chat.error');
      expect(run.of('fetch.request')).toEqual([]);
    }
  });

  test('scripted-script-bounded', () => {
    expect(parseAgentE2eScript(JSON.stringify(SCRIPT))).toEqual(SCRIPT);
    expect(parseAgentE2eScript(`{"steps":[{"text":["${'x'.repeat(AGENT_E2E_SCRIPT_MAX_CHARS)}"]}]}`)).toBeNull();
    expect(parseAgentE2eScript({ steps: [] })).toBeNull();
    expect(parseAgentE2eScript('{"steps":[{}]}')).toBeNull();
    expect(parseAgentE2eScript('{"steps":[{"text":[""]}]}')).toBeNull();
    expect(parseAgentE2eScript('{"steps":[{"toolCalls":[{"toolName":"page_text","input":{"__proto__":{}}}]}]}')).toBeNull();
  });
});
