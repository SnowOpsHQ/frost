import { NOINDEX_VERDICT_NAMES } from '@app/specs/seo-indexability.spec';

// Whose noindex decides the verdict (spec `seo-indexability.spec.ts`, `NOINDEX_VERDICT_NAMES`): the
// generic robots tag and Googlebot's; another crawler's is a warning naming it.

const VERDICT_NAMES: ReadonlySet<string> = new Set(NOINDEX_VERDICT_NAMES);

/** Which tags a check reads: all of them, those that decide the verdict (`NOINDEX_VERDICT_NAMES`), or the other crawlers'. */
export type NoindexScope = 'all' | 'verdict' | 'other';

/** Whether a robots name (`robots` for the generic tag) is in `scope`. */
export function inScope(name: string, scope: NoindexScope): boolean {
  return scope === 'all' || (scope === 'verdict') === VERDICT_NAMES.has(name);
}
