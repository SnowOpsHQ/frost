// Test fakes for the data sources (Phase 12 Task 1): a data credential store over the agent's memory
// fs and fake `safeStorage`, a recording fetch, and an all-open gate.
import { vi } from 'vitest';
import type { LegalGateId } from '@app/specs/data-sources.spec';
import { createFakeSafeStorage, createMemoryFs } from '../../agent/__tests__/fakes';
import { createDataCredentialStore } from '../credentials';

export const FILE = '/user-data/data-credentials.json';
export const SERPAPI_KEY = 'serpapi-0123456789abcdefSECRETKEY';
export const SERPER_KEY = 'serper-0123456789abcdefSECRETKEY';
export const PERPLEXITY_KEY = 'pplx-0123456789abcdefSECRETKEY';
export const OPENAI_KEY = 'sk-search-0123456789abcdefSECRETKEY';
export const DFS_LOGIN = 'owner@frost.example';
export const DFS_PASSWORD = 'dfs-0123456789abcdefSECRETPASS';
export const ALL_SECRETS = [SERPAPI_KEY, SERPER_KEY, PERPLEXITY_KEY, OPENAI_KEY, DFS_LOGIN, DFS_PASSWORD, 'SECRETKEY', 'SECRETPASS'];

export const allOpen = (_id: LegalGateId): boolean => true;

export function dataStore(options: { available?: boolean; weak?: boolean; platform?: NodeJS.Platform } = {}) {
  const memory = createMemoryFs();
  const safe = createFakeSafeStorage(options);
  const log = vi.fn<(line: string) => void>();
  let n = 0;
  const store = createDataCredentialStore({ safeStorage: safe.storage, file: FILE, fs: memory.fs, platform: options.platform ?? 'linux', log, tempSuffix: () => `t${(n += 1)}` });
  return { store, memory, safe, log };
}

export interface RecordedFetch {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that records each call and answers `answer(url, init)` (a `Response`, or a thrown error). */
export function recordingFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('{"ok":true}', { status: 200 })) {
  const calls: RecordedFetch[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  });
  return { fetch, calls };
}
