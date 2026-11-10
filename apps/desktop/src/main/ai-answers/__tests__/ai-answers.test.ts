// Spec: specs/ai-answers.spec.ts (AI_ANSWERS_RUN_REFUSALS, AI_ANSWERS_RUN_REFUSAL_TEXT, aiAnswersRunRefusalOf,
// AI_SEARCH_SETTING_RESULTS, AI_ANSWERS_LIMITS), specs/ai-answers.schema.ts (AiAnswersViewSchema, AiAnswersRunAnswerSchema,
// AiAnswerRecordSchema), specs/ai-search.spec.ts (AI_SEARCH_LIMITS, AI_SEARCH_ENGINE_LABELS, resolveAiSearch),
// specs/data-sources.spec.ts (AI_SEARCH_PROVIDER_AVAILABLE, LEGAL_GATE_NOTE)
// Acceptance: specs/ai-answers.feature.md (Main) · plan docs/plans/phase-12-big-bets.md Decision 9, Task 9
// (`ai-answers-stored-from-agent-and-view`, `ai-answers-view-runs-without-approval-card`), the lead's L5 gate
// ("As built": `ai-answers-gated-off-run-refuses`)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { openSessionStore, type SessionStore } from '@app/db';
import { AI_ANSWER_PURGE_INTERVAL_MS, AI_ANSWERS_RUN_REFUSAL_TEXT } from '@app/specs/ai-answers.spec';
import { AiAnswerRecordSchema, AiAnswersRunAnswerSchema, AiAnswersViewSchema } from '@app/specs/ai-answers.schema';
import { AI_SEARCH_LIMITS } from '@app/specs/ai-search.spec';
import { AI_SEARCH_PROVIDER_AVAILABLE, LEGAL_GATE_NOTE, type LegalGateId } from '@app/specs/data-sources.spec';
import { createLegalGates } from '../../data-sources/gates';
import { runAiAnswerJob } from '../../ai-search/parse';
import { createAiSearchService } from '../../ai-search/service';
import { createAiAnswersMain } from '../service';

const PERPLEXITY_ANSWER = {
  id: 'frost-fixture-pplx-9',
  model: 'sonar',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Brew <b>green</b> tea at 80 °C; **never** boiling [1].' } }],
  citations: ['https://tea.example/brewing', 'https://shop.tea.example/kettles', 'https://leaf.example.org/guide'],
  search_results: [
    { title: 'Brewing green tea', url: 'https://tea.example/brewing' },
    { title: 'Kettles', url: 'https://shop.tea.example/kettles' },
  ],
};
const OPENAI_ANSWER = {
  id: 'resp_frost_fixture_9',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'Cool water, short steep.', annotations: [{ type: 'url_citation', url: 'https://leaf.example.org/guide', title: 'Leaf guide' }] }] }],
};

const dirs: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function openStore(): SessionStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'frost-ai-answers-'));
  dirs.push(dir);
  const store = openSessionStore({ dir });
  stores.push(store);
  return store;
}

/** Task 8's real service over a fake client and the in-process parse; gates by injection (default: open). */
function harness(options: { open?: (id: LegalGateId) => boolean; keys?: { perplexity?: boolean; 'openai-search'?: boolean }; store?: SessionStore; hold?: Promise<void>; timers?: boolean } = {}) {
  const store = options.store ?? openStore();
  let clock = Date.UTC(2026, 10, 10, 12);
  const sent: string[] = [];
  const client = {
    dataApiRequest: vi.fn(async (provider: string) => {
      sent.push(provider);
      await options.hold;
      return { ok: true as const, status: 200, body: JSON.stringify(provider === 'perplexity' ? PERPLEXITY_ANSWER : OPENAI_ANSWER), url: 'https://provider.example/' };
    }),
  };
  const keys = vi.fn(async () => options.keys ?? { perplexity: true, 'openai-search': true });
  const aiSearch = createAiSearchService({
    client: client as never,
    isOpen: options.open ?? (() => true),
    keys,
    settings: store.settings,
    parse: async (job) => runAiAnswerJob(job),
    now: () => clock,
  });
  const main = createAiAnswersMain({ store: store.aiAnswers, aiSearch, now: () => clock, ...(options.timers ? {} : { setInterval: () => null, clearInterval: () => undefined }) });
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return { store, aiSearch, main, client, sent, keys, settle, tick: (ms: number) => (clock += ms), now: () => clock };
}

describe('the AI answers view, main side', () => {
  test('ai-answers-stored-from-agent-and-view', async () => {
    const { main, aiSearch, settle } = harness();
    // The agent's approved call (the port's `ask`, as the tool runs it after the card): stored once, through `onAnswer`.
    const agentAnswer = await aiSearch.ask({ query: 'brew green tea', engine: 'perplexity', via: 'api' });
    expect(agentAnswer.status).toBe('ok');
    await settle();
    // The view's own run.
    const viewAnswer = await main.run({ query: 'green tea water', engine: 'chatgpt' });
    expect(AiAnswersRunAnswerSchema.parse(viewAnswer)).toEqual(viewAnswer);
    expect(viewAnswer).toMatchObject({ status: 'ok', answer: { query: 'green tea water', engine: 'chatgpt', via: 'api', provider: 'openai-search', origin: 'view', id: expect.any(Number) } });

    // Both appear, newest first, with their sources and cited (registrable) domains.
    const list = await main.list({ limit: 10 });
    expect(list.total).toBe(2);
    expect(list.rows.map((row) => [row.query, row.origin, row.engine])).toEqual([
      ['green tea water', 'view', 'chatgpt'],
      ['brew green tea', 'agent', 'perplexity'],
    ]);
    const agentRecord = await main.get(list.rows[1]!.id);
    expect(AiAnswerRecordSchema.parse(agentRecord)).toEqual(agentRecord);
    expect(agentRecord).toMatchObject({
      origin: 'agent',
      chatId: null,
      citations: [
        { url: 'https://tea.example/brewing', title: 'Brewing green tea' },
        { url: 'https://shop.tea.example/kettles', title: 'Kettles' },
        { url: 'https://leaf.example.org/guide', title: '' },
      ],
      // shop.tea.example and tea.example are one registrable domain.
      citedDomains: ['tea.example', 'example.org'],
    });
    // The answer is kept as the worker made it (inert text; the view never renders markup).
    expect(agentRecord!.answer).toContain('<b>green</b>');
    expect((await main.get(list.rows[0]!.id))!.citedDomains).toEqual(['example.org']);

    // Delete one, then Delete all empties the table.
    expect(await main.delete(list.rows[0]!.id)).toBe(true);
    expect((await main.list({ limit: 10 })).total).toBe(1);
    expect(await main.deleteAll()).toBe(true);
    expect(await main.list({ limit: 10 })).toEqual({ rows: [], more: false, total: 0 });
  });

  test('ai-answers-view-runs-without-approval-card', async () => {
    const { main, aiSearch, sent } = harness();
    const told = vi.fn();
    aiSearch.onAnswer(told);
    // No engine named: the default, else the first usable (Task 8's rule) — sent at once, no broker, no card.
    const answer = await main.run({ query: 'oolong' });
    expect(sent).toEqual(['perplexity']);
    expect(answer).toMatchObject({ status: 'ok', answer: { engine: 'perplexity', via: 'api', answer: expect.stringContaining('80 °C') } });
    // Stored once: the view's run is not told to `onAnswer` (that hook is the agent's).
    expect(told).not.toHaveBeenCalled();
    expect((await main.list({ limit: 10 })).rows.map((row) => row.origin)).toEqual(['view']);
    // The default engine setting is honoured.
    expect(await main.setDefaultEngine('chatgpt')).toBe('ok');
    await main.run({ query: 'sencha' });
    expect(sent).toEqual(['perplexity', 'openai-search']);
  });

  test('ai-answers-gated-off-run-refuses', async () => {
    // The shipped constants: both AI search providers gated off.
    expect(AI_SEARCH_PROVIDER_AVAILABLE).toEqual({ perplexity: false, 'openai-search': false });
    const gates = createLegalGates({ packaged: true });
    const { main, client, keys, store } = harness({ open: (id) => gates.isOpen(id) });
    for (const input of [{ query: 'green tea' }, { query: 'green tea', engine: 'perplexity' as const }, { query: 'green tea', engine: 'chatgpt' as const }]) {
      expect(await main.run(input)).toEqual({ status: 'refused', reason: 'unavailable', note: LEGAL_GATE_NOTE });
    }
    // Nothing sent, no key looked up, nothing stored.
    expect(client.dataApiRequest).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    expect((await store.aiAnswers.list({ limit: 10 })).total).toBe(0);
    // The view says so: no engine available or usable.
    const view = AiAnswersViewSchema.parse(await main.view());
    expect(view.engines.map((engine) => [engine.engine, engine.available, engine.usable])).toEqual([
      ['perplexity', false, false],
      ['chatgpt', false, false],
      ['google-ai-mode', false, false],
    ]);
    // Setting a gated engine's via to api, or making it the default: unavailable. Off is never gated.
    expect(await main.setVia('perplexity', 'api')).toBe('unavailable');
    expect(await main.setDefaultEngine('chatgpt')).toBe('unavailable');
    expect(await main.setVia('perplexity', 'off')).toBe('ok');
  });

  test('ai-answers-run-bounded', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { main, sent, tick, settle } = harness({ hold });
    // One view run at a time.
    const first = main.run({ query: 'green tea', engine: 'perplexity' });
    await settle();
    expect(await main.run({ query: 'black tea', engine: 'chatgpt' })).toEqual({ status: 'refused', reason: 'busy', note: AI_ANSWERS_RUN_REFUSAL_TEXT.busy });
    release();
    expect((await first).status).toBe('ok');
    // The same engine within the cooldown: nothing sent.
    tick(AI_SEARCH_LIMITS.perEngineCooldownMs - 1);
    expect(await main.run({ query: 'white tea', engine: 'perplexity' })).toEqual({ status: 'refused', reason: 'cooldown', note: AI_ANSWERS_RUN_REFUSAL_TEXT.cooldown });
    // Another engine is not held back; the first one is again once the cooldown passed.
    expect((await main.run({ query: 'white tea', engine: 'chatgpt' })).status).toBe('ok');
    tick(1);
    expect((await main.run({ query: 'white tea', engine: 'perplexity' })).status).toBe('ok');
    expect(sent).toEqual(['perplexity', 'openai-search', 'perplexity']);
    // One clock for both paths (lead ruling): the agent's approved call holds the view back on that engine, and the other way round.
    const shared = harness();
    expect((await shared.aiSearch.ask({ query: 'tea', engine: 'chatgpt', via: 'api' })).status).toBe('ok');
    expect(await shared.main.run({ query: 'tea', engine: 'chatgpt' })).toMatchObject({ status: 'refused', reason: 'cooldown' });
    expect((await shared.main.run({ query: 'tea', engine: 'perplexity' })).status).toBe('ok');
    expect(await shared.aiSearch.ask({ query: 'tea', engine: 'perplexity', via: 'api' })).toMatchObject({ status: 'unavailable', state: 'cooldown' });
    expect(shared.sent).toEqual(['openai-search', 'perplexity']);
    // Given back when the client sent nothing (here: the setting changed while it waited).
    const cancelled = harness();
    cancelled.client.dataApiRequest.mockResolvedValueOnce({ ok: false, refusal: 'cancelled' } as never);
    expect(await cancelled.main.run({ query: 'tea', engine: 'perplexity' })).toMatchObject({ status: 'refused', reason: 'setting-changed' });
    expect((await cancelled.main.run({ query: 'tea', engine: 'perplexity' })).status).toBe('ok');
    // google-ai-mode has no API; an engine without a key is not set up; nothing sent, nothing stored.
    expect(await main.run({ query: 'tea', engine: 'google-ai-mode' })).toMatchObject({ status: 'refused', reason: 'no-api' });
    const noKey = harness({ keys: { perplexity: false, 'openai-search': false } });
    expect(await noKey.main.run({ query: 'tea' })).toMatchObject({ status: 'refused', reason: 'none-set-up' });
    expect(await noKey.main.run({ query: 'tea', engine: 'perplexity' })).toMatchObject({ status: 'refused', reason: 'engine-off' });
    expect(noKey.sent).toEqual([]);
    // A provider failure: a fixed message, nothing stored.
    const failing = harness();
    failing.client.dataApiRequest.mockResolvedValueOnce({ ok: false, refusal: 'http-error' } as never);
    expect(await failing.main.run({ query: 'tea', engine: 'perplexity' })).toEqual({ status: 'refused', reason: 'request-failed', note: AI_ANSWERS_RUN_REFUSAL_TEXT['request-failed'] });
    expect((await failing.main.list({ limit: 5 })).total).toBe(0);
  });

  test('ai-answers-retention-at-start-up', async () => {
    const store = openStore();
    const DAY = 86_400_000;
    const first = harness({ store });
    await first.main.run({ query: 'old tea', engine: 'perplexity' });
    // Forty days on, start-up purges what the default 30 days no longer keeps.
    const later = harness({ store });
    later.tick(40 * DAY);
    expect((await later.main.list({ limit: 5 })).total).toBe(1);
    await later.main.start();
    expect((await later.main.list({ limit: 5 })).total).toBe(0);
    // Retention off: an answer is shown but not kept.
    expect(await later.main.setRetention('off')).toBe(true);
    expect((await later.main.view()).retention).toBe('off');
    const answer = await later.main.run({ query: 'green tea', engine: 'perplexity' });
    expect(answer).toMatchObject({ status: 'ok', answer: { id: null, query: 'green tea' } });
    await later.aiSearch.ask({ query: 'agent tea', engine: 'chatgpt', via: 'api' });
    await later.settle();
    expect((await later.main.list({ limit: 5 })).total).toBe(0);
  });

  test('ai-answers-purged-daily', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const DAY = 86_400_000;
    const { main, store, tick } = harness({ timers: true });
    await main.run({ query: 'tea', engine: 'perplexity' });
    await main.start();
    expect((await store.aiAnswers.list({ limit: 5 })).total).toBe(1);
    // A day on, still within 30 days: kept. Thirty-one days on: the daily purge deletes it, with no write.
    tick(DAY);
    await vi.advanceTimersByTimeAsync(AI_ANSWER_PURGE_INTERVAL_MS);
    expect((await store.aiAnswers.list({ limit: 5 })).total).toBe(1);
    tick(30 * DAY);
    await vi.advanceTimersByTimeAsync(AI_ANSWER_PURGE_INTERVAL_MS);
    expect((await store.aiAnswers.list({ limit: 5 })).total).toBe(0);
    // Disposed (`will-quit`): the interval is cleared.
    expect(vi.getTimerCount()).toBe(1);
    main.dispose();
    expect(vi.getTimerCount()).toBe(0);
    // A second start never adds a second timer; a start after dispose adds none.
    await main.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ai-search-settings-setters', async () => {
    const { main, store } = harness({ open: (id) => id === 'perplexity' });
    expect(await main.setVia('perplexity', 'off')).toBe('ok');
    expect(await main.setVia('chatgpt', 'off')).toBe('ok');
    expect((await store.settings.aiSearchSettings()).via).toEqual({ perplexity: 'off', chatgpt: 'off', 'google-ai-mode': null });
    // Off: not usable; back to api: usable.
    let view = await main.view();
    expect(view.engines.find((engine) => engine.engine === 'perplexity')).toEqual({ engine: 'perplexity', provider: 'perplexity', available: true, hasKey: true, via: 'off', usable: false });
    expect(await main.setVia('perplexity', 'api')).toBe('ok');
    view = await main.view();
    expect(view.engines.find((engine) => engine.engine === 'perplexity')).toMatchObject({ via: 'api', usable: true });
    // chatgpt's provider is gated off here: api refused, the setting unchanged.
    expect(await main.setVia('chatgpt', 'api')).toBe('unavailable');
    expect((await store.settings.aiSearchSettings()).via.chatgpt).toBe('off');
    expect(view.engines.find((engine) => engine.engine === 'chatgpt')).toEqual({ engine: 'chatgpt', provider: 'openai-search', available: false, hasKey: false, via: 'off', usable: false });
    // google-ai-mode: no API.
    expect(await main.setVia('google-ai-mode', 'api')).toBe('no-api');
    expect(await main.setDefaultEngine('google-ai-mode')).toBe('no-api');
    expect(await main.setVia('google-ai-mode', 'off')).toBe('ok');
    // The default engine: set and cleared.
    expect(await main.setDefaultEngine('perplexity')).toBe('ok');
    expect((await main.view()).defaultEngine).toBe('perplexity');
    expect(await main.setDefaultEngine(null)).toBe('ok');
    expect((await main.view()).defaultEngine).toBeNull();
    // The retention.
    expect(await main.setRetention('7d')).toBe(true);
    expect((await main.view()).retention).toBe('7d');
  });
});
