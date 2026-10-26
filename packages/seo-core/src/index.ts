// Public surface of the SEO engine (spec `specs/seo-rules.spec.ts`, `specs/seo-snapshot.spec.ts`;
// acceptance `specs/seo-rules.feature.md`). Pure TypeScript: no Electron, DOM, Node or Zod at
// runtime, so main and the chrome renderer can both import it.
export { countSeverities, pageFacts, panelStatus, rankFindings, runAudit, scoreAudit, scoreBand } from './audit';
export { RULES } from './rules';
export { altState, filterImages, imageCounts, isLazyInFirstViewport, isOversized, isSvg, lacksDimensions, type AltState } from './images';
export { csvCell, filterLinks, linkCounts, linksCsv, NO_LINK_FILTER, relFlags, type LinkCounts, type LinkFilter } from './links';
export { pageUrls, socialPreview, type SocialPreview, type SocialSource, type SocialValue } from './social';
export type {
  CappedText,
  Finding,
  ImageSize,
  FindingDetails,
  FindingFact,
  PageFacts,
  PageHeading,
  PageImage,
  PageLink,
  PageSnapshot,
  PageSocial,
  SeoAudit,
  SeoAuditResponse,
  SeoRule,
  SeverityCounts,
} from './types';
