import { SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import { COMPLIANCE_CHECKS } from '../compliance/rules';
import { CONTENT_CHECKS } from '../content/rules';
import { JAVASCRIPT_CHECKS } from '../javascript/rules';
import type { FindingDetails, PageSnapshot, SeoRule } from '../types';
import { BODY_CHECKS } from './body';
import { HEAD_CHECKS } from './head';
import { INDEXABILITY_CHECKS } from './indexability';
import { PERFORMANCE_CHECKS } from '../performance/rules';
import { SCHEMA_CHECKS } from './schema';
import { SOCIAL_CHECKS } from './social';

// The rule set: every catalog entry of `specs/seo-rules.spec.ts`, in catalog order, with its check.
// A catalog entry without a check, or a check without a catalog entry, is a compile error.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;
type CheckId = keyof typeof HEAD_CHECKS | keyof typeof BODY_CHECKS | keyof typeof SOCIAL_CHECKS | keyof typeof SCHEMA_CHECKS | keyof typeof INDEXABILITY_CHECKS | keyof typeof PERFORMANCE_CHECKS | keyof typeof COMPLIANCE_CHECKS | keyof typeof CONTENT_CHECKS | keyof typeof JAVASCRIPT_CHECKS;
/** `true` only when the checks' ids are exactly the catalog's. */
type SameIds = [Exclude<CheckId, SeoRuleId>, Exclude<SeoRuleId, CheckId>] extends [never, never] ? true : false;
const sameIds: SameIds = true;
void sameIds;

const CHECKS: Readonly<Record<SeoRuleId, Check>> = { ...HEAD_CHECKS, ...BODY_CHECKS, ...SOCIAL_CHECKS, ...SCHEMA_CHECKS, ...INDEXABILITY_CHECKS, ...PERFORMANCE_CHECKS, ...COMPLIANCE_CHECKS, ...CONTENT_CHECKS, ...JAVASCRIPT_CHECKS };

export const RULES: readonly SeoRule[] = SEO_RULE_SPECS.map((spec) => ({ ...spec, check: CHECKS[spec.id] }));
