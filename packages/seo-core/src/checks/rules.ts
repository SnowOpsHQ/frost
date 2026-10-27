import { LINK_REASON_LABELS, RECIPROCITY_LABELS, SITEMAP_ERROR_LABELS, SITEMAP_INVALID_ERRORS, type SitemapErrorKind } from '@app/specs/seo-checks.spec';
import type { FindingDetails, PageSnapshot } from '../types';
import { details, fact, formatCount } from '../util';

// The checks' rules (catalog `specs/seo-checks.spec.ts`, `CHECKS_RULE_SPECS`, spread into
// `SEO_RULE_SPECS`; acceptance `seo-checks.feature.md`, Rules). Each reads `PageContext.checks` and
// passes until its check has run on the page shown.

type Check = (snapshot: PageSnapshot) => FindingDetails | null;

const INVALID: ReadonlySet<SitemapErrorKind> = new Set(SITEMAP_INVALID_ERRORS);

export const CHECKS_CHECKS = {
  'links-broken': (s) => {
    const links = s.checks?.links;
    if (!links || links.broken.length === 0) return null;
    return details(
      [fact('Broken', formatCount(links.broken.length)), fact('Checked', formatCount(links.checked))],
      links.broken.map((link) => `${link.status ?? LINK_REASON_LABELS[link.reason]}: ${link.url}`),
      links.broken.length,
    );
  },
  'links-internal-redirect': (s) => {
    const links = s.checks?.links;
    if (!links || links.internalRedirects.length === 0) return null;
    return details(
      [fact('Redirected', formatCount(links.internalRedirects.length))],
      links.internalRedirects.map((link) => `${link.url} → ${link.finalUrl}`),
      links.internalRedirects.length,
    );
  },
  'sitemap-page-not-listed': (s) => {
    const sitemaps = s.checks?.sitemaps;
    if (!sitemaps || sitemaps.listed !== false) return null;
    return details([fact('Files read', formatCount(sitemaps.files)), fact('URLs listed', formatCount(sitemaps.urlCount)), fact('Page', s.url)]);
  },
  'sitemap-unreachable': (s) => {
    const sitemaps = s.checks?.sitemaps;
    const invalid = (sitemaps?.errors ?? []).filter((error) => INVALID.has(error.kind));
    if (invalid.length === 0) return null;
    return details([fact('Sitemaps with problems', formatCount(invalid.length))], invalid.map((error) => `${SITEMAP_ERROR_LABELS[error.kind]}: ${error.url}`), invalid.length);
  },
  'hreflang-no-return-link': (s) => {
    const hreflang = s.checks?.hreflang;
    if (!hreflang || hreflang.noReturn.length === 0) return null;
    return details(
      [fact('Without a return link', formatCount(hreflang.noReturn.length)), fact('Checked', formatCount(hreflang.checked))],
      hreflang.noReturn.map((alternate) => `${alternate.lang} ${alternate.url}: ${RECIPROCITY_LABELS[alternate.status]}`),
      hreflang.noReturn.length,
    );
  },
} satisfies Record<string, Check>;
