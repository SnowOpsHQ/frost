// Public surface of the change-intelligence engine (spec `specs/capture.spec.ts`; acceptance
// `specs/changes-diff.feature.md`). Pure TypeScript: no Electron, DOM, Node or Zod, so main (which
// stores snapshots and diffs) and the chrome (which shows them) can both import it.
export { canonicalJson, CanonicalJsonError, snapshotIdentityJson } from './canonical-json';
export { cut, diffSnapshots, EMPTY_CAPTURE_SNAPSHOT, summarize } from './diff';
export { inlineDiff, type DiffProbe } from './lcs';
