// Spec: specs/ai-destinations.spec.ts (AI_SEARCH_DESTINATIONS, aiDestinationUrl, OPEN_DESTINATION_REFUSALS),
// specs/command-palette.spec.ts (OPEN_IN_URL_MAX_LENGTH), specs/browser-polish.spec.ts (wellFormed), specs/serp-service.schema.ts (SerpState,
// OpenDestinationAnswerSchema), specs/serp.spec.ts (SERP_DEVICES)
// Acceptance: specs/serp-panels.feature.md (Open in an AI engine, Main)
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AI_SEARCH_DESTINATIONS, OPEN_DESTINATION_REFUSALS, aiDestinationUrl, type AiDestinationId, type AiSearchDestination } from '@app/specs/ai-destinations.spec';
import { wellFormed } from '@app/specs/browser-polish.spec';
import { OPEN_IN_URL_MAX_LENGTH } from '@app/specs/command-palette.spec';
import { OpenDestinationAnswerSchema, type SerpState } from '@app/specs/serp-service.schema';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import { SelectorPackSchema, type SelectorPack } from '@app/specs/serp-selector-pack.schema';
import { SERP_DEVICES } from '@app/specs/serp.spec';
import { BUNDLED_PACK } from '../bundled';
import { createDestinations } from '../destinations';
import { matchSerp } from '../engines';

/** The bundled pack, parsed (its signature is `pack-store.test.ts`'s concern). */
const PACK: SelectorPack = SelectorPackSchema.parse(JSON.parse(new TextDecoder().decode(BUNDLED_PACK.bytes)));

const SERP_URL = 'https://www.google.com/search?q=green+tea&gl=us';
const paramsOf = (query: string): SearchParams => ({ engine: 'google', engineLabel: 'Google', query, gl: 'us', hl: null, device: 'desktop', page: 1, offset: null, url: SERP_URL });
const pending = (query: string, tabId = 4): SerpState => ({ status: 'pending', tabId, documentSeq: 1, url: SERP_URL, params: paramsOf(query) });
const ready = (query: string, tabId = 4): SerpState =>
  ({ status: 'ready', tabId, documentSeq: 1, url: SERP_URL, readAt: 1, snapshot: { status: 'ready', params: paramsOf(query) } }) as unknown as SerpState;
const unreadable = (query: string | null, tabId = 4): SerpState => ({
  status: 'unreadable',
  tabId,
  documentSeq: 1,
  url: SERP_URL,
  readAt: 1,
  reason: 'no-container',
  params: query === null ? null : paramsOf(query),
  packVersion: 1,
} as SerpState);

/** The active tab in these tests is 4 (7 where a test makes it so). */
let activeId: number | null = 4;
const active = (): number | null => activeId;

const destination = (id: AiDestinationId): AiSearchDestination => AI_SEARCH_DESTINATIONS.find((d) => d.id === id)!;
const IDS = AI_SEARCH_DESTINATIONS.map((d) => d.id);

describe('AI-engine destinations', () => {
  beforeEach(() => {
    activeId = 4;
  });

  test('destination-urls-are-fixed-https', () => {
    expect(IDS).toEqual(['perplexity', 'chatgpt', 'google-ai-mode']);
    expect(OPEN_DESTINATION_REFUSALS).toEqual(['no-search', 'no-tab']);
    expect(aiDestinationUrl(destination('perplexity'), 'green tea')).toBe('https://www.perplexity.ai/search?q=green+tea');
    expect(aiDestinationUrl(destination('chatgpt'), 'green tea')).toBe('https://chatgpt.com/?q=green+tea');
    expect(aiDestinationUrl(destination('google-ai-mode'), 'green tea')).toBe('https://www.google.com/search?q=green+tea&udm=50');
    const hostile = ['a&b=c', 'x#frag', '/../../admin', 'k=v&udm=2', 'me@evil.com', '//evil.com/x', 'line\nbreak', 'lone \uD800 surrogate', 'pair 😀 ok', '?q=other', '%26q%3D2'];
    for (const dest of AI_SEARCH_DESTINATIONS) {
      for (const query of hostile) {
        const built = aiDestinationUrl(dest, query);
        expect(built, `${dest.id} ${JSON.stringify(query)}`).not.toBeNull();
        const url = new URL(built!);
        // The table's origin and path, exactly; its parameters and nothing more.
        expect(url.protocol).toBe('https:');
        expect(url.origin).toBe(dest.origin);
        expect(url.pathname).toBe(dest.path);
        expect(url.hash).toBe('');
        expect(url.username + url.password).toBe('');
        expect([...url.searchParams.keys()]).toEqual([dest.queryParam, ...Object.keys(dest.params)]);
        // The query is one value, as it was (a lone surrogate becomes U+FFFD, still in that one value).
        expect(url.searchParams.getAll(dest.queryParam)).toEqual([wellFormed(query)]);
        for (const [key, value] of Object.entries(dest.params)) expect(url.searchParams.getAll(key)).toEqual([value]);
      }
      // Blank, or past the cap: nothing to open.
      expect(aiDestinationUrl(dest, '')).toBeNull();
      expect(aiDestinationUrl(dest, '   ')).toBeNull();
      expect(aiDestinationUrl(dest, 'x'.repeat(OPEN_IN_URL_MAX_LENGTH))).toBeNull();
      const fits = OPEN_IN_URL_MAX_LENGTH - aiDestinationUrl(dest, 'x')!.length + 1;
      expect(aiDestinationUrl(dest, 'x'.repeat(fits))!.length).toBe(OPEN_IN_URL_MAX_LENGTH);
      expect(aiDestinationUrl(dest, 'x'.repeat(fits + 1))).toBeNull();
    }
    // A malformed entry (not https, its query parameter twice, a path the URL rewrites) builds nothing.
    const base = destination('perplexity');
    expect(aiDestinationUrl({ ...base, origin: 'http://www.perplexity.ai' }, 'tea')).toBeNull();
    expect(aiDestinationUrl({ ...base, params: { q: 'fixed' } }, 'tea')).toBeNull();
    expect(aiDestinationUrl({ ...base, path: '/a/../search' }, 'tea')).toBeNull();
    expect(aiDestinationUrl({ ...base, origin: 'https://www.perplexity.ai/x' }, 'tea')).toBeNull();
  });

  test('destination-uses-the-tabs-own-query', () => {
    for (const state of [pending('green tea'), ready('green tea'), unreadable('green tea')]) {
      const opener = vi.fn((_url: string) => 9);
      const destinations = createDestinations({ activeTabId: active, state: () => state, openBackgroundTab: opener });
      const answer = destinations.open(4, 'perplexity');
      expect(answer, state.status).toEqual({ status: 'opened', tabId: 9 });
      expect(OpenDestinationAnswerSchema.parse(answer)).toEqual(answer);
      expect(new URL(opener.mock.calls[0]![0]).searchParams.get('q')).toBe('green tea');
    }
    // The state asked for is the named tab's, and only the tab id and the table id go in: there is no text argument.
    const state = vi.fn((tabId: number) => pending(`query of ${tabId}`, tabId));
    const opener = vi.fn((_url: string) => 9);
    activeId = 7;
    createDestinations({ activeTabId: active, state, openBackgroundTab: opener }).open(7, 'chatgpt');
    expect(state).toHaveBeenCalledWith(7);
    expect(opener).toHaveBeenCalledWith('https://chatgpt.com/?q=query+of+7');
    expect(createDestinations({ activeTabId: active, state, openBackgroundTab: opener }).open.length).toBe(2);
    // Only the active tab (as `browser.openTool`): another tab's id, or no active tab, is refused, its state never read.
    for (const current of [4, null]) {
      activeId = current;
      const background = vi.fn((tabId: number) => pending('background search', tabId));
      const never = vi.fn((_url: string) => 9);
      expect(createDestinations({ activeTabId: active, state: background, openBackgroundTab: never }).open(7, 'perplexity'), String(current)).toEqual({ status: 'refused', reason: 'no-search' });
      expect(background).not.toHaveBeenCalled();
      expect(never).not.toHaveBeenCalled();
    }
    activeId = 4;
    // A state of another tab than the one asked for is not taken.
    const other = vi.fn((_url: string) => 9);
    expect(createDestinations({ activeTabId: active, state: () => pending('tea', 5), openBackgroundTab: other }).open(4, 'perplexity')).toEqual({ status: 'refused', reason: 'no-search' });
    expect(other).not.toHaveBeenCalled();
    // Not a search: nothing opens.
    const notSearches: SerpState[] = [
      { status: 'not-serp', tabId: 4, url: 'https://www.perplexity.ai/search?q=tea' },
      { status: 'not-serp', tabId: 4, url: '' },
      { status: 'disabled', tabId: 4, reason: 'pack-invalid' },
      unreadable(null),
    ];
    for (const notSearch of notSearches) {
      const refused = vi.fn((_url: string) => 9);
      expect(createDestinations({ activeTabId: active, state: () => notSearch, openBackgroundTab: refused }).open(4, 'google-ai-mode'), notSearch.status).toEqual({ status: 'refused', reason: 'no-search' });
      expect(refused).not.toHaveBeenCalled();
    }
    // An unknown destination id (past the router's enum) opens nothing either.
    const unknown = vi.fn((_url: string) => 9);
    expect(createDestinations({ activeTabId: active, state: () => pending('tea'), openBackgroundTab: unknown }).open(4, 'evil' as AiDestinationId)).toEqual({ status: 'refused', reason: 'no-search' });
    expect(unknown).not.toHaveBeenCalled();
  });

  test('destination-opener-gets-only-table-urls', () => {
    const queries = ['green tea', 'a&b=c#d', '//evil.com/@x', 'lone \uDC00 half', 'k=v&udm=2'];
    for (const id of IDS) {
      for (const query of queries) {
        const opener = vi.fn((_url: string) => 3);
        const destinations = createDestinations({ activeTabId: active, state: () => ready(query), openBackgroundTab: opener });
        expect(destinations.open(4, id)).toEqual({ status: 'opened', tabId: 3 });
        expect(opener).toHaveBeenCalledTimes(1);
        expect(opener.mock.calls[0]).toEqual([aiDestinationUrl(destination(id), query)]);
      }
    }
    // Nothing opens until asked: creating the destinations calls neither the state nor the opener.
    const state = vi.fn(() => pending('tea'));
    const opener = vi.fn((_url: string) => 3);
    createDestinations({ activeTabId: active, state, openBackgroundTab: opener });
    expect(state).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
  });

  test('ai-destinations-are-not-serps', () => {
    for (const dest of AI_SEARCH_DESTINATIONS) {
      for (const query of ['green tea', 'best running shoes 2026']) {
        const url = aiDestinationUrl(dest, query)!;
        for (const device of SERP_DEVICES) expect(matchSerp(url, PACK, device), `${url} ${device}`).toBeNull();
      }
    }
    // Google AI Mode is refused by the pack's reject rule (the same address without `udm=50` is a result page).
    expect(matchSerp('https://www.google.com/search?q=green+tea', PACK, 'desktop')).not.toBeNull();
    expect(matchSerp(aiDestinationUrl(destination('google-ai-mode'), 'green tea')!, PACK, 'desktop')).toBeNull();
  });

  test('destination-no-tab-at-the-cap', () => {
    // The controller answers `null` at the tab cap (or with no window): no tab.
    const opener = vi.fn((_url: string): number | null => null);
    const answer = createDestinations({ activeTabId: active, state: () => pending('tea'), openBackgroundTab: opener }).open(4, 'perplexity');
    expect(answer).toEqual({ status: 'refused', reason: 'no-tab' });
    expect(OpenDestinationAnswerSchema.parse(answer)).toEqual(answer);
    expect(opener).toHaveBeenCalledTimes(1);
    // Set up without an opener: no tab, for every destination.
    const without = createDestinations({ activeTabId: active, state: () => pending('tea') });
    for (const id of IDS) expect(without.open(4, id)).toEqual({ status: 'refused', reason: 'no-tab' });
    // An opener that throws opens nothing and answers the same.
    const throwing = createDestinations({
      activeTabId: active,
      state: () => pending('tea'),
      openBackgroundTab: () => {
        throw new Error('gone');
      },
    });
    expect(throwing.open(4, 'chatgpt')).toEqual({ status: 'refused', reason: 'no-tab' });
  });
});
