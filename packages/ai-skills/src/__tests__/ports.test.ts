// Spec: packages/ai-skills/src/ports.ts (SerpPort, IntentPort, GscPort, PortAnswer, PortQueryOptions,
// unavailablePort), specs/agent-protocol.schema.ts (AGENT_PROTOCOL_LIMITS.maxErrorChars)
// Acceptance: specs/agent-protocol.feature.md (Tool definitions and ports)
import { describe, expect, test } from 'vitest';
import { AGENT_PROTOCOL_LIMITS } from '@app/specs/agent-protocol.schema';
import { createFakeGscPort, createFakeIntentPort, createFakeSerpPort } from '../fakes';
import { unavailable, unavailablePort, type GscPort, type IntentPort, type PortAnswer, type SerpPort } from '../index';

describe('ports', () => {
  test('ports-fakes-satisfy-interfaces', async () => {
    const serp = createFakeSerpPort();
    const intent = createFakeIntentPort();
    const gsc = createFakeGscPort();
    // Assignable to the interfaces (checked by the type checker).
    const ports: { serp: SerpPort; intent: IntentPort; gsc: GscPort } = { serp, intent, gsc };

    const results = await ports.serp.results({ query: 'running shoes', locale: 'en-US' });
    expect(results.status).toBe('ok');
    if (results.status === 'ok') expect(results.data.results.length).toBeGreaterThan(0);
    const answer = await ports.serp.aiSearch({ query: 'running shoes' });
    expect(answer.status).toBe('ok');
    const classified = await ports.intent.classify({ query: 'buy running shoes' });
    expect(classified.status).toBe('ok');
    if (classified.status === 'ok') expect(classified.data.primary).toBe('transactional');
    const performance = await ports.gsc.performance({ url: 'https://example.com/', days: 28 });
    expect(performance.status).toBe('ok');
    if (performance.status === 'ok') expect(performance.data.days).toBe(28);

    expect(serp.calls).toStrictEqual([
      { method: 'results', query: { query: 'running shoes', locale: 'en-US' } },
      { method: 'aiSearch', query: { query: 'running shoes' } },
    ]);
    expect(intent.calls).toStrictEqual([{ query: 'buy running shoes' }]);
    expect(gsc.calls).toStrictEqual([{ url: 'https://example.com/', days: 28 }]);

    // A fake can be told to answer `unavailable`.
    const offline = createFakeGscPort({ answer: unavailable('site owner data is not connected') });
    expect(await offline.performance({ url: 'https://example.com/', days: 7 })).toStrictEqual({ status: 'unavailable', reason: 'site owner data is not connected' });
  });

  test('ports-honour-abort', async () => {
    const serp = createFakeSerpPort();
    const intent = createFakeIntentPort();
    const gsc = createFakeGscPort();
    const reason = new Error('stopped');

    const done = new AbortController();
    done.abort(reason);
    await expect(serp.results({ query: 'q' }, { signal: done.signal })).rejects.toBe(reason);
    await expect(serp.aiSearch({ query: 'q' }, { signal: done.signal })).rejects.toBe(reason);
    await expect(intent.classify({ query: 'q' }, { signal: done.signal })).rejects.toBe(reason);
    await expect(gsc.performance({ url: 'https://example.com/', days: 1 }, { signal: done.signal })).rejects.toBe(reason);

    const later = new AbortController();
    const pending = [
      serp.results({ query: 'q' }, { signal: later.signal }),
      serp.aiSearch({ query: 'q' }, { signal: later.signal }),
      intent.classify({ query: 'q' }, { signal: later.signal }),
      gsc.performance({ url: 'https://example.com/', days: 1 }, { signal: later.signal }),
    ];
    later.abort(reason);
    for (const answer of pending) await expect(answer).rejects.toBe(reason);

    // An unaborted signal changes nothing.
    expect((await serp.results({ query: 'q' }, { signal: new AbortController().signal })).status).toBe('ok');
  });

  test('unavailable-port', async () => {
    const port = unavailablePort('not connected yet');
    const ports: { serp: SerpPort; intent: IntentPort; gsc: GscPort } = { serp: port, intent: port, gsc: port };
    const expected: PortAnswer<never> = { status: 'unavailable', reason: 'not connected yet' };
    expect(await ports.serp.results({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.serp.aiSearch({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.intent.classify({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.gsc.performance({ url: 'https://example.com/', days: 28 })).toStrictEqual(expected);
    expect(unavailable('why')).toStrictEqual({ status: 'unavailable', reason: 'why' });
    expect(await port.results({ query: 'q' }, { signal: new AbortController().signal })).toStrictEqual(expected);

    // The reason is cut to the tool error cap, never splitting a surrogate pair.
    const max = AGENT_PROTOCOL_LIMITS.maxErrorChars;
    const long = unavailable('x'.repeat(max + 10));
    expect(long.status === 'unavailable' && long.reason.length).toBe(max);
    const astral = unavailable(`${'x'.repeat(max - 1)}\u{1F600}tail`);
    expect(astral.status === 'unavailable' && astral.reason).toBe('x'.repeat(max - 1));
    const fromPort = await unavailablePort('y'.repeat(max * 2)).classify({ query: 'q' });
    expect(fromPort.status === 'unavailable' && fromPort.reason.length).toBe(max);
  });
});
