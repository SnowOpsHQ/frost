import { SEARCH_INTENTS, type GscPort, type IntentPort, type PortAnswer, type SearchIntent, type SerpPort } from '@app/ai-skills';
import { GSC_NO_PAGE_REASON, GSC_NOT_PUBLIC_REASON, gscPageUrl, isGscReadablePage, SEARCH_TOOL_LIMITS as L, SEARCH_TOOL_SOURCES, SEARCH_TOOL_TIMEOUT_MS, type SearchToolName } from '@app/specs/agent-search-tools.spec';
import { AGENT_TOOL_INPUT_LIMITS, UNSAFE_INPUT_CHARS, type ToolErrorCode } from '@app/specs/agent-tools.spec';
import type { ToolRunContext, ToolRunOutcome } from '../approvals';

// The agent's search tools over the read-only data ports (Phase 5 Task 8; spec
// `specs/agent-search-tools.spec.ts`; acceptance `specs/agent-search-tools.feature.md`). The page
// tool runner (`runner.ts`) hands these tools here with input it re-parsed. Each asks its port with
// a signal that aborts when the chat stops or after `SEARCH_TOOL_TIMEOUT_MS`, and maps the answer:
// `ok` to bounded data, `unavailable` to data `{ unavailable: reason }` (the broker's errors carry
// fixed messages, so the reason travels as untrusted data the model can explain), anything else to
// a fixed error. No port changes anything; none sees a key or the page. Every answer's JSON text is
// trimmed to `SEARCH_TOOL_LIMITS.budgetChars` (list entries dropped from the end, then the AI
// answer's text cut), so the broker's cap never has to cut it blindly.
//
// `gsc_performance` reads only the `url` in its input: main's broker fills in the chat tab's page as
// the call arrives (`completeToolInput`), so the approval shows the page read. A call that still has
// none answers `GSC_NO_PAGE_REASON`; a page that isn't public answers `GSC_NOT_PUBLIC_REASON`; the
// port is asked for neither.

export interface SearchToolPorts {
  readonly serp?: SerpPort | null;
  readonly intent?: IntentPort | null;
  readonly gsc?: GscPort | null;
}

export interface SearchToolDeps {
  readonly ports?: SearchToolPorts;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** The parsed inputs (the tools' schemas in `@app/ai-skills`). */
export type SearchToolInput =
  | { readonly toolName: 'serp_results'; readonly input: { query: string; locale?: string | undefined; device?: 'desktop' | 'mobile' | undefined } }
  | { readonly toolName: 'run_ai_search'; readonly input: { query: string; locale?: string | undefined } }
  | { readonly toolName: 'search_intent'; readonly input: { query: string } }
  | { readonly toolName: 'gsc_performance'; readonly input: { url?: string | undefined; days?: number | undefined } };

const fail = (code: ToolErrorCode): ToolRunOutcome => ({ ok: false, code });
const UNSAFE_ALL = new RegExp(UNSAFE_INPUT_CHARS.source, 'gu');

/** `value` as one clean line cut at `max` (never between a surrogate pair); `null` for a non-string. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  let text = value.replace(UNSAFE_ALL, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    const last = text.charCodeAt(max - 1);
    text = text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
  }
  return text;
}

/** A finite number, or `null`. */
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** A finite number within `[min, max]`, or `null`. */
const within = (value: unknown, min: number, max: number): number | null => {
  const n = num(value);
  return n === null ? null : Math.min(max, Math.max(min, n));
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): readonly unknown[] | null => (Array.isArray(value) ? value : null);

/**
 * `data` with entries dropped from the end of its list `key` (its `<key>Total` stays) until its JSON
 * text fits `SEARCH_TOOL_LIMITS.budgetChars`; then, if `textKey` is given, that text cut (and
 * `<textKey>Truncated` set). Never longer than the budget unless the rest alone is.
 */
export function fitBudget<T extends Record<string, unknown>>(data: T, key: keyof T & string, textKey?: keyof T & string): T {
  const size = (value: unknown) => JSON.stringify(value).length;
  let current = data;
  const items = current[key];
  if (Array.isArray(items) && size(current) > L.budgetChars) {
    // Halve, then step: never more than a few dozen serialisations.
    let kept = items.length;
    while (kept > 0 && size({ ...current, [key]: items.slice(0, kept) }) > L.budgetChars) kept = kept > 8 ? Math.floor(kept / 2) : kept - 1;
    current = { ...current, [key]: items.slice(0, kept) };
  }
  if (textKey !== undefined && size(current) > L.budgetChars) {
    const text = current[textKey];
    if (typeof text === 'string') {
      let cut: string = text;
      for (let guard = 0; guard < 32 && cut.length > 0; guard += 1) {
        const over = size({ ...current, [textKey]: cut }) - L.budgetChars;
        if (over <= 0) break;
        cut = cleanText(cut, Math.max(0, cut.length - Math.max(over, 16)))!;
      }
      current = { ...current, [textKey]: cut, [`${textKey}Truncated`]: true };
    }
  }
  return current;
}

// ---- Mapping each port's data (`null`: not the port's shape) ----

function mapSerp(data: unknown) {
  if (!isRecord(data)) return null;
  const results = list(data.results);
  const features = list(data.features);
  if (results === null || features === null) return null;
  return fitBudget({
    query: cleanText(data.query, L.maxQueryChars),
    locale: cleanText(data.locale, L.maxShortChars),
    device: data.device === 'mobile' ? 'mobile' : 'desktop',
    fetchedAt: cleanText(data.fetchedAt, L.maxShortChars),
    results: results.slice(0, L.maxSerpResults).map((result, index) => {
      const item = isRecord(result) ? result : {};
      const position = num(item.position);
      return {
        position: position !== null && Number.isInteger(position) && position >= 1 ? position : index + 1,
        url: cleanText(item.url, L.maxUrlChars),
        title: cleanText(item.title, L.maxTitleChars),
        snippet: cleanText(item.snippet, L.maxSnippetChars),
      };
    }),
    resultsTotal: results.length,
    features: features.slice(0, L.maxSerpFeatures).flatMap((feature) => {
      const name = cleanText(feature, L.maxFeatureChars);
      return name === null || name === '' ? [] : [name];
    }),
    featuresTotal: features.length,
  }, 'results');
}

function mapAiSearch(data: unknown) {
  if (!isRecord(data) || typeof data.answer !== 'string') return null;
  const citations = list(data.citations);
  if (citations === null) return null;
  const answer = cleanText(data.answer, L.maxAnswerChars)!;
  return fitBudget({
    query: cleanText(data.query, L.maxQueryChars),
    answer,
    answerTruncated: answer.length < cleanText(data.answer, Number.MAX_SAFE_INTEGER)!.length,
    citations: citations.slice(0, L.maxCitations).map((citation) => {
      const item = isRecord(citation) ? citation : {};
      return { url: cleanText(item.url, L.maxUrlChars), title: cleanText(item.title, L.maxTitleChars) };
    }),
    citationsTotal: citations.length,
    fetchedAt: cleanText(data.fetchedAt, L.maxShortChars),
  }, 'citations', 'answer');
}

const isIntent = (value: unknown): value is SearchIntent => typeof value === 'string' && (SEARCH_INTENTS as readonly string[]).includes(value);

function mapIntent(data: unknown) {
  if (!isRecord(data) || !isIntent(data.primary)) return null;
  const intents = list(data.intents);
  if (intents === null) return null;
  const seen = new Set<string>();
  const kept: { intent: SearchIntent; confidence: number | null }[] = [];
  for (const entry of intents) {
    if (!isRecord(entry) || !isIntent(entry.intent) || seen.has(entry.intent)) continue;
    seen.add(entry.intent);
    kept.push({ intent: entry.intent, confidence: within(entry.confidence, 0, 1) });
    if (kept.length >= L.maxIntents) break;
  }
  return { query: cleanText(data.query, L.maxQueryChars), primary: data.primary, intents: kept };
}

function mapGsc(data: unknown) {
  if (!isRecord(data)) return null;
  const queries = list(data.queries);
  if (queries === null) return null;
  return fitBudget({
    url: cleanText(data.url, L.maxUrlChars),
    days: num(data.days),
    clicks: num(data.clicks),
    impressions: num(data.impressions),
    ctr: within(data.ctr, 0, 1),
    position: num(data.position),
    queries: queries.slice(0, L.maxGscQueries).map((row) => {
      const item = isRecord(row) ? row : {};
      return { query: cleanText(item.query, L.maxQueryChars), clicks: num(item.clicks), impressions: num(item.impressions), ctr: within(item.ctr, 0, 1), position: num(item.position) };
    }),
    queriesTotal: queries.length,
  }, 'queries');
}

export function createSearchTools(deps: SearchToolDeps) {
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const ports = deps.ports ?? {};

  /**
   * Asks a port: its answer mapped by `map`, `{ unavailable: reason }` for an `unavailable` answer,
   * else a fixed error. The port's signal aborts on Stop or at the timeout, and the call doesn't
   * wait on a port that ignores it.
   */
  const ask = <T>(toolName: SearchToolName, query: (signal: AbortSignal) => Promise<PortAnswer<T>>, map: (data: T) => unknown, context: ToolRunContext): Promise<ToolRunOutcome> => {
    const source = SEARCH_TOOL_SOURCES[toolName];
    if (context.signal.aborted) return Promise.resolve(fail('failed'));
    const controller = new AbortController();
    return new Promise<ToolRunOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: ToolRunOutcome) => {
        if (done) return;
        done = true;
        clearTimer(timer);
        context.signal.removeEventListener('abort', onStop);
        // Whatever ended the call, the port may stop working on it.
        if (!controller.signal.aborted) controller.abort();
        resolve(outcome);
      };
      const onStop = () => finish(fail('failed'));
      const timer = setTimer(() => finish(fail('timeout')), SEARCH_TOOL_TIMEOUT_MS);
      context.signal.addEventListener('abort', onStop, { once: true });
      let pending: Promise<PortAnswer<T>>;
      try {
        pending = query(controller.signal);
      } catch {
        finish(fail('failed'));
        return;
      }
      Promise.resolve(pending).then(
        (answer) => {
          if (done) return;
          if (!isRecord(answer)) return finish(fail('failed'));
          if (answer.status === 'unavailable') {
            const reason = cleanText(answer.reason, L.maxReasonChars);
            return finish({ ok: true, data: { unavailable: reason === null || reason === '' ? 'This data source gave no reason.' : reason }, source });
          }
          if (answer.status !== 'ok') return finish(fail('failed'));
          let data: unknown;
          try {
            data = map(answer.data);
          } catch {
            data = null;
          }
          finish(data === null ? fail('failed') : { ok: true, data, source });
        },
        () => finish(fail('failed')),
      );
    });
  };

  const run = (call: SearchToolInput, context: ToolRunContext): Promise<ToolRunOutcome> => {
    switch (call.toolName) {
      case 'serp_results': {
        const port = ports.serp;
        if (!port) return Promise.resolve(fail('unavailable'));
        const { query, locale, device } = call.input;
        return ask('serp_results', (signal) => port.results({ query, ...(locale !== undefined ? { locale } : {}), ...(device !== undefined ? { device } : {}) }, { signal, tabId: context.tabId }), mapSerp, context);
      }
      case 'run_ai_search': {
        const port = ports.serp;
        if (!port) return Promise.resolve(fail('unavailable'));
        // An `act` tool, never grantable: only the user's approval of this call sends the query out.
        if (context.via !== 'approval') return Promise.resolve(fail('not-allowed'));
        const { query, locale } = call.input;
        return ask('run_ai_search', (signal) => port.aiSearch({ query, ...(locale !== undefined ? { locale } : {}) }, { signal, tabId: context.tabId }), mapAiSearch, context);
      }
      case 'search_intent': {
        const port = ports.intent;
        if (!port) return Promise.resolve(fail('unavailable'));
        return ask('search_intent', (signal) => port.classify({ query: call.input.query }, { signal, tabId: context.tabId }), mapIntent, context);
      }
      case 'gsc_performance': {
        const port = ports.gsc;
        if (!port) return Promise.resolve(fail('unavailable'));
        const source = SEARCH_TOOL_SOURCES.gsc_performance;
        // The page is the input's (the broker filled in the tab's): never the tab's at run time.
        const url = gscPageUrl(call.input.url);
        if (url === null) return Promise.resolve({ ok: true, data: { unavailable: GSC_NO_PAGE_REASON }, source });
        if (!isGscReadablePage(url)) return Promise.resolve({ ok: true, data: { unavailable: GSC_NOT_PUBLIC_REASON, url: cleanText(url, L.maxUrlChars) }, source });
        const days = call.input.days ?? AGENT_TOOL_INPUT_LIMITS.defaultGscDays;
        return ask('gsc_performance', (signal) => port.performance({ url, days }, { signal, tabId: context.tabId }), mapGsc, context);
      }
    }
  };

  return { run };
}
