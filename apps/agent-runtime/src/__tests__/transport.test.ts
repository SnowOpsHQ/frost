// Spec: specs/agent-protocol.schema.ts · Acceptance: specs/agent-runtime.feature.md (Transport)
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { bindParentPort, createChannel, createMemoryPortPair, type MessagePortMainLike, type ParentPortLike } from '../transport';
import { chatStart, settle, startHarness } from './harness';

describe('transport', () => {
  test('invalid-inbound-dropped', async () => {
    const h = startHarness({ modelFactory: () => { throw new Error('no chat should start'); } });
    await h.next('ready');
    const invalid: unknown[] = [
      null,
      'chat.start',
      42,
      { type: 'approval.answer', approved: true },
      { type: 'chat.delta', chatId: 'chat-1', text: 'from the wrong side' },
      { ...chatStart(), extra: true },
      { type: 'chat.stop', chatId: 'has a space' },
      { type: 'tool.result', chatId: 'chat-1', callId: 'c', result: { ok: true, output: { source: 'x', data: 1 } } },
    ];
    for (const message of invalid) expect(() => h.send(message)).not.toThrow();
    await settle();
    expect(h.runtime.stats.inboundDropped).toBe(invalid.length);
    // Only `ready`: nothing echoed, no chat started, no error reported.
    expect(h.received.map((message) => message.type)).toEqual(['ready']);
  });

  test('outbound-validated', async () => {
    const [main, runtime] = createMemoryPortPair();
    const seen: unknown[] = [];
    main.onMessage((data) => seen.push(data));
    const channel = createChannel(runtime);
    expect(channel.send({ type: 'chat.delta', chatId: 'chat-1', text: '' })).toBe(false);
    expect(channel.send({ type: 'tool.invoke', chatId: 'chat-1', callId: 'c1', toolName: 'shell', input: {} } as never)).toBe(false);
    expect(channel.send({ type: 'chat.delta', chatId: 'chat-1', text: 'ok' })).toBe(true);
    await settle();
    expect(seen).toEqual([{ type: 'chat.delta', chatId: 'chat-1', text: 'ok' }]);
    expect(channel.stats.outboundDropped).toBe(2);
  });

  test('parent-port-binding', async () => {
    const parent = new EventEmitter();
    const port = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() });
    const bound = bindParentPort(parent as unknown as ParentPortLike);
    // A message without a port is not the transfer.
    parent.emit('message', { data: 'hello', ports: [] });
    parent.emit('message', { data: null, ports: [port as unknown as MessagePortMainLike] });
    const runtimePort = await bound;
    expect(parent.listenerCount('message')).toBe(0);

    const inbound: unknown[] = [];
    runtimePort.onMessage((data) => inbound.push(data));
    runtimePort.start();
    expect(port.start).toHaveBeenCalledOnce();
    port.emit('message', { data: { type: 'chat.stop', chatId: 'chat-1' } });
    expect(inbound).toEqual([{ type: 'chat.stop', chatId: 'chat-1' }]);
    runtimePort.post({ type: 'ready', protocolVersion: 1 });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', protocolVersion: 1 });
    const closed = vi.fn();
    runtimePort.onClose?.(closed);
    port.emit('close');
    expect(closed).toHaveBeenCalledOnce();
  });

  test('parent-port-binding (outside a utility process)', async () => {
    await expect(bindParentPort(undefined)).rejects.toThrow(/utility process/);
  });
});
