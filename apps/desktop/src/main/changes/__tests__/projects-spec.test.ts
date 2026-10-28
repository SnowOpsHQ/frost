// Spec: specs/projects.spec.ts (searchUrlFor, SEARCH_PARAM_URL_RULES, SEARCH_PARAMS_NEVER_SENT, PROJECT_RUN_LIMITS,
// queryLabel, deleteProjectDialog, MOBILE_QUERY_PROFILE), specs/browser-polish.spec.ts (SEARCH_ENGINES, wellFormed)
// Acceptance: specs/projects.feature.md (Search URLs; Scenarios: search-url-for-params)
import { describe, expect, test } from 'vitest';
import { SEARCH_ENGINE_IDS, SEARCH_ENGINES } from '@app/specs/browser-polish.spec';
import { WATCH_TIMEOUT_MS, MAX_PENDING_WATCHES } from '@app/specs/browser.spec';
import { SEARCH_LANGUAGE_MAX_CHARS, SEARCH_LOCATION_MAX_CHARS, type SearchParams } from '@app/specs/capture-search-params.schema';
import { DELETE_PROJECT, MOBILE_QUERY_PROFILE, PROJECT_RUN_LIMITS, QUERY_FIELD_MAX_CHARS, SEARCH_PARAM_URL_RULES, SEARCH_PARAMS_NEVER_SENT, deleteProjectDialog, queryLabel, searchUrlFor } from '@app/specs/projects.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES } from '@app/specs/render-profile.spec';

const BASE: SearchParams = { engine: 'google', query: 'green tea', country: null, language: null, location: null, device: null };

describe('projects spec', () => {
  test('search-url-for-params', () => {
    // Every engine has a rule, and its URL starts as the address bar's search of the query.
    expect(Object.keys(SEARCH_PARAM_URL_RULES).sort()).toEqual([...SEARCH_ENGINE_IDS].sort());
    for (const engine of SEARCH_ENGINES) expect(searchUrlFor({ ...BASE, engine: engine.id })).toBe(engine.template.replace('{q}', 'green%20tea'));
    const full = { ...BASE, country: 'de', language: 'pt-br', location: 'Berlin', device: 'mobile' as const };
    expect(searchUrlFor({ ...full, engine: 'google' })).toBe('https://www.google.com/search?q=green%20tea&hl=pt-br&gl=de');
    expect(searchUrlFor({ ...full, engine: 'bing' })).toBe('https://www.bing.com/search?q=green%20tea&setlang=pt-br&cc=de');
    expect(searchUrlFor({ ...full, engine: 'duckduckgo' })).toBe('https://duckduckgo.com/?q=green%20tea&kl=de-pt-br');
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

  test('search-url-never-sends-location', () => {
    expect(SEARCH_PARAMS_NEVER_SENT).toEqual(['location']);
    for (const engine of SEARCH_ENGINE_IDS) {
      const url = searchUrlFor({ ...BASE, engine, location: 'Somewhere Unique', device: 'mobile' });
      expect(url).not.toContain('Somewhere');
      expect(url).not.toContain('mobile');
      expect(url).toBe(searchUrlFor({ ...BASE, engine }));
    }
  });

  test('projects-spec-values', () => {
    // The long-poll matches browser.watch's.
    expect(PROJECT_RUN_LIMITS.runStateWatchTimeoutMs).toBe(WATCH_TIMEOUT_MS);
    expect(PROJECT_RUN_LIMITS.maxPendingRunWatches).toBe(MAX_PENDING_WATCHES);
    expect(PROJECT_RUN_LIMITS).toMatchObject({ maxRunTargets: 70, targetActiveTimeoutMs: 45_000, captureRetryMs: 500 });
    // The query form's field caps are the schema's.
    expect(QUERY_FIELD_MAX_CHARS).toEqual({ language: SEARCH_LANGUAGE_MAX_CHARS, location: SEARCH_LOCATION_MAX_CHARS });
    // A mobile query: a phone with a mobile user agent, the rest frost's defaults.
    expect(MOBILE_QUERY_PROFILE).toEqual({ ...DEFAULT_RENDER_PROFILE, device: 'phone', userAgent: 'mobile' });
    const phone = QUICK_RENDER_PROFILES.find((quick) => quick.id === 'mobile-slow')!.profile;
    expect([MOBILE_QUERY_PROFILE.device, MOBILE_QUERY_PROFILE.userAgent]).toEqual([phone.device, phone.userAgent]);
    // Labels name the query, its engine and its settings.
    expect(queryLabel({ ...BASE, country: 'de', language: 'de', device: 'mobile', location: 'Berlin' })).toBe('“green tea” on Google (DE, de, mobile, Berlin)');
    expect(queryLabel({ ...BASE, engine: 'duckduckgo' })).toBe('“green tea” on DuckDuckGo');
    // The delete confirmation: Cancel is the default; the name quoted and isolated.
    // A replacement pattern in the name is text, not a pattern.
    expect(deleteProjectDialog("Tea $' $& $` $$").detail).toContain("“⁨Tea $' $& $` $$⁩”");
    const dialog = deleteProjectDialog('Tea ‮gnp.exe');
    expect(dialog.defaultId).toBe(DELETE_PROJECT.dialog.cancelId);
    expect(dialog.buttons[DELETE_PROJECT.confirmIndex]).toBe('Delete Project');
    expect(dialog.detail).toContain('“⁨Tea ‮gnp.exe⁩”');
  });
});
