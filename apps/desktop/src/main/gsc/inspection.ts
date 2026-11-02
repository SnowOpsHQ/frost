import {
  GSC_INSPECTION_LIMITS,
  isGscInspectionLink,
  type GoogleInspectionResponse,
  type GscInspectionIndex,
  type GscInspectionOk,
  type GscRichResults,
  type GscRichType,
} from '@app/specs/gsc-inspection.schema';
import { GSC_LIMITS, type GscProperty } from '@app/specs/gsc.schema';
import { isWebUrl } from '@app/specs/web-url.spec';

// URL Inspection's answer, rebuilt from Google's (spec `gsc-inspection.schema.ts`; acceptance
// `gsc-inspection.feature.md`; plan Phase 9 Decision 6). Everything Google sent is untrusted text:
// enums were already read against frost's tables while parsing (`GoogleInspectionResponseSchema`);
// here every string is cut to `GSC_INSPECTION_LIMITS.maxTextChars`, items and issues are capped,
// canonicals are kept only as `http(s)` URLs, the crawl time only as an ISO time, and the Search
// Console link only on `GSC_INSPECTION_LINK_HOST` (`isGscInspectionLink`). Nothing else of Google's
// answer is carried (`sitemap`, `referringUrls`, AMP and mobile usability never got past the parse).
// The service validates the result with `GscInspectionAnswerSchema` before answering it.

/** `value` cut to `GSC_INSPECTION_LIMITS.maxTextChars` (never splitting a surrogate pair); absent is `''`. */
export function cutInspectionText(value: string | undefined): string {
  if (value === undefined) return '';
  if (value.length <= GSC_INSPECTION_LIMITS.maxTextChars) return value;
  const cut = value.slice(0, GSC_INSPECTION_LIMITS.maxTextChars);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** An `http(s)` URL within `GSC_LIMITS.maxUrlChars`, else `null`. */
const canonicalOf = (value: string | undefined): string | null => (value !== undefined && value.length <= GSC_LIMITS.maxUrlChars && isWebUrl(value) ? value : null);

/** Google's RFC 3339 time as an ISO time (`YYYY-MM-DDTHH:mm:ss.sssZ`), else `null`. */
function crawlTimeOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso) ? iso : null;
}

/** A Search Console link within `GSC_LIMITS.maxUrlChars` on `GSC_INSPECTION_LINK_HOST`, else `null`. */
const linkOf = (value: string | undefined): string | null => (value !== undefined && value.length <= GSC_LIMITS.maxUrlChars && isGscInspectionLink(value) ? value : null);

type GoogleResult = GoogleInspectionResponse['inspectionResult'];

function indexOf(status: GoogleResult['indexStatusResult']): GscInspectionIndex {
  return {
    verdict: status?.verdict ?? { value: 'unknown', code: null },
    coverageState: cutInspectionText(status?.coverageState),
    robotsTxtState: status?.robotsTxtState ?? { value: 'unknown', code: null },
    indexingState: status?.indexingState ?? { value: 'unknown', code: null },
    pageFetchState: status?.pageFetchState ?? { value: 'unknown', code: null },
    lastCrawlTime: crawlTimeOf(status?.lastCrawlTime),
    crawledAs: status?.crawledAs ?? null,
    googleCanonical: canonicalOf(status?.googleCanonical),
    userCanonical: canonicalOf(status?.userCanonical),
  };
}

/** The detected types in Google's order: at most `maxItems` items in all (no further types once spent), `maxIssues` issues each. */
function richResultsOf(rich: GoogleResult['richResultsResult']): GscRichResults | null {
  if (!rich) return null;
  const { maxItems, maxIssues } = GSC_INSPECTION_LIMITS;
  const types: GscRichType[] = [];
  let items = 0;
  for (const detected of rich.detectedItems ?? []) {
    if (types.length >= maxItems || items >= maxItems) break;
    const kept = (detected.items ?? []).slice(0, maxItems - items).map((item) => ({
      name: cutInspectionText(item.name),
      issues: (item.issues ?? []).slice(0, maxIssues).map((issue) => ({ message: cutInspectionText(issue.issueMessage), severity: issue.severity })),
    }));
    items += kept.length;
    types.push({ type: cutInspectionText(detected.richResultType), items: kept });
  }
  return { verdict: rich.verdict, types };
}

/** frost's `ok` answer for `url` (already without its fragment) in `property`, from Google's parsed answer. */
export function inspectionAnswerOf(google: GoogleInspectionResponse, context: { readonly property: GscProperty; readonly url: string; readonly inspectedAt: string }): GscInspectionOk {
  const result = google.inspectionResult;
  return {
    status: 'ok',
    property: context.property,
    url: context.url,
    inspectedAt: context.inspectedAt,
    index: indexOf(result.indexStatusResult),
    richResults: richResultsOf(result.richResultsResult),
    link: linkOf(result.inspectionResultLink),
  };
}
