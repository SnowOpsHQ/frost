// AI checks (Phase 9 Task 9, Decision 15; acceptance `specs/agent-runtime.feature.md`, Checks): one
// tool-less model request per `check.start`, answered `check.finish` (the model's text) or
// `check.error` (a code, never the error's own text).
//
// The request is a turn's in miniature, on the same model factory and proxied fetch: main's system
// prompt, the check's input as the one user message, and no tools. It never retries
// (`CHECK_MAX_RETRIES`), so its one request is all main's budget (`MAX_MODEL_REQUESTS_PER_CHECK`)
// has to admit; its `fetch.request` carries the check's id, which is how main tells it from a turn's.
// It sends no reasoning option at all: a check always runs at `auto`, whatever the agent's Reasoning
// setting is (`check.start` has no effort field), and main's proxy refuses any reasoning field.
//
// It streams (`streamText`) as a turn does: the ChatGPT plan takes streamed requests only (main's
// proxy refuses one without `stream: true`) and the e2e seam's scripted model only streams. It is
// still one request.
import { streamText, type LanguageModel } from 'ai';
import type { MainToRuntimeMessage, RuntimeToMainMessage } from '@app/specs/agent-protocol.schema';
import { AI_CHECK_LIMITS, type AiCheckErrorCode } from '@app/specs/ai-checks.spec';
import type { ModelRoute } from '@app/specs/agent-tools.spec';
import { CHAT_PROVIDER_OPTIONS, CHATGPT_PROVIDER_OPTIONS, refuseDownload, type ChatProviderOptions } from './chat';
import { ModelNotAllowedError } from './provider';
import { ProxyFetchError } from './proxy-fetch';

export type CheckStart = Extract<MainToRuntimeMessage, { type: 'check.start' }>;

/** A check's request is never retried (a turn's is, once: `CHAT_MAX_RETRIES`). */
export const CHECK_MAX_RETRIES = 0;

/**
 * The call options a check on `route` sends besides the prompt (Decision 15's per-route output
 * options): the key routes and the gateway `maxOutputTokens = AI_CHECK_LIMITS.maxOutputTokens`
 * (main's proxy requires a cap there); the ChatGPT plan no output cap and no sampling field (the
 * route refuses both), with its `store: false` and developer-message options. The provider options
 * are the route's alone: never a reasoning option.
 */
export function checkCallOptions(route: ModelRoute): { readonly maxOutputTokens?: number; readonly providerOptions: ChatProviderOptions } {
  return route === 'chatgpt' ? { providerOptions: CHATGPT_PROVIDER_OPTIONS } : { maxOutputTokens: AI_CHECK_LIMITS.maxOutputTokens, providerOptions: CHAT_PROVIDER_OPTIONS };
}

export interface RunCheckOptions {
  readonly start: CheckStart;
  readonly model: LanguageModel;
  /** Posts a message to main; `false` when it was not sent. */
  readonly post: (message: RuntimeToMainMessage) => boolean;
  /** Aborted by `check.stop`. */
  readonly signal: AbortSignal;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** Why a check's request failed, as a `check.error` code (the error's own text is never passed on). */
export function checkErrorCode(error: unknown): AiCheckErrorCode {
  for (let current: unknown = error, depth = 0; current !== null && typeof current === 'object' && depth < 8; depth += 1) {
    if (current instanceof ModelNotAllowedError) return 'failed';
    if (current instanceof ProxyFetchError) {
      switch (current.code) {
        case 'refused':
        case 'timeout':
        case 'too-large':
        case 'aborted':
        case 'network':
          return current.code;
        case 'invalid-request':
          return 'failed';
      }
    }
    current = (current as { lastError?: unknown }).lastError ?? (current as { cause?: unknown }).cause;
  }
  return 'failed';
}

/** Runs one check; settles (never rejects) once its `check.finish` or `check.error` is posted. */
export async function runCheck({ start, model, post, signal, ...timers }: RunCheckOptions): Promise<void> {
  const { checkId } = start;
  const setTimer = timers.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = timers.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  // The request's own signal: main's stop, the time limit, or an answer over the cap.
  const controller = new AbortController();
  let ended: AiCheckErrorCode | null = null;
  const end = (code: AiCheckErrorCode) => {
    ended ??= code;
    controller.abort();
  };
  const onStop = () => end('aborted');
  if (signal.aborted) onStop();
  else signal.addEventListener('abort', onStop, { once: true });
  const timer = setTimer(() => end('timeout'), AI_CHECK_LIMITS.requestTimeoutMs);
  let text = '';
  let failure: unknown = null;
  try {
    if (ended === null) {
      const result = streamText({
        model,
        ...(start.systemPrompt === '' ? {} : { instructions: start.systemPrompt }),
        messages: [{ role: 'user', content: start.input }],
        maxRetries: CHECK_MAX_RETRIES,
        ...checkCallOptions(start.route),
        abortSignal: controller.signal,
        experimental_download: refuseDownload,
        // The default logs the error (and whatever it carries); the check's failure is reported below.
        onError: () => {},
      });
      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          text += part.text;
          if (text.length > AI_CHECK_LIMITS.maxOutputChars) {
            end('too-large');
            break;
          }
        } else if (part.type === 'error' || part.type === 'tool-error') {
          failure ??= part.error ?? part;
        }
      }
    }
  } catch (thrown) {
    failure ??= thrown;
  } finally {
    clearTimer(timer);
    signal.removeEventListener('abort', onStop);
  }
  if (ended !== null) post({ type: 'check.error', checkId, code: ended });
  else if (failure !== null) post({ type: 'check.error', checkId, code: checkErrorCode(failure) });
  else post({ type: 'check.finish', checkId, text });
}
