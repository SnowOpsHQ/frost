import { classifyLink, linkTargetKey, needsGetFallback, skippedLink, type PageLink } from '@app/seo-core';
import { LINK_CHECK_LIMITS, type LinkCheckResult } from '@app/specs/seo-checks.spec';
import type { CheckFetch } from './checks-fetch';
import { isPrivateHost } from './fetcher';

// The link check's planning and one link's request (spec `seo-checks.spec.ts`, `LINK_CHECK_LIMITS`,
// `HEAD_FALLBACK_STATUSES`; acceptance `seo-checks.feature.md`, Link checks; review focus
// `link-checks-are-bounded`). The run itself (the scheduler, robots.txt, the cache) is `checks.ts`.

export type LinkLimits = typeof LINK_CHECK_LIMITS;

/** A run's plan: every unique target in the links' order, the ones not fetched (with why), and the `http(s)` ones that may be. */
export interface LinkPlan {
  readonly order: readonly string[];
  readonly skipped: ReadonlyMap<string, LinkCheckResult>;
  readonly candidates: readonly string[];
}

/**
 * Plans a run over the page's `links`: each target once (`linkTargetKey`: parsed, no fragment; a
 * non-`http(s)` one under its `href`, `skipped` `not-http`), a private host `skipped` (`private`)
 * unless the page is on one, and of the rest the first `maxLinks` candidates, any more `skipped`
 * (`over-cap`).
 */
export function planLinks(links: readonly PageLink[], pageUrl: string, limits: Pick<LinkLimits, 'maxLinks'> = LINK_CHECK_LIMITS): LinkPlan {
  const pagePrivate = (() => {
    try {
      return isPrivateHost(new URL(pageUrl).hostname);
    } catch {
      return false;
    }
  })();
  const order: string[] = [];
  const seen = new Set<string>();
  const skipped = new Map<string, LinkCheckResult>();
  const candidates: string[] = [];
  for (const link of links) {
    if (link.href === '') continue;
    const key = linkTargetKey(link.href);
    const id = key ?? link.href;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    if (key === null) skipped.set(id, skippedLink(id, 'not-http'));
    else if (!pagePrivate && isPrivateHost(new URL(key).hostname)) skipped.set(id, skippedLink(id, 'private'));
    else if (candidates.length >= limits.maxLinks) skipped.set(id, skippedLink(id, 'over-cap'));
    else candidates.push(id);
  }
  return { order, skipped, candidates };
}

export interface LinkRequestOptions {
  readonly fetch: CheckFetch;
  /** The page the links are on: private hosts may be requested only when it is on one (`fetcher.spec.ts`). */
  readonly page: string;
  readonly userAgent: string | null;
  /** Origins known not to do HEAD (asked with GET at once; a HEAD answer in `HEAD_FALLBACK_STATUSES` adds its origin). */
  readonly getOnly: Set<string>;
  readonly signal: AbortSignal;
  readonly limits?: Pick<LinkLimits, 'requestTimeoutMs' | 'maxRedirects' | 'getBodyBytes'>;
  readonly now?: () => number;
}

/**
 * Checks one link: HEAD first (unless its origin is known not to do HEAD), then, when HEAD answers
 * `HEAD_FALLBACK_STATUSES`, GET with the body cut at `getBodyBytes` and the connection aborted; one
 * `requestTimeoutMs` deadline for both. `null` when the run was stopped (no result).
 */
export async function checkLink(url: string, options: LinkRequestOptions): Promise<LinkCheckResult | null> {
  const limits = options.limits ?? LINK_CHECK_LIMITS;
  const now = options.now ?? Date.now;
  const origin = new URL(url).origin;
  const deadline = now() + limits.requestTimeoutMs;
  const ask = (method: 'HEAD' | 'GET') =>
    options.fetch(url, {
      method,
      maxBytes: method === 'GET' ? limits.getBodyBytes : 0,
      timeoutMs: Math.max(1, deadline - now()),
      maxRedirects: limits.maxRedirects,
      page: options.page,
      userAgent: options.userAgent,
      signal: options.signal,
    });
  let method: 'HEAD' | 'GET' = options.getOnly.has(origin) ? 'GET' : 'HEAD';
  let answer = await ask(method);
  if (method === 'HEAD' && answer.outcome === 'response' && needsGetFallback(answer.status)) {
    options.getOnly.add(origin);
    method = 'GET';
    answer = await ask(method);
  }
  if (options.signal.aborted) return null;
  return classifyLink(url, { outcome: answer.outcome, status: answer.status, redirects: answer.redirects, finalUrl: answer.finalUrl, method });
}
