import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_API_E2E_SWITCH, DATA_API_PARTITION, DATA_CREDENTIALS_FILE, LEGAL_GATES_E2E_SWITCH, type DataProvider } from '@app/specs/data-sources.spec';
import type { ChangeIntelRepository, DataUsageRepository, SettingsRepository } from '@app/db';
import type { DataSourcesService } from '@app/ipc-contract';
import { credentialSettings, type CredentialFs, type SafeStorageLike } from '../agent/credentials';
import { createDataApiClient, type DataApiClient } from './api-client';
import { createDataCredentialStore } from './credentials';
import { dataApiE2eSeamFrom } from './e2e-seam';
import { createLegalGates, type LegalGates } from './gates';
import { createProjectCheck, type ProjectCheckDeps } from './project-check';
import { createDataSourcesService } from './service';
import { createDataUsageService } from './usage';

// Data sources' main-side composition (Phase 12 Task 1; plan Decision 4; acceptance
// `data-sources.feature.md`): the legal gates, the key store in `userData`, the API client on the
// in-memory `frost-data-api` session (the e2e seam honoured only unpackaged), counting each request
// it sends in the usage counter (Task 2), and the settings service for the `dataSources.*` IPC.
// Task 4: "Check via API" into a project's readings (`project-check.ts`), over the change store, the SERP
// worker's `api` job and the project's retention (`checks`; without them both procedures answer
// `unavailable` and send nothing).
// Main wires it with one line, after app ready. Only the client gets the store itself; the service
// gets its settings view, which has no way to read a key.

/** The Electron pieces the data sources use (main passes the real ones). */
export interface DataSourcesElectron {
  readonly app: {
    readonly isPackaged: boolean;
    getPath(name: 'userData'): string;
    readonly commandLine: { getSwitchValue(name: string): string };
  };
  readonly session: { fromPartition(partition: string): { fetch(url: string, init: RequestInit): Promise<Response> } };
  readonly safeStorage: SafeStorageLike;
  /** One line per event; never a key, a URL query or a body. */
  readonly log?: (line: string) => void;
  /** File operations (default `node:fs/promises`). */
  readonly fs?: CredentialFs;
  /** Reads the e2e seam file (default `node:fs`, bounded; tests pass a spy). */
  readonly readSeamFile?: (file: string, maxBytes: number) => string | null;
  /** `process.platform` (the key store's protection report). */
  readonly platform?: NodeJS.Platform;
}

/** The session store's pieces the data sources use (Task 2; main passes `sessionStore.*`). */
export interface DataSourcesStores {
  /** The usage counter (`data_api_usage`): the client counts each request it sends. */
  readonly usage: Pick<DataUsageRepository, 'increment' | 'counts'>;
  /** `app_settings`: which SERP vendor "Check via API" uses. */
  readonly settings: Pick<SettingsRepository, 'dataSerpProvider' | 'setDataSerpProvider'>;
  readonly now?: () => number;
}

/** Task 4's pieces from the rest of main ("Check via API" into a project's readings). */
export interface DataSourcesChecks {
  /** `SessionStore.changeIntel`: the project's saved searches, and where API readings are written. */
  readonly store: Pick<ChangeIntelRepository, 'project' | 'projectQueries' | 'appendApiReading'>;
  /** The SERP worker's `api` job (`serp.analyseApi`). */
  readonly parse: ProjectCheckDeps['parse'];
  /** The project's retention after a check stored readings (`projects.afterApiCheck`). */
  readonly afterWrite: (projectId: string) => void;
}

export interface DataSourcesMain {
  /** The legal gates every gated main entry reads (`isOpen`). */
  readonly gates: LegalGates;
  /** `dataApiRequest`: the one reviewed path to a provider's API (Tasks 3, 4 and 8 call it). */
  readonly client: DataApiClient;
  /** For `dataSources.*` (status, setKey, clearKey; Task 2: usage, serpProvider, setSerpProvider; Task 4: checkPlan, checkProjectSearches). */
  readonly service: DataSourcesService;
}

export function setupDataSources(deps: DataSourcesElectron & DataSourcesStores & { readonly checks?: DataSourcesChecks }): DataSourcesMain {
  const { app } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);
  const gates = createLegalGates({ switchValue: app.commandLine.getSwitchValue(LEGAL_GATES_E2E_SWITCH), packaged: app.isPackaged });
  const isOpen = gates.isOpen.bind(gates);
  const store = createDataCredentialStore({ safeStorage: deps.safeStorage, file: path.join(app.getPath('userData'), DATA_CREDENTIALS_FILE), fs: deps.fs ?? fs, log, ...(deps.platform ? { platform: deps.platform } : {}) });
  const seam = dataApiE2eSeamFrom({ packaged: app.isPackaged, switchValue: app.commandLine.getSwitchValue(DATA_API_E2E_SWITCH), log, ...(deps.readSeamFile ? { readFile: deps.readSeamFile } : {}) });
  const countRequest = async (provider: DataProvider) => void (await deps.usage.increment(provider, now()));
  const client = createDataApiClient({ store, isOpen, fetch: (url, init) => deps.session.fromPartition(DATA_API_PARTITION).fetch(url, init), seam, log, countRequest });
  const keys = createDataSourcesService({ store: credentialSettings(store), isOpen });
  const usage = createDataUsageService({ usage: deps.usage, settings: deps.settings, status: () => keys.status(), isOpen, now });
  const checks = deps.checks;
  const projectCheck = checks
    ? createProjectCheck({ store: checks.store, client, isOpen, serpProvider: () => usage.serpProvider(), parse: checks.parse, afterWrite: checks.afterWrite, now, log })
    : { checkPlan: async () => ({ status: 'refused', reason: 'unavailable' }) as const, checkProjectSearches: async () => ({ status: 'refused', reason: 'unavailable' }) as const };
  const service: DataSourcesService = { ...keys, ...usage, checkPlan: (input) => projectCheck.checkPlan(input), checkProjectSearches: (input) => projectCheck.checkProjectSearches(input) };
  return { gates, client, service };
}
