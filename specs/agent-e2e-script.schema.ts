/**
 * The e2e seam's model script (Phase 5 Task 6a; acceptance `agent-session.feature.md`, E2e seam).
 * Unpackaged builds only: main reads the file `--frost-e2e-agent-script=<file>` names
 * (`AGENT_E2E_SCRIPT_SWITCH`), validates it here, and hands its canonical JSON to the runtime in
 * `AGENT_E2E_SCRIPT_ENV`; the runtime then plays it as its model (`scripted-model.ts`) and makes no
 * model request. Main and runtime only (Zod).
 *
 * A script is a list of model steps. Each time the chat loop asks the model for a response it gets
 * the next step, across turns (the runtime keeps one cursor while it runs): its text chunks streamed
 * in order, then its tool calls (the step finishes `tool-calls`), or with no calls it finishes
 * `stop`. Past the last step every response is `AGENT_E2E_SCRIPT_END_TEXT`.
 *
 * ```json
 * { "steps": [
 *   { "toolCalls": [{ "toolName": "navigate", "input": { "url": "https://example.com/next" } }] },
 *   { "text": ["Opened ", "the page."], "usage": { "input": 1200, "output": 40 } }
 * ] }
 * ```
 */
import { z } from 'zod';
import { AGENT_E2E_SCRIPT_MAX_CHARS } from './agent-session.spec';
import { AGENT_TOOL_NAMES } from './agent-tools.spec';
import { boundedJsonSchema } from './agent-protocol.schema';

export const AGENT_E2E_SCRIPT_LIMITS = {
  /** Steps in a script. */
  maxSteps: 64,
  /** Text chunks in a step, and one chunk's length (characters). */
  maxChunks: 64,
  maxChunkChars: 4000,
  /** Tool calls in a step. */
  maxToolCalls: 8,
  /** A tool call's input (JSON text, characters). */
  maxInputChars: 8000,
} as const;

/** What the scripted model answers once the script has run out. */
export const AGENT_E2E_SCRIPT_END_TEXT = 'The e2e script has no more steps.';

const L = AGENT_E2E_SCRIPT_LIMITS;
const tokens = z.int().nonnegative().max(10_000_000);

export const AgentE2eStepSchema = z
  .strictObject({
    text: z.array(z.string().min(1).max(L.maxChunkChars)).max(L.maxChunks).optional(),
    toolCalls: z
      .array(z.strictObject({ toolName: z.enum(AGENT_TOOL_NAMES), input: boundedJsonSchema(L.maxInputChars, 'tool input is not bounded JSON') }))
      .max(L.maxToolCalls)
      .optional(),
    /** The step's reported usage (default: 100 input and 10 output tokens). */
    usage: z.strictObject({ input: tokens, output: tokens }).optional(),
  })
  .refine((step) => (step.text?.length ?? 0) + (step.toolCalls?.length ?? 0) > 0, { message: 'a step has text or tool calls' });
export type AgentE2eStep = z.output<typeof AgentE2eStepSchema>;

export const AgentE2eScriptSchema = z.strictObject({ steps: z.array(AgentE2eStepSchema).min(1).max(L.maxSteps) });
export type AgentE2eScript = z.output<typeof AgentE2eScriptSchema>;

/**
 * `text` (a script file's or the environment variable's JSON) as a validated script, or `null`:
 * longer than `AGENT_E2E_SCRIPT_MAX_CHARS`, not JSON, or not a script. Never throws.
 */
export function parseAgentE2eScript(text: unknown): AgentE2eScript | null {
  if (typeof text !== 'string' || text.length > AGENT_E2E_SCRIPT_MAX_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = AgentE2eScriptSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
