// The e2e seam's scripted model (Phase 5 Task 6a; spec `specs/agent-e2e-script.schema.ts`;
// acceptance `specs/agent-session.feature.md`, E2e seam). Unpackaged builds only: main passes a
// validated script in `AGENT_E2E_SCRIPT_ENV` only when the app runs unpackaged with
// `--frost-e2e-agent-script`, and the runtime then builds every turn's model here instead of a
// provider. It plays the script's next step on each `doStream` call and never calls the proxied
// `fetch`, so no model request leaves. A tiny hand-rolled `LanguageModelV4`: nothing from `ai/test`
// is bundled.
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { AGENT_E2E_SCRIPT_END_TEXT, parseAgentE2eScript, type AgentE2eScript, type AgentE2eStep } from '@app/specs/agent-e2e-script.schema';
import { AGENT_E2E_SCRIPT_ENV } from '@app/specs/agent-session.spec';
import type { ModelFactory } from './provider';

/** The usage a step reports when the script gives none. */
export const SCRIPTED_DEFAULT_USAGE = { input: 100, output: 10 } as const;

/** Why a scripted turn fails: the environment named a script that isn't one. */
export class ScriptedModelError extends Error {
  override readonly name = 'ScriptedModelError';
}

function usageOf(step: AgentE2eStep | null) {
  const { input, output } = step?.usage ?? SCRIPTED_DEFAULT_USAGE;
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

/** The stream parts one step plays (`null`: the script has run out). `callIds` numbers the calls. */
export function scriptedStepParts(step: AgentE2eStep | null, nextCallId: () => string): LanguageModelV4StreamPart[] {
  const text = step === null ? [AGENT_E2E_SCRIPT_END_TEXT] : (step.text ?? []);
  const calls = step?.toolCalls ?? [];
  const parts: LanguageModelV4StreamPart[] = [{ type: 'stream-start', warnings: [] }];
  if (text.length > 0) {
    parts.push({ type: 'text-start', id: 'text' });
    for (const delta of text) parts.push({ type: 'text-delta', id: 'text', delta });
    parts.push({ type: 'text-end', id: 'text' });
  }
  for (const call of calls) parts.push({ type: 'tool-call', toolCallId: nextCallId(), toolName: call.toolName, input: JSON.stringify(call.input) });
  parts.push({ type: 'finish', finishReason: { unified: calls.length > 0 ? 'tool-calls' : 'stop', raw: undefined }, usage: usageOf(step) });
  return parts;
}

function streamOf(parts: readonly LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

/**
 * A model factory playing `script`: one cursor shared by every turn of this runtime (each
 * `doStream` takes the next step), with call ids `e2e-call-<n>`. The route, model id and `fetch`
 * are ignored: nothing is requested.
 */
export function createScriptedModelFactory(script: AgentE2eScript): ModelFactory {
  let cursor = 0;
  let calls = 0;
  const nextCallId = () => `e2e-call-${(calls += 1)}`;
  return (_route, modelId) => {
    const model: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'frost-e2e-script',
      modelId,
      supportedUrls: {},
      doGenerate: () => Promise.reject(new ScriptedModelError('the scripted model only streams')),
      doStream: async () => {
        const step = script.steps[cursor] ?? null;
        if (step !== null) cursor += 1;
        return { stream: streamOf(scriptedStepParts(step, nextCallId)) };
      },
    };
    return model;
  };
}

/** A factory whose every turn fails (the environment named a script that isn't valid). */
const failingFactory: ModelFactory = () => {
  throw new ScriptedModelError('the e2e agent script is not valid');
};

/**
 * The model factory the environment asks for: `null` (use the providers) when `AGENT_E2E_SCRIPT_ENV`
 * is unset; the scripted one when it holds a valid script; one that fails every turn when it holds
 * anything else. Main sets the variable only in an unpackaged build with the e2e switch.
 */
export function scriptedModelFactoryFromEnv(env: Readonly<Record<string, string | undefined>>): ModelFactory | null {
  const text = env[AGENT_E2E_SCRIPT_ENV];
  if (text === undefined) return null;
  const script = parseAgentE2eScript(text);
  return script === null ? failingFactory : createScriptedModelFactory(script);
}
