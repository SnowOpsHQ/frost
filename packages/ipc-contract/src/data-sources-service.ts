import type { DataProvider, DataSerpProvider } from '@app/specs/data-sources.spec';
import type {
  DataCheckPlan,
  DataCheckPlanInput,
  DataCheckProjectAnswer,
  DataCheckProjectInput,
  DataSerpProviderView,
  DataSetKeyResult,
  DataSetSerpProviderResult,
  DataSourcesSetKeyInput,
  DataSourcesView,
  DataUsageView,
} from '@app/specs/data-sources.schema';

// Data sources as the `dataSources.*` procedures see them (Phase 12 Task 1; spec
// `data-sources.schema.ts`; acceptance `data-sources.feature.md`, Keys; Task 2: usage and the SERP vendor). Main implements it
// (`apps/desktop/src/main/data-sources/service.ts`); this package only knows the interface. No
// member answers a key: the renderer sets and clears keys and learns `hasKey` and `available` only.

export interface DataSourcesService {
  /** How well keys are protected here, and per provider whether all its slots hold a key and whether its legal gate is open. */
  status(): Promise<DataSourcesView>;
  /** Stores the provider's key (or DataForSEO's login and/or password); `unavailable` while its legal gate is closed. */
  setKey(input: DataSourcesSetKeyInput): Promise<DataSetKeyResult>;
  /** Clears every slot of `provider` (never gated); whether it worked. */
  clearKey(provider: DataProvider): Promise<boolean>;
  /** Task 2: requests sent per provider this UTC month and last (the local counter). */
  usage(): Promise<DataUsageView>;
  /** Task 2: which SERP vendor "Check via API" uses, and the vendors offered for it (gate open and key set). */
  serpProvider(): Promise<DataSerpProviderView>;
  /** Task 2: stores the choice; `unavailable` while its legal gate is closed, `no-key` without its key. */
  setSerpProvider(provider: DataSerpProvider): Promise<DataSetSerpProviderResult>;
  /** Task 4: what a "Check via API" of the project's saved searches would send (the vendor, the requests), or why none; sends nothing. */
  checkPlan(input: DataCheckPlanInput): Promise<DataCheckPlan>;
  /** Task 4: checks them via the vendor (as confirmed: `changed` otherwise), storing each answer as an API reading. */
  checkProjectSearches(input: DataCheckProjectInput): Promise<DataCheckProjectAnswer>;
}
