import { installMainLogRing } from './main';

// Imported for its side effect, first thing in `main/index.ts` (Phase 11 Task 12; acceptance
// `diagnostics.feature.md`): the diagnostics ring wraps main's `console.warn` / `console.error` before
// any other module of main runs, so their warnings are kept (scrubbed) too.
installMainLogRing();
