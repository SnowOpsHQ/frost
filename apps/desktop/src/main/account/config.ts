import { ACCOUNT_CONFIG_ENV, UNPACKAGED_HTTP_API_HOSTS } from '@app/specs/account-state.schema';
import { EntitlementJwksSchema, type EntitlementJwks } from '@app/specs/entitlements-snapshot.spec';

// The build's account configuration (spec `account-state.schema.ts`, `ACCOUNT_CONFIG_ENV`; acceptance
// `account-signin.feature.md`, Configuration; plan "Configuration"). Public values only: an API base
// and the JWKS of the keys that sign entitlement snapshots. Baked in at build time (Vite replaces
// `import.meta.env.FROST_PUBLIC_*`, `envPrefix` in `vite.main.config.ts`).
//
// A build that has a value baked in never reads it from the run-time environment: if either value is
// baked in, the environment is ignored for both (a swapped JWKS would self-sign `pro`, a swapped base
// would open a look-alike authorize page). `app.isPackaged` is not the guard: it only looks at the
// executable's name, so a renamed installed app reads as unpackaged. Only an unpackaged build with
// neither value baked in (dev, e2e: a source build has no real keys to protect) reads the
// environment. Packaged requires `https:`.

type EnvName = (typeof ACCOUNT_CONFIG_ENV)[keyof typeof ACCOUNT_CONFIG_ENV];
export type AccountEnv = Partial<Record<EnvName, string | undefined>>;

export interface AccountConfig {
  /** The API's origin (`https://api.example.com`, no trailing slash). */
  readonly apiBase: string;
  /** The keys snapshots are verified against. */
  readonly jwks: EntitlementJwks;
}

export interface AccountConfigSources {
  readonly isPackaged: boolean;
  /** The values baked into the build (`buildTimeAccountEnv()`). */
  readonly buildTime: AccountEnv;
  /** The run-time environment (`process.env`); read only unpackaged, and only with nothing baked in. */
  readonly runtime: Readonly<Record<string, string | undefined>>;
}

/** The values Vite baked into this bundle (each `undefined` when the build had none). */
export function buildTimeAccountEnv(): AccountEnv {
  // Written out literally: Vite replaces each `import.meta.env.<NAME>` expression statically.
  return {
    FROST_PUBLIC_API_BASE_URL: import.meta.env.FROST_PUBLIC_API_BASE_URL,
    FROST_PUBLIC_ENTITLEMENT_JWKS: import.meta.env.FROST_PUBLIC_ENTITLEMENT_JWKS,
  };
}

/** The API base as an origin, or `null` when it is not allowed for this build. */
function apiBaseOf(value: string | undefined, isPackaged: boolean): string | null {
  if (value === undefined || value === '' || value.trim() !== value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.pathname !== '/') return null;
  // Exactly an origin (the parser repairs some inputs, such as `https:api`): it must read back as written.
  if (value !== url.origin && value !== `${url.origin}/`) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && !isPackaged && UNPACKAGED_HTTP_API_HOSTS.includes(url.hostname)) return url.origin;
  return null;
}

function jwksOf(value: string | undefined): EntitlementJwks | null {
  if (value === undefined || value === '') return null;
  try {
    const parsed = EntitlementJwksSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The account configuration for this build, or `null` (unconfigured: nothing is sent anywhere). */
export function resolveAccountConfig(sources: AccountConfigSources): AccountConfig | null {
  const baked = Object.values(ACCOUNT_CONFIG_ENV).some((name) => (sources.buildTime[name] ?? '') !== '');
  const source = sources.isPackaged || baked ? sources.buildTime : sources.runtime;
  const pick = (name: EnvName): string | undefined => source[name];
  const apiBase = apiBaseOf(pick(ACCOUNT_CONFIG_ENV.apiBaseUrl), sources.isPackaged);
  const jwks = jwksOf(pick(ACCOUNT_CONFIG_ENV.entitlementJwks));
  return apiBase !== null && jwks !== null ? { apiBase, jwks } : null;
}
