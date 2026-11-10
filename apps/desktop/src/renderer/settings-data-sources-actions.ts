import type { DataProvider, DataSerpProvider } from '@app/specs/data-sources.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type { DataSerpProviderView, DataSetKeyResult, DataSetSerpProviderResult, DataSourcesSetKeyInput, DataSourcesView, DataUsageView } from '@app/specs/data-sources.schema';
import { ipc } from './ipc';

// Settings › Data sources' calls to main (Phase 12 Tasks 1–2; `data-sources-router.ts`, every one
// behind `enforceSender`). Reads answer `null` on an IPC failure; writes answer `failed` (or `false`).
// `setKey` is the only place a key crosses IPC (renderer → main); no answer carries one.

export const dataSourcesActions = {
  status: (): Promise<DataSourcesView | null> => ipc.dataSources.status.query().catch(() => null),
  usage: (): Promise<DataUsageView | null> => ipc.dataSources.usage.query().catch(() => null),
  serpProvider: (): Promise<DataSerpProviderView | null> => ipc.dataSources.serpProvider.query().catch(() => null),
  setKey: (input: DataSourcesSetKeyInput): Promise<DataSetKeyResult> => ipc.dataSources.setKey.mutate(input).catch(() => 'failed' as const),
  clearKey: (provider: DataProvider): Promise<boolean> => ipc.dataSources.clearKey.mutate({ provider }).catch(() => false),
  setSerpProvider: (provider: DataSerpProvider): Promise<DataSetSerpProviderResult> => ipc.dataSources.setSerpProvider.mutate({ provider }).catch(() => 'failed' as const),
};
