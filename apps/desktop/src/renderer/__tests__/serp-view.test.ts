// Spec: specs/serp-service.spec.ts (SERP_OUTLINE_STYLES, SERP_NOT_SERP_MESSAGE), specs/serp.spec.ts
// (SERP_UNREADABLE_MESSAGES, SERP_TRUNCATED_NOTE, SERP_DEVICE_LABELS), specs/serp-selector-pack.spec.ts
// (SERP_RESULT_TYPE_LABELS, PACK_UPDATE_MESSAGES), specs/intent-classifier.spec.ts (INTENT_LABEL_NAMES,
// INTENT_DEFINITIONS, INTENT_STATE_MESSAGES)
// Acceptance: specs/serp-panels.feature.md (SERP panel view model)
import { describe, expect, test } from 'vitest';
import { INTENT_DEFINITIONS, INTENT_STATE_MESSAGES } from '@app/specs/intent-classifier.spec';
import { PACK_UPDATE_MESSAGES, SERP_RESULT_TYPES, type SerpResultType } from '@app/specs/serp-selector-pack.spec';
import type { PackStatus, SerpState } from '@app/specs/serp-service.schema';
import { SERP_NOT_SERP_MESSAGE, SERP_OUTLINE_STYLES } from '@app/specs/serp-service.spec';
import type { SearchParams } from '@app/specs/serp-search-params.schema';
import type { SerpComposition, SerpReady } from '@app/specs/serp-snapshot.schema';
import { SERP_TRUNCATED_NOTE, SERP_UNREADABLE_MESSAGES } from '@app/specs/serp.spec';
import {
  NO_TITLE,
  PARAM_NOT_SET,
  UNREADABLE_TITLE,
  compositionSegments,
  compositionSummary,
  forgetSerp,
  intentChip,
  knownSerp,
  ownershipNote,
  ownershipRows,
  ownershipTitle,
  packStatusText,
  packUpdateLine,
  percent,
  rememberSerp,
  resultRows,
  searchParamFacts,
  serpParams,
  serpStateView,
} from '../serp-view';

const PARAMS: SearchParams = {
  engine: 'google',
  engineLabel: 'Google',
  query: 'green tea',
  gl: 'uk',
  hl: 'en',
  device: 'mobile',
  page: 2,
  offset: 10,
  url: 'https://www.google.com/search?q=green+tea&gl=uk&hl=en&start=10',
};

function counts(values: Partial<Record<SerpResultType, number>>): Record<SerpResultType, number> {
  return Object.fromEntries(SERP_RESULT_TYPES.map((type) => [type, values[type] ?? 0])) as Record<SerpResultType, number>;
}

const SNAPSHOT: SerpReady = {
  status: 'ready',
  params: { ...PARAMS, page: 1, offset: null },
  packVersion: 3,
  results: [
    { rank: 1, type: 'ad', position: 1, featureSlot: null, title: 'Tea shop', url: 'https://www.google.com/aclk?x', redirected: false, domain: 'google.com' },
    { rank: 2, type: 'featured-snippet', position: null, featureSlot: 1, title: 'What green tea is', url: 'https://tea.example/what', redirected: true, domain: 'tea.example' },
    { rank: 3, type: 'organic', position: 1, featureSlot: null, title: 'Green tea guide', url: 'https://tea.example/guide', redirected: true, domain: 'tea.example' },
    { rank: 4, type: 'people-also-ask', position: null, featureSlot: 2, title: 'Is green tea good?', url: null, redirected: false, domain: null },
    { rank: 5, type: 'organic', position: 2, featureSlot: null, title: '', url: 'https://leaves.example/', redirected: false, domain: 'leaves.example' },
    { rank: 6, type: 'organic', position: 3, featureSlot: null, title: 'More tea', url: 'https://tea.example/more', redirected: false, domain: 'tea.example' },
  ],
  composition: { counts: counts({ ad: 1, 'featured-snippet': 1, organic: 3, 'people-also-ask': 1 }), features: [] },
  ownership: {
    page: 1,
    organic: 3,
    complete: true,
    domains: [
      { domain: 'tea.example', count: 2, share: 2 / 3, positions: [1, 3], best: 1 },
      { domain: 'leaves.example', count: 1, share: 1 / 3, positions: [2], best: 2 },
    ],
  },
  truncated: false,
};

const PACK: PackStatus = { state: 'ready', version: 3, source: 'remote', published: '2026-10-28', lastUpdate: null, checking: false };

describe('SERP panel view model', () => {
  test('serp-params-labels', () => {
    const facts = searchParamFacts(PARAMS);
    expect(facts.map((fact) => fact.key)).toEqual(['engine', 'query', 'gl', 'hl', 'device', 'page']);
    expect(Object.fromEntries(facts.map((fact) => [fact.label, fact.value]))).toEqual({ Engine: 'Google', Query: 'green tea', Country: 'uk', Language: 'en', Device: 'Mobile', Page: '2' });
    const bare = searchParamFacts({ ...PARAMS, gl: null, hl: null, device: 'desktop', page: 1 });
    expect(bare.find((fact) => fact.key === 'gl')!.value).toBe(PARAM_NOT_SET);
    expect(bare.find((fact) => fact.key === 'hl')!.value).toBe(PARAM_NOT_SET);
    expect(bare.find((fact) => fact.key === 'device')!.value).toBe('Desktop');
    // Which states carry parameters.
    expect(serpParams({ status: 'pending', tabId: 1, documentSeq: 1, url: PARAMS.url, params: PARAMS })).toBe(PARAMS);
    expect(serpParams({ status: 'ready', tabId: 1, documentSeq: 1, url: PARAMS.url, readAt: 1, snapshot: SNAPSHOT })).toBe(SNAPSHOT.params);
    expect(serpParams({ status: 'unreadable', tabId: 1, documentSeq: 1, url: PARAMS.url, readAt: 1, reason: 'no-container', params: PARAMS, packVersion: 3 })).toBe(PARAMS);
    expect(serpParams({ status: 'unreadable', tabId: 1, documentSeq: 1, url: PARAMS.url, readAt: 1, reason: 'invalid-answer', params: null, packVersion: 3 })).toBeNull();
    expect(serpParams({ status: 'not-serp', tabId: 1, url: 'https://tea.example/' })).toBeNull();
    expect(serpParams({ status: 'disabled', tabId: 1, reason: 'pack-invalid' })).toBeNull();
  });

  test('serp-composition-segments', () => {
    const segments = compositionSegments(SNAPSHOT.composition);
    // SERP_RESULT_TYPES order, only the types present.
    expect(segments.map((segment) => segment.type)).toEqual(['organic', 'ad', 'featured-snippet', 'people-also-ask']);
    expect(segments.map((segment) => segment.count)).toEqual([3, 1, 1, 1]);
    expect(segments.map((segment) => segment.color)).toEqual(segments.map((segment) => SERP_OUTLINE_STYLES[segment.type].color));
    expect(segments[0]).toMatchObject({ x: 0, width: 50 });
    expect(segments[1]!.x).toBe(50);
    // Contiguous, and the widths fill the bar.
    for (let i = 1; i < segments.length; i++) expect(segments[i]!.x).toBeCloseTo(segments[i - 1]!.x + segments[i - 1]!.width, 6);
    expect(segments.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100, 6);
    expect(compositionSummary(SNAPSHOT.composition)).toBe('6 results: Organic result 3, Ad 1, Featured snippet 1, Related questions 1');
    const empty: SerpComposition = { counts: counts({}), features: [] };
    expect(compositionSegments(empty)).toEqual([]);
    expect(compositionSummary(empty)).toBe('No results read');
    expect(compositionSummary({ counts: counts({ organic: 1 }), features: [] })).toBe('1 result: Organic result 1');
  });

  test('serp-ownership-rows', () => {
    expect(ownershipRows(SNAPSHOT.ownership)).toEqual([
      { domain: 'tea.example', count: 2, share: '67%', positions: '1, 3' },
      { domain: 'leaves.example', count: 1, share: '33%', positions: '2' },
    ]);
    expect(ownershipTitle(SNAPSHOT.ownership)).toBe('Who owns page 1');
    expect(ownershipTitle({ ...SNAPSHOT.ownership, page: 3 })).toBe('Who owns page 3');
    expect(ownershipNote(SNAPSHOT.ownership)).toBeNull();
    expect(ownershipNote({ ...SNAPSHOT.ownership, complete: false })).toBe(SERP_TRUNCATED_NOTE);
  });

  test('serp-result-rows', () => {
    const rows = resultRows(SNAPSHOT);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((row) => row.typeLabel)).toEqual(['Ad 1', 'Featured snippet', 'Organic 1', 'Related questions', 'Organic 2', 'Organic 3']);
    expect(rows[4]!.title).toBe(NO_TITLE);
    expect(rows[3]!.domain).toBeNull();
    expect(rows[2]).toEqual({ rank: 3, type: 'organic', typeLabel: 'Organic 1', title: 'Green tea guide', domain: 'tea.example' });
  });

  test('serp-intent-chip', () => {
    const ready = intentChip({ state: 'ready', result: { label: 'commercial', confidence: 0.874, scores: { informational: 0.1, navigational: 0.01, commercial: 0.874, transactional: 0.016 }, model: 'fake' } });
    expect(ready).toEqual({ kind: 'ready', label: 'Commercial', definition: INTENT_DEFINITIONS.commercial, confidence: '87%' });
    expect(intentChip({ state: 'model-missing' })).toEqual({ kind: 'state', state: 'model-missing', message: INTENT_STATE_MESSAGES['model-missing'], enable: true });
    expect(intentChip({ state: 'downloading' })).toEqual({ kind: 'state', state: 'downloading', message: INTENT_STATE_MESSAGES.downloading, enable: false });
    expect(intentChip({ state: 'unavailable' })).toEqual({ kind: 'state', state: 'unavailable', message: INTENT_STATE_MESSAGES.unavailable, enable: false });
    expect(intentChip({ state: 'no-query' })).toEqual({ kind: 'none' });
    expect(intentChip(null)).toEqual({ kind: 'none' });
    expect(percent(0)).toBe('0%');
    expect(percent(0.996)).toBe('100%');
    expect(percent(0.5)).toBe('50%');
  });

  test('serp-state-messages', () => {
    const states: SerpState[] = [
      { status: 'not-serp', tabId: 1, url: 'https://tea.example/' },
      { status: 'pending', tabId: 1, documentSeq: 1, url: PARAMS.url, params: PARAMS },
      { status: 'ready', tabId: 1, documentSeq: 1, url: PARAMS.url, readAt: 1, snapshot: SNAPSHOT },
      { status: 'unreadable', tabId: 1, documentSeq: 1, url: PARAMS.url, readAt: 1, reason: 'no-container', params: PARAMS, packVersion: 3 },
      { status: 'disabled', tabId: 1, reason: 'pack-invalid' },
    ];
    const [notSerp, pending, ready, unreadable, disabled] = states.map(serpStateView);
    expect(notSerp).toMatchObject({ kind: 'not-serp', title: SERP_NOT_SERP_MESSAGE, offerUpdate: false });
    expect(pending).toMatchObject({ kind: 'pending', offerUpdate: false });
    expect(pending!.title).toMatch(/Reading/);
    expect(ready).toMatchObject({ kind: 'ready', offerUpdate: false });
    expect(unreadable).toEqual({ kind: 'unreadable', title: UNREADABLE_TITLE, message: SERP_UNREADABLE_MESSAGES['no-container'], reason: 'no-container', offerUpdate: true });
    expect(UNREADABLE_TITLE).toBe('Couldn’t read this layout');
    expect(disabled).toMatchObject({ kind: 'disabled', message: SERP_UNREADABLE_MESSAGES['pack-invalid'], reason: 'pack-invalid', offerUpdate: false });
  });

  test('serp-pack-status-text', () => {
    expect(packStatusText(PACK)).toBe('Selectors v3 · installed update · published 2026-10-28');
    expect(packStatusText({ ...PACK, source: 'bundled', version: 1 })).toBe('Selectors v1 · bundled with frost · published 2026-10-28');
    expect(packStatusText({ state: 'disabled', version: null, source: null, published: null, lastUpdate: null, checking: false })).toBe('Selectors disabled: the bundled pack failed verification');
    expect(packUpdateLine(PACK)).toBeNull();
    expect(packUpdateLine({ ...PACK, checking: true })).toBe('Checking for selector updates…');
    for (const outcome of ['installed', 'not-newer', 'bad-signature', 'unreachable'] as const) expect(packUpdateLine({ ...PACK, lastUpdate: { outcome, at: 1 } })).toBe(PACK_UPDATE_MESSAGES[outcome]);
  });

  test('serp-known-state', () => {
    // What the palette reads: the last state a panel saw for the tab, forgotten once no panel watches it.
    const state = { version: 3, tabId: 7, serp: { status: 'not-serp', tabId: 7, url: 'https://tea.example/' }, outlines: false, intent: null, pack: PACK } as const;
    expect(knownSerp(7)).toBeUndefined();
    rememberSerp(state);
    expect(knownSerp(7)).toBe(state);
    forgetSerp(7);
    expect(knownSerp(7)).toBeUndefined();
  });
});
