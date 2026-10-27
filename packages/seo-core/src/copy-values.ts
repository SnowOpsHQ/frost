import type { CopyValueKey } from '@app/specs/command-palette.spec';
import type { SeoAudit } from './types';

// The values the command palette's copy actions write (spec `command-palette.spec.ts`,
// `COPY_VALUE_KEYS`; acceptance `command-palette.feature.md`, Copy values). Main writes them from its
// own ready audit (`seo.copyValue`); the chrome uses the same function to offer only the copies that
// have a value and to preview them. Every value is page- or server-derived text, as the audit kept it.

/** The non-empty `value`, else `null`. */
function present(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === '' ? null : value;
}

/** What copying `key` from `audit` writes, or `null` when the audit has no such value. */
export function copyValueOf(audit: SeoAudit, key: CopyValueKey): string | null {
  switch (key) {
    case 'url':
      return present(audit.url);
    case 'title':
      return present(audit.page.title?.text);
    case 'meta-description':
      return present(audit.page.description?.text);
    case 'canonical':
      return present(audit.indexability.canonical.effective ?? audit.page.canonical);
    case 'h1':
      return present(audit.page.headings.find((heading) => heading.level === 1 && heading.text !== '')?.text);
    case 'robots-meta':
      return present(audit.page.robots);
    case 'status-code': {
      const status = audit.indexability.http?.status;
      return typeof status === 'number' ? String(status) : null;
    }
  }
}
