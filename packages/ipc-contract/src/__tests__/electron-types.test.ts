// Spec: specs/ipc-sender.spec.ts · Acceptance: specs/ipc-sender.feature.md
// Type-level only (checked by `tsc --noEmit`): `electron` is imported as types, never at runtime.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { expectTypeOf, test } from 'vitest';
import type { CreateContextOptions, SenderPolicy } from '../index';

type FromEvent = (
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow | null,
  policy: SenderPolicy,
) => CreateContextOptions;

test('context-derivable-from-electron-ipc-event', () => {
  // Task 4 builds the options straight from the real event, with no adapter logic in between.
  const fromEvent: FromEvent = (event, window, policy) => ({
    sender: event.sender,
    senderFrame: event.senderFrame,
    window,
    policy,
  });
  expectTypeOf(fromEvent).toBeFunction();
  expectTypeOf<BrowserWindow>().toExtend<NonNullable<CreateContextOptions['window']>>();
  expectTypeOf<IpcMainInvokeEvent['senderFrame']>().toExtend<CreateContextOptions['senderFrame']>();
  expectTypeOf<IpcMainInvokeEvent['sender']>().toExtend<CreateContextOptions['sender']>();
});
