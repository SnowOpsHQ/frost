// @vitest-environment jsdom
// Spec: specs/gsc-inspection.spec.ts (GSC_INSPECTION_STATES, GSC_INSPECTION_COPY, GSC_CANONICAL_MATCH, gscCanonicalMatch,
// GSC_RICH_SEVERITY_ORDER, the code tables), specs/gsc-inspection.schema.ts (GscInspectionAnswer, types only), specs/gsc.spec.ts (GscStatus)
// Acceptance: specs/gsc-inspection.feature.md (Card, View model)
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, test, vi } from 'vitest';
import type { GscInspectionAnswer, GscInspectionOk } from '@app/specs/gsc-inspection.schema';
import { GSC_CANONICAL_MATCH, GSC_INSPECTION_COPY, GSC_INSPECTION_STATES, GSC_PAGE_FETCH_STATES, GSC_RICH_SEVERITY_ORDER, gscCanonicalMatch, type GscInspectionState } from '@app/specs/gsc-inspection.spec';
import type { GscStatus } from '@app/specs/gsc.spec';
import { GSC_UNAVAILABLE_REASONS } from '@app/specs/gsc.spec';
import { gscInspectionView, lastCrawlText, richIssueGroups, type GscInspectionEntry } from '../gsc-inspection-view';

vi.mock('../ipc', () => ({ actions: {}, ipc: {} }));

const PAGE = 'https://www.example.com/a';
const NOW = Date.parse('2026-11-02T12:00:00Z');

const gsc = (changes: Partial<GscStatus> = {}): GscStatus => ({ configured: true, entitled: true, connected: true, connecting: false, keychain: 'persistent', error: null, version: 1, ...changes });

function ok(changes: { index?: Partial<GscInspectionOk['index']>; richResults?: GscInspectionOk['richResults']; link?: string | null } = {}): GscInspectionOk {
  return {
    status: 'ok',
    property: { siteUrl: 'https://www.example.com/', kind: 'url-prefix', permissionLevel: 'siteOwner' },
    url: PAGE,
    inspectedAt: '2026-11-02T11:58:00.000Z',
    index: {
      verdict: { value: 'PASS' },
      coverageState: 'Submitted and indexed',
      robotsTxtState: { value: 'ALLOWED' },
      indexingState: { value: 'INDEXING_ALLOWED' },
      pageFetchState: { value: 'SUCCESSFUL' },
      lastCrawlTime: '2026-10-30T10:05:00.000Z',
      crawledAs: { value: 'MOBILE' },
      googleCanonical: PAGE,
      userCanonical: PAGE,
      ...changes.index,
    },
    richResults: changes.richResults === undefined ? null : changes.richResults,
    link: changes.link === undefined ? 'https://search.google.com/search-console/inspect?resource_id=x' : changes.link,
  } as GscInspectionOk;
}

const entry = (answer: GscInspectionAnswer | null, inspecting = false): GscInspectionEntry => ({ inspecting, answer });
const view = (changes: { gsc?: GscStatus | null; url?: string; entry?: GscInspectionEntry | null; auditCanonical?: string | null } = {}) =>
  gscInspectionView({ gsc: 'gsc' in changes ? changes.gsc! : gsc(), url: changes.url ?? PAGE, entry: changes.entry ?? null, now: NOW, auditCanonical: changes.auditCanonical ?? null, timeZone: 'UTC' });
const unavailable = (reason: (typeof GSC_UNAVAILABLE_REASONS)[number]): GscInspectionAnswer => ({ status: 'unavailable', reason });

describe('Search Console inspection view', () => {
  test('states-and-copy', () => {
    // Hidden: main has not answered, or this build has no Search Console client.
    expect(view({ gsc: null })).toBeNull();
    expect(view({ gsc: gsc({ configured: false, connected: false }) })).toBeNull();
    expect(view({ entry: entry(unavailable('unconfigured')) })).toBeNull();
    expect(view({ entry: entry(unavailable('not-entitled')) })).toBeNull();

    const states: [ReturnType<typeof view>, GscInspectionState][] = [
      [view({ gsc: gsc({ connected: false }) }), 'not-connected'],
      [view({ gsc: gsc({ connected: false, connecting: true }) }), 'not-connected'],
      [view({ gsc: gsc({ connected: false, error: 'auth-expired' }) }), 'auth-expired'],
      [view({ url: 'about:blank' }), 'not-a-web-page'],
      [view({ url: 'file:///tmp/a.html' }), 'not-a-web-page'],
      [view(), 'idle'],
      [view({ entry: entry(null, true) }), 'inspecting'],
      [view({ entry: entry(ok()) }), 'ok'],
      [view({ entry: entry(unavailable('not-connected')) }), 'not-connected'],
      [view({ entry: entry(unavailable('no-property')) }), 'no-property'],
      [view({ entry: entry(unavailable('auth-expired')) }), 'auth-expired'],
      [view({ entry: entry(unavailable('quota')) }), 'quota'],
      [view({ entry: entry(unavailable('network')) }), 'network'],
      [view({ entry: entry(unavailable('invalid')) }), 'invalid'],
      [view({ entry: entry(unavailable('not-a-web-page')) }), 'not-a-web-page'],
    ];
    for (const [shown, state] of states) {
      expect(shown?.state, state).toBe(state);
      const copy = GSC_INSPECTION_COPY.states[state];
      expect(shown!.copy.action).toBe(copy.action);
      expect(shown!.copy.actionLabel).toBe(copy.actionLabel);
      expect(shown!.copy.message).toBe(copy.message.replace('{host}', 'www.example.com'));
    }
    // Every state is reachable.
    expect(new Set(states.map(([, state]) => state))).toEqual(new Set(GSC_INSPECTION_STATES));
    // The host is filled in.
    expect(view({ entry: entry(unavailable('no-property')) })!.copy.message).toBe('None of your Search Console properties covers www.example.com.');
    // The buttons: Connect / Reconnect open Settings; idle inspects; ok inspects again; failures retry.
    expect(view({ gsc: gsc({ connected: false }) })!.copy).toMatchObject({ action: 'open-gsc-settings', actionLabel: 'Connect in Settings' });
    expect(view()!.copy).toMatchObject({ action: 'inspect', actionLabel: 'Inspect in Search Console' });
    expect(view({ entry: entry(ok()) })!.copy).toMatchObject({ action: 'inspect-again', actionLabel: 'Inspect again' });
    expect(view({ entry: entry(unavailable('quota')) })!.copy).toMatchObject({ action: 'retry' });
    // The ok copy says it is the indexed version, not live.
    expect(GSC_INSPECTION_COPY.states.ok.message).toMatch(/indexed version/);
    expect(GSC_INSPECTION_COPY.states.ok.message).toMatch(/not a live test/);

    // Inspecting again keeps the earlier answer shown (pending); an answer of another page is not this one's.
    const again = view({ entry: entry(ok(), true) })!;
    expect(again.state).toBe('inspecting');
    expect(again.pending).toBe(true);
    expect(again.index).not.toBeNull();
    // The link is never part of the view: only whether one exists.
    expect(view({ entry: entry(ok()) })!.canOpen).toBe(true);
    expect(view({ entry: entry(ok({ link: null })) })!.canOpen).toBe(false);
    expect(JSON.stringify(view({ entry: entry(ok()) }))).not.toContain('search.google.com');
    // When it was asked.
    expect(view({ entry: entry(ok()) })!.inspected).toBe('Inspected 2 minutes ago');

    // Enum labels from the tables; unknown codes shown as such, with Google's raw code (or none).
    const index = view({ entry: entry(ok({ index: { pageFetchState: { value: 'unknown', code: 'NEW_FETCH_STATE' }, verdict: { value: 'unknown', code: null }, crawledAs: null } })) })!.index!;
    expect(index.pageFetch).toEqual({ known: false, label: GSC_INSPECTION_COPY.text.unknown, code: 'NEW_FETCH_STATE' });
    expect(index.verdict).toEqual({ known: false, label: GSC_INSPECTION_COPY.text.unknown, code: null });
    expect(index.crawledAs).toBeNull();
    expect(view({ entry: entry(ok()) })!.index!.pageFetch).toEqual({ known: true, label: GSC_PAGE_FETCH_STATES.SUCCESSFUL });
    expect(view({ entry: entry(ok()) })!.index!.crawledAs).toEqual({ known: true, label: 'Smartphone crawler' });
    // An empty coverage state is absent.
    expect(view({ entry: entry(ok({ index: { coverageState: '' } })) })!.index!.coverage).toBeNull();
    expect(view({ entry: entry(ok()) })!.index!.coverage).toBe('Submitted and indexed');
  });

  test('canonical-three-way-compare', () => {
    // The spec's compare: resolved against the page, without fragments.
    expect(gscCanonicalMatch(PAGE, PAGE, PAGE)).toBe('same');
    expect(gscCanonicalMatch(PAGE, `${PAGE}#top`, PAGE)).toBe('same');
    expect(gscCanonicalMatch(PAGE, '/a', PAGE)).toBe('same');
    expect(gscCanonicalMatch('https://WWW.example.com/a', PAGE, PAGE)).toBe('same');
    expect(gscCanonicalMatch(PAGE, 'https://www.example.com/b', PAGE)).toBe('google-differs');
    expect(gscCanonicalMatch(PAGE, 'https://www.example.com/a?x=1', PAGE)).toBe('google-differs');
    expect(gscCanonicalMatch(PAGE, null, PAGE)).toBe('user-missing');
    expect(gscCanonicalMatch(PAGE, '', PAGE)).toBe('user-missing');
    expect(gscCanonicalMatch(null, PAGE, PAGE)).toBeNull();
    expect(gscCanonicalMatch(PAGE, 'http://[bad', PAGE)).toBe('google-differs');

    // Google's, the one the page declares as Google read it, and the one frost read.
    const same = view({ entry: entry(ok()), auditCanonical: `${PAGE}#x` })!.index!;
    expect(same.googleCanonical).toBe(PAGE);
    expect(same.userCanonical).toEqual({ url: PAGE, match: 'same', matchLabel: GSC_CANONICAL_MATCH.same });
    expect(same.auditCanonical).toEqual({ url: `${PAGE}#x`, match: 'same', matchLabel: GSC_CANONICAL_MATCH.same });

    // Google chose another URL than both.
    const B = 'https://www.example.com/b';
    const differs = view({ entry: entry(ok({ index: { googleCanonical: B } })), auditCanonical: PAGE })!.index!;
    expect(differs.userCanonical.match).toBe('google-differs');
    expect(differs.auditCanonical!.match).toBe('google-differs');
    expect(differs.auditCanonical!.matchLabel).toBe(GSC_CANONICAL_MATCH['google-differs']);

    // The page declares none to Google, while frost read one (or none).
    const missing = view({ entry: entry(ok({ index: { userCanonical: null } })), auditCanonical: PAGE })!.index!;
    expect(missing.userCanonical).toEqual({ url: null, match: 'user-missing', matchLabel: GSC_CANONICAL_MATCH['user-missing'] });
    expect(missing.auditCanonical!.match).toBe('same');
    expect(view({ entry: entry(ok()), auditCanonical: null })!.index!.auditCanonical!.match).toBe('user-missing');

    // Google reported none: nothing to compare.
    const none = view({ entry: entry(ok({ index: { googleCanonical: null } })), auditCanonical: PAGE })!.index!;
    expect(none.googleCanonical).toBeNull();
    expect(none.userCanonical.match).toBeNull();
    expect(none.auditCanonical!.match).toBeNull();
  });

  test('last-crawl-relative-and-absolute', () => {
    expect(lastCrawlText('2026-10-30T10:05:00.000Z', NOW, 'UTC')).toBe('3 days ago (Oct 30, 2026, 10:05 AM)');
    expect(lastCrawlText('2026-11-02T11:59:30.000Z', NOW, 'UTC')).toBe('just now (Nov 2, 2026, 11:59 AM)');
    expect(lastCrawlText('2026-11-02T09:00:00.000Z', NOW, 'UTC')).toBe('3 hours ago (Nov 2, 2026, 9:00 AM)');
    expect(lastCrawlText('2026-11-02T11:15:00.000Z', NOW, 'UTC')).toBe('45 minutes ago (Nov 2, 2026, 11:15 AM)');
    expect(lastCrawlText('2026-08-01T00:00:00.000Z', NOW, 'UTC')).toBe('3 months ago (Aug 1, 2026, 12:00 AM)');
    expect(lastCrawlText('2024-10-01T00:00:00.000Z', NOW, 'UTC')).toBe('2 years ago (Oct 1, 2024, 12:00 AM)');
    // Ahead of the clock (skew): just now.
    expect(lastCrawlText('2026-11-02T12:10:00.000Z', NOW, 'UTC')).toBe('just now (Nov 2, 2026, 12:10 PM)');
    // Never crawled.
    expect(lastCrawlText(null, NOW, 'UTC')).toBe(GSC_INSPECTION_COPY.text.notCrawled);
    // In the view.
    expect(view({ entry: entry(ok()) })!.index!.lastCrawl).toBe('3 days ago (Oct 30, 2026, 10:05 AM)');
    expect(view({ entry: entry(ok({ index: { lastCrawlTime: null } })) })!.index!.lastCrawl).toBe('Not crawled yet');
  });

  test('rich-issues-grouped-by-severity', () => {
    const groups = richIssueGroups([
      { message: 'Missing field "price"', severity: { value: 'WARNING' } },
      { message: 'Invalid value in "offers"', severity: { value: 'ERROR' } },
      { message: 'Something new', severity: { value: 'unknown', code: 'NOTICE' } },
      { message: 'Missing field "image"', severity: { value: 'WARNING' } },
      { message: 'Another error', severity: { value: 'ERROR' } },
    ]);
    expect(groups.map((g) => g.severity)).toEqual([...GSC_RICH_SEVERITY_ORDER]);
    expect(groups.map((g) => g.label)).toEqual(['Error', 'Warning', GSC_INSPECTION_COPY.text.unknown]);
    expect(groups[0]!.issues.map((i) => i.message)).toEqual(['Invalid value in "offers"', 'Another error']);
    expect(groups[1]!.issues.map((i) => i.message)).toEqual(['Missing field "price"', 'Missing field "image"']);
    expect(groups[2]!.issues).toEqual([{ message: 'Something new', code: 'NOTICE' }]);
    // Empty groups are left out.
    expect(richIssueGroups([{ message: 'w', severity: { value: 'WARNING' } }]).map((g) => g.severity)).toEqual(['WARNING']);
    expect(richIssueGroups([])).toEqual([]);

    const rich = view({
      entry: entry(
        ok({
          richResults: {
            verdict: { value: 'FAIL' },
            types: [
              {
                type: 'Product snippets',
                items: [
                  { name: 'Widget', issues: [{ message: 'e', severity: { value: 'ERROR' } }, { message: 'w', severity: { value: 'WARNING' } }] },
                  { name: '', issues: [] },
                ],
              },
              { type: 'Breadcrumbs', items: [{ name: 'Trail', issues: [{ message: 'w2', severity: { value: 'WARNING' } }] }] },
            ],
          },
        }),
      ),
    })!.rich!;
    expect(rich.verdict).toEqual({ known: true, label: 'Failed' });
    expect(rich.errors).toBe(1);
    expect(rich.warnings).toBe(2);
    expect(rich.types.map((t) => t.type)).toEqual(['Product snippets', 'Breadcrumbs']);
    expect(rich.types[0]!.items[0]!.groups.map((g) => g.severity)).toEqual(['ERROR', 'WARNING']);
    expect(rich.types[0]!.items[0]!.issueCount).toBe(2);
    expect(rich.types[0]!.items[1]).toMatchObject({ name: null, issueCount: 0, groups: [] });

    // No rich results reported.
    const none = view({ entry: entry(ok({ richResults: null })) })!.rich!;
    expect(none).toMatchObject({ verdict: null, types: [], errors: 0, warnings: 0 });
  });

  test('strings-are-inert', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const RLO = '‮';
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
    const hostile = `${RLO}gpj.exe ${markup}`;
    const answer = ok({
      index: { coverageState: hostile, googleCanonical: `https://www.example.com/${RLO}b`, pageFetchState: { value: 'unknown', code: 'NEW_CODE' } },
      richResults: { verdict: { value: 'PASS' }, types: [{ type: hostile, items: [{ name: hostile, issues: [{ message: hostile, severity: { value: 'ERROR' } }] }] }] },
    });
    // The view keeps Google's strings as they are (no markup is built from them).
    const shown = view({ entry: entry(answer) })!;
    expect(shown.index!.coverage).toBe(hostile);
    expect(shown.rich!.types[0]!.type).toBe(hostile);

    const { GscInspectionBody } = await import('../components/seo/GscInspectionCard');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    for (const kind of ['index', 'rich'] as const) {
      await act(async () => {
        root.render(createElement(GscInspectionBody, { kind, view: shown }));
      });
      // Nothing from Google became an element, a link or a style.
      expect(host.querySelector('img, script, a, iframe, [style], [href], [onerror]'), kind).toBeNull();
      const texts = [...host.querySelectorAll('[data-google-text]')];
      expect(texts.length, kind).toBeGreaterThan(0);
      for (const element of texts) {
        // Literal, isolated text: a <bdi dir="auto"> with only a text node, its tooltip isolated too.
        expect(element.tagName).toBe('BDI');
        expect(element.getAttribute('dir')).toBe('auto');
        expect(element.children.length).toBe(0);
        expect(element.getAttribute('title')!.startsWith('⁨')).toBe(true);
        expect(element.getAttribute('title')!.endsWith('⁩')).toBe(true);
      }
      const hostileText = texts.filter((element) => element.textContent === hostile);
      expect(hostileText.length, kind).toBeGreaterThan(0);
      expect(host.textContent).toContain(RLO);
    }
    // The unknown code is inert text too.
    await act(async () => {
      root.render(createElement(GscInspectionBody, { kind: 'index', view: shown }));
    });
    expect([...host.querySelectorAll('[data-google-text]')].some((element) => element.textContent === 'NEW_CODE')).toBe(true);
    act(() => root.unmount());
    host.remove();
  });
});
