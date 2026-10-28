/**
 * `createTelemetry`: the consent gate in front of both channels (spec `telemetry-privacy.spec.ts`,
 * acceptance `telemetry.feature.md`). Consent lives here; each channel reads it live, so turning a
 * channel off takes effect at every check point at once.
 */
import { DEFAULT_CONSENT, TELEMETRY_CHANNELS, TelemetryConsentSchema, type TelemetryChannel, type TelemetryConsent } from '@app/specs/telemetry-privacy.spec';
import { OtelChannel } from './otel';
import { createScrubber, machineLiterals } from './scrub';
import { SentryChannel } from './sentry';
import { httpUrl } from './send';
import type { Telemetry, TelemetryOptions } from './types';

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const consent: TelemetryConsent = { ...TelemetryConsentSchema.parse(options.consent ?? DEFAULT_CONSENT) };
  const scrub = createScrubber({ literals: options.redact ?? machineLiterals() });
  let closed = false;

  const endpoint = httpUrl(options.otel?.endpoint);
  const otel =
    options.otel && endpoint
      ? new OtelChannel({ endpoint: endpoint.href, send: options.otel.send, headers: options.otel.headers, resource: options.resource, scrub, enabled: () => !closed && consent.usage })
      : undefined;
  const sentry = options.sentry
    ? SentryChannel.create({
        dsn: options.sentry.dsn,
        send: options.sentry.send,
        environment: options.sentry.environment,
        resource: options.resource,
        appRoot: options.appRoot,
        scrub,
        enabled: () => !closed && consent.errors,
      })
    : undefined;

  return {
    span(name, attributes, fn) {
      return otel ? otel.span(name, attributes, fn) : fn({ setAttributes: () => undefined });
    },
    captureException(error, hint) {
      sentry?.captureException(error, hint);
    },
    setConsent(channel: TelemetryChannel, on: boolean) {
      if (!(TELEMETRY_CHANNELS as readonly string[]).includes(channel)) throw new TypeError(`unknown telemetry channel: ${String(channel)}`);
      if (typeof on !== 'boolean') throw new TypeError('consent must be a boolean');
      consent[channel] = on;
      if (channel === 'usage') otel?.setEnabled(on);
      else sentry?.setEnabled(on);
    },
    consent: () => ({ ...consent }),
    configured: () => ({ usage: otel !== undefined, errors: sentry !== undefined }),
    async flush() {
      await Promise.all([otel?.flush(), sentry?.flush()]).catch(() => undefined);
    },
    async shutdown() {
      if (closed) return;
      await Promise.all([otel?.shutdown(), sentry?.shutdown()]).catch(() => undefined);
      closed = true;
    },
  };
}
