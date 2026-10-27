import { parentPort } from 'node:worker_threads';
import type { ServedParseInput } from '@app/specs/seo-javascript.schema';
import { robotsVerdicts } from '../devtools/robots-verdicts';
import { analyseSnapshot, analyseSpeed } from './analyse';
import { analyseCheck } from './checks-analyse';
import { parseServedHtml } from './served-parse';

// The SEO analysis worker's entry (bundled by the Forge Vite main build as `seo-analysis.cjs`;
// acceptance `seo-schema.feature.md`, Analysis off the main thread). It runs in a `worker_threads`
// Worker with no Electron APIs; all it ever receives is `{ id, raw, context }`, the extractor's
// answer and what main collected beside it (the response, robots.txt and the speed measurement),
// or `{ id, kind, raw }` for another job kind: `speed`, a live speed measurement
// (`seo-speed.feature.md`); `served`, served HTML bytes to parse (`seo-javascript.feature.md`);
// `robots`, the devtools drawer's robots.txt verdict job (`devtools.feature.md`); `checks`, a link,
// sitemap or hreflang check's job (`seo-checks.feature.md`, sent to a worker of its own). All it
// sends back is `{ id, result }`.

/** The job's result, by its kind. */
function resultOf(message: { readonly kind?: unknown; readonly raw: unknown; readonly context?: unknown }): unknown {
  switch (message.kind) {
    case 'speed':
      return analyseSpeed(message.raw);
    case 'served':
      return parseServedHtml(message.raw as ServedParseInput);
    case 'robots':
      return robotsVerdicts(message.raw);
    case 'checks':
      return analyseCheck(message.raw);
    default:
      return analyseSnapshot(message.raw, message.context);
  }
}

parentPort?.on('message', (message: { readonly id: number; readonly kind?: unknown; readonly raw: unknown; readonly context?: unknown }) => {
  parentPort?.postMessage({ id: message.id, result: resultOf(message) });
});
