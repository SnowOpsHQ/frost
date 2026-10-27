// Spec: specs/seo-sidebar.spec.ts (SIDEBAR_DEFAULT_OPEN, SEO_PANELS), specs/seo-rules.spec.ts (thresholds)
// Acceptance: specs/seo-sidebar.feature.md (Renderer helpers), specs/seo-panels.feature.md (Renderer helpers), specs/seo-schema.feature.md (Renderer helpers)
import { describe, expect, test } from 'vitest';
import type { Finding, SchemaEntity, SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { TITLE_MAX_CHARS, TITLE_MIN_CHARS } from '@app/specs/seo-rules.spec';
import { LINK_FILTER_QUERY_MAX_CHARS, SEO_PANELS, SIDEBAR_DEFAULT_OPEN } from '@app/specs/seo-sidebar.spec';
import { SCHEMA_PANEL_LIMITS } from '@app/specs/schema-types.spec';
import { declaredSize, entityIndex, errorExcerpt, firstShown, formatSize, moreShown, openByDefault, rawSegments, highlightToClear, isolatedTooltip, lengthIndicator, linkQuery, openableUrl, oversizeRatio, railStatuses, schemaTypeSummary, shownResponse, sidebarOpenFromStorage, UNTYPED_LABEL } from '../seo-view';

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
    const statuses = railStatuses(ready('https://a.example/', [finding('warning', 'links'), finding('error', 'title'), finding('warning', 'social')]));
    const expected: Record<string, string | undefined> = { overview: 'error', 'on-page': 'error', links: 'warn', images: 'pass', social: 'warn', schema: 'pass', indexability: 'pass', speed: 'pass', compliance: 'pass' };
    for (const panel of SEO_PANELS) {
      if (panel.available) expect(statuses[panel.id], panel.id).toBe(expected[panel.id]);
      else expect(statuses[panel.id], panel.id).toBeUndefined();
    }
    // Social findings colour Overview and Social, not On-Page.
    expect(railStatuses(ready('https://a.example/', [finding('error', 'social')]))).toMatchObject({ overview: 'error', 'on-page': 'pass', social: 'error', links: 'pass', images: 'pass' });
    // Schema findings colour Overview and Schema, not On-Page.
    expect(railStatuses(ready('https://a.example/', [finding('error', 'schema')]))).toMatchObject({ overview: 'error', 'on-page': 'pass', schema: 'error', social: 'pass' });
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'schema')])).schema).toBe('warn');
    expect(railStatuses(ready('https://a.example/', [finding('info', 'url')]))['on-page']).toBe('pass');
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'url')]))['on-page']).toBe('warn');
    // Indexability: HTTP / robots.txt and hreflang findings colour it, not On-Page; the robots meta tags colour both.
    expect(railStatuses(ready('https://a.example/', [finding('error', 'indexability')]))).toMatchObject({ overview: 'error', 'on-page': 'pass', indexability: 'error' });
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'hreflang')]))).toMatchObject({ 'on-page': 'pass', indexability: 'warn' });
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'indexing')]))).toMatchObject({ 'on-page': 'warn', indexability: 'warn' });
    // Page speed (Task 5): performance findings colour Overview and Speed only.
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'performance')]))).toMatchObject({ overview: 'warn', 'on-page': 'pass', speed: 'warn' });
    // Compliance: security and accessibility findings colour it (and Overview), not On-Page.
    expect(railStatuses(ready('https://a.example/', [finding('error', 'security')]))).toMatchObject({ overview: 'error', 'on-page': 'pass', compliance: 'error' });
    expect(railStatuses(ready('https://a.example/', [finding('warning', 'accessibility')]))).toMatchObject({ 'on-page': 'pass', compliance: 'warn' });
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

  test('tooltip-is-bidi-isolated', () => {
    expect(isolatedTooltip('plain')).toBe('\u2068plain\u2069');
    // An override inside stays inside: the tooltip text ends with the isolate's close.
    expect(isolatedTooltip('\u202Eevil')).toBe('\u2068\u202Eevil\u2069');
  });

  test('only-web-urls-are-openable', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1:8080/x']) expect(openableUrl(url), url).toBe(true);
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'mailto:a@example.com', 'file:///etc/passwd', '/relative', '', 'app://app/']) expect(openableUrl(url), url).toBe(false);
  });

  test('image-size-labels', () => {
    expect(formatSize({ width: 1200, height: 630 })).toBe('1,200 × 630');
    expect(formatSize(null)).toBeNull();
    expect(declaredSize('640', ' 360 ')).toBe('640 × 360');
    expect(declaredSize('640', null)).toBe('640 × ?');
    expect(declaredSize(null, '')).toBeNull();
    expect(oversizeRatio({ width: 100, height: 50 }, { width: 250, height: 50 })).toBe('2.5×');
    expect(oversizeRatio({ width: 100, height: 50 }, null)).toBeNull();
    expect(oversizeRatio({ width: 0, height: 50 }, { width: 10, height: 10 })).toBeNull();
  });

  test('link-query-is-capped', () => {
    expect(linkQuery('coffee')).toBe('coffee');
    expect(linkQuery('x'.repeat(LINK_FILTER_QUERY_MAX_CHARS + 5))).toHaveLength(LINK_FILTER_QUERY_MAX_CHARS);
    // A surrogate pair at the cut is dropped whole.
    const emoji = `${'x'.repeat(LINK_FILTER_QUERY_MAX_CHARS - 1)}😀`;
    expect(linkQuery(emoji)).toBe('x'.repeat(LINK_FILTER_QUERY_MAX_CHARS - 1));
  });

  test('highlight-follows-its-panel', () => {
    // Shown with its toggle in view: kept.
    expect(highlightToClear('links', 'links', true)).toBe(false);
    expect(highlightToClear('headings', 'on-page', true)).toBe(false);
    // The sidebar collapsed, or another panel opened: off.
    expect(highlightToClear('links', 'links', false)).toBe(true);
    expect(highlightToClear('links', 'overview', true)).toBe(true);
    expect(highlightToClear('headings', 'links', true)).toBe(true);
    expect(highlightToClear('headings', 'on-page', false)).toBe(true);
    // Nothing on: nothing to do.
    expect(highlightToClear('off', 'overview', false)).toBe(false);
  });

  test('schema-type-summary', () => {
    const entity = (types: string[], extended: number | null = null) => ({ types, extends: extended });
    expect(schemaTypeSummary([entity(['Organization']), entity(['Product']), entity(['Product', 'Thing']), entity([]), entity(['Product']), entity([], 1)])).toEqual([
      { type: 'Product', count: 3 },
      { type: 'Organization', count: 1 },
      { type: 'Thing', count: 1 },
      { type: UNTYPED_LABEL, count: 1 },
    ]);
    expect(schemaTypeSummary([])).toEqual([]);
  });

  test('schema-error-excerpt', () => {
    expect(errorExcerpt('{"a": 1,}', 7)).toEqual({ before: '{"a": 1', at: ',', after: '}' });
    // Clamped to the text; the end has no character.
    expect(errorExcerpt('abc', 3)).toEqual({ before: 'abc', at: '', after: '' });
    expect(errorExcerpt('abc', 99)).toEqual({ before: 'abc', at: '', after: '' });
    expect(errorExcerpt('abc', -4)).toEqual({ before: '', at: 'a', after: 'bc' });
    expect(errorExcerpt('abc', Number.NaN)).toEqual({ before: '', at: 'a', after: 'bc' });
    // A whole code point, never half a surrogate pair.
    expect(errorExcerpt('x😀y', 1)).toEqual({ before: 'x', at: '😀', after: 'y' });
  });

  test('schema-entity-index', () => {
    const leaf = { key: 2, syntax: 'json-ld', block: 0, types: ['Offer'], id: null, properties: [], topLevel: false, extends: null } as SchemaEntity;
    const top = { key: 1, syntax: 'json-ld', block: 0, types: ['Product'], id: null, properties: [{ name: 'offers', values: [{ kind: 'entity', entity: leaf }, { kind: 'ref', id: '#x', target: 9 }] }], topLevel: true, extends: null } as SchemaEntity;
    expect([...entityIndex([top]).keys()].sort()).toEqual([1, 2]);
  });

  test('schema-panel-bounds', () => {
    const open = Array.from({ length: 10 }, (_, i) => openByDefault(i));
    expect(open.filter(Boolean)).toHaveLength(SCHEMA_PANEL_LIMITS.openTopLevel);
    expect(open.slice(0, SCHEMA_PANEL_LIMITS.openTopLevel).every(Boolean)).toBe(true);
    expect(firstShown(400, SCHEMA_PANEL_LIMITS.entitiesShown)).toBe(SCHEMA_PANEL_LIMITS.entitiesShown);
    expect(firstShown(7, SCHEMA_PANEL_LIMITS.rowsShown)).toBe(7);
    expect(moreShown(SCHEMA_PANEL_LIMITS.rowsShown, 30, SCHEMA_PANEL_LIMITS.rowsShown)).toBe(30);
    expect(moreShown(10, 100, 10)).toBe(20);
  });

  test('raw-view-marks-controls', () => {
    expect(rawSegments('{"a": 1}')).toEqual([{ kind: 'text', text: '{"a": 1}' }]);
    expect(rawSegments('a\u202Eb\tc\nd\u0000e\u2066\u007F')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'mark', code: 'U+202E' },
      { kind: 'text', text: 'b\tc\nd' },
      { kind: 'mark', code: 'U+0000' },
      { kind: 'text', text: 'e' },
      { kind: 'mark', code: 'U+2066' },
      { kind: 'mark', code: 'U+007F' },
    ]);
    expect(rawSegments('')).toEqual([]);
  });
});
