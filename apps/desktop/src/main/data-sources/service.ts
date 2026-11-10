import type { DataSourcesService } from '@app/ipc-contract';
import { DATA_PROVIDER_SLOTS, DATA_PROVIDERS, normalizeDataSecret, type DataCredentialSlot, type DataProvider, type LegalGateId } from '@app/specs/data-sources.spec';
import type { DataSetKeyResult, DataSourcesSetKeyInput, DataSourcesView } from '@app/specs/data-sources.schema';
import type { CredentialSettings } from '../agent/credentials';

// Settings › Data sources, main side (Phase 12 Task 1; spec `data-sources.schema.ts`; acceptance
// `data-sources.feature.md`, Keys and Legal gates). It only gets the store's settings view
// (`CredentialSettings`: no `withKey`), so nothing here can read a key back. Main is the authority
// for each provider's legal gate: setting a key for a gated provider answers `unavailable` (nothing
// stored); clearing is never gated.

export interface DataSourcesServiceDeps {
  readonly store: CredentialSettings<DataCredentialSlot>;
  /** The legal gates (`gates.ts`; tests open them by injection). */
  readonly isOpen: (id: LegalGateId) => boolean;
}

/** The keys' part of `DataSourcesService` (Task 2's usage and SERP vendor members are `usage.ts`'s). */
export type DataKeysService = Pick<DataSourcesService, 'status' | 'setKey' | 'clearKey'>;

export function createDataSourcesService(deps: DataSourcesServiceDeps): DataKeysService {
  const { store, isOpen } = deps;

  /** How many of the provider's slots hold a key, and how many it has. */
  const slotsSet = async (provider: DataProvider): Promise<{ readonly set: number; readonly of: number }> => {
    const slots = DATA_PROVIDER_SLOTS[provider];
    let set = 0;
    for (const slot of slots) if (await store.hasKey(slot)) set += 1;
    return { set, of: slots.length };
  };

  /** Stores each `[slot, value]` in order after every value passed `normalizeDataSecret` (so an invalid half stores nothing). */
  const storeAll = async (entries: readonly (readonly [DataCredentialSlot, string])[]): Promise<DataSetKeyResult> => {
    if (entries.some(([slot, value]) => normalizeDataSecret(slot, value) === null)) return 'invalid';
    for (const [slot, value] of entries) {
      const result = await store.setKey(slot, value);
      if (result !== 'stored') return result;
    }
    return 'stored';
  };

  return {
    async status(): Promise<DataSourcesView> {
      const providers = {} as Record<DataProvider, { hasKey: boolean; partial: boolean; available: boolean }>;
      for (const provider of DATA_PROVIDERS) {
        const { set, of } = await slotsSet(provider);
        // `partial`: some but not all slots (DataForSEO's login or password alone), so it can be cleared.
        providers[provider] = { hasKey: set === of, partial: set > 0 && set < of, available: isOpen(provider) };
      }
      return { protection: await store.protection(), providers };
    },

    async setKey(input: DataSourcesSetKeyInput): Promise<DataSetKeyResult> {
      if (!isOpen(input.provider)) return 'unavailable';
      if (input.provider === 'dataforseo') {
        const entries: (readonly [DataCredentialSlot, string])[] = [];
        if (input.login !== undefined) entries.push(['dataforseo-login', input.login]);
        if (input.password !== undefined) entries.push(['dataforseo-password', input.password]);
        return entries.length === 0 ? 'invalid' : storeAll(entries);
      }
      return storeAll([[input.provider, input.key]]);
    },

    async clearKey(provider: DataProvider): Promise<boolean> {
      let cleared = true;
      for (const slot of DATA_PROVIDER_SLOTS[provider] ?? []) cleared = (await store.clearKey(slot)) && cleared;
      return cleared;
    },
  };
}
