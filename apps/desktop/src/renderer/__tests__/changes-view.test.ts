// Spec: specs/capture.spec.ts (DIFF_REGIONS, DIFF_REGION_LABELS, CHANGE_KINDS), specs/changes.spec.ts
// (CAPTURE_REFUSALS, CAPTURE_REFUSAL_MESSAGES, HistoryVersion), specs/render-profile.spec.ts
// (QUICK_RENDER_PROFILES, renderProfileSummary)
// Acceptance: specs/changes-panel.feature.md (Unit)
import { describe, expect, test } from 'vitest';
import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
import { MAX_HISTORY_PAGE } from '@app/specs/capture-db.spec';
import { CHANGE_KINDS, DIFF_REGIONS, DIFF_REGION_LABELS, type Change, type ChangeCounts, type DiffRegion } from '@app/specs/capture.spec';
import { CAPTURE_REFUSALS, CAPTURE_REFUSAL_MESSAGES, type DiffSummary, type HistoryVersion } from '@app/specs/changes.spec';
import { DEFAULT_RENDER_PROFILE, QUICK_RENDER_PROFILES, renderProfileSummary } from '@app/specs/render-profile.spec';
import {
  CHANGE_KIND_LABELS,
  FIRST_HISTORY_GOAL,
  HISTORY_PAGE_SIZE,
  canCapture,
  captureCountText,
  captureInput,
  captureOutcomeText,
  compareFrom,
  contextLabel,
  countBadge,
  groupByLane,
  groupChangesByRegion,
  historyGoalMet,
  historyReadLimit,
  laneLabel,
  mergeHistory,
  olderInLane,
  pageUrlOf,
  shownLane,
  unchangedRegions,
  versionSummaryText,
  canScreenshot,
  formatBytes,
  pixelSizeText,
  screenshotAlt,
  screenshotInput,
  screenshotKindLabel,
  screenshotOutcomeKind,
  screenshotOutcomeText,
} from '../changes-view';
import { SCREENSHOT_KIND_LABELS, SCREENSHOT_REFUSALS, SCREENSHOT_REFUSAL_MESSAGES } from '@app/specs/screenshot.spec';

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
    // Counts while more versions are still to be read.
    expect(countBadge(20, true)).toBe('20+');
    expect(countBadge(3, false)).toBe('3');
  });

  test('capture-needs-a-settled-audit', () => {
    const url = 'https://www.example.com/a';
    const tab = { url, loading: false, error: null, crashed: false };
    const ready = (outcome: string | null): SeoAuditResponse =>
      ({ status: 'ready', url, audit: { url, takenAt: 1, indexability: { robots: outcome === null ? null : { outcome } } } as unknown as SeoAudit }) as SeoAuditResponse;
    expect(canCapture(tab, ready('ok'))).toBe(true);
    expect(canCapture(tab, ready(null))).toBe(true);
    expect(canCapture(tab, ready('unreachable'))).toBe(true);
    // A provisional audit (robots.txt still on its way) is not offered: main refuses it.
    expect(canCapture(tab, ready('pending'))).toBe(false);
    // Nor a page still loading (the audit on screen is the last load's), nor no ready audit.
    expect(canCapture({ ...tab, loading: true }, ready('ok'))).toBe(false);
    expect(canCapture(tab, { status: 'pending', url })).toBe(false);
    expect(canCapture(tab, { status: 'unavailable', url, reason: 'timeout' })).toBe(false);
    expect(canCapture(tab, null)).toBe(false);
    expect(canCapture(undefined, ready('ok'))).toBe(false);
    expect(canCapture({ ...tab, url: 'about:blank' }, ready('ok'))).toBe(false);
    expect(canCapture({ ...tab, crashed: true }, ready('ok'))).toBe(false);
  });

  test('history-reads-cover-their-goal', () => {
    // A page's URL without its fragment (in-page anchors are the same page).
    expect(pageUrlOf('https://a.example/p?q=1#top')).toBe('https://a.example/p?q=1');
    expect(pageUrlOf('https://a.example/p')).toBe('https://a.example/p');
    // The first read is one page.
    expect(historyReadLimit(0, FIRST_HISTORY_GOAL)).toBe(HISTORY_PAGE_SIZE);
    // After a capture: as many as were listed, a page at most MAX_HISTORY_PAGE long.
    expect(historyReadLimit(0, { want: 45, include: null })).toBe(45);
    expect(historyReadLimit(0, { want: 250, include: null })).toBe(MAX_HISTORY_PAGE);
    expect(historyReadLimit(100, { want: 250, include: null })).toBe(MAX_HISTORY_PAGE);
    expect(historyReadLimit(240, { want: 250, include: null })).toBe(HISTORY_PAGE_SIZE);
    const [a, b] = [version(), version()];
    expect(historyGoalMet([a!], true, { want: 1, include: null })).toBe(true);
    expect(historyGoalMet([a!], true, { want: 2, include: null })).toBe(false);
    // The captured version must be listed (its lane stays shown), unless the history ends first.
    expect(historyGoalMet([a!], true, { want: 1, include: b!.versionId })).toBe(false);
    expect(historyGoalMet([a!, b!], true, { want: 1, include: b!.versionId })).toBe(true);
    expect(historyGoalMet([a!], false, { want: 5, include: b!.versionId })).toBe(true);
    // A text change's context is the block it follows.
    expect(contextLabel('text')).toBe('Follows');
    expect(contextLabel('link')).toBe('URL');
  });
});

// Spec: specs/screenshot.spec.ts (SCREENSHOT_KIND_LABELS, SCREENSHOT_REFUSALS, SCREENSHOT_REFUSAL_MESSAGES)
// Acceptance: specs/screenshot.feature.md (The Changes panel; Scenario screenshot-view-helpers)
describe('screenshot helpers', () => {
  const ID = '0190a000-0000-7000-8000-000000000001';
  test('screenshot-view-helpers', () => {
    const page = { url: 'https://example.com/a', error: null, crashed: false };
    // A web page that shows (loading or not); not an empty tab, an error panel or a crash.
    expect(canScreenshot(page)).toBe(true);
    expect(canScreenshot({ ...page, url: 'about:blank' })).toBe(false);
    expect(canScreenshot({ ...page, crashed: true })).toBe(false);
    expect(canScreenshot({ ...page, error: { kind: 'network' } as never })).toBe(false);
    expect(canScreenshot(undefined)).toBe(false);
    // The input carries the project only when one is chosen.
    expect(screenshotInput(3, 'full')).toEqual({ tabId: 3, kind: 'full' });
    expect(screenshotInput(3, 'area', ID)).toEqual({ tabId: 3, kind: 'area', projectId: ID });
    // Sizes and bytes.
    expect(pixelSizeText(1_280, 4_000)).toBe('1,280 × 4,000 px');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_536)).toBe('1.5 kB');
    expect(formatBytes(2_400_000)).toBe('2.4 MB');
    expect(formatBytes(52_428_800)).toBe('52.4 MB');
    // Kinds are named by the spec's labels.
    for (const kind of ['viewport', 'full', 'area'] as const) expect(screenshotKindLabel(kind)).toBe(SCREENSHOT_KIND_LABELS[kind]);
    // Outcomes: saved by kind (and cut at a cap), each refusal its message, a failed call the store's.
    expect(screenshotOutcomeText({ status: 'saved', id: ID, kind: 'viewport', width: 800, height: 600, bytes: 9, truncated: false })).toBe('Saved a screenshot of the viewport (800 × 600 px).');
    expect(screenshotOutcomeText({ status: 'saved', id: ID, kind: 'full', width: 800, height: 16_384, bytes: 9, truncated: true })).toBe(
      'Saved a full-page screenshot (800 × 16,384 px). The page is taller than a screenshot keeps, so it was cut at the bottom.',
    );
    expect(screenshotOutcomeText({ status: 'saved', id: ID, kind: 'area', width: 20, height: 30, bytes: 9, truncated: false })).toBe('Saved a screenshot of the selected area (20 × 30 px).');
    for (const reason of SCREENSHOT_REFUSALS) expect(screenshotOutcomeText({ status: 'refused', reason })).toBe(SCREENSHOT_REFUSAL_MESSAGES[reason]);
    expect(screenshotOutcomeText(null)).toBe(SCREENSHOT_REFUSAL_MESSAGES['store-failed']);
    expect(screenshotOutcomeKind({ status: 'saved', id: ID, kind: 'area', width: 1, height: 1, bytes: 1, truncated: false })).toBe('saved');
    expect(screenshotOutcomeKind({ status: 'refused', reason: 'cancelled' })).toBe('cancelled');
    expect(screenshotOutcomeKind({ status: 'refused', reason: 'busy' })).toBe('refused');
    expect(screenshotOutcomeKind(null)).toBe('failed');
    // The image's alt text says what it is, in frost's words.
    expect(screenshotAlt({ kind: 'full', width: 800, height: 2_000 })).toBe('Full page screenshot, 800 × 2,000 px');
  });
});
