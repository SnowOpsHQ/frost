import type { DataProvider, DataSerpProvider } from '@app/specs/data-sources.spec';
// Type-only from the Zod schema (its schemas must stay out of this bundle: strict Trusted Types).
import type {
  DataCheckPlan,
  DataCheckProjectAnswer,
  DataCheckProjectInput,
  DataSerpProviderView,
  DataSetKeyResult,
  DataSetSerpProviderResult,
  DataSourcesSetKeyInput,
  DataSourcesView,
  DataUsageView,
} from '@app/specs/data-sources.schema';
import { ipc } from './ipc';

// Settings › Data sources' calls to main (Phase 12 Tasks 1–2; `data-sources-router.ts`, every one
// behind `enforceSender`). Reads answer `null` on an IPC failure; writes answer `failed` (or `false`).
// `setKey` is the only place a key crosses IPC (renderer → main); no answer carries one. Task 4's
// "Check via API" calls (`checkPlan`, `checkProjectSearches`) answer `null` on any failure (never throw).

export const dataSourcesActions = {
  status: (): Promise<DataSourcesView | null> => ipc.dataSources.status.query().catch(() => null),
  usage: (): Promise<DataUsageView | null> => ipc.dataSources.usage.query().catch(() => null),
  serpProvider: (): Promise<DataSerpProviderView | null> => ipc.dataSources.serpProvider.query().catch(() => null),
  setKey: (input: DataSourcesSetKeyInput): Promise<DataSetKeyResult> => ipc.dataSources.setKey.mutate(input).catch(() => 'failed' as const),
  clearKey: (provider: DataProvider): Promise<boolean> => ipc.dataSources.clearKey.mutate({ provider }).catch(() => false),
  setSerpProvider: (provider: DataSerpProvider): Promise<DataSetSerpProviderResult> => ipc.dataSources.setSerpProvider.mutate({ provider }).catch(() => 'failed' as const),
  /** Task 4: what a check of the project's saved searches would send (main's vendor and count), or why none. */
  checkPlan: async (projectId: string): Promise<DataCheckPlan | null> => {
    try {
      return await ipc.dataSources.checkPlan.query({ projectId });
    } catch {
      return null;
    }
  },
  /** Task 4: the check, as the user confirmed it (the vendor and the count shown). */
  checkProjectSearches: async (input: DataCheckProjectInput): Promise<DataCheckProjectAnswer | null> => {
    try {
      return await ipc.dataSources.checkProjectSearches.mutate(input);
    } catch {
      return null;
    }
  },
};
