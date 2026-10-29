// Zod without generated code (Task 3 review): the runtime's lockdown stops code generation from
// strings, and Zod decides whether to compile a fast parser (`new Function`) once per schema, when
// the schema is built, at import time, long before the lockdown runs. So the runtime puts Zod in
// `jitless` mode first, before any module that builds a schema loads: `index.ts` imports this
// module first. Zod reads its configuration from `globalThis.__zod_globalConfig` when it loads
// (`zod/v4/core`), so setting it there first is the only way to reach the schemas built at load;
// `jitless-zod` (lockdown.test.ts) checks that Zod sees it.
const holder = globalThis as { __zod_globalConfig?: Record<string, unknown> };
// The same object Zod keeps (created here when Zod has not loaded yet, which is the runtime's case).
(holder.__zod_globalConfig ??= {}).jitless = true;

export {};
