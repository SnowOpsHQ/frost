// Spec: packages/ai-skills/src/ports.ts (SerpPort, IntentPort, GscPort, PortAnswer, unavailablePort)
// Acceptance: specs/agent-protocol.feature.md (Tool definitions and ports)
import { describe, expect, test } from 'vitest';
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

  test('unavailable-port', async () => {
    const port = unavailablePort('not connected yet');
    const ports: { serp: SerpPort; intent: IntentPort; gsc: GscPort } = { serp: port, intent: port, gsc: port };
    const expected: PortAnswer<never> = { status: 'unavailable', reason: 'not connected yet' };
    expect(await ports.serp.results({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.serp.aiSearch({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.intent.classify({ query: 'q' })).toStrictEqual(expected);
    expect(await ports.gsc.performance({ url: 'https://example.com/', days: 28 })).toStrictEqual(expected);
    expect(unavailable('why')).toStrictEqual({ status: 'unavailable', reason: 'why' });
  });
});
