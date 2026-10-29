/**
 * The build's public configuration, one rule for all of it (Phase 4; plan "Configuration"; acceptance
 * `account-signin.feature.md`, `telemetry.feature.md` (Desktop) and `gsc.feature.md`, Configuration).
 *
 * Public values (`FROST_PUBLIC_*`, never a secret) are baked into a build by Vite (`import.meta.env`,
 * `envPrefix` `FROST_PUBLIC_`). **If any one of `PUBLIC_CONFIG_ENV` is baked into the build, the
 * run-time environment is read for none of them** (nor for the unpackaged-only `FROST_GSC_*` fakes):
 * a build made with real values is pinned to them as a whole, so a swapped variable can neither point
 * the account at a look-alike backend, swap the snapshot keys, redirect telemetry, nor send Google
 * codes and refresh tokens to another token endpoint. Only an **unpackaged** build with nothing baked
 * in at all (dev, e2e: a source build has no real values to protect) reads them from its run-time
 * environment. `app.isPackaged` alone is not the guard: it only looks at the executable's name.
 *
 * Main-only (it imports the modules' Zod specs).
 */
import { ACCOUNT_CONFIG_ENV } from './account-state.schema';
import { GSC_CONFIG_ENV } from './gsc.spec';
import { TELEMETRY_CONFIG_ENV } from './telemetry-consent.schema';

/** Every public build value main reads: the account's, telemetry's and Search Console's. */
export const PUBLIC_CONFIG_ENV = Object.freeze([...Object.values(ACCOUNT_CONFIG_ENV), ...Object.values(TELEMETRY_CONFIG_ENV), ...Object.values(GSC_CONFIG_ENV)] as const);
export type PublicConfigEnvName = (typeof ACCOUNT_CONFIG_ENV)[keyof typeof ACCOUNT_CONFIG_ENV] | (typeof TELEMETRY_CONFIG_ENV)[keyof typeof TELEMETRY_CONFIG_ENV] | (typeof GSC_CONFIG_ENV)[keyof typeof GSC_CONFIG_ENV];

/** The values a build has baked in (each `undefined` or `''` when it has none). */
export type PublicEnv = Partial<Record<PublicConfigEnvName, string | undefined>>;

/** Whether any `PUBLIC_CONFIG_ENV` value is baked into the build (a non-empty value). */
export function bakedAny(buildTime: PublicEnv): boolean {
  return PUBLIC_CONFIG_ENV.some((name) => (buildTime[name] ?? '') !== '');
}

/** Whether this build reads its configuration from the run-time environment: unpackaged, with nothing baked in. */
export function runtimeOverridesAllowed(isPackaged: boolean, buildTime: PublicEnv): boolean {
  return !isPackaged && !bakedAny(buildTime);
}
