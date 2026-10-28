// Fakes of the read-only ports (`ports.ts`) for tests (Phase 5 Task 1; acceptance
// `specs/agent-protocol.feature.md`, ports-fakes-satisfy-interfaces). Each answers canned data (or
// the answer it is given) and records the queries it received. Exported as `@app/ai-skills/fakes`.
import type {
  AiSearchAnswer,
  AiSearchQuery,
  GscPerformance,
  GscPerformanceQuery,
  GscPort,
  IntentClassification,
  IntentPort,
  IntentQuery,
  PortAnswer,
  SerpPort,
  SerpQuery,
  SerpResults,
} from './ports';

const FETCHED_AT = '2026-01-01T00:00:00.000Z';

export const FAKE_SERP_RESULTS: SerpResults = {
  query: 'running shoes',
  locale: 'en-US',
  device: 'desktop',
  fetchedAt: FETCHED_AT,
  results: [
    { position: 1, url: 'https://shoes.example/running', title: 'Running shoes for every pace', snippet: 'Road, trail and race shoes, fitted in store.' },
    { position: 2, url: 'https://reviews.example/best-running-shoes', title: 'The best running shoes, tested', snippet: 'We ran 500 miles in 40 pairs.' },
  ],
  features: ['questions'],
};

export const FAKE_AI_SEARCH_ANSWER: AiSearchAnswer = {
  query: 'running shoes',
  answer: 'Choose by surface and gait; a fitting helps.',
  citations: [{ url: 'https://reviews.example/best-running-shoes', title: 'The best running shoes, tested' }],
  fetchedAt: FETCHED_AT,
};

export const FAKE_INTENT: IntentClassification = {
  query: 'buy running shoes',
  primary: 'transactional',
  intents: [
    { intent: 'transactional', confidence: 0.8 },
    { intent: 'commercial', confidence: 0.15 },
    { intent: 'informational', confidence: 0.05 },
  ],
};

export const FAKE_GSC_PERFORMANCE: GscPerformance = {
  url: 'https://example.com/',
  days: 28,
  clicks: 120,
  impressions: 4000,
  ctr: 0.03,
  position: 8.4,
  queries: [{ query: 'example', clicks: 90, impressions: 1000, ctr: 0.09, position: 2.1 }],
};

const ok = <T>(data: T): PortAnswer<T> => ({ status: 'ok', data });

export type FakeSerpPort = SerpPort & { readonly calls: ({ method: 'results'; query: SerpQuery } | { method: 'aiSearch'; query: AiSearchQuery })[] };

/** A `SerpPort` answering `results` / `aiSearch` (canned data by default). */
export function createFakeSerpPort(options: { results?: PortAnswer<SerpResults>; aiSearch?: PortAnswer<AiSearchAnswer> } = {}): FakeSerpPort {
  const calls: FakeSerpPort['calls'] = [];
  return {
    calls,
    async results(query) {
      calls.push({ method: 'results', query });
      return options.results ?? ok({ ...FAKE_SERP_RESULTS, query: query.query, locale: query.locale ?? null, device: query.device ?? 'desktop' });
    },
    async aiSearch(query) {
      calls.push({ method: 'aiSearch', query });
      return options.aiSearch ?? ok({ ...FAKE_AI_SEARCH_ANSWER, query: query.query });
    },
  };
}

export type FakeIntentPort = IntentPort & { readonly calls: IntentQuery[] };

/** An `IntentPort` answering `answer` (canned data by default). */
export function createFakeIntentPort(options: { answer?: PortAnswer<IntentClassification> } = {}): FakeIntentPort {
  const calls: IntentQuery[] = [];
  return {
    calls,
    async classify(query) {
      calls.push(query);
      return options.answer ?? ok({ ...FAKE_INTENT, query: query.query });
    },
  };
}

export type FakeGscPort = GscPort & { readonly calls: GscPerformanceQuery[] };

/** A `GscPort` answering `answer` (canned data by default). */
export function createFakeGscPort(options: { answer?: PortAnswer<GscPerformance> } = {}): FakeGscPort {
  const calls: GscPerformanceQuery[] = [];
  return {
    calls,
    async performance(query) {
      calls.push(query);
      return options.answer ?? ok({ ...FAKE_GSC_PERFORMANCE, url: query.url, days: query.days });
    },
  };
}
