// @vitest-environment jsdom
// Spec: specs/browser-polish.spec.ts (BrowserState.historyViewSeq), specs/browser.spec.ts (TabState.documentSeq)
// Acceptance: specs/browser-polish.feature.md (History view, history-sheet-opens-with-a-new-document)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { useHistoryView } from '../hooks/useHistoryView';

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
