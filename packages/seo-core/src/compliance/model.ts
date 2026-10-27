import type { A11yImpact, HeaderState, ReferrerPolicyValue, SecurityHeaderName, SecurityVerdict } from '@app/specs/seo-compliance.spec';
import type { ResponseSource } from '@app/specs/seo-indexability.spec';
import type { A11yViolation, InsecureResource } from '@app/specs/seo-snapshot.spec';
import type { CspPolicy } from './csp';
import type { Hsts } from './headers';

// What the Compliance panel shows (acceptance `seo-compliance.feature.md`, Panel): plain data built
// in the analysis worker from the validated snapshot and context, so the chrome renders text only.

/** One row of the security header table. */
export interface SecurityHeaderRow {
  readonly name: SecurityHeaderName;
  readonly label: string;
  readonly state: HeaderState;
  /** The header's values as kept (or the meta tag's, when `fromMeta`); empty when missing or unknown. */
  readonly values: readonly string[];
  /** The value shown came from a `<meta>` tag, not the header. */
  readonly fromMeta: boolean;
  /** frost's reading of it ("max-age 1 year · includeSubDomains"), `null` when there is nothing to say. */
  readonly note: string | null;
}

/** http subresources of an https page, split by what browsers do with them (`ACTIVE_RESOURCE_KINDS`). */
export interface MixedContent {
  readonly active: readonly InsecureResource[];
  readonly passive: readonly InsecureResource[];
  /** Distinct http subresources the page asks for (at least `active.length + passive.length`). */
  readonly total: number;
  /** The extractor stopped scanning early (`resourcesTruncated`): there may be more. */
  readonly truncated: boolean;
}

/** The security facts, read once per snapshot. */
export interface SecurityFacts {
  readonly url: string;
  readonly https: boolean;
  /** Served from this computer (`LOOPBACK_HOST_PATTERNS`). */
  readonly loopback: boolean;
  /** Main has the document's response headers (`ResponseMeta.headersAvailable`). */
  readonly headersKnown: boolean;
  /** Where the response metadata came from, `null` when none was recorded. */
  readonly responseSource: ResponseSource | null;
  /** The first `Strict-Transport-Security` value parsed (`null`: none, or browsers would ignore it). */
  readonly hsts: Hsts | null;
  /** Every enforced policy: the header's, then the meta tags'. */
  readonly cspPolicies: readonly CspPolicy[];
  readonly inlineScriptsAllowed: boolean;
  /** `frame-ancestors` is set by a header policy. */
  readonly frameAncestors: boolean;
  readonly frameOptionsProtect: boolean;
  readonly nosniff: boolean;
  /** The document's referrer policy, and what set it (`null`: none known). */
  readonly referrerPolicy: ReferrerPolicyValue | null;
  readonly referrerFrom: 'header' | 'meta' | null;
  readonly mixed: MixedContent;
}

export interface SecurityReport extends SecurityFacts {
  readonly verdict: SecurityVerdict;
  readonly headers: readonly SecurityHeaderRow[];
}

/** One impact level's violated rules (worst first, then by elements affected). */
export interface A11yImpactGroup {
  readonly impact: A11yImpact;
  readonly rules: readonly A11yViolation[];
  /** Elements affected across these rules (`nodeTotal`s). */
  readonly nodeTotal: number;
}

/** The accessibility check as the audit holds it (`A11Y_REPORT_STATUSES`). */
export type AccessibilityReport =
  | { readonly status: 'not-run' }
  | { readonly status: 'invalid' }
  | {
      readonly status: 'done';
      readonly url: string;
      readonly axeVersion: string;
      readonly ranAt: number;
      readonly durationMs: number;
      /** Every impact level, worst first (empty groups included). */
      readonly groups: readonly A11yImpactGroup[];
      readonly violationTotal: number;
      /** More rules were violated than kept (`violationTotal` above the rules listed). */
      readonly truncated: boolean;
      readonly passes: number;
      readonly incomplete: number;
      readonly inapplicable: number;
    };

/** The Compliance panel's data (`SeoAudit.compliance`). */
export interface ComplianceReport {
  readonly security: SecurityReport;
  readonly accessibility: AccessibilityReport;
}
