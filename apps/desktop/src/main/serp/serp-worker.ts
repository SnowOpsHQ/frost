import { parentPort } from 'node:worker_threads';
import { runProbeJob } from './probe-parse';
import { analyseSerp } from './serp-analyse';

// The SERP analysis worker's entry (bundled by the Forge Vite main build as `serp-analysis.cjs`;
// spec `serp.spec.ts`, `SERP_ANALYSIS_TIMEOUT_MS`; acceptance `serp-overlay.feature.md`, Analysis).
// It runs in a `worker_threads` Worker of the SERP's own, with no Electron APIs; all it ever
// receives is `{ id, raw, params, packVersion, redirects }` (the reader's answer, the page's search
// parameters, the pack's version and the engine's click redirects) and all it sends back is `{ id, result }`, the `SerpSnapshot`
// (`analyseSerp` validates everything it is given). A message without a numeric id is dropped.
//
// The visibility probes (Phase 3 Task 5, `visibility-probes.spec.ts`) run their own instance of this
// worker (`probe-parser.ts`): `{ id, kind: 'probe', job }` is answered `{ id, result }` by
// `runProbeJob`, which validates the job (`ProbeJobSchema`) and its answer.

parentPort?.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null) return;
  const { id, kind, job, raw, params, packVersion, redirects } = message as { readonly id?: unknown; readonly kind?: unknown; readonly job?: unknown; readonly raw?: unknown; readonly params?: unknown; readonly packVersion?: unknown; readonly redirects?: unknown };
  if (typeof id !== 'number') return;
  if (kind === 'probe') {
    parentPort?.postMessage({ id, result: runProbeJob(job) });
    return;
  }
  parentPort?.postMessage({ id, result: analyseSerp(raw, { params, packVersion, redirects }) });
});
