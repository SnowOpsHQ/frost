// Spec: specs/seo-sidebar.spec.ts (SIDEBAR_DEFAULT_OPEN, SEO_PANELS), specs/seo-rules.spec.ts (thresholds)
// Acceptance: specs/seo-sidebar.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { Finding, SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { TITLE_MAX_CHARS, TITLE_MIN_CHARS } from '@app/specs/seo-rules.spec';
import { SEO_PANELS, SIDEBAR_DEFAULT_OPEN } from '@app/specs/seo-sidebar.spec';
import { lengthIndicator, railStatuses, shownResponse, sidebarOpenFromStorage } from '../seo-view';

function finding(severity: Finding['severity'], category: Finding['category']): Finding {
  return { ruleId: 'title-missing', category, severity, title: 't', why: 'w', fix: 'f', details: { facts: [], samples: [] } };
}

function ready(url: string, findings: Finding[]): SeoAuditResponse {
  return { status: 'ready', url, audit: { url, findings } as unknown as SeoAudit };
}

describe('seo view helpers', () => {
  test('sidebar-open-from-storage', () => {
    expect(sidebarOpenFromStorage('1')).toBe(true);
    expect(sidebarOpenFromStorage('0')).toBe(false);
    for (const other of [null, '', 'true', 'false', '2', ' 1']) expect(sidebarOpenFromStorage(other), String(other)).toBe(SIDEBAR_DEFAULT_OPEN);
  });

  test('length-indicator', () => {
    expect(lengthIndicator(null, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('missing');
    expect(lengthIndicator(0, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('missing');
    expect(lengthIndicator(TITLE_MIN_CHARS - 1, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('short');
    expect(lengthIndicator(TITLE_MIN_CHARS, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('ok');
    expect(lengthIndicator(TITLE_MAX_CHARS, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('ok');
    expect(lengthIndicator(TITLE_MAX_CHARS + 1, TITLE_MIN_CHARS, TITLE_MAX_CHARS)).toBe('long');
  });

  test('rail-statuses', () => {
    expect(railStatuses(null)).toEqual({});
    expect(railStatuses({ status: 'pending', url: 'https://a.example/' })).toEqual({});
    expect(railStatuses({ status: 'unavailable', url: 'https://a.example/', reason: 'timeout' })).toEqual({});
    const statuses = railStatuses(ready('https://a.example/', [finding('warning', 'links'), finding('error', 'title')]));
    for (const panel of SEO_PANELS) {
      if (panel.available) expect(statuses[panel.id], panel.id).toBe('error');
      else expect(statuses[panel.id], panel.id).toBeUndefined();
    }
    expect(railStatuses(ready('https://a.example/', [finding('info', 'url')]))['on-page']).toBe('pass');
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'url')]))['on-page']).toBe('warn');
  });

  test('response-matches-tab', () => {
    const tab = { id: 3, url: 'https://a.example/b' };
    const answer = ready('https://a.example/b', []);
    expect(shownResponse(tab, { tabId: 3, response: answer })).toBe(answer);
    // Another tab's answer, or one for another URL (an SPA moved on), is never shown.
    expect(shownResponse(tab, { tabId: 4, response: answer })).toEqual({ status: 'pending', url: tab.url });
    expect(shownResponse({ ...tab, url: 'https://a.example/c' }, { tabId: 3, response: answer })).toEqual({ status: 'pending', url: 'https://a.example/c' });
    expect(shownResponse(tab, null)).toEqual({ status: 'pending', url: tab.url });
  });
});
