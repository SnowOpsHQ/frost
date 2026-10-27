// Spec: specs/seo-checks.spec.ts (LINK_STATUS_LABELS, LINK_REASON_LABELS, RECIPROCITY_LABELS, CHECK_RUN_STATUSES)
// Acceptance: specs/seo-checks.feature.md (Panels and palette)
import { describe, expect, test } from 'vitest';
import type { PageLink } from '@app/seo-core';
import { IDLE_HREFLANG_RUN, IDLE_LINK_RUN, IDLE_SITEMAP_RUN, type LinkCheckResult } from '@app/specs/seo-checks.spec';
import { checksFor, knownChecks, linkKindCounts, linkResultIndex, linkStatusText, linkTone, reciprocityText, reciprocityTone, rememberChecks, runSummary } from '../checks-view';

const result = (url: string, changes: Partial<LinkCheckResult> = {}): LinkCheckResult => ({ url, kind: 'ok', status: 200, finalUrl: null, redirects: 0, reason: null, method: 'HEAD', cached: false, ...changes });
const link = (href: string): PageLink => ({ href, scheme: '', rel: '', text: '', kind: 'internal', target: null });

describe('checks view', () => {
  test('checks-view-labels', () => {
    expect(linkStatusText(result('a'))).toBe('200');
    expect(linkStatusText(result('a', { kind: 'broken', status: 404, reason: 'http-error' }))).toBe('404 Broken');
    expect(linkStatusText(result('a', { kind: 'redirect', status: 200, redirects: 1 }))).toBe('200 Redirect');
    expect(linkStatusText(result('a', { kind: 'broken', status: null, reason: 'timeout' }))).toBe('Broken: Timed out');
    expect(linkStatusText(result('a', { kind: 'skipped', status: null, reason: 'private' }))).toBe('Skipped: Private address');
    expect(linkStatusText(result('a', { kind: 'blocked', status: null }))).toBe('Blocked by robots.txt');
    expect([linkTone('ok'), linkTone('broken'), linkTone('redirect'), linkTone('blocked'), linkTone('skipped')]).toEqual(['ok', 'error', 'warn', 'warn', 'muted']);
    expect(runSummary('idle', 0, 0)).toBe('Not checked yet');
    expect(runSummary('running', 3, 1_200)).toBe('Checking… 3 of 1,200');
    expect(runSummary('done', 1, 1)).toBe('Checked 1 link');
    expect(runSummary('stopped', 2, 9)).toBe('Stopped after 2 of 9');
    expect(reciprocityText('missing-return')).toBe('Does not link back');
    expect([reciprocityTone('reciprocal'), reciprocityTone('wrong-language'), reciprocityTone('unreachable')]).toEqual(['ok', 'error', 'muted']);
  });

  test('checks-view-result-index', () => {
    const run = { ...IDLE_LINK_RUN, status: 'done' as const, results: [result('https://example.com/a'), result('mailto:x@y', { kind: 'skipped', status: null, reason: 'not-http' }), result('https://example.com/b', { kind: 'broken', status: 404 })] };
    const of = linkResultIndex(run);
    expect(of(link('https://example.com/a#frag'))?.kind).toBe('ok');
    expect(of(link('mailto:x@y'))?.kind).toBe('skipped');
    expect(of(link(''))).toBeUndefined();
    expect(of(link('https://example.com/c'))).toBeUndefined();
    expect(linkKindCounts(run)).toEqual({ ok: 1, redirect: 0, broken: 1, temporary: 0, blocked: 0, skipped: 1 });
    expect(linkResultIndex(undefined)(link('https://example.com/a'))).toBeUndefined();
    const state = { version: 2, tabId: 4, url: 'https://example.com/', links: run, sitemaps: IDLE_SITEMAP_RUN, hreflang: IDLE_HREFLANG_RUN };
    expect(checksFor(state, 4)).toBe(state);
    expect(checksFor(state, 5)).toBeNull();
    rememberChecks(state);
    expect(knownChecks(4)).toBe(state);
    expect(knownChecks(5)).toBeUndefined();
  });
});
