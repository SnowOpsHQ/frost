import { SEO_RULE_SPECS, type SeoRuleId } from '@app/specs/seo-rules.spec';
import type { FindingDetails, PageSnapshot, SeoRule } from '../types';
import { BODY_CHECKS } from './body';
import { HEAD_CHECKS } from './head';

// The rule set: every catalog entry of `specs/seo-rules.spec.ts`, in catalog order, with its check.
// A catalog entry without a check, or a check without a catalog entry, is a compile error.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;
type CheckId = keyof typeof HEAD_CHECKS | keyof typeof BODY_CHECKS;
/** `true` only when the checks' ids are exactly the catalog's. */
type SameIds = [Exclude<CheckId, SeoRuleId>, Exclude<SeoRuleId, CheckId>] extends [never, never] ? true : false;
const sameIds: SameIds = true;
void sameIds;

const CHECKS: Readonly<Record<SeoRuleId, Check>> = { ...HEAD_CHECKS, ...BODY_CHECKS };

export const RULES: readonly SeoRule[] = SEO_RULE_SPECS.map((spec) => ({ ...spec, check: CHECKS[spec.id] }));
