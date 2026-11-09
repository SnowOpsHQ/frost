import { searchIdentityJson, type SearchKeyOf } from '@app/specs/rankings.spec';
import { searchHostOf } from '@app/specs/rankings-url.spec';
import { sha256Hex } from './snapshot';

// The search key (Phase 10, plan Decision 4; acceptance `rankings.feature.md`, The search key and its
// version): one function for the capture that writes a reading (`service.ts`) and every rankings read
// (`rankings.ts`), so the key a reading is stored under and the key a saved search is looked up by can
// never drift apart (whole-branch review ruling). Main only: it hashes, and `@app/change-intel` stays
// free of hashing and `URL` (the read model takes it injected, `SearchKeyOf`).

/**
 * The current-version search key of a search: SHA-256 hex of `searchIdentityJson(params, filters,
 * searchHostOf(params.url))`; `null` when its URL has no host.
 */
export const searchKeyOf: SearchKeyOf = (params, filters) => {
  const host = searchHostOf(params.url);
  return host === null ? null : sha256Hex(searchIdentityJson(params, filters, host));
};
