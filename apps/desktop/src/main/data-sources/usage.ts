import type { DataUsageRepository, SettingsRepository } from '@app/db';
import type { DataSourcesService } from '@app/ipc-contract';
import { DATA_PROVIDERS, DATA_SERP_PROVIDERS, dataUsageMonth, dataUsageMonthBefore, resolveDataSerpProvider, type DataProvider, type DataSerpProvider, type LegalGateId } from '@app/specs/data-sources.spec';
import type { DataSerpProviderView, DataSetSerpProviderResult, DataSourcesView, DataUsageView } from '@app/specs/data-sources.schema';

// Settings › Data sources, the usage counter and the "Check via API" vendor (Phase 12 Task 2; spec
// `data-sources.spec.ts`, `DATA_USAGE_LIMITS`, `DATA_SERP_PROVIDER_KEY`; acceptance
// `data-sources.feature.md`, Usage counter and Settings). The counts come from `data_api_usage`
// (written by the client, `api-client.ts` `countRequest`); the vendor choice lives in `app_settings`.
// Main is the authority: it offers (and stores) only a vendor whose legal gate is open and whose
// slots are all set, so the renderer lists `choices` and never decides one itself. With exactly one
// vendor offered and none stored, that one is the answer (`resolveDataSerpProvider`, lead ruling).

export interface DataUsageServiceDeps {
  readonly usage: Pick<DataUsageRepository, 'counts'>;
  readonly settings: Pick<SettingsRepository, 'dataSerpProvider' | 'setDataSerpProvider'>;
  /** The keys' view (`hasKey` per provider; `service.ts`). */
  readonly status: () => Promise<DataSourcesView>;
  /** The legal gates (`gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
  readonly now?: () => number;
}

export type DataUsageService = Pick<DataSourcesService, 'usage' | 'serpProvider' | 'setSerpProvider'>;

export function createDataUsageService(deps: DataUsageServiceDeps): DataUsageService {
  const now = deps.now ?? (() => Date.now());

  /** The SERP vendors offered: gate open and every slot set, in `DATA_SERP_PROVIDERS` order. */
  const choices = async (): Promise<DataSerpProvider[]> => {
    const view = await deps.status();
    return DATA_SERP_PROVIDERS.filter((provider) => deps.isOpen(provider) && view.providers[provider].hasKey);
  };

  return {
    async usage(): Promise<DataUsageView> {
      const thisMonth = dataUsageMonth(now());
      const lastMonth = dataUsageMonthBefore(thisMonth);
      const counts = await deps.usage.counts([thisMonth, lastMonth]);
      const providers = {} as Record<DataProvider, { thisMonth: number; lastMonth: number }>;
      for (const provider of DATA_PROVIDERS) providers[provider] = { thisMonth: counts[provider]?.[0] ?? 0, lastMonth: counts[provider]?.[1] ?? 0 };
      return { thisMonth, lastMonth, providers };
    },

    async serpProvider(): Promise<DataSerpProviderView> {
      const [offered, stored] = [await choices(), await deps.settings.dataSerpProvider()];
      // The stored choice while offered; else the only one offered (lead ruling); else none.
      return { provider: resolveDataSerpProvider(stored, offered), choices: offered };
    },

    async setSerpProvider(provider: DataSerpProvider): Promise<DataSetSerpProviderResult> {
      if (!deps.isOpen(provider)) return 'unavailable';
      if (!(await choices()).includes(provider)) return 'no-key';
      return (await deps.settings.setDataSerpProvider(provider, now())) ? 'stored' : 'failed';
    },
  };
}
