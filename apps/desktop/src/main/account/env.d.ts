// The build-time public values main reads (`config.ts`). Vite replaces each
// `import.meta.env.FROST_PUBLIC_*` statically (`envPrefix` in `vite.main.config.ts`); never a secret.
interface ImportMetaEnv {
  readonly FROST_PUBLIC_API_BASE_URL?: string;
  readonly FROST_PUBLIC_ENTITLEMENT_JWKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
