import {
  DSN_PROJECT_ID_PATTERN,
  DSN_PUBLIC_KEY_PATTERN,
  TELEMETRY_CONFIG_ENV,
  UNPACKAGED_HTTP_TELEMETRY_HOSTS,
} from '@app/specs/telemetry-consent.schema';

// The build's telemetry configuration (spec `telemetry-consent.schema.ts`, `TELEMETRY_CONFIG_ENV`;
// acceptance `telemetry.feature.md`, Desktop, Configuration; plan "Configuration"). Read the way the
// account's is (`../account/config.ts`): baked in at build time (Vite replaces
// `import.meta.env.FROST_PUBLIC_*`, `envPrefix` in `vite.main.config.ts`). A build that has a value
// baked in never reads it from the run-time environment: if either value is baked in, the environment
// is ignored for both (`app.isPackaged` only looks at the executable's name, so it is not the guard).
// Only an unpackaged build with neither baked in (dev, e2e) reads the environment. Packaged requires
// `https:`. A missing or refused value leaves its channel not
// configured: it sends nothing, whatever the consent.

type EnvName = (typeof TELEMETRY_CONFIG_ENV)[keyof typeof TELEMETRY_CONFIG_ENV];
export type TelemetryEnv = Partial<Record<EnvName, string | undefined>>;

export interface TelemetryConfig {
  /** The OTLP/HTTP traces endpoint (`usage`), or `null`. */
  readonly otelEndpoint: string | null;
  /** The Sentry DSN (`errors`), or `null`. */
  readonly sentryDsn: string | null;
}

export interface TelemetryConfigSources {
  readonly isPackaged: boolean;
  /** The values baked into the build (`buildTimeTelemetryEnv()`). */
  readonly buildTime: TelemetryEnv;
  /** The run-time environment (`process.env`); read only unpackaged, and only with nothing baked in. */
  readonly runtime: Readonly<Record<string, string | undefined>>;
}

/** The values Vite baked into this bundle (each `undefined` when the build had none). */
export function buildTimeTelemetryEnv(): TelemetryEnv {
  // Written out literally: Vite replaces each `import.meta.env.<NAME>` expression statically.
  return {
    FROST_PUBLIC_SENTRY_DSN: import.meta.env.FROST_PUBLIC_SENTRY_DSN,
    FROST_PUBLIC_OTEL_ENDPOINT: import.meta.env.FROST_PUBLIC_OTEL_ENDPOINT,
  };
}

/** `value` as an `http(s)` URL this build may send to (no query or fragment), or `null`. */
function allowedUrl(value: string | undefined, isPackaged: boolean): URL | null {
  if (value === undefined || value === '' || value.trim() !== value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.password !== '' || url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && !isPackaged && UNPACKAGED_HTTP_TELEMETRY_HOSTS.includes(url.hostname)) return url;
  return null;
}

function endpointOf(value: string | undefined, isPackaged: boolean): string | null {
  const url = allowedUrl(value, isPackaged);
  return url !== null && url.username === '' ? url.href : null;
}

function dsnOf(value: string | undefined, isPackaged: boolean): string | null {
  const url = allowedUrl(value, isPackaged);
  if (url === null || !DSN_PUBLIC_KEY_PATTERN.test(url.username)) return null;
  const project = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  return DSN_PROJECT_ID_PATTERN.test(project) ? value! : null;
}

/** The telemetry configuration for this build (each channel `null` when not configured). */
export function resolveTelemetryConfig(sources: TelemetryConfigSources): TelemetryConfig {
  const baked = Object.values(TELEMETRY_CONFIG_ENV).some((name) => (sources.buildTime[name] ?? '') !== '');
  const source = sources.isPackaged || baked ? sources.buildTime : sources.runtime;
  const pick = (name: EnvName): string | undefined => source[name];
  return {
    otelEndpoint: endpointOf(pick(TELEMETRY_CONFIG_ENV.otelEndpoint), sources.isPackaged),
    sentryDsn: dsnOf(pick(TELEMETRY_CONFIG_ENV.sentryDsn), sources.isPackaged),
  };
}
