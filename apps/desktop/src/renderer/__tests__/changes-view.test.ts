// Spec: specs/capture.spec.ts (DIFF_REGIONS, DIFF_REGION_LABELS, CHANGE_KINDS), specs/changes.spec.ts
// (CAPTURE_REFUSALS, CAPTURE_REFUSAL_MESSAGES, HistoryVersion), specs/render-profile.spec.ts
// (QUICK_RENDER_PROFILES, renderProfileSummary)
// Acceptance: specs/changes-panel.feature.md (Unit)
import { describe, expect, test } from 'vitest';
import { CHANGE_KINDS, DIFF_REGIONS, DIFF_REGION_LABELS, type Change, type ChangeCounts, type DiffRegion } from '@app/specs/capture.spec';
import { CAPTURE_REFUSALS, CAPTURE_REFUSAL_MESSAGES, type DiffSummary, type HistoryVersion } from '@app/specs/changes.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES, renderProfileSummary } from '@app/specs/render-profile.spec';
import {
  CHANGE_KIND_LABELS,
  captureCountText,
  captureInput,
  captureOutcomeText,
  compareFrom,
  groupByLane,
  groupChangesByRegion,
  laneLabel,
  mergeHistory,
  olderInLane,
  shownLane,
  unchangedRegions,
  versionSummaryText,
} from '../changes-view';

const ZERO: ChangeCounts = { added: 0, removed: 0, changed: 0 };
const summaryOf = (counts: Partial<Record<DiffRegion, Partial<ChangeCounts>>>): DiffSummary =>
  Object.fromEntries(DIFF_REGIONS.map((region) => [region, { ...ZERO, ...counts[region] }])) as DiffSummary;

let seq = 0;
function version(changes: Partial<HistoryVersion> = {}): HistoryVersion {
  seq += 1;
  return {
    versionId: `0190a000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    createdAt: 1_000 - seq,
    captureCount: 1,
    lastCapturedAt: 1_000 - seq,
    laneKey: 'a'.repeat(64),
    renderProfile: null,
    searchParams: null,
    parentVersionId: null,
    summary: null,
    changeCount: null,
    ...changes,
  };
}

const change = (region: DiffRegion, field: Change['field'], kind: Change['kind'] = 'changed'): Change => ({ region, field, kind, before: kind === 'added' ? null : 'b', after: kind === 'removed' ? null : 'a', context: null });

describe('changes-view', () => {
  test('lanes-group-and-label', () => {
    const phone = QUICK_RENDER_PROFILES.find((p) => p.id === 'googlebot-smartphone')!;
    const laneA = 'a'.repeat(64);
    const laneB = 'b'.repeat(64);
    // Newest first, as the history answers them: lane B's newest is first.
    const v1 = version({ laneKey: laneB, renderProfile: phone.profile });
    const v2 = version({ laneKey: laneA });
    const v3 = version({ laneKey: laneB, renderProfile: phone.profile });
    const v4 = version({ laneKey: laneA });
    const lanes = groupByLane([v1, v2, v3, v4]);
    expect(lanes.map((lane) => lane.key)).toEqual([laneB, laneA]);
    expect(lanes[0]!.versions).toEqual([v1, v3]);
    expect(lanes[1]!.versions).toEqual([v2, v4]);
    expect(lanes.map((lane) => lane.label)).toEqual(['Googlebot smartphone', 'Default']);
    // Labels: no profile or the default one, a quick profile, any other profile.
    expect(laneLabel({ renderProfile: null, searchParams: null })).toBe('Default');
    expect(laneLabel({ renderProfile: DEFAULT_RENDER_PROFILE, searchParams: null })).toBe('Default');
    expect(laneLabel({ renderProfile: phone.profile, searchParams: null })).toBe('Googlebot smartphone');
    const custom = { ...DEFAULT_RENDER_PROFILE, device: 'tablet' as const, network: '4g' as const };
    expect(laneLabel({ renderProfile: custom, searchParams: null })).toBe(renderProfileSummary(custom));
    // Search parameters follow the profile.
    expect(laneLabel({ renderProfile: null, searchParams: { engine: 'bing', query: 'cold brew', country: 'us', language: 'en', location: null, device: 'mobile' } })).toBe('Default · “cold brew” · Bing · us · en · mobile');
    // The shown lane: the chosen one while it is listed, else the newest version's.
    expect(shownLane(lanes, laneA)!.key).toBe(laneA);
    expect(shownLane(lanes, null)!.key).toBe(laneB);
    expect(shownLane(lanes, 'c'.repeat(64))!.key).toBe(laneB);
    expect(shownLane([], null)).toBeNull();
  });

  test('version-summary-text', () => {
    expect(versionSummaryText(version())).toBe('First capture');
    expect(versionSummaryText(version({ parentVersionId: '0190a000-0000-7000-8000-000000000001' }))).toBe('Earlier versions removed');
    const summary = summaryOf({ main: { changed: 1, added: 1 }, head: { changed: 1 }, nav: { removed: 1 } });
    expect(versionSummaryText(version({ parentVersionId: '0190a000-0000-7000-8000-000000000001', summary, changeCount: 4 }))).toBe(
      `${DIFF_REGION_LABELS.head} 1 · ${DIFF_REGION_LABELS.main} 2 · ${DIFF_REGION_LABELS.nav} 1`,
    );
    expect(versionSummaryText(version({ parentVersionId: '0190a000-0000-7000-8000-000000000001', summary: summaryOf({}), changeCount: 0 }))).toBe('No visible changes');
  });

  test('regions-group-in-order', () => {
    const changes = [change('nav', 'link'), change('main', 'text'), change('head', 'title'), change('main', 'heading', 'added'), change('audit', 'score')];
    const groups = groupChangesByRegion(changes);
    expect(groups.map((group) => group.region)).toEqual(['head', 'main', 'nav', 'audit']);
    expect(groups.map((group) => group.label)).toEqual([DIFF_REGION_LABELS.head, DIFF_REGION_LABELS.main, DIFF_REGION_LABELS.nav, DIFF_REGION_LABELS.audit]);
    // Order within a region is the diff's.
    expect(groups[1]!.changes.map((c) => c.field)).toEqual(['text', 'heading']);
    const summary = summaryOf({ head: { changed: 1 }, main: { changed: 1, added: 1 }, nav: { changed: 1 }, audit: { changed: 1 } });
    expect(unchangedRegions({ summary })).toEqual(DIFF_REGIONS.filter((region) => !['head', 'main', 'nav', 'audit'].includes(region)));
    expect(unchangedRegions({ summary: summaryOf({}) })).toEqual([...DIFF_REGIONS]);
  });

  test('change-kind-labels', () => {
    for (const kind of CHANGE_KINDS) expect(CHANGE_KIND_LABELS[kind]).toMatch(/^[A-Z][a-z]+$/);
    expect(CHANGE_KIND_LABELS).toEqual({ added: 'Added', removed: 'Removed', changed: 'Changed' });
    expect(captureCountText(1)).toBe('1 capture');
    expect(captureCountText(3)).toBe('3 captures');
    expect(captureCountText(1_200)).toBe('1,200 captures');
  });

  test('capture-outcome-text', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(captureOutcomeText({ status: 'captured', captureId: id, versionId: id, newVersion: true, changeCount: null })).toBe('Captured the first version of this page.');
    expect(captureOutcomeText({ status: 'captured', captureId: id, versionId: id, newVersion: true, changeCount: 1 })).toBe('Captured a new version: 1 change.');
    expect(captureOutcomeText({ status: 'captured', captureId: id, versionId: id, newVersion: true, changeCount: 7 })).toBe('Captured a new version: 7 changes.');
    expect(captureOutcomeText({ status: 'captured', captureId: id, versionId: id, newVersion: false, changeCount: null })).toBe('No change since the last capture.');
    for (const reason of CAPTURE_REFUSALS) expect(captureOutcomeText({ status: 'refused', reason })).toBe(CAPTURE_REFUSAL_MESSAGES[reason]);
    expect(captureOutcomeText(null)).toBe(CAPTURE_REFUSAL_MESSAGES['store-failed']);
    // The project seam (Task 6): Unfiled by default.
    expect(captureInput(4)).toEqual({ tabId: 4 });
    expect(captureInput(4, id)).toEqual({ tabId: 4, projectId: id });
  });

  test('compare-candidates', () => {
    const [v1, v2, v3] = [version(), version(), version()];
    const [lane] = groupByLane([v1!, v2!, v3!]);
    expect(olderInLane(lane!, v1!.versionId)).toEqual([v2, v3]);
    expect(olderInLane(lane!, v3!.versionId)).toEqual([]);
    expect(olderInLane(lane!, 'missing')).toEqual([]);
    // The previous version by default; a chosen older one while it is older.
    expect(compareFrom(lane!, v1!.versionId, null)).toBe(v2);
    expect(compareFrom(lane!, v1!.versionId, v3!.versionId)).toBe(v3);
    expect(compareFrom(lane!, v2!.versionId, v1!.versionId)).toBe(v3);
    expect(compareFrom(lane!, v3!.versionId, null)).toBeNull();
    // A further page appends, and a version already listed is not repeated.
    const v4 = version();
    expect(mergeHistory([v1!, v2!], [v2!, v3!, v4])).toEqual([v1, v2, v3, v4]);
  });
});
