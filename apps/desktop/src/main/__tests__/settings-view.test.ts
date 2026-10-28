// Spec: specs/account-settings.spec.ts (SETTINGS_MENU, MAX_PENDING_SETTINGS_WATCHES), specs/account-settings.schema.ts
// Acceptance: specs/account-settings.feature.md (Main)
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { MAX_PENDING_SETTINGS_WATCHES, SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { appMenuTemplate, type AppMenuCommands } from '../menu';
import { createSettingsView } from '../settings-view';

vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(hasWindow = true) {
  const focus = vi.fn();
  const view = createSettingsView({ chrome: () => (hasWindow ? { focus } : null) });
  return { view, focus };
}

describe('settings view (main)', () => {
  test('settings-view-show-bumps-and-focuses', async () => {
    const { view, focus } = setup();
    expect(view.state()).toEqual({ seq: 0 });
    const waiting = view.watch(0);
    view.show();
    expect(await waiting).toEqual({ seq: 1 });
    expect(focus).toHaveBeenCalledOnce();
    view.show();
    expect(view.state()).toEqual({ seq: 2 });
    // Without an app window nothing changes.
    const none = setup(false);
    none.view.show();
    expect(none.view.state()).toEqual({ seq: 0 });
    expect(none.focus).not.toHaveBeenCalled();
  });

  test('settings-view-watch-long-polls', async () => {
    const { view } = setup();
    view.show();
    // Older: at once.
    expect(await view.watch(-1)).toEqual({ seq: 1 });
    expect(await view.watch(0)).toEqual({ seq: 1 });
    // Current: waits for the next change.
    let answered: unknown = null;
    void view.watch(1).then((state) => (answered = state));
    await flush();
    expect(answered).toBeNull();
    view.show();
    await flush();
    expect(answered).toEqual({ seq: 2 });
    // Aborting releases it with the current state.
    const abort = new AbortController();
    const aborted = view.watch(2, abort.signal);
    abort.abort();
    expect(await aborted).toEqual({ seq: 2 });
    // One more than the cap answers the oldest early.
    const order: number[] = [];
    for (let i = 0; i <= MAX_PENDING_SETTINGS_WATCHES; i++) void view.watch(2).then(() => order.push(i));
    await flush();
    expect(order).toEqual([0]);
    view.dispose();
    await flush();
    expect(order).toHaveLength(MAX_PENDING_SETTINGS_WATCHES + 1);
  });

  test.each(['darwin', 'linux', 'win32'] as const)('settings-menu-item (%s)', (platform) => {
    const showSettings = vi.fn();
    const commands = new Proxy({ showSettings } as unknown as AppMenuCommands, { get: (target, key) => (key in target ? target[key as keyof AppMenuCommands] : vi.fn()) });
    const template = appMenuTemplate(commands, platform);
    const home = platform === 'darwin' ? template[0]! : template.find((menu) => menu.label === 'Edit')!;
    const items = home.submenu as MenuItemConstructorOptions[];
    const item = items.find((entry) => entry.id === SETTINGS_MENU.id)!;
    expect(item).toMatchObject({ label: 'Settings…', accelerator: 'CmdOrCtrl+,' });
    if (platform !== 'darwin') expect(items.at(-1)).toBe(item);
    // Only once in the whole menu.
    const all = (list: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => list.flatMap((entry) => [entry, ...(Array.isArray(entry.submenu) ? all(entry.submenu) : [])]);
    expect(all(template).filter((entry) => entry.id === SETTINGS_MENU.id)).toHaveLength(1);
    (item.click as unknown as () => void)();
    expect(showSettings).toHaveBeenCalledOnce();
  });
});
