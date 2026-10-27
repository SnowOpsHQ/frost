import type { HreflangSource, IndexabilityVerdict, ResponseSource, RobotsAgent, RobotsFetchOutcome } from '@app/specs/seo-indexability.spec';
import type { RedirectHop, ResponseHeader, RobotsMeta } from '@app/specs/seo-snapshot.spec';
import type { XRobotsTag } from './headers';

// What the Indexability panel shows (acceptance `seo-indexability.feature.md`, Panel), read once per
// snapshot by `analyseIndexability`. Every string is page- or server-derived and rendered as text.

/** The page's HTTP response as main recorded it (`ResponseMetaSchema`), with its server redirects counted. */
export interface HttpReport {
  readonly url: string;
  readonly source: ResponseSource;
  readonly status: number | null;
  readonly headersAvailable: boolean;
  readonly headers: readonly ResponseHeader[];
  readonly redirects: readonly RedirectHop[];
  readonly redirectTotal: number;
  /** Redirects a server answered (`internal` ones aside; hops past the cap count as server ones). */
  readonly serverRedirects: number;
}

export interface CanonicalReport {
  /** The first `<link rel="canonical">`, resolved (else as written); `null` without one. */
  readonly html: string | null;
  /** The first HTTP `Link` header value with `rel="canonical"`, resolved against the page; `null` without one. */
  readonly header: string | null;
  /** The canonical search engines read: the HTML one, else the header's. */
  readonly effective: string | null;
  /** `effective` names another URL than the page's (fragment aside). */
  readonly elsewhere: boolean;
  /** Both exist and name different URLs. */
  readonly conflict: boolean;
}

export interface RobotsRuleRef {
  readonly allow: boolean;
  readonly raw: string;
  readonly line: number;
}

/** A crawler's verdict for this URL under the site's robots.txt. */
export interface RobotsAgentVerdict {
  readonly agent: RobotsAgent;
  /** `true` may crawl, `false` blocked, `null` unknown (robots.txt could not be read). */
  readonly allowed: boolean | null;
  /** The `user-agent` values of the groups it follows (merged), `[]` when none applies. */
  readonly groupAgents: readonly string[];
  /** The line of the first of those groups (`null`: none). */
  readonly groupLine: number | null;
  /** It follows the `*` groups (it has none of its own). */
  readonly fallback: boolean;
  /** The rule that decided (`null`: no rule matched, or no file). */
  readonly rule: RobotsRuleRef | null;
}

export interface RobotsSitemapRef {
  readonly raw: string;
  /** Resolved against the robots.txt URL; `null` if it does not parse or is not `http(s)`. */
  readonly url: string | null;
  readonly line: number;
}

export interface RobotsReport {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly outcome: RobotsFetchOutcome;
  readonly status: number | null;
  readonly redirects: number;
  readonly bytes: number;
  /** The file was longer than `ROBOTS_FETCH_LIMITS.maxBytes`: the rest was not read. */
  readonly truncated: boolean;
  readonly groupCount: number;
  readonly ruleCount: number;
  readonly sitemaps: readonly RobotsSitemapRef[];
  readonly sitemapTotal: number;
  /** The URL path and query the rules were matched against (normalised). */
  readonly path: string;
  /** One verdict per `ROBOTS_AGENTS` crawler, in that order. */
  readonly agents: readonly RobotsAgentVerdict[];
  /** The file's text for "View robots.txt": its first `ROBOTS_PARSE_LIMITS.maxViewChars` characters. */
  readonly text: string;
  /** `text` is cut (the file, as read, is longer). */
  readonly textCut: boolean;
}

export interface HreflangEntry {
  /** The hreflang value as written. */
  readonly value: string;
  readonly href: string;
  /** Resolved against the page (`null` if it does not parse). */
  readonly resolved: string | null;
  readonly source: HreflangSource;
  /** A valid code (`hreflang-invalid-code`). */
  readonly valid: boolean;
  /** It points to this page (or its canonical). */
  readonly self: boolean;
  readonly relative: boolean;
  /** Its value (case aside) is used by another annotation too. */
  readonly duplicate: boolean;
}

export interface HreflangReport {
  /** The head's annotations, then the `Link` header's (at most `SNAPSHOT_LIMITS.maxHreflang` of each). */
  readonly entries: readonly HreflangEntry[];
  /** The head's full count plus the header's. */
  readonly total: number;
  readonly hasXDefault: boolean;
  readonly hasSelf: boolean;
}

export interface IndexabilityReport {
  readonly verdict: IndexabilityVerdict;
  /** Why the page is not indexable (or which URL it defers to), frost's own sentences; `[]` when indexable. */
  readonly reasons: readonly string[];
  readonly http: HttpReport | null;
  readonly robotsMeta: readonly RobotsMeta[];
  readonly xRobotsTag: readonly XRobotsTag[];
  readonly canonical: CanonicalReport;
  /** `null`: robots.txt was not fetched (not collected). */
  readonly robots: RobotsReport | null;
  readonly hreflang: HreflangReport;
}
