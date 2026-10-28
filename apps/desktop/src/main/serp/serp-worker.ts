import { parentPort } from 'node:worker_threads';
import { analyseSerp } from './serp-analyse';

// The SERP analysis worker's entry (bundled by the Forge Vite main build as `serp-analysis.cjs`;
// spec `serp.spec.ts`, `SERP_ANALYSIS_TIMEOUT_MS`; acceptance `serp-overlay.feature.md`, Analysis).
// It runs in a `worker_threads` Worker of the SERP's own, with no Electron APIs; all it ever
// receives is `{ id, raw, params, packVersion, redirects }` (the reader's answer, the page's search
// parameters, the pack's version and the engine's click redirects) and all it sends back is `{ id, result }`, the `SerpSnapshot`
// (`analyseSerp` validates everything it is given). A message without a numeric id is dropped.

parentPort?.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const { id, raw, params, packVersion, redirects } = message as { readonly id?: unknown; readonly raw?: unknown; readonly params?: unknown; readonly packVersion?: unknown; readonly redirects?: unknown };
  if (typeof id !== 'number') return;
  parentPort?.postMessage({ id, result: analyseSerp(raw, { params, packVersion, redirects }) });
});
