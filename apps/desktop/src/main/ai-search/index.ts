import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DataSourcesView } from '@app/specs/data-sources.schema';
import type { AnalysisWorker } from '../seo/analysis';
import type { DataSourcesMain } from '../data-sources';
import { createAiAnswerParser } from './parser';
import { createAiSearchService, type AiSearchService, type AiSearchSettingsReader } from './service';

// AI search's main-side composition (Phase 12 Task 8; acceptance `specs/ai-search.feature.md`,
// Wiring): the service over the data sources' client, legal gates and key status (never the key
// store itself), the stored settings (`sessionStore.settings`), and a SERP worker of AI search's own
// for the answers' parse (`serp-analysis.cjs`, `worker_threads`, a capped heap, as the SERP's own),
// disposed on `will-quit`. Main wires it with one line after the data sources, and hands it to the
// agent: `aiSearch` (the broker's context) and `serpAdapter(serp.readApi, aiSearchAdapter(aiSearch))`.

export interface AiSearchSetupDeps {
  readonly app: { once(event: 'will-quit', listener: () => void): unknown };
  /** `setupDataSources(…)`: the client, the gates and the keys' status. */
  readonly dataSources: Pick<DataSourcesMain, 'client' | 'gates'> & { readonly service: { status(): Promise<DataSourcesView> } };
  /** `sessionStore.settings`. */
  readonly settings: AiSearchSettingsReader;
  readonly log?: (line: string) => void;
  /** Test seam: the parse worker. */
  readonly spawn?: () => AnalysisWorker;
}

export function setupAiSearch(deps: AiSearchSetupDeps): AiSearchService {
  const parser = createAiAnswerParser({
    spawn: deps.spawn ?? (() => new Worker(path.join(__dirname, 'serp-analysis.cjs'), { resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } })),
  });
  deps.app.once('will-quit', () => parser.dispose());
  return createAiSearchService({
    client: deps.dataSources.client,
    isOpen: (id) => deps.dataSources.gates.isOpen(id),
    keys: async () => {
      const view = await deps.dataSources.service.status();
      return { perplexity: view.providers.perplexity.hasKey, 'openai-search': view.providers['openai-search'].hasKey };
    },
    settings: deps.settings,
    parse: (job) => parser.parse(job),
    ...(deps.log ? { log: deps.log } : {}),
  });
}

export { createAiSearchService, type AiSearchService, type AiSearchServiceDeps, type AiSearchSettingsReader, type AiSearchViewQuery, type AiSearchViewResult } from './service';
export { createAiAnswerParser, type AiAnswerParser } from './parser';
