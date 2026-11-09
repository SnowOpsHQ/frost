// @vitest-environment jsdom
// Spec: specs/browser-polish.spec.ts (BrowserState.historyViewSeq; Phase 11: history.list's projectId, changeCount,
// historyChangeLabel), specs/browser.spec.ts (TabState.documentSeq)
// Acceptance: specs/browser-polish.feature.md (History view, history-sheet-opens-with-a-new-document; History
// retention, ranges and projects: history view project filter and change counts)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { HistoryCursorAnswer, HistoryPageAnswer } from '@app/ipc-contract';
import { historyChangeLabel } from '@app/specs/browser-polish.spec';
import { useHistoryListing, useHistoryView, type HistoryListing, type HistorySource } from '../hooks/useHistoryView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let open = false;
function Probe({ seq, documentSeq, id = 1 }: { seq: number; documentSeq: number; id?: number }) {
  [open] = useHistoryView(seq, { id, documentSeq });
  return null;
}
const show = (props: { seq: number; documentSeq: number; id?: number }) => act(() => root.render(createElement(Probe, props)));

beforeEach(() => {
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

test('history-sheet-opens-with-a-new-document', () => {
  show({ seq: 0, documentSeq: 1 });
  expect(open).toBe(false);
  // Opened, then a new document commits: it closes.
  show({ seq: 1, documentSeq: 1 });
  expect(open).toBe(true);
  show({ seq: 1, documentSeq: 2 });
  expect(open).toBe(false);
  // The request and a new document arrive in one state: the request came after it, so it opens.
  show({ seq: 2, documentSeq: 3 });
  expect(open).toBe(true);
  // Another tab shown afterwards still closes it.
  show({ seq: 2, documentSeq: 3, id: 2 });
  expect(open).toBe(false);
});

test('history-view-project-filter-and-change-counts', async () => {
  const A = '0190ab12-3456-7abc-8def-0123456789ab';
  const visit = (url: string, changeCount: number) => ({ url, title: url, visitCount: 1, lastVisitAt: 5, changeCount });
  const answers = new Map<string, (page: HistoryPageAnswer) => void>();
  const calls: [string, HistoryCursorAnswer | null, string | undefined][] = [];
  const source: HistorySource = {
    list: vi.fn((query: string, after: HistoryCursorAnswer | null, projectId?: string) => {
      calls.push([query, after, projectId]);
      return new Promise<HistoryPageAnswer>((resolve) => answers.set(`${query}|${projectId ?? ''}|${after?.url ?? ''}`, resolve));
    }),
  };
  let shown: HistoryListing | null = null;
  let more: () => void = () => {};
  function Lister({ query, projectId }: { query: string; projectId: string | null }) {
    const listed = useHistoryListing(source, query, projectId);
    shown = listed.listing;
    more = listed.more;
    return null;
  }
  const list = (query: string, projectId: string | null) => act(() => root.render(createElement(Lister, { query, projectId })));
  const answer = (key: string, page: HistoryPageAnswer) => act(async () => answers.get(key)!(page));

  // Every visit first, then the project's: the filter goes to main with the search.
  await list('', null);
  expect(calls).toEqual([['', null, undefined]]);
  await list('', A);
  expect(calls[1]).toEqual(['', null, A]);
  // The older listing's slow answer never lands over the filtered one.
  await answer(`|${A}|`, { visits: [visit('https://site.example/a', 3)], next: { lastVisitAt: 5, url: 'https://site.example/a' } });
  await answer('||', { visits: [visit('https://site.example/other', 0)], next: null });
  expect(shown!.projectId).toBe(A);
  expect(shown!.visits.map((v) => [v.url, v.changeCount])).toEqual([['https://site.example/a', 3]]);
  expect(shown!.loading).toBe(false);
  // "Show more" keeps the filter and the search.
  act(() => more());
  expect(calls[2]).toEqual(['', { lastVisitAt: 5, url: 'https://site.example/a' }, A]);
  await answer(`|${A}|https://site.example/a`, { visits: [visit('https://site.example/a', 3), visit('https://site.example/b', 1)], next: null });
  expect(shown!.visits.map((v) => v.url)).toEqual(['https://site.example/a', 'https://site.example/b']);
  // Searching within the project; then back to every page.
  await list('tea', A);
  expect(calls[3]).toEqual(['tea', null, A]);
  await list('tea', null);
  expect(calls[4]).toEqual(['tea', null, undefined]);
  // A row's change count as shown.
  expect(historyChangeLabel(3)).toBe('3 changes');
  expect(historyChangeLabel(1)).toBe('1 change');
  expect(historyChangeLabel(1_200)).toBe('1,200 changes');
  expect(historyChangeLabel(0)).toBeNull();
  expect(historyChangeLabel(undefined)).toBeNull();
});
