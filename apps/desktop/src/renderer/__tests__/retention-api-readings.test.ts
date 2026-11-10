// @vitest-environment jsdom
// Spec: specs/retention.spec.ts (PurgeCountsView.readings, purgeCountsText, purgesNothing)
// Acceptance: specs/retention.feature.md (Preview and Purge now: API readings (Phase 12 Task 4);
// api-only-purge-counts-show-readings: the preview line and the "Purge now" button of an API-only project)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RetentionPreviewAnswer } from '@app/specs/retention.spec';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P1 = '01920000-0000-7000-8000-0000000000a1';
const fakes = vi.hoisted(() => ({ retentionPreview: vi.fn(), purgeNow: vi.fn() }));
vi.mock('../ipc', () => ({
  ipc: {
    projects: {
      retentionPreview: { query: fakes.retentionPreview },
      usage: { query: vi.fn(async () => ({ status: 'refused', reason: 'store-failed' })) },
      purgeLog: { query: vi.fn(async () => ({ entries: [] })) },
      purgeNow: { mutate: fakes.purgeNow },
    },
  },
}));

const { Retention } = await import('../components/changes/Retention');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

let refreshKey = 0;
async function render(preview: RetentionPreviewAnswer) {
  refreshKey += 1;
  fakes.retentionPreview.mockResolvedValue(preview);
  await act(async () => root.render(createElement(Retention, { projectId: P1, retention: { mode: 'days', value: 30 }, refreshKey, busy: false, say: vi.fn(), onChanged: vi.fn() })));
  await act(async () => {});
}
const purgeButton = () => host.querySelector<HTMLButtonElement>('[data-testid="retention-purge"]')!;

test('api-only-purge-counts-show-readings', async () => {
  // A project with only API readings: the preview names them and Purge now is enabled.
  await render({ status: 'ok', policy: { mode: 'days', value: 30 }, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0, readings: 2 }, bytes: 1_500 });
  expect(host.textContent).toContain('0 screenshots and 2 API readings');
  expect(host.textContent).not.toContain('would remove nothing');
  expect(purgeButton().disabled).toBe(false);
  // Truly nothing: disabled, as before.
  await render({ status: 'ok', policy: { mode: 'days', value: 30 }, counts: { captures: 0, versions: 0, diffs: 0, screenshots: 0 }, bytes: 0 });
  expect(host.textContent).toContain('Purging now would remove nothing.');
  expect(purgeButton().disabled).toBe(true);
});
