// Spec: specs/projects.spec.ts (searchUrlFor, searchLocaleFor, SEARCH_PARAM_URL_RULES, PROJECT_RUN_LIMITS, queryLabel,
// deleteProjectDialog, QUERY_DEVICE_PROFILES, QUERY_FIELD_MAX_CHARS; Phase 10: RUN_SCOPES, PROJECT_REFUSALS, normalizeTag,
// normalizeTags, BULK_SEARCH_LIMITS, BULK_LINE_OUTCOMES, splitBulkSearches, bulkSearchInputs, PROJECT_SORTS, sortProjects),
// specs/browser-polish.spec.ts (SEARCH_ENGINES, wellFormed), specs/workspace-db.spec.ts (TAG_MAX_CHARS, MAX_TAGS_PER_ENTRY)
// Acceptance: specs/projects.feature.md (Saved searches; Tags; Bulk add; Favorites and sort; Run scope;
// Scenarios: search-url-for-params, projects-spec-values, project workspace)
import { describe, expect, test } from 'vitest';
import { SEARCH_ENGINE_IDS, SEARCH_ENGINES } from '@app/specs/browser-polish.spec';
import { WATCH_TIMEOUT_MS, MAX_PENDING_WATCHES } from '@app/specs/browser.spec';
import { MAX_PROJECT_QUERIES } from '@app/specs/capture-db.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import {
  BULK_LINE_OUTCOMES,
  BULK_SEARCH_LIMITS,
  DELETE_PROJECT,
  MOBILE_QUERY_PROFILE,
  PROJECT_REFUSAL_MESSAGES,
  PROJECT_REFUSALS,
  PROJECT_SORT_LABELS,
  PROJECT_SORTS,
  RUN_SCOPES,
  bulkSearchInputs,
  normalizeTag,
  normalizeTags,
  sortProjects,
  splitBulkSearches,
  type ProjectSummary,
  PROJECT_RUN_LIMITS,
  QUERY_DEVICE_PROFILES,
  QUERY_FIELD_MAX_CHARS,
  SEARCH_PARAM_URL_RULES,
  TABLET_QUERY_PROFILE,
  deleteProjectDialog,
  queryLabel,
  searchLocaleFor,
  searchUrlFor,
  type SavedSearchInput,
} from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';
import { SERP_PARAM_LIMITS } from '@app/specs/serp.spec';
import { MAX_TAGS_PER_ENTRY, TAG_MAX_CHARS } from '@app/specs/workspace-db.spec';

const BASE: SavedSearchInput = { engine: 'google', query: 'green tea', country: null, language: null, device: 'desktop' };
const PARAMS: SearchParams = { engine: 'google', engineLabel: 'Google', query: 'green tea', gl: null, hl: null, device: 'desktop', page: 1, offset: null, url: 'https://www.google.com/search?q=green+tea' };

describe('projects spec', () => {
  test('search-url-for-params', () => {
    // Every engine has a rule, and its URL starts as the address bar's search of the query.
    expect(Object.keys(SEARCH_PARAM_URL_RULES).sort()).toEqual([...SEARCH_ENGINE_IDS].sort());
    for (const engine of SEARCH_ENGINES) expect(searchUrlFor({ ...BASE, engine: engine.id })).toBe(engine.template.replace('{q}', 'green%20tea'));
    const full = { ...BASE, country: 'de', language: 'pt-br', device: 'mobile' as const };
    // The pack's parameter names, the country first; the device is never a parameter.
    expect(searchUrlFor({ ...full, engine: 'google' })).toBe('https://www.google.com/search?q=green%20tea&gl=de&hl=pt-br');
    expect(searchUrlFor({ ...full, engine: 'bing' })).toBe('https://www.bing.com/search?q=green%20tea&cc=de&setlang=pt-br');
    expect(searchUrlFor({ ...full, engine: 'duckduckgo' })).toBe('https://duckduckgo.com/?q=green%20tea&kl=de-pt-br');
    expect(searchUrlFor({ ...full, device: 'tablet' })).toBe(searchUrlFor(full));
    // What Phase 3 must read back.
    expect(searchLocaleFor({ ...full, engine: 'google' })).toEqual({ gl: 'de', hl: 'pt-br' });
    expect(searchLocaleFor({ ...full, engine: 'bing' })).toEqual({ gl: 'de', hl: 'pt-br' });
    expect(searchLocaleFor({ ...full, engine: 'duckduckgo' })).toEqual({ gl: 'de-pt-br', hl: null });
    expect(searchLocaleFor({ ...BASE, engine: 'duckduckgo', country: 'fr' })).toEqual({ gl: null, hl: null });
    // One of the two: Google and Bing send it; DuckDuckGo needs both for its one region value.
    expect(searchUrlFor({ ...BASE, country: 'fr' })).toBe('https://www.google.com/search?q=green%20tea&gl=fr');
    expect(searchUrlFor({ ...BASE, engine: 'bing', language: 'fr' })).toBe('https://www.bing.com/search?q=green%20tea&setlang=fr');
    expect(searchUrlFor({ ...BASE, engine: 'duckduckgo', country: 'fr' })).toBe('https://duckduckgo.com/?q=green%20tea');
    expect(searchUrlFor({ ...BASE, engine: 'duckduckgo', language: 'fr' })).toBe('https://duckduckgo.com/?q=green%20tea');
    // Encoding: the query is only ever the value of the engine's query parameter.
    const tricky = searchUrlFor({ ...BASE, query: 'a&hl=xx#frag ?/ café 🍵' });
    expect(tricky).toBe(`https://www.google.com/search?q=${encodeURIComponent('a&hl=xx#frag ?/ café 🍵')}`);
    expect(new URL(tricky).searchParams.get('q')).toBe('a&hl=xx#frag ?/ café 🍵');
    expect(new URL(tricky).hash).toBe('');
    // A lone surrogate is U+FFFD (encodeURIComponent would throw on it).
    expect(searchUrlFor({ ...BASE, query: 'tea \ud800 pot' })).toBe('https://www.google.com/search?q=tea%20%EF%BF%BD%20pot');
    expect(new URL(searchUrlFor({ ...BASE, query: '\udc00' })).searchParams.get('q')).toBe('�');
    // The host and path never change.
    for (const engine of SEARCH_ENGINES) {
      const url = new URL(searchUrlFor({ ...full, engine: engine.id, query: '//evil.example/x' }));
      expect(url.origin + url.pathname).toBe(new URL(engine.template.replace('{q}', '')).origin + new URL(engine.template.replace('{q}', '')).pathname);
    }
  });

  test('projects-spec-values', () => {
    // The long-poll matches browser.watch's.
    expect(PROJECT_RUN_LIMITS.runStateWatchTimeoutMs).toBe(WATCH_TIMEOUT_MS);
    expect(PROJECT_RUN_LIMITS.maxPendingRunWatches).toBe(MAX_PENDING_WATCHES);
    expect(PROJECT_RUN_LIMITS).toMatchObject({ maxRunTargets: 70, targetActiveTimeoutMs: 45_000, captureRetryMs: 500 });
    // The longest language still makes a DuckDuckGo region Phase 3 records.
    expect(QUERY_FIELD_MAX_CHARS).toEqual({ language: SERP_PARAM_LIMITS.maxLocaleChars - 3 });
    expect(searchLocaleFor({ ...BASE, engine: 'duckduckgo', country: 'de', language: 'a'.repeat(QUERY_FIELD_MAX_CHARS.language) }).gl).toHaveLength(SERP_PARAM_LIMITS.maxLocaleChars);
    // A mobile query: a phone with a mobile user agent, the rest frost's defaults.
    expect(MOBILE_QUERY_PROFILE).toEqual({ ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile' });
    const phone = QUICK_RENDER_PROFILES.find((quick) => quick.id === 'mobile-slow')!.profile;
    expect([MOBILE_QUERY_PROFILE.device, MOBILE_QUERY_PROFILE.userAgent]).toEqual([phone.device, phone.userAgent]);
    // A tablet query: the tablet preset with a mobile user agent; desktop queries use the project's.
    expect(TABLET_QUERY_PROFILE).toEqual({ ...DEFAULT_RENDER_PROFILE, device: 'tablet', userAgent: 'mobile' });
    expect(QUERY_DEVICE_PROFILES).toEqual({ mobile: MOBILE_QUERY_PROFILE, tablet: TABLET_QUERY_PROFILE });
    // Labels name the query, its engine and its settings.
    expect(queryLabel({ ...PARAMS, gl: 'de', hl: 'de', device: 'mobile' })).toBe('“green tea” on Google (DE, de, mobile)');
    expect(queryLabel({ ...PARAMS, engine: 'duckduckgo', engineLabel: 'DuckDuckGo', gl: 'de-de' })).toBe('“green tea” on DuckDuckGo (DE-DE, desktop)');
    // The delete confirmation: Cancel is the default; the name quoted and isolated.
    // A replacement pattern in the name is text, not a pattern.
    expect(deleteProjectDialog("Tea $' $& $` $$").detail).toContain("“⁨Tea $' $& $` $$⁩”");
    const dialog = deleteProjectDialog('Tea ‮gnp.exe');
    expect(dialog.defaultId).toBe(DELETE_PROJECT.dialog.cancelId);
    expect(dialog.buttons[DELETE_PROJECT.confirmIndex]).toBe('Delete Project');
    expect(dialog.detail).toContain('“⁨Tea ‮gnp.exe⁩”');
  });

  test('projects-workspace-values', () => {
    // Run scopes, refusals, bulk limits, line outcomes and sorts.
    expect(RUN_SCOPES).toEqual(['all', 'searches']);
    expect(PROJECT_REFUSALS).toEqual(expect.arrayContaining(['invalid-domain', 'invalid-tag', 'unfiled', 'limit']));
    expect(Object.keys(PROJECT_REFUSAL_MESSAGES).sort()).toEqual([...PROJECT_REFUSALS].sort());
    expect(BULK_SEARCH_LIMITS).toMatchObject({ maxLines: MAX_PROJECT_QUERIES, maxLocales: 5 });
    expect(BULK_LINE_OUTCOMES).toEqual(['added', 'exists', 'invalid', 'limit']);
    expect(PROJECT_SORTS).toEqual(['name', 'last-captured', 'created']);
    expect(Object.keys(PROJECT_SORT_LABELS)).toEqual([...PROJECT_SORTS]);
    // Tags: NFC, white space runs as one space, trimmed, lowercase; blank, too long or unprintable refused.
    expect(normalizeTag('  Top\t\n 10 ')).toBe('top 10');
    expect(normalizeTag('Cafe\u0301')).toBe('café');
    expect(normalizeTag('x'.repeat(TAG_MAX_CHARS))).toBe('x'.repeat(TAG_MAX_CHARS));
    for (const bad of ['', '   ', 'x'.repeat(TAG_MAX_CHARS + 1), 'a\u0000b', 'a\u007fb', 'a\u202eb', 'a\u2066b']) expect(normalizeTag(bad), JSON.stringify(bad)).toBeNull();
    expect(normalizeTags(['B', 'a', ' b '])).toEqual(['a', 'b']);
    expect(normalizeTags(Array.from({ length: MAX_TAGS_PER_ENTRY }, (_, n) => `t${n}`))).toHaveLength(MAX_TAGS_PER_ENTRY);
    expect(normalizeTags(Array.from({ length: MAX_TAGS_PER_ENTRY + 1 }, (_, n) => `t${n}`))).toBeNull();
    expect(normalizeTags(['ok', ''])).toBeNull();
    // Bulk text: lines or commas, white space collapsed, blanks and repeats dropped, in order.
    expect(splitBulkSearches('green tea\r\nblack  tea, oolong\n\n , green tea\nGreen tea')).toEqual(['green tea', 'black tea', 'oolong', 'Green tea']);
    expect(splitBulkSearches(' \n, \n')).toEqual([]);
    // One search per locale, on each device, locales first.
    expect(
      bulkSearchInputs('tea', {
        engine: 'bing',
        locales: [
          { country: 'de', language: 'de' },
          { country: null, language: null },
        ],
        devices: ['desktop', 'mobile'],
      }),
    ).toEqual([
      { engine: 'bing', query: 'tea', country: 'de', language: 'de', device: 'desktop' },
      { engine: 'bing', query: 'tea', country: 'de', language: 'de', device: 'mobile' },
      { engine: 'bing', query: 'tea', country: null, language: null, device: 'desktop' },
      { engine: 'bing', query: 'tea', country: null, language: null, device: 'mobile' },
    ]);
    // Sort: Unfiled first, favorites next, then by the sort; ties by name, then id. The input is left as it is.
    const p = (id: string, name: string, changes: Partial<ProjectSummary> = {}): ProjectSummary => ({
      id,
      name,
      unfiled: false,
      renderProfile: null,
      retention: { mode: 'forever', value: null },
      favorite: false,
      site: null,
      createdAt: 0,
      lastCapturedAt: null,
      ...changes,
    });
    const list = [
      p('1', 'banana', { createdAt: 3, lastCapturedAt: 10 }),
      p('2', 'Apple', { createdAt: 4 }),
      p('0', 'Unfiled', { unfiled: true, createdAt: 0 }),
      p('3', 'cherry', { createdAt: 2, lastCapturedAt: 30, favorite: true }),
      p('4', 'apple', { createdAt: 1, lastCapturedAt: 20 }),
      p('5', 'date', { createdAt: 5, favorite: true }),
    ];
    const names = (sort: (typeof PROJECT_SORTS)[number]) => sortProjects(list, sort).map((project) => project.id);
    expect(names('name')).toEqual(['0', '3', '5', '2', '4', '1']);
    expect(names('last-captured')).toEqual(['0', '3', '5', '4', '1', '2']);
    expect(names('created')).toEqual(['0', '5', '3', '2', '1', '4']);
    expect(list.map((project) => project.id)).toEqual(['1', '2', '0', '3', '4', '5']);
  });
});
