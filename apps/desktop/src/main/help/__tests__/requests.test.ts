// Spec: specs/help.spec.ts (HELP_SHEETS, MAX_PENDING_HELP_WATCHES), specs/whats-new.schema.ts (HelpViewStateSchema)
// Acceptance: specs/help.feature.md (Menu: the sheets open in the window the menu acted on)
import { expect, test, vi } from 'vitest';
import { MAX_PENDING_HELP_WATCHES } from '@app/specs/help.spec';
import { createHelpRequests } from '../requests';

test('help-requests-per-window', async () => {
  const focus = vi.fn();
  const requests = createHelpRequests({ chrome: (windowId) => (windowId === 99 ? null : { windowId: windowId ?? 1, focus }) });
  expect(requests.state(1)).toEqual({ seq: 0, sheet: null });
  // A waiting watch is answered by a request for its window only.
  const one = requests.watch(1, 0);
  const two = requests.watch(2, 0);
  requests.show('shortcuts', 1);
  await expect(one).resolves.toEqual({ seq: 1, sheet: 'shortcuts' });
  expect(focus).toHaveBeenCalledOnce();
  // No window given: the focused one (the deps' choice); no window at all: nothing.
  requests.show('whats-new');
  expect(requests.state(1)).toEqual({ seq: 2, sheet: 'whats-new' });
  requests.show('shortcuts', 99);
  expect(focus).toHaveBeenCalledTimes(2);
  // Newer already: answered at once.
  await expect(requests.watch(1, 0)).resolves.toEqual({ seq: 2, sheet: 'whats-new' });
  // Bounded: one more than the cap answers the oldest early.
  const waits = Array.from({ length: MAX_PENDING_HELP_WATCHES }, () => requests.watch(3, 0));
  await expect(two).resolves.toEqual({ seq: 0, sheet: null });
  // Aborted and disposed watches answer the state now.
  const abort = new AbortController();
  const aborted = requests.watch(4, 0, abort.signal);
  abort.abort();
  await expect(aborted).resolves.toEqual({ seq: 0, sheet: null });
  requests.dispose();
  await expect(Promise.all(waits)).resolves.toHaveLength(MAX_PENDING_HELP_WATCHES);
});
