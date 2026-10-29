/**
 * Renderer errors (Phase 4 Task 7; acceptance `telemetry.feature.md`, Desktop). Plain values with no
 * Zod, so the chrome renderer can use them (its strict Trusted Types CSP blocks Zod's eval probe).
 * The Zod schemas of the `telemetry.*` procedures and the consent file are in
 * `telemetry-consent.schema.ts`.
 *
 * Clean-room: frost's own names and limits.
 */

/** How the chrome caught an error: `window`'s `error` event or `unhandledrejection` event. */
export const RENDERER_ERROR_SOURCES = ['error', 'unhandledrejection'] as const;
export type RendererErrorSource = (typeof RENDERER_ERROR_SOURCES)[number];

/**
 * The chrome cuts each field to these before sending; a longer one is refused. `maxNameChars` and
 * `maxMessageChars` are `TELEMETRY_LIMITS.maxTypeChars` and `maxMessageChars` (what is kept anyway).
 */
export const RENDERER_ERROR_LIMITS = {
  maxNameChars: 128,
  maxMessageChars: 1_024,
  maxStackChars: 8_192,
} as const;

/** `telemetry.reportError`'s input (`RendererErrorInputSchema`): an error the chrome did not handle, as plain text. */
export interface RendererErrorInput {
  source: RendererErrorSource;
  name: string;
  message: string;
  stack: string | null;
}

/**
 * At most `maxReports` renderer errors per `windowMs` reach main's telemetry (over all app windows);
 * the rest answer `rate-limited`. The chrome also stops sending after `maxReports` in a window.
 */
export const RENDERER_ERROR_RATE_LIMIT = {
  maxReports: 10,
  windowMs: 60_000,
} as const;
