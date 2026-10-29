import { bakedAny, runtimeOverridesAllowed, type PublicEnv } from '@app/specs/build-config.spec';

// The build's public configuration, one rule for all of it (spec `build-config.spec.ts`): if any
// `FROST_PUBLIC_*` value (the account's, telemetry's, Search Console's) is baked into the build, the
// run-time environment is read for none of them (nor for the `FROST_GSC_*` fakes); only an unpackaged
// build with nothing baked in (dev, e2e) reads it. `../account/config.ts`, `../telemetry/config.ts` and
// `../gsc/config.ts` each decide with `runtimeOverridesAllowed`, given `buildTimePublicEnv()`.

export { bakedAny, runtimeOverridesAllowed, type PublicEnv };

/** Every public value Vite baked into this bundle (each `undefined` when the build had none). */
export function buildTimePublicEnv(): PublicEnv {
  // Written out literally: Vite replaces each `import.meta.env.<NAME>` expression statically
  // (`envPrefix` in `vite.main.config.ts`; declared in each module's `env.d.ts`).
  return {
    FROST_PUBLIC_API_BASE_URL: import.meta.env.FROST_PUBLIC_API_BASE_URL,
    FROST_PUBLIC_ENTITLEMENT_JWKS: import.meta.env.FROST_PUBLIC_ENTITLEMENT_JWKS,
    FROST_PUBLIC_SENTRY_DSN: import.meta.env.FROST_PUBLIC_SENTRY_DSN,
    FROST_PUBLIC_OTEL_ENDPOINT: import.meta.env.FROST_PUBLIC_OTEL_ENDPOINT,
    FROST_PUBLIC_GSC_CLIENT_ID: import.meta.env.FROST_PUBLIC_GSC_CLIENT_ID,
    FROST_PUBLIC_GSC_CLIENT_SECRET: import.meta.env.FROST_PUBLIC_GSC_CLIENT_SECRET,
  };
}
