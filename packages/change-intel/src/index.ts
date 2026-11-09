// Public surface of the change-intelligence engine (spec `specs/capture.spec.ts`; acceptance
// `specs/changes-diff.feature.md`). Pure TypeScript: no Electron, DOM, Node or Zod, so main (which
// stores snapshots and diffs) and the chrome (which shows them) can both import it.
export { canonicalJson, CanonicalJsonError, snapshotIdentityJson } from './canonical-json';
export { cut, diffSnapshots, EMPTY_CAPTURE_SNAPSHOT, summarize } from './diff';
export { inlineDiff, type DiffProbe } from './lcs';
// The rank read model and SERP comparison (Phase 10 Task 3; spec `specs/rankings.spec.ts`; acceptance
// `specs/rankings.feature.md`).
export { changeOf, rankCsvRows, rankOf, rankSeries, rankTable, type RankCsvCell, type RankModelOptions, type RankRangeOptions, type RankTableOptions } from './rankings';
export { compareSerps, type CompareOptions } from './compare';
