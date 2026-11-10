import type { DataProvider } from '@app/specs/data-sources.spec';
import type { DataSetKeyResult, DataSourcesSetKeyInput, DataSourcesView } from '@app/specs/data-sources.schema';

// Data sources as the `dataSources.*` procedures see them (Phase 12 Task 1; spec
// `data-sources.schema.ts`; acceptance `data-sources.feature.md`, Keys). Main implements it
// (`apps/desktop/src/main/data-sources/service.ts`); this package only knows the interface. No
// member answers a key: the renderer sets and clears keys and learns `hasKey` and `available` only.

export interface DataSourcesService {
  /** How well keys are protected here, and per provider whether all its slots hold a key and whether its legal gate is open. */
  status(): Promise<DataSourcesView>;
  /** Stores the provider's key (or DataForSEO's login and/or password); `unavailable` while its legal gate is closed. */
  setKey(input: DataSourcesSetKeyInput): Promise<DataSetKeyResult>;
  /** Clears every slot of `provider` (never gated); whether it worked. */
  clearKey(provider: DataProvider): Promise<boolean>;
}
