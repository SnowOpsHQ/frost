import { parentPort } from 'node:worker_threads';
import { analyseSnapshot } from './analyse';

// The SEO analysis worker's entry (bundled by the Forge Vite main build as `seo-analysis.cjs`;
// acceptance `seo-schema.feature.md`, Analysis off the main thread). It runs in a `worker_threads`
// Worker with no Electron APIs; all it ever receives is `{ id, raw, context }`, the extractor's
// answer and what main collected beside it (the response and robots.txt), and all it sends back is
// `{ id, result }`.

parentPort?.on('message', (message: { readonly id: number; readonly raw: unknown; readonly context?: unknown }) => {
  parentPort?.postMessage({ id: message.id, result: analyseSnapshot(message.raw, message.context) });
});
