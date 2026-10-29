// Fakes of the read-only ports (`ports.ts`) for tests (Phase 5 Task 1; acceptance
// `specs/agent-protocol.feature.md`, ports-fakes-satisfy-interfaces and ports-honour-abort). Each
// answers canned data (or the answer it is given) on a later task, records the queries it received,
// and rejects with the signal's reason if its signal is aborted first. Exported as
// `@app/ai-skills/fakes`.
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
  PortQueryOptions,
  ProbeReport,
  ProbesPort,
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

/** `answer` on a later task, unless `signal` aborts first (then its reason). */
function answerUnlessAborted<T>(answer: T, options: PortQueryOptions | undefined): Promise<T> {
  const signal = options?.signal;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    }, 0);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type FakeSerpPort = SerpPort & { readonly calls: ({ method: 'results'; query: SerpQuery } | { method: 'aiSearch'; query: AiSearchQuery })[] };

/** A `SerpPort` answering `results` / `aiSearch` (canned data by default). */
export function createFakeSerpPort(options: { results?: PortAnswer<SerpResults>; aiSearch?: PortAnswer<AiSearchAnswer> } = {}): FakeSerpPort {
  const calls: FakeSerpPort['calls'] = [];
  return {
    calls,
    results(query, queryOptions) {
      calls.push({ method: 'results', query });
      return answerUnlessAborted(options.results ?? ok({ ...FAKE_SERP_RESULTS, query: query.query, locale: query.locale ?? null, device: query.device ?? 'desktop' }), queryOptions);
    },
    aiSearch(query, queryOptions) {
      calls.push({ method: 'aiSearch', query });
      return answerUnlessAborted(options.aiSearch ?? ok({ ...FAKE_AI_SEARCH_ANSWER, query: query.query }), queryOptions);
    },
  };
}

export type FakeIntentPort = IntentPort & { readonly calls: IntentQuery[] };

/** An `IntentPort` answering `answer` (canned data by default). */
export function createFakeIntentPort(options: { answer?: PortAnswer<IntentClassification> } = {}): FakeIntentPort {
  const calls: IntentQuery[] = [];
  return {
    calls,
    classify(query, queryOptions) {
      calls.push(query);
      return answerUnlessAborted(options.answer ?? ok({ ...FAKE_INTENT, query: query.query }), queryOptions);
    },
  };
}

export type FakeGscPort = GscPort & { readonly calls: GscPerformanceQuery[] };

/** A `GscPort` answering `answer` (canned data by default). */
export function createFakeGscPort(options: { answer?: PortAnswer<GscPerformance> } = {}): FakeGscPort {
  const calls: GscPerformanceQuery[] = [];
  return {
    calls,
    performance(query, queryOptions) {
      calls.push(query);
      return answerUnlessAborted(options.answer ?? ok({ ...FAKE_GSC_PERFORMANCE, url: query.url, days: query.days }), queryOptions);
    },
  };
}

export const FAKE_PROBE_REPORT: ProbeReport = {
  url: 'https://example.com/',
  status: 'done',
  startedAt: FETCHED_AT,
  finishedAt: FETCHED_AT,
  agents: [
    { agent: 'browser', kind: 'browser', outcome: 'ok', status: 200, redirects: 0, finalUrl: 'https://example.com/', robots: 'allowed', noindex: false, nofollow: false, canonical: 'https://example.com/', wordCount: 420, title: 'Example', differsIn: [], textSimilarity: null },
    { agent: 'crawler', kind: 'search', outcome: 'ok', status: 200, redirects: 0, finalUrl: 'https://example.com/', robots: 'allowed', noindex: true, nofollow: false, canonical: 'https://example.com/', wordCount: 410, title: 'Example', differsIn: ['noindex'], textSimilarity: 0.97 },
  ],
};

export type FakeProbesPort = ProbesPort & { readonly calls: { method: 'latest' | 'run'; tabId: number }[] };

/** A `ProbesPort` answering `latest` / `run` (canned data by default: a finished run; `run` starts). */
export function createFakeProbesPort(options: { latest?: PortAnswer<ProbeReport>; run?: PortAnswer<{ started: boolean }> } = {}): FakeProbesPort {
  const calls: FakeProbesPort['calls'] = [];
  return {
    calls,
    latest(tabId, queryOptions) {
      calls.push({ method: 'latest', tabId });
      return answerUnlessAborted(options.latest ?? ok(FAKE_PROBE_REPORT), queryOptions);
    },
    run(tabId, queryOptions) {
      calls.push({ method: 'run', tabId });
      return answerUnlessAborted(options.run ?? ok({ started: true }), queryOptions);
    },
  };
}
