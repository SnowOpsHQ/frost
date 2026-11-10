import { COPY_VALUE_MAX_CHARS, type CopyValueKey } from '@app/specs/command-palette.spec';
import { MASKED_VALUE, SECRET_HEADERS } from '@app/specs/devtools.spec';
import { SOCIAL_TAGS } from '@app/specs/seo-limits.spec';
import { escapeHtml } from './content';
import { registrableDomain } from './performance';
import { formatJson } from './schema';
import type { PageLink, SeoAudit } from './types';

// The values the command palette's copy actions write (spec `command-palette.spec.ts`,
// `COPY_VALUE_KEYS`; acceptance `command-palette.feature.md`, Copy values). Main writes them from its
// own ready audit (`seo.copyValue`, and the context menu's Copy SEO Data); the chrome uses the same
// function to offer only the copies that have a value and to preview them. Every value is page- or
// server-derived text, as the audit kept it; nothing is fetched again.

/** The non-empty `value`, else `null`. */
function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

/** `lines` joined with `\n`, or `null` when there are none. */
function joined(lines: readonly string[]): string | null {
  return lines.length === 0 ? null : lines.join('\n');
}

/** `value` cut to `COPY_VALUE_MAX_CHARS` UTF-16 code units, never inside a surrogate pair. */
function capped(value: string | null): string | null {
  if (value === null || value.length <= COPY_VALUE_MAX_CHARS) return value;
  const last = value.charCodeAt(COPY_VALUE_MAX_CHARS - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? COPY_VALUE_MAX_CHARS - 1 : COPY_VALUE_MAX_CHARS);
}

/** The audited URL, parsed (`null` if it does not parse). */
function parsed(audit: SeoAudit): URL | null {
  try {
    return new URL(audit.url);
  } catch {
    return null;
  }
}

/** `text` on the first line, the audited URL on the second; `null` without `text`. */
function withUrl(audit: SeoAudit, text: string | null): string | null {
  return text === null ? null : `${text}\n${audit.url}`;
}

/** The first H1 with text. */
function firstH1(audit: SeoAudit): string | null {
  return present(audit.page.headings.find((heading) => heading.level === 1 && heading.text !== '')?.text);
}

/** The canonical search engines read (the HTML one, else the `Link` header's). */
function canonicalOf(audit: SeoAudit): string | null {
  return present(audit.indexability.canonical.effective ?? audit.page.canonical);
}

/** `name: value` lines for the social tags with `prefix` that have a value (plus `og:url` for Open Graph). */
function socialLines(audit: SeoAudit, prefix: 'og:' | 'twitter:'): string | null {
  const lines: string[] = [];
  for (const tag of SOCIAL_TAGS) {
    if (!tag.startsWith(prefix)) continue;
    const value = audit.page.social[tag];
    if (present(value) !== null) lines.push(`${tag}: ${value}`);
  }
  if (prefix === 'og:' && present(audit.page.ogUrl) !== null) lines.push(`og:url: ${audit.page.ogUrl}`);
  return joined(lines);
}

/** The distinct hrefs of the links of `kind`, in document order. */
function linkUrls(links: readonly PageLink[], kind: PageLink['kind']): string | null {
  const seen = new Set<string>();
  for (const link of links) if (link.kind === kind && link.href !== '') seen.add(link.href);
  return joined([...seen]);
}

const SECRET: ReadonlySet<string> = new Set(SECRET_HEADERS);

/** What copying `key` from `audit` writes, uncapped, or `null` when the audit has no such value. */
function valueOf(audit: SeoAudit, key: CopyValueKey): string | null {
  switch (key) {
    case 'url':
      return present(audit.url);
    case 'title':
      return present(audit.page.title?.text);
    case 'meta-description':
      return present(audit.page.description?.text);
    case 'canonical':
      return canonicalOf(audit);
    case 'h1':
      return firstH1(audit);
    case 'robots-meta':
      return present(audit.page.robots);
    case 'status-code': {
      const status = audit.indexability.http?.status;
      return typeof status === 'number' ? String(status) : null;
    }
    // Phase 11 Task 1 (Decision 2).
    case 'clean-url': {
      const url = parsed(audit);
      return url === null || url.origin === 'null' ? null : `${url.origin}${url.pathname}`;
    }
    case 'origin': {
      const url = parsed(audit);
      return url === null || url.origin === 'null' ? null : url.origin;
    }
    case 'root-domain': {
      const url = parsed(audit);
      return url === null ? null : present(registrableDomain(url.hostname));
    }
    case 'title-with-url':
      return withUrl(audit, present(audit.page.title?.text));
    case 'h1-with-url':
      return withUrl(audit, firstH1(audit));
    case 'headings-outline':
      return joined(audit.page.headings.map((heading) => `${'  '.repeat(Math.max(0, heading.level - 1))}H${heading.level}: ${heading.text}`));
    case 'og-tags':
      return socialLines(audit, 'og:');
    case 'twitter-tags':
      return socialLines(audit, 'twitter:');
    case 'word-count':
      return String(audit.page.wordCount);
    case 'canonical-html': {
      const canonical = canonicalOf(audit);
      return canonical === null ? null : `<link rel="canonical" href="${escapeHtml(canonical)}">`;
    }
    case 'hreflang-html':
      return joined(audit.indexability.hreflang.entries.map((entry) => `<link rel="alternate" hreflang="${escapeHtml(entry.value)}" href="${escapeHtml(entry.resolved ?? entry.href)}">`));
    case 'x-robots-tag':
      return joined(audit.indexability.xRobotsTag.map((tag) => tag.value));
    case 'response-headers':
      return joined((audit.indexability.http?.headers ?? []).map((header) => `${header.name}: ${SECRET.has(header.name.toLowerCase()) ? MASKED_VALUE : header.value}`));
    case 'sitemaps':
      return joined((audit.indexability.robots?.sitemaps ?? []).map((sitemap) => sitemap.url ?? sitemap.raw));
    case 'all-schema-json': {
      // A blank line between blocks.
      const blocks = audit.schema.blocks.filter((block) => block.text !== '').map((block) => (block.status === 'valid' ? formatJson(block.text).text : block.text));
      return blocks.length === 0 ? null : blocks.join('\n\n');
    }
    case 'internal-urls':
      return linkUrls(audit.page.linkList, 'internal');
    case 'external-urls':
      return linkUrls(audit.page.linkList, 'external');
  }
}

/** What copying `key` from `audit` writes (cut at `COPY_VALUE_MAX_CHARS`), or `null` when the audit has no such value. */
export function copyValueOf(audit: SeoAudit, key: CopyValueKey): string | null {
  return capped(valueOf(audit, key));
}
