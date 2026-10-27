import type { AccessibilityRunState } from '@app/specs/seo-compliance.spec';
import type { ScoreBand, SeoCategory, SeoRuleId, SeoRuleSpec, SeoSeverity } from '@app/specs/seo-rules.spec';
import type { SeoUnavailableReason } from '@app/specs/seo-sidebar.spec';
// Types only: the snapshot's Zod schema stays in main (it is the untrusted page's data).
import type { CappedText, PageHeading, PageImage, PageLink, PageSnapshot, PageSocial } from '@app/specs/seo-snapshot.spec';
import type { ComplianceReport } from './compliance/model';
import type { IndexabilityReport } from './indexability/model';
import type { SpeedReport } from './performance/model';
import type { SchemaReport } from './schema/model';

export type { CappedText, ExtractedSnapshot, HreflangLink, ImageSize, PageContext, PageHeading, PageImage, PageLink, PageSnapshot, PageSocial, RedirectHop, ResponseHeader, ResponseMeta, RobotsFetch } from '@app/specs/seo-snapshot.spec';

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
  /** The first meta description with text, `null` when there is none. */
  readonly description: CappedText | null;
  readonly descriptionTotal: number;
  /** The first canonical, resolved (else as written); `null` when there is none. */
  readonly canonical: string | null;
  readonly canonicalTotal: number;
  /** Every robots meta as `name: content`, joined with ` · `; `null` when there is none. */
  readonly robots: string | null;
  /** The robots metas (`robots`, `googlebot` …) that ask not to index the page; empty when it may be indexed. */
  readonly noindexFor: readonly string[];
  readonly ogUrl: string | null;
  readonly lang: string | null;
  readonly viewport: string | null;
  readonly headings: readonly PageHeading[];
  readonly headingTotal: number;
  readonly wordCount: number;
  readonly textTruncated: boolean;
  /** The extractor hit its deadline: lists may be shorter than their caps. */
  readonly partial: boolean;
  /** Counted over the first `analysed` links (`SNAPSHOT_LIMITS.maxLinks`) of `total`. */
  readonly links: { readonly analysed: number; readonly total: number; readonly internal: number; readonly external: number; readonly other: number; readonly nofollow: number };
  /** Counted over the first `analysed` images of `total`. */
  readonly images: { readonly analysed: number; readonly total: number; readonly missingAlt: number };
  /** The snapshot's links (at most `SNAPSHOT_LIMITS.maxLinks`, of `links.total`): the Links panel's rows. */
  readonly linkList: readonly PageLink[];
  /** The snapshot's images (at most `SNAPSHOT_LIMITS.maxImages`, of `images.total`): the Images panel's rows. */
  readonly imageList: readonly PageImage[];
  /** The Open Graph and Twitter card tags (`og:url` is `ogUrl`). */
  readonly social: PageSocial;
}

/** One page's audit. `findings` are ranked: errors, then warnings, then info, each in catalog order. */
export interface SeoAudit {
  readonly url: string;
  readonly takenAt: number;
  readonly durationMs: number;
  readonly score: number;
  readonly band: ScoreBand;
  /** `false` when a rule in `NOT_INDEXABLE_RULES` fails: the score is capped (`NOINDEX_SCORE_CAP`) and the card says "Not indexable". */
  readonly indexable: boolean;
  readonly counts: SeverityCounts;
  readonly findings: readonly Finding[];
  readonly page: PageFacts;
  /** The page's structured data, read into one tree with its issues (the Schema panel, Task 3). */
  readonly schema: SchemaReport;
  /** The page's indexability: verdict, HTTP response, robots.txt, canonicals and hreflang (the Indexability panel, Task 4). */
  readonly indexability: IndexabilityReport;
  /** The page's speed measured with the audit (the Speed panel's fallback until it measures live, Task 5); `null`: not measured. */
  readonly performance: SpeedReport | null;
  /** The page's security (HTTPS, mixed content, headers) and its accessibility check, if one ran (the Compliance panel, Task 6). */
  readonly compliance: ComplianceReport;
}

/**
 * `seo.getAudit`'s answer (`seo-sidebar.spec.ts`, `SEO_AUDIT_STATUSES`). A ready answer carries the
 * tab's accessibility run (`seo-compliance.spec.ts`, `AccessibilityRunState`) when main has one.
 */
export type SeoAuditResponse =
  | { readonly status: 'pending'; readonly url: string }
  | { readonly status: 'ready'; readonly url: string; readonly audit: SeoAudit; readonly accessibilityRun?: AccessibilityRunState }
  | { readonly status: 'unavailable'; readonly url: string; readonly reason: SeoUnavailableReason };
