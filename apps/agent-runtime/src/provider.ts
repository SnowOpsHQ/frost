// One interface over the model routes (Phase 5 Task 2, plan decisions 1 and 5; acceptance
// `specs/agent-runtime.feature.md`, Providers). Each route's provider gets a placeholder key and the
// proxied `fetch`: the real key lives in main, which drops whatever credential header the provider
// sends and adds its own. The providers' default base URLs are the ones `MODEL_REQUESTS` allows.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { routeModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import { ProxyFetchError, type FetchFunction } from './proxy-fetch';

/** The key every provider is given: not a credential, and dropped before a request leaves. */
export const PLACEHOLDER_API_KEY = 'frost-placeholder-key';

/** Builds the language model for a chat (injectable: Task 6's scripted model replaces it). */
export type ModelFactory = (route: ModelRoute, modelId: string, fetch: FetchFunction) => LanguageModelV4;

/** A model id the route does not serve. */
export class ModelNotAllowedError extends Error {
  override readonly name = 'ModelNotAllowedError';
}

/** The proxied-request failure inside `error` (its cause chain), if any. */
function proxyFailure(error: unknown): ProxyFetchError | undefined {
  for (let current: unknown = error, depth = 0; current !== null && typeof current === 'object' && depth < 8; depth += 1) {
    if (current instanceof ProxyFetchError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Rethrows a failed proxied request as itself. A provider may wrap it as a retryable server error
 * (the gateway's reads any failure as HTTP 500), and the AI SDK would send a refused request again;
 * main's answer is final, so the SDK sees an error it never retries. HTTP errors the provider
 * reports from a real response (429, 5xx) are left as they are.
 */
const proxyFailuresAreFinal: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    try {
      return await doGenerate();
    } catch (error) {
      throw proxyFailure(error) ?? error;
    }
  },
  wrapStream: async ({ doStream }) => {
    try {
      return await doStream();
    } catch (error) {
      throw proxyFailure(error) ?? error;
    }
  },
};

/**
 * The language model for `modelId` on `route`, sending its requests through `fetch`: Anthropic's
 * Messages API, OpenAI's Responses API, or the gateway's language model endpoint. Throws
 * `ModelNotAllowedError` for a model not allowed on the route (`routeModelId`).
 */
export const createModel: ModelFactory = (route, modelId, fetch) => {
  const providerModelId = routeModelId(route, modelId);
  if (providerModelId === null) throw new ModelNotAllowedError('this model is not available on the selected route');
  const settings = { apiKey: PLACEHOLDER_API_KEY, fetch };
  const model =
    route === 'byok-anthropic'
      ? createAnthropic(settings).languageModel(providerModelId)
      : route === 'byok-openai'
        ? createOpenAI(settings).responses(providerModelId)
        : createGateway(settings).languageModel(providerModelId);
  return wrapLanguageModel({ model, middleware: proxyFailuresAreFinal });
};
