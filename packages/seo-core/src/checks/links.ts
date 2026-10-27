import { HEAD_FALLBACK_STATUSES, type CheckFetchOutcome, type LinkCheckResult, type LinkSkipReason } from '@app/specs/seo-checks.spec';
import { parseUrl, withoutFragment } from '../util';

// Link status classification (spec `seo-checks.spec.ts`, `LINK_STATUS_KINDS`, `LINK_BROKEN_REASONS`,
// `HEAD_FALLBACK_STATUSES`; acceptance `seo-checks.feature.md`, Classification). Pure: main's link
// check calls it with what its bounded fetcher answered.

/** What the fetcher answered for one link: how it ended, the final status, the redirects followed, where they ended, which method answered. */
export interface LinkAnswer {
  readonly outcome: CheckFetchOutcome;
  readonly status: number | null;
  readonly redirects: number;
  readonly finalUrl: string | null;
  readonly method: 'HEAD' | 'GET';
}

/** The key a link target is checked under: its `href` parsed, without its `#fragment`; `null` when it is not `http(s)`. */
export function linkTargetKey(href: string): string | null {
  const url = parseUrl(href);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null;
  return withoutFragment(url);
}

/** Whether a HEAD answer says the server does not do HEAD (`HEAD_FALLBACK_STATUSES`): ask again with GET. */
export function needsGetFallback(status: number | null): boolean {
  return status !== null && (HEAD_FALLBACK_STATUSES as readonly number[]).includes(status);
}

/** A link not fetched. */
export function skippedLink(url: string, reason: LinkSkipReason): LinkCheckResult {
  return { url, kind: 'skipped', status: null, finalUrl: null, redirects: 0, reason, method: null, cached: false };
}

/** A same-origin link robots.txt disallows (not fetched). */
export function blockedLink(url: string): LinkCheckResult {
  return { url, kind: 'blocked', status: null, finalUrl: null, redirects: 0, reason: null, method: null, cached: false };
}

/**
 * The result for `url` from `answer`; `null` for an aborted fetch (the run was cancelled: no result).
 * A 2xx is `ok`, or `redirect` after a redirect; 4xx and 5xx are `broken` (`http-error`); any other
 * final status is `broken` (`other-status`); no answer is `broken` with why; a redirect to a private
 * host is `skipped` (`private`).
 */
export function classifyLink(url: string, answer: LinkAnswer): LinkCheckResult | null {
  const base = { url, status: answer.status, finalUrl: answer.redirects > 0 ? answer.finalUrl : null, redirects: answer.redirects, method: answer.method, cached: false };
  switch (answer.outcome) {
    case 'aborted':
      return null;
    case 'response': {
      const status = answer.status;
      if (status !== null && status >= 200 && status < 300) return { ...base, kind: answer.redirects > 0 ? 'redirect' : 'ok', reason: null };
      if (status !== null && status >= 400 && status < 600) return { ...base, kind: 'broken', reason: 'http-error' };
      return { ...base, kind: 'broken', reason: 'other-status' };
    }
    case 'private-redirect':
      return { ...base, kind: 'skipped', reason: 'private' };
    default:
      return { ...base, kind: 'broken', reason: answer.outcome };
  }
}
