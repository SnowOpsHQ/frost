/**
 * Telemetry on the desktop (Phase 4 Task 7; acceptance `telemetry.feature.md`, Desktop; review focus
 * "Telemetry UI matches behaviour"). Main owns `@app/telemetry` (`telemetry-privacy.spec.ts`); the
 * chrome reads and changes consent through the sender-guarded `telemetry.*` procedures and reports
 * its own uncaught errors through `telemetry.reportError`.
 *
 * - The consent lives in `userData/TELEMETRY_CONSENT_FILE` (`TelemetryConsentFileSchema`), read
 *   synchronously at startup before any window opens or anything could be exported. A missing,
 *   unreadable, malformed or unknown-version file is `DEFAULT_CONSENT` (both off).
 * - `TelemetryStateSchema` is **strict** and says only whether each channel is on and whether this
 *   build has an endpoint (or DSN) for it, as booleans: never the endpoint or DSN itself.
 * - A renderer error is plain text the chrome cut to `RENDERER_ERROR_LIMITS` (in the Zod-free
 *   `telemetry-consent.spec.ts`, for the renderer); main scrubs it (the package's `SCRUB_RULES`) and
 *   drops it unless `errors` is on. At most `RENDERER_ERROR_RATE_LIMIT` reports per window of time
 *   reach main's telemetry; the rest answer `rate-limited`.
 *
 * Clean-room: frost's own names and limits.
 */
import { z } from 'zod';
import {
  RENDERER_ERROR_LIMITS,
  RENDERER_ERROR_RATE_LIMIT,
  RENDERER_ERROR_SOURCES,
  type RendererErrorInput,
  type RendererErrorSource,
} from './telemetry-consent.spec';
import { TELEMETRY_CHANNELS, TelemetryConsentSchema } from './telemetry-privacy.spec';

// The renderer's plain values (no Zod) live in `telemetry-consent.spec.ts`; re-exported here for main.
export { RENDERER_ERROR_LIMITS, RENDERER_ERROR_RATE_LIMIT, RENDERER_ERROR_SOURCES, type RendererErrorInput, type RendererErrorSource };

// ---- Configuration ------------------------------------------------------------------------------

/**
 * The build's public telemetry values (plan "Configuration"), read like the account's
 * (`account-state.schema.ts`, `ACCOUNT_CONFIG_ENV`): baked in at build time (`import.meta.env`,
 * `envPrefix` `FROST_PUBLIC_`). **A build that has a value baked in never reads it from the run-time
 * environment**: if either value is baked in, the run-time environment is ignored for both; only an
 * **unpackaged** build with neither baked in (dev, e2e) reads them from it. A missing or refused value
 * leaves its channel not configured.
 */
export const TELEMETRY_CONFIG_ENV = {
  sentryDsn: 'FROST_PUBLIC_SENTRY_DSN',
  otelEndpoint: 'FROST_PUBLIC_OTEL_ENDPOINT',
} as const;

/**
 * Hosts an **unpackaged** build may send telemetry to over plain `http:` (a local collector in
 * tests). A packaged build requires `https:`. Neither value may carry a password, query or fragment;
 * the DSN carries its public key as the URL's user name and its project as the last path segment.
 */
export const UNPACKAGED_HTTP_TELEMETRY_HOSTS: readonly string[] = Object.freeze(['127.0.0.1']);

/** A Sentry DSN's public key (its URL user name) and project ID (its last path segment). */
export const DSN_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9]{1,64}$/;
export const DSN_PROJECT_ID_PATTERN = /^[0-9]{1,20}$/;

// ---- The consent file ---------------------------------------------------------------------------

/** The consent's file in `userData` (no database: the plan's "No desktop database migrations"). */
export const TELEMETRY_CONSENT_FILE = 'telemetry-consent.json';
export const TELEMETRY_CONSENT_FILE_VERSION = 1;
/** A consent file larger than this is not read (it is not one frost wrote): defaults. */
export const TELEMETRY_CONSENT_FILE_MAX_BYTES = 1_024;

/**
 * What the file holds: the consent per channel and when the user last decided (epoch ms). Strict: a
 * file with any other member, another `v`, or a wrong type is not frost's and reads as the defaults.
 */
export const TelemetryConsentFileSchema = z.strictObject({
  v: z.literal(TELEMETRY_CONSENT_FILE_VERSION),
  usage: z.boolean(),
  errors: z.boolean(),
  decidedAt: z.number().int().nonnegative(),
});
export type TelemetryConsentFile = z.infer<typeof TelemetryConsentFileSchema>;

// ---- What the chrome sees -----------------------------------------------------------------------

export const TelemetryChannelSchema = z.enum(TELEMETRY_CHANNELS);

/** Whether this build has an endpoint (`usage`) or DSN (`errors`): booleans, never the value. */
export const TelemetryConfiguredSchema = z.strictObject({
  usage: z.boolean(),
  errors: z.boolean(),
});

/**
 * `telemetry.state` and `telemetry.setConsent`'s answer. `consent` is what main's telemetry does now
 * (a channel not configured may be on and still sends nothing); `version` goes up at every change.
 */
export const TelemetryStateSchema = z.strictObject({
  consent: TelemetryConsentSchema,
  configured: TelemetryConfiguredSchema,
  version: z.number().int().nonnegative(),
});
export type TelemetryState = z.infer<typeof TelemetryStateSchema>;

/** `telemetry.setConsent`: one channel on or off. */
export const SetConsentInputSchema = z.strictObject({
  channel: TelemetryChannelSchema,
  on: z.boolean(),
});
export type SetConsentInput = z.infer<typeof SetConsentInputSchema>;

// ---- Renderer errors ----------------------------------------------------------------------------

/** The mechanism main reports each source as (`CaptureHint.mechanism`, a lower-case token). */
export const RENDERER_ERROR_MECHANISMS = {
  error: 'renderer_onerror',
  unhandledrejection: 'renderer_onunhandledrejection',
} as const satisfies Record<RendererErrorSource, string>;

/** `telemetry.reportError`: an error the chrome did not handle, as plain text (cut to `RENDERER_ERROR_LIMITS`). */
export const RendererErrorInputSchema = z.strictObject({
  source: z.enum(RENDERER_ERROR_SOURCES),
  name: z.string().max(RENDERER_ERROR_LIMITS.maxNameChars),
  message: z.string().max(RENDERER_ERROR_LIMITS.maxMessageChars),
  stack: z.string().max(RENDERER_ERROR_LIMITS.maxStackChars).nullable(),
}) satisfies z.ZodType<RendererErrorInput>;

/**
 * `telemetry.reportError`'s answer: `reported` (handed to the `errors` channel, which scrubs it),
 * `dropped` (`errors` is off or not configured: nothing kept) or `rate-limited`.
 */
export const RENDERER_ERROR_RESULTS = ['reported', 'dropped', 'rate-limited'] as const;
export const RendererErrorResultSchema = z.enum(RENDERER_ERROR_RESULTS);
export type RendererErrorResult = z.infer<typeof RendererErrorResultSchema>;
