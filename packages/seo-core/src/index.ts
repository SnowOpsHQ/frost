// Public surface of the SEO engine (spec `specs/seo-rules.spec.ts`, `specs/seo-snapshot.spec.ts`;
// acceptance `specs/seo-rules.feature.md`). Pure TypeScript: no Electron, DOM, Node or Zod at
// runtime, so main and the chrome renderer can both import it.
export { countSeverities, pageFacts, panelStatus, rankFindings, runAudit, scoreAudit, scoreBand } from './audit';
export { RULES } from './rules';
export type {
  CappedText,
  Finding,
  FindingDetails,
  FindingFact,
  PageFacts,
  PageHeading,
  PageImage,
  PageLink,
  PageSnapshot,
  SeoAudit,
  SeoAuditResponse,
  SeoRule,
  SeverityCounts,
} from './types';
