import {
  GSC_CLIENT_ID_PATTERN,
  GSC_CLIENT_SECRET_PATTERN,
  GSC_CONFIG_ENV,
  GSC_ENDPOINT_ENV,
  GSC_ENDPOINTS,
  UNPACKAGED_HTTP_GSC_HOSTS,
  type GscEndpoints,
} from '@app/specs/gsc.spec';

// The build's Search Console configuration (spec `gsc.spec.ts`, `GSC_CONFIG_ENV`, `GSC_ENDPOINTS`,
// `GSC_ENDPOINT_ENV`; acceptance `gsc.feature.md`, Configuration; plan "Configuration"). Read the way
// the account's is (`../account/config.ts`): the client ID and secret are baked in at build time (Vite
// replaces `import.meta.env.FROST_PUBLIC_*`, `envPrefix` in `vite.main.config.ts`).
//
// A build that has either value baked in never reads the run-time environment (for either), and talks
// to Google's fixed endpoints only. `app.isPackaged` is not the guard (it only looks at the
// executable's name). Only an unpackaged build with neither value baked in (dev, e2e) reads the
// environment, and only such a build may point an endpoint at a fake (`FROST_GSC_*`): a swapped token
// endpoint would receive the codes and refresh tokens. A refused override is unconfigured, never a
// silent fall-back to Google.

type ClientEnvName = (typeof GSC_CONFIG_ENV)[keyof typeof GSC_CONFIG_ENV];
export type GscEnv = Partial<Record<ClientEnvName, string | undefined>>;

export interface GscConfig {
  readonly clientId: string;
  /** Google's installed-app "secret" (sent to the token and revoke endpoints; not confidential, never logged). */
  readonly clientSecret: string;
  readonly endpoints: GscEndpoints;
}

export interface GscConfigSources {
  readonly isPackaged: boolean;
  /** The values baked into the build (`buildTimeGscEnv()`). */
  readonly buildTime: GscEnv;
  /** The run-time environment (`process.env`); read only unpackaged, and only with nothing baked in. */
  readonly runtime: Readonly<Record<string, string | undefined>>;
}

/** The values Vite baked into this bundle (each `undefined` when the build had none). */
export function buildTimeGscEnv(): GscEnv {
  // Written out literally: Vite replaces each `import.meta.env.<NAME>` expression statically.
  return {
    FROST_PUBLIC_GSC_CLIENT_ID: import.meta.env.FROST_PUBLIC_GSC_CLIENT_ID,
    FROST_PUBLIC_GSC_CLIENT_SECRET: import.meta.env.FROST_PUBLIC_GSC_CLIENT_SECRET,
  };
}

/** A fake's endpoint (`https:`, or `http:` on a loopback host; no credentials, query or fragment), or `null`. */
function overrideOf(value: string): string | null {
  if (value.trim() !== value || value.includes('?') || value.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && UNPACKAGED_HTTP_GSC_HOSTS.includes(url.hostname));
  if (!allowed) return null;
  return url.href.endsWith('/') && url.pathname !== '/' ? url.href.slice(0, -1) : url.href;
}

/** The Search Console configuration for this build, or `null` (unconfigured: nothing is sent to Google). */
export function resolveGscConfig(sources: GscConfigSources): GscConfig | null {
  const baked = Object.values(GSC_CONFIG_ENV).some((name) => (sources.buildTime[name] ?? '') !== '');
  const fromRuntime = !sources.isPackaged && !baked;
  const source: Readonly<Record<string, string | undefined>> = fromRuntime ? sources.runtime : sources.buildTime;
  const clientId = source[GSC_CONFIG_ENV.clientId];
  const clientSecret = source[GSC_CONFIG_ENV.clientSecret];
  if (clientId === undefined || !GSC_CLIENT_ID_PATTERN.test(clientId)) return null;
  if (clientSecret === undefined || !GSC_CLIENT_SECRET_PATTERN.test(clientSecret)) return null;
  const endpoints: Record<keyof GscEndpoints, string> = { ...GSC_ENDPOINTS };
  if (fromRuntime) {
    for (const key of Object.keys(GSC_ENDPOINT_ENV) as (keyof GscEndpoints)[]) {
      const value = sources.runtime[GSC_ENDPOINT_ENV[key]];
      if (value === undefined || value === '') continue;
      const override = overrideOf(value);
      if (override === null) return null;
      endpoints[key] = override;
    }
  }
  return { clientId, clientSecret, endpoints };
}
