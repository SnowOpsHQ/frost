// One interface over the model routes (Phase 5 Task 2, plan decisions 1 and 5; acceptance
// `specs/agent-runtime.feature.md`, Providers). Each route's provider gets a placeholder key and the
// proxied `fetch`: the real key lives in main, which drops whatever credential header the provider
// sends and adds its own. The providers' default base URLs are the ones `MODEL_REQUESTS` allows.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGateway } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { routeModelId, type ModelRoute } from '@app/specs/agent-tools.spec';
import type { FetchFunction } from './proxy-fetch';

/** The key every provider is given: not a credential, and dropped before a request leaves. */
export const PLACEHOLDER_API_KEY = 'frost-placeholder-key';

/** Builds the language model for a chat (injectable: Task 6's scripted model replaces it). */
export type ModelFactory = (route: ModelRoute, modelId: string, fetch: FetchFunction) => LanguageModelV4;

/** A model id the route does not serve. */
export class ModelNotAllowedError extends Error {
  override readonly name = 'ModelNotAllowedError';
}

/**
 * The language model for `modelId` on `route`, sending its requests through `fetch`: Anthropic's
 * Messages API, OpenAI's Responses API, or the gateway's language model endpoint. Throws
 * `ModelNotAllowedError` for a model not allowed on the route (`routeModelId`).
 */
export const createModel: ModelFactory = (route, modelId, fetch) => {
  const providerModelId = routeModelId(route, modelId);
  if (providerModelId === null) throw new ModelNotAllowedError('this model is not available on the selected route');
  const settings = { apiKey: PLACEHOLDER_API_KEY, fetch };
  switch (route) {
    case 'byok-anthropic':
      return createAnthropic(settings).languageModel(providerModelId);
    case 'byok-openai':
      return createOpenAI(settings).responses(providerModelId);
    case 'gateway':
      return createGateway(settings).languageModel(providerModelId);
  }
};
