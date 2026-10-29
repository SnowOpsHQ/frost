// Spec: specs/account-settings.spec.ts (SETTINGS_MENU, MAX_PENDING_SETTINGS_WATCHES), specs/account-settings.schema.ts
// Acceptance: specs/account-settings.feature.md (Main)
import type { BaseWindow, MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { MAX_PENDING_SETTINGS_WATCHES, SETTINGS_MENU } from '@app/specs/account-settings.spec';
import { appMenuTemplate, type AppMenuCommands } from '../../menu';
import { createSettingsRequests } from '../settings-requests';

vi.mock('electron', async () => (await import('../../../test/electron-fake')).electronFake());

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const FOCUSED = 4;
const OTHER = 9;

function setup(windows: readonly number[] = [FOCUSED, OTHER]) {
  const focused: number[] = [];
  const requests = createSettingsRequests({
    chrome: (windowId) => {
      const id = windowId ?? (windows.includes(FOCUSED) ? FOCUSED : undefined);
      return id !== undefined && windows.includes(id) ? { windowId: id, focus: () => focused.push(id) } : null;
    },
  });
  return { requests, focused };
}

describe('settings requests (main)', () => {
  test('settings-requests-show-bumps-and-focuses', async () => {
    const { requests, focused } = setup();
    expect(requests.state(FOCUSED)).toEqual({ seq: 0 });
    const waiting = requests.watch(FOCUSED, 0);
    let otherAnswered = false;
    void requests.watch(OTHER, 0).then(() => (otherAnswered = true));
    // No window ID: the focused window.
    requests.show();
    expect(await waiting).toEqual({ seq: 1 });
    await flush();
    expect(otherAnswered).toBe(false);
    expect(requests.state(OTHER)).toEqual({ seq: 0 });
    expect(focused).toEqual([FOCUSED]);
    // The window the menu acted on.
    requests.show(OTHER);
    await flush();
    expect(otherAnswered).toBe(true);
    expect(requests.state(OTHER)).toEqual({ seq: 1 });
    expect(requests.state(FOCUSED)).toEqual({ seq: 1 });
    expect(focused).toEqual([FOCUSED, OTHER]);
    // No app window: nothing changes.
    const none = setup([]);
    none.requests.show();
    none.requests.show(FOCUSED);
    expect(none.requests.state(FOCUSED)).toEqual({ seq: 0 });
    expect(none.focused).toEqual([]);
  });

  test('settings-requests-watch-long-polls', async () => {
    const { requests } = setup();
    requests.show();
    expect(await requests.watch(FOCUSED, -1)).toEqual({ seq: 1 });
    expect(await requests.watch(FOCUSED, 0)).toEqual({ seq: 1 });
    let answered: unknown = null;
    void requests.watch(FOCUSED, 1).then((state) => (answered = state));
    await flush();
    expect(answered).toBeNull();
    requests.show();
    await flush();
    expect(answered).toEqual({ seq: 2 });
    const abort = new AbortController();
    const aborted = requests.watch(FOCUSED, 2, abort.signal);
    abort.abort();
    expect(await aborted).toEqual({ seq: 2 });
    const order: number[] = [];
    for (let i = 0; i <= MAX_PENDING_SETTINGS_WATCHES; i++) void requests.watch(FOCUSED, 2).then(() => order.push(i));
    await flush();
    expect(order).toEqual([0]);
    requests.dispose();
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
    const all = (list: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => list.flatMap((entry) => [entry, ...(Array.isArray(entry.submenu) ? all(entry.submenu) : [])]);
    expect(all(template).filter((entry) => entry.id === SETTINGS_MENU.id)).toHaveLength(1);
    const click = item.click as unknown as (menuItem: unknown, win: Pick<BaseWindow, 'id'> | undefined, event: unknown) => void;
    click(item, { id: OTHER }, {});
    expect(showSettings).toHaveBeenLastCalledWith(OTHER);
    click(item, undefined, {});
    expect(showSettings).toHaveBeenLastCalledWith(undefined);
  });
});
