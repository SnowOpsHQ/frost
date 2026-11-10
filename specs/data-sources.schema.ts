/**
 * Data sources' shapes (Phase 12 Task 1; values `data-sources.spec.ts`; acceptance
 * `data-sources.feature.md`): the `dataSources.*` IPC inputs, the renderer's view (never a key), and
 * the `frost-e2e-data-api` seam file. Main validates with these; the renderer only reads the view.
 */
import { z } from 'zod';
import { KEY_PROTECTIONS } from './agent-proxy.spec';
import { DATA_PROVIDERS, DATA_SECRET_MAX_CHARS, type DataProvider } from './data-sources.spec';

/**
 * One pasted secret: one line (no line break anywhere), bounded loosely (main trims and refuses
 * anything that isn't a key with `invalid`, `normalizeDataSecret`). The IPC's error formatter
 * replaces a refused input's message with its code, so no error carries a key back.
 */
const Secret = z
  .string()
  .min(1)
  .max(DATA_SECRET_MAX_CHARS * 2)
  .refine((value) => !/[\r\n\u2028\u2029]/.test(value), { message: 'one line' });

const SingleKeyProvider = z.enum(['serpapi', 'serper', 'perplexity', 'openai-search']);

/**
 * `dataSources.setKey`: one key for a one-slot provider, or DataForSEO's login and/or password
 * (at least one; setting one never clears the other).
 */
export const DataSourcesSetKeyInputSchema = z.union([
  z.strictObject({ provider: SingleKeyProvider, key: Secret }),
  z
    .strictObject({ provider: z.literal('dataforseo'), login: Secret.optional(), password: Secret.optional() })
    .refine((value) => value.login !== undefined || value.password !== undefined, { message: 'login or password' }),
]);
export type DataSourcesSetKeyInput = z.output<typeof DataSourcesSetKeyInputSchema>;

/** `dataSources.clearKey`: every slot of `provider` (never gated). */
export const DataSourcesClearKeyInputSchema = z.strictObject({ provider: z.enum(DATA_PROVIDERS) });

/**
 * `dataSources.setKey`'s answer: the credential store's (`stored`, `invalid`, `no-keychain`,
 * `failed`) or `unavailable` (the provider's legal gate is closed; nothing stored).
 */
export const DATA_SET_KEY_RESULTS = ['stored', 'invalid', 'no-keychain', 'failed', 'unavailable'] as const;
export type DataSetKeyResult = (typeof DATA_SET_KEY_RESULTS)[number];

/** One provider as the renderer sees it: whether all its slots hold a usable key, and whether its gate is open. */
export const DataSourceViewSchema = z.strictObject({
  hasKey: z.boolean(),
  /** The legal gate (`legalGates.isOpen`): `false` hides or disables the control with `LEGAL_GATE_NOTE`. */
  available: z.boolean(),
});

/** `dataSources.status`: how well keys are protected here, and each provider's row. Never a key. */
export const DataSourcesViewSchema = z.strictObject({
  protection: z.enum(KEY_PROTECTIONS),
  providers: z.strictObject({
    serpapi: DataSourceViewSchema,
    dataforseo: DataSourceViewSchema,
    serper: DataSourceViewSchema,
    perplexity: DataSourceViewSchema,
    'openai-search': DataSourceViewSchema,
  }) satisfies z.ZodType<Record<DataProvider, { hasKey: boolean; available: boolean }>>,
});
export type DataSourcesView = z.output<typeof DataSourcesViewSchema>;

// ---- The e2e seam (`DATA_API_E2E_SWITCH`) -------------------------------------------------------

/** The seam file's text, at most (characters). */
export const DATA_API_E2E_SEAM_MAX_CHARS = 4 * 1024;

/**
 * Whether `base` is a base the seam may name: exactly `http://127.0.0.1:<port>` (an explicit port,
 * no path, credentials, query or fragment). Never throws.
 */
export function isDataApiE2eBase(base: unknown): base is string {
  if (typeof base !== 'string' || base.length > 64) return false;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') return false;
  return parsed.origin === base;
}

const E2eBase = z.string().refine(isDataApiE2eBase, { message: 'not a loopback http origin' });

/**
 * The seam file (unpackaged builds only): each provider it names is sent to that loopback base in
 * place of its canonical origin, with the same method, path and query. What is checked against
 * `DATA_API_REQUESTS` is still the canonical URL; only the destination of a request that passed
 * every check moves. A packaged build never reads it and refuses to start with the switch.
 *
 * ```json
 * { "serpapi": "http://127.0.0.1:41234", "perplexity": "http://127.0.0.1:41234" }
 * ```
 */
export const DataApiE2eSeamSchema = z.strictObject({
  serpapi: E2eBase.optional(),
  dataforseo: E2eBase.optional(),
  serper: E2eBase.optional(),
  perplexity: E2eBase.optional(),
  'openai-search': E2eBase.optional(),
});
export type DataApiE2eSeam = z.output<typeof DataApiE2eSeamSchema>;

/** `text` (the seam file) as a validated seam, or `null`: too long, not JSON, or not a seam. Never throws. */
export function parseDataApiE2eSeam(text: unknown): DataApiE2eSeam | null {
  if (typeof text !== 'string' || text.length > DATA_API_E2E_SEAM_MAX_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DataApiE2eSeamSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
