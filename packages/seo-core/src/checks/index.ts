// Link status, sitemap and hreflang reciprocity checks (Phase 2.5 Task 7; spec `seo-checks.spec.ts`;
// acceptance `seo-checks.feature.md`): the pure parts. Main fetches; the analysis worker parses.
export { blockedLink, classifyLink, linkTargetKey, needsGetFallback, skippedLink, type LinkAnswer } from './links';
export { lastmodIssue, lastmodTime } from './lastmod';
export { decodeAttribute, headHreflangLinks, type HeadHreflang } from './head-hreflang';
export { hreflangTargets, reciprocityOf, type AlternateTarget, type ReturnLink } from './reciprocity';
export { checksContextOf } from './summary';
