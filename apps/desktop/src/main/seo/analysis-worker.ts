import { parentPort } from 'node:worker_threads';
import { analyseSnapshot, analyseSpeed } from './analyse';

// The SEO analysis worker's entry (bundled by the Forge Vite main build as `seo-analysis.cjs`;
// acceptance `seo-schema.feature.md`, Analysis off the main thread). It runs in a `worker_threads`
// Worker with no Electron APIs; all it ever receives is `{ id, raw, context }`, the extractor's
// answer and what main collected beside it (the response, robots.txt and the speed measurement),
// or `{ id, kind: 'speed', raw }`, a live speed measurement (`seo-speed.feature.md`); and all it
// sends back is `{ id, result }`.

parentPort?.on('message', (message: { readonly id: number; readonly kind?: unknown; readonly raw: unknown; readonly context?: unknown }) => {
  parentPort?.postMessage({ id: message.id, result: message.kind === 'speed' ? analyseSpeed(message.raw) : analyseSnapshot(message.raw, message.context) });
});
