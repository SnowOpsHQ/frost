// Spec: specs/ipc-transport.spec.ts · Acceptance: specs/ipc-transport.feature.md (Main wiring)
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';
import { createWindowRegistry } from '../app-windows';

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly webContents: { id: number; devToolsWebContents: { id: number } | null };
  constructor(private readonly windowId: number) {
    super();
    this.webContents = { id: windowId * 10, devToolsWebContents: null };
  }
  get id(): number {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    return this.windowId;
  }
}

describe('app window registry', () => {
  test('tracks-app-window-ids', () => {
    const registry = createWindowRegistry();
    const a = new FakeWindow(1);
    const b = new FakeWindow(2);
    new FakeWindow(3); // never tracked
    registry.track(a);
    registry.track(b);
    expect([...registry.knownWindowIds]).toEqual([1, 2]);

    a.destroyed = true;
    a.emit('closed');
    expect([...registry.knownWindowIds]).toEqual([2]);
    expect(registry.knownWindowIds.has(3)).toBe(false);
  });

  test('recognizes-app-webcontents', () => {
    const registry = createWindowRegistry();
    const a = new FakeWindow(1);
    const untracked = new FakeWindow(2);
    registry.track(a);
    expect(registry.isAppWebContents(a.webContents)).toBe(true);
    expect(registry.isAppWebContents(untracked.webContents)).toBe(false);
    expect(registry.isAppWebContents({ id: 999 })).toBe(false);

    // The app window's own DevTools, only while they are open for it.
    const devTools = { id: 11 };
    expect(registry.isAppWebContents(devTools)).toBe(false);
    a.webContents.devToolsWebContents = devTools;
    expect(registry.isAppWebContents(devTools)).toBe(true);
    untracked.webContents.devToolsWebContents = { id: 21 };
    expect(registry.isAppWebContents({ id: 21 })).toBe(false);

    a.destroyed = true;
    a.emit('closed');
    expect(registry.isAppWebContents(a.webContents)).toBe(false);
    expect(registry.isAppWebContents(devTools)).toBe(false);
  });
});
