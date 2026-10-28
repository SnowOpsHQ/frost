// Spec: specs/agent-protocol.schema.ts (ready, AGENT_PROTOCOL_VERSION) · Acceptance:
// specs/agent-runtime.feature.md (Runtime)
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '@app/specs/agent-protocol.schema';
import type { ModelFactory } from '../provider';
import { chatStart, startHarness, textStep, toolStep } from './harness';

describe('runtime', () => {
  test('runtime-ready', async () => {
    const h = startHarness();
    expect(await h.next('ready')).toEqual({ type: 'ready', protocolVersion: AGENT_PROTOCOL_VERSION });
    expect(h.received.length).toBe(1);
  });

  test('runtime-one-turn-per-chat', async () => {
    const models: MockLanguageModelV4[] = [];
    const factory: ModelFactory = () => {
      const model = new MockLanguageModelV4({ doStream: [toolStep('call-1', 'page_audit', {}), textStep(['done'])] });
      models.push(model);
      return model;
    };
    const h = startHarness({ modelFactory: factory });
    h.send(chatStart());
    await h.next('tool.invoke');
    h.send(chatStart());
    // Another chat runs beside it.
    h.send(chatStart({ chatId: 'chat-2' }));
    await h.next('tool.invoke', (message) => message.chatId === 'chat-2');
    expect(h.runtime.stats.startsDropped).toBe(1);
    expect(models.length).toBe(2);
    expect([...h.runtime.activeChats].sort()).toEqual(['chat-1', 'chat-2']);

    h.send({ type: 'tool.result', chatId: 'chat-1', callId: 'call-1', result: { ok: false, error: { code: 'unavailable', message: 'no audit yet' } } });
    await h.next('chat.finish', (message) => message.chatId === 'chat-1');
    expect(h.runtime.activeChats).toEqual(['chat-2']);
    // A result for one chat never reaches another's call.
    expect(h.of('chat.finish').filter((message) => message.chatId === 'chat-2')).toEqual([]);
    // Once a turn ended, the chat id can start the next one.
    h.send(chatStart({ messages: [{ role: 'user', content: 'Again.' }] }));
    await h.next('tool.invoke', (message) => message.chatId === 'chat-1' && models.length === 3);
  });

  test('runtime-model-factory', async () => {
    const factory = vi.fn<ModelFactory>(() => new MockLanguageModelV4({ doStream: [textStep(['hi'])] }));
    const h = startHarness({ modelFactory: factory });
    h.send(chatStart({ route: 'gateway', modelId: 'openai/gpt-5-mini' }));
    await h.next('chat.finish');
    expect(factory).toHaveBeenCalledOnce();
    const [route, modelId, fetch] = factory.mock.calls[0]!;
    expect(route).toBe('gateway');
    expect(modelId).toBe('openai/gpt-5-mini');
    expect(typeof fetch).toBe('function');
  });

  test('runtime-model-factory (a factory that throws)', async () => {
    const h = startHarness({
      modelFactory: () => {
        throw new Error('no such model: secret detail');
      },
    });
    h.send(chatStart());
    const error = await h.next('chat.error');
    expect(error).toEqual({ type: 'chat.error', chatId: 'chat-1', message: 'The chat failed.' });
    expect(h.runtime.activeChats).toEqual([]);
  });

  test('runtime-model-factory (the default refuses a model off its route)', async () => {
    const h = startHarness();
    h.send(chatStart({ route: 'byok-openai', modelId: 'anthropic/claude-sonnet-5-5' }));
    const error = await h.next('chat.error');
    expect(error.message).toBe('This model is not available on the selected route.');
  });
});
