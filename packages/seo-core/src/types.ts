import type { ScoreBand, SeoCategory, SeoRuleId, SeoRuleSpec, SeoSeverity } from '@app/specs/seo-rules.spec';
import type { SeoUnavailableReason } from '@app/specs/seo-sidebar.spec';
// Types only: the snapshot's Zod schema stays in main (it is the untrusted page's data).
import type { CappedText, PageHeading, PageSnapshot } from '@app/specs/seo-snapshot.spec';

export type { CappedText, PageHeading, PageImage, PageLink, PageSnapshot } from '@app/specs/seo-snapshot.spec';

/** One labelled value a finding shows (e.g. `Length` → `72 characters`). Plain text, never markup. */
export interface FindingFact {
  readonly label: string;
  readonly value: string;
}

/**
 * What a failing check reports: labelled facts, up to `FINDING_SAMPLE_LIMIT` offending values
 * (`samples`), and, for rules that count elements, how many failed (`count`).
 */
export interface FindingDetails {
  readonly facts: readonly FindingFact[];
  readonly samples: readonly string[];
  readonly count?: number;
}

/** A rule: its catalog entry (`seo-rules.spec.ts`) plus the check, `null` when the page passes. */
export interface SeoRule extends SeoRuleSpec {
  readonly id: SeoRuleId;
  check(snapshot: PageSnapshot): FindingDetails | null;
}

/** A failing rule on one page. */
export interface Finding {
  readonly ruleId: SeoRuleId;
  readonly category: SeoCategory;
  readonly severity: SeoSeverity;
  readonly title: string;
  readonly why: string;
  readonly fix: string;
  readonly details: FindingDetails;
}

export type SeverityCounts = Readonly<Record<SeoSeverity, number>>;

/** What the On-Page panel shows, derived from the snapshot (bounded by its caps). */
export interface PageFacts {
  readonly url: string;
  /** The first title, `null` when there is none. */
  readonly title: CappedText | null;
  readonly titleTotal: number;
  readonly description: CappedText | null;
  readonly descriptionTotal: number;
  /** The first canonical, resolved (else as written); `null` when there is none. */
  readonly canonical: string | null;
  readonly canonicalTotal: number;
  /** Every meta robots value, joined with `, `; `null` when there is none. */
  readonly robots: string | null;
  readonly ogUrl: string | null;
  readonly lang: string | null;
  readonly viewport: string | null;
  readonly headings: readonly PageHeading[];
  readonly headingTotal: number;
  readonly wordCount: number;
  readonly textTruncated: boolean;
  /** Counted over the first `analysed` links (`SNAPSHOT_LIMITS.maxLinks`) of `total`. */
  readonly links: { readonly analysed: number; readonly total: number; readonly internal: number; readonly external: number; readonly other: number; readonly nofollow: number };
  /** Counted over the first `analysed` images of `total`. */
  readonly images: { readonly analysed: number; readonly total: number; readonly missingAlt: number };
}

/** One page's audit. `findings` are ranked: errors, then warnings, then info, each in catalog order. */
export interface SeoAudit {
  readonly url: string;
  readonly takenAt: number;
  readonly durationMs: number;
  readonly score: number;
  readonly band: ScoreBand;
  readonly counts: SeverityCounts;
  readonly findings: readonly Finding[];
  readonly page: PageFacts;
}

/** `seo.getAudit`'s answer (`seo-sidebar.spec.ts`, `SEO_AUDIT_STATUSES`). */
export type SeoAuditResponse =
  | { readonly status: 'pending'; readonly url: string }
  | { readonly status: 'ready'; readonly url: string; readonly audit: SeoAudit }
  | { readonly status: 'unavailable'; readonly url: string; readonly reason: SeoUnavailableReason };
