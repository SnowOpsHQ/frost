// The build-time telemetry values main reads (`config.ts`), merged into the `ImportMetaEnv` that
// `../account/env.d.ts` declares. Vite replaces each `import.meta.env.FROST_PUBLIC_*` statically
// (`envPrefix` in `vite.main.config.ts`); public values only, never a secret.
interface ImportMetaEnv {
  readonly FROST_PUBLIC_SENTRY_DSN?: string;
  readonly FROST_PUBLIC_OTEL_ENDPOINT?: string;
}
