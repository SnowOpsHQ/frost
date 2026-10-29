// The build-time Search Console values main reads (`config.ts`), merged into the `ImportMetaEnv` that
// `../account/env.d.ts` declares. Vite replaces each `import.meta.env.FROST_PUBLIC_*` statically
// (`envPrefix` in `vite.main.config.ts`). The installed-app client secret is not confidential by
// Google's own definition; it is still never committed.
interface ImportMetaEnv {
  readonly FROST_PUBLIC_GSC_CLIENT_ID?: string;
  readonly FROST_PUBLIC_GSC_CLIENT_SECRET?: string;
}
