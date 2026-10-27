import { parentPort } from 'node:worker_threads';
import { robotsVerdicts } from '../devtools/robots-verdicts';
import { analyseSnapshot, analyseSpeed } from './analyse';

// The SEO analysis worker's entry (bundled by the Forge Vite main build as `seo-analysis.cjs`;
// acceptance `seo-schema.feature.md`, Analysis off the main thread). It runs in a `worker_threads`
// Worker with no Electron APIs; all it ever receives is `{ id, raw, context }`, the extractor's
// answer and what main collected beside it (the response, robots.txt and the speed measurement),
// or `{ id, kind: 'speed', raw }`, a live speed measurement (`seo-speed.feature.md`), or
// `{ id, kind: 'robots', raw }`, the devtools drawer's robots.txt verdict job (`devtools.feature.md`);
// and all it sends back is `{ id, result }`.

/** The job's result, by its kind. */
function resultOf(message: { readonly kind?: unknown; readonly raw: unknown; readonly context?: unknown }): unknown {
  if (message.kind === 'speed') return analyseSpeed(message.raw);
  if (message.kind === 'robots') return robotsVerdicts(message.raw);
  return analyseSnapshot(message.raw, message.context);
}

parentPort?.on('message', (message: { readonly id: number; readonly kind?: unknown; readonly raw: unknown; readonly context?: unknown }) => {
  parentPort?.postMessage({ id: message.id, result: resultOf(message) });
});
