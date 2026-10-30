/**
 * Reasoning effort (Phase 8 Task 8a, Decision 8; acceptance `agent-host.feature.md`, Settings and
 * Reasoning): one setting, mapped per model, checked by main. Plain values and pure functions with
 * **no runtime import** (types only, erased), so `agent-chatgpt.spec.ts` (import-free for the chrome)
 * and `agent-proxy.spec.ts` import its values without a cycle.
 *
 * - `REASONING_EFFORTS`: what the user may choose, stored in the agent settings beside the route and
 *   model. `auto` sends nothing (the provider's default).
 * - `MODEL_REASONING_SUPPORT`: the levels each catalogue model offers; on the `chatgpt` route the
 *   levels the account's model list advertises (`reasoningLevels`). A stored level the model lacks
 *   acts as `auto` (`effectiveEffort`), so the proxy and the runtime always work from the effective
 *   level, never the raw stored one.
 * - `reasoningWire`: the provider options the runtime sends for an effort (one pure mapping);
 *   `checkReasoning`: whether a body's reasoning-bearing fields (`REASONING_FIELDS`) are exactly
 *   what the provider writes for that mapping. The proxy runs it after the structural allowlist
 *   (`checkModelRequest` in `agent-proxy.spec.ts`), and refuses a mismatch as `reasoning`.
 *
 * The mapping, written from the installed providers' request builders (`@ai-sdk/anthropic` 4.0.90,
 * `@ai-sdk/openai` 4.0.104, `@ai-sdk/gateway` 4.0.128):
 * - Anthropic (`byok-anthropic`, gateway `anthropic/*`): adaptive thinking plus the effort,
 *   `{ anthropic: { thinking: { type: 'adaptive' }, effort } }`. The key route's body carries
 *   `thinking: { type: 'adaptive' }` and `output_config: { effort }` (no beta header); the gateway's
 *   carries the provider options as given. Adaptive thinking spends within `max_tokens`, so the
 *   output cap stays the only budget (Open question 4).
 * - OpenAI (`byok-openai`, gateway `openai/*`) and the ChatGPT plan: `{ openai: { reasoningEffort } }`
 *   with `off` sent as `minimal` (GPT-5 only: the ChatGPT route never offers `off`, because the
 *   provider drops `minimal` for the plan's GPT-6 slugs and would send no level). The Responses
 *   body carries `reasoning.effort` (the provider adds a `reasoning.summary` beside it, not
 *   compared); the gateway's carries the provider option.
 * - Gemini (gateway `google/*`): `{ google: { thinkingConfig: { thinkingLevel } } }`, levels only
 *   (no budget; `GEMINI_THINKING_LEVELS` in `agent-proxy.spec.ts`).
 * - Grok (gateway `spacexai/*`): nothing (Auto only, no option verified; Open question 3).
 */
import type { ChatgptModelView } from './agent-chatgpt.spec';
import type { AgentModelSettings } from './agent-proxy.spec';
import type { ModelId, ModelRoute } from './agent-tools.spec';

/** The levels the user may choose, in display order. */
export const REASONING_EFFORTS = ['auto', 'off', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** A new install, and a settings file from before the setting (or one holding no valid level). */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'auto';

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * The levels each catalogue model offers, `auto` first, in `REASONING_EFFORTS` order (Decision 8's
 * table). Claude: adaptive thinking with an effort (no `off`: Claude Opus 5.5 always thinks). GPT-5:
 * every level (`off` → `minimal`). Gemini: the thinking levels the gateway's public model list
 * advertises per model (2026-10-30: `low`, `medium`, `high` for Gemini 4 Argon; `low`, `high` for
 * Gemini 3.8 Flash, which has no `medium`). Grok: Auto only until an option is verified.
 */
export const MODEL_REASONING_SUPPORT: Readonly<Record<ModelId, readonly ReasoningEffort[]>> = {
  'anthropic/claude-sonnet-5-5': ['auto', 'low', 'medium', 'high'],
  'anthropic/claude-opus-5-5': ['auto', 'low', 'medium', 'high'],
  'openai/gpt-5': ['auto', 'off', 'low', 'medium', 'high'],
  'openai/gpt-5-mini': ['auto', 'off', 'low', 'medium', 'high'],
  'google/gemini-4-argon': ['auto', 'low', 'medium', 'high'],
  'google/gemini-3.8-flash': ['auto', 'low', 'high'],
  'spacexai/grok-4.7': ['auto'],
  'spacexai/grok-4.20-non-reasoning': ['auto'],
};

const AUTO_ONLY: readonly ReasoningEffort[] = ['auto'];

const isCatalogueModel = (modelId: string): modelId is ModelId => Object.hasOwn(MODEL_REASONING_SUPPORT, modelId);

/**
 * The levels the ChatGPT route can offer: never `off` (Task 8a fix round 1; see
 * `CHATGPT_ADVERTISED_EFFORTS`: the OpenAI provider drops `minimal` for the plan's GPT-6 slugs and
 * would send no level).
 */
const CHATGPT_LEVELS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high'];

/**
 * The levels `modelId` offers: a catalogue model's `MODEL_REASONING_SUPPORT`; a ChatGPT model's
 * `auto` plus the levels its entry in `chatgptModels` (the account's last list) advertises, never
 * `off`, so `auto` only when it advertises none or is not listed; any other id, `auto` only.
 */
export function reasoningLevels(modelId: string, chatgptModels: readonly ChatgptModelView[]): readonly ReasoningEffort[] {
  if (isCatalogueModel(modelId)) return MODEL_REASONING_SUPPORT[modelId];
  const efforts = chatgptModels.find((model) => model.id === modelId)?.efforts;
  if (efforts === undefined) return AUTO_ONLY;
  return CHATGPT_LEVELS.filter((effort) => effort === 'auto' || efforts.includes(effort));
}

/**
 * The level in effect: the stored one (absent → `auto`) when the model offers it
 * (`reasoningLevels`), else `auto`. What the runtime is told to send and what the proxy checks
 * against, for the current settings and for those a running turn began on alike.
 */
export function effectiveEffort(settings: Pick<AgentModelSettings, 'modelId' | 'reasoningEffort'>, chatgptModels: readonly ChatgptModelView[]): ReasoningEffort {
  const stored: unknown = settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  return isReasoningEffort(stored) && reasoningLevels(settings.modelId, chatgptModels).includes(stored) ? stored : 'auto';
}

/** The provider options the runtime adds for an effort (merged into its other options; `{}` for `auto`). */
export interface ReasoningWire {
  readonly anthropic?: { readonly thinking: { readonly type: 'adaptive' }; readonly effort: 'low' | 'medium' | 'high' };
  readonly openai?: { readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' };
  readonly google?: { readonly thinkingConfig: { readonly thinkingLevel: 'low' | 'medium' | 'high' } };
}

type ReasoningFamily = 'anthropic' | 'openai' | 'google';

/** Which mapping `modelId` on `route` follows, or `null` (none: Grok, or a model the route doesn't serve). */
function reasoningFamily(route: ModelRoute, modelId: string): ReasoningFamily | null {
  if (route === 'chatgpt') return modelId.startsWith('chatgpt/') ? 'openai' : null;
  if (!isCatalogueModel(modelId)) return null;
  const provider = modelId.slice(0, modelId.indexOf('/'));
  if (route === 'byok-anthropic') return provider === 'anthropic' ? 'anthropic' : null;
  if (route === 'byok-openai') return provider === 'openai' ? 'openai' : null;
  return provider === 'anthropic' || provider === 'openai' || provider === 'google' ? provider : null;
}

/**
 * The provider options the runtime sends for `effort` on `route` with `modelId` (module comment):
 * `{}` for `auto`, for a catalogue model's level it doesn't offer (it acts as `auto`), and for a
 * model with no mapping. On the `chatgpt` route the account's list decides the levels
 * (`effectiveEffort`); `low`, `medium` and `high` map there, `off` (never offered) to nothing.
 */
export function reasoningWire(route: ModelRoute, modelId: string, effort: ReasoningEffort): ReasoningWire {
  if (effort === 'auto') return {};
  const family = reasoningFamily(route, modelId);
  if (family === null || (isCatalogueModel(modelId) && !MODEL_REASONING_SUPPORT[modelId].includes(effort)) || (route === 'chatgpt' && !CHATGPT_LEVELS.includes(effort))) return {};
  switch (family) {
    case 'anthropic':
      return effort === 'off' ? {} : { anthropic: { thinking: { type: 'adaptive' }, effort } };
    case 'openai':
      return { openai: { reasoningEffort: effort === 'off' ? 'minimal' : effort } };
    case 'google':
      return effort === 'off' ? {} : { google: { thinkingConfig: { thinkingLevel: effort } } };
  }
}

/**
 * The reasoning-bearing fields of each route's body, as paths: what `checkReasoning` compares.
 * Not compared: `reasoning.summary`, `include`, Anthropic's `sendReasoning` and the other
 * structural options (the allowlist in `agent-proxy.spec.ts` decides those).
 */
export const REASONING_FIELDS: Readonly<Record<ModelRoute, readonly string[]>> = {
  'byok-anthropic': ['thinking', 'output_config.effort'],
  'byok-openai': ['reasoning.effort'],
  chatgpt: ['reasoning.effort'],
  gateway: ['providerOptions.anthropic.thinking', 'providerOptions.anthropic.effort', 'providerOptions.openai.reasoningEffort', 'providerOptions.google.thinkingConfig'],
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at `path` (own keys of plain objects only), or `undefined`. */
function valueAt(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** The `REASONING_FIELDS` a body carries on `route`, by path (absent fields left out). Never throws. */
export function reasoningFieldsOf(route: ModelRoute, body: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const paths = Object.hasOwn(REASONING_FIELDS, route) ? REASONING_FIELDS[route] : [];
  for (const path of paths) {
    const value = valueAt(body, path);
    if (value !== undefined) fields[path] = value;
  }
  return fields;
}

/** The body fragment the route's provider writes for `wire` (module comment). */
function wireAsBody(route: ModelRoute, wire: ReasoningWire): Json {
  switch (route) {
    case 'byok-anthropic':
      return { ...(wire.anthropic === undefined ? {} : { thinking: wire.anthropic.thinking, output_config: { effort: wire.anthropic.effort } }) };
    case 'byok-openai':
    case 'chatgpt':
      return wire.openai === undefined ? {} : { reasoning: { effort: wire.openai.reasoningEffort } };
    case 'gateway':
      return { providerOptions: wire };
  }
}

/** JSON written with sorted keys, so two values compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Whether `body` (JSON text) carries exactly the reasoning fields the provider writes for
 * `reasoningWire(route, modelId, effort)`: each `REASONING_FIELDS` path present with the same value
 * where the mapping has one, absent where it has none. `effort` is the effective one
 * (`effectiveEffort`). Never throws; unparsable text is `false`.
 */
export function checkReasoning(route: ModelRoute, modelId: string, effort: ReasoningEffort, body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  return canonical(reasoningFieldsOf(route, parsed)) === canonical(reasoningFieldsOf(route, wireAsBody(route, reasoningWire(route, modelId, effort))));
}
