// Spec: specs/browser.spec.ts (TAB_SHORTCUT_COUNT) · Acceptance: specs/tabs.feature.md (Menu)
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { TAB_SHORTCUT_COUNT } from '@app/specs/browser.spec';
import { appMenuTemplate, installAppMenu, type TabCommands } from '../menu';

vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

function fakeCommands() {
  return {
    newTab: vi.fn(),
    closeActiveTab: vi.fn(),
    focusAddressBar: vi.fn(),
    activateTabAt: vi.fn(),
    activateLastTab: vi.fn(),
  } satisfies TabCommands;
}

/** Every item of the template, depth first. */
function allItems(template: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? allItems(item.submenu) : [])]);
}

function itemById(template: readonly MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const found = allItems(template).find((item) => item.id === id);
  if (!found) throw new Error(`no menu item ${id}`);
  return found;
}

/** Calls the item's click handler as Electron would (item, window, event). */
function click(item: MenuItemConstructorOptions): void {
  const handler = item.click as unknown as ((...args: unknown[]) => void) | undefined;
  if (!handler) throw new Error(`menu item ${item.id ?? item.label} has no click`);
  handler(item, undefined, {});
}

describe('application menu', () => {
  test.each(PLATFORMS)('menu-accelerators-call-controller (%s)', (platform) => {
    const commands = fakeCommands();
    const template = appMenuTemplate(commands, platform);

    const expectations: [id: string, accelerator: string, called: () => void][] = [
      ['new-tab', 'CmdOrCtrl+T', () => expect(commands.newTab).toHaveBeenCalledTimes(1)],
      ['close-tab', 'CmdOrCtrl+W', () => expect(commands.closeActiveTab).toHaveBeenCalledTimes(1)],
      ['focus-address-bar', 'CmdOrCtrl+L', () => expect(commands.focusAddressBar).toHaveBeenCalledTimes(1)],
      ['select-last-tab', `CmdOrCtrl+${TAB_SHORTCUT_COUNT}`, () => expect(commands.activateLastTab).toHaveBeenCalledTimes(1)],
    ];
    for (const [id, accelerator, called] of expectations) {
      const item = itemById(template, id);
      expect(item.accelerator, id).toBe(accelerator);
      click(item);
      called();
    }

    for (let n = 1; n < TAB_SHORTCUT_COUNT; n++) {
      const item = itemById(template, `select-tab-${n}`);
      expect(item.accelerator).toBe(`CmdOrCtrl+${n}`);
      click(item);
      expect(commands.activateTabAt).toHaveBeenLastCalledWith(n - 1);
    }
    expect(commands.activateTabAt).toHaveBeenCalledTimes(TAB_SHORTCUT_COUNT - 1);
  });

  test.each(PLATFORMS)('menu-keeps-edit-roles (%s)', (platform) => {
    const template = appMenuTemplate(fakeCommands(), platform);
    const edit = template.find((item) => item.label === 'Edit');
    expect(edit).toBeDefined();
    const roles = (edit!.submenu as MenuItemConstructorOptions[]).map((item) => item.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']));
  });

  test.each(PLATFORMS)('menu-accelerators-are-unique (%s)', (platform) => {
    const items = allItems(appMenuTemplate(fakeCommands(), platform));
    // Default role menus bring their own accelerators (the window menu's close is Cmd/Ctrl+W).
    const roles = items.map((item) => item.role);
    for (const role of ['fileMenu', 'windowMenu', 'viewMenu', 'editMenu', 'defaultMenu'] as const) expect(roles).not.toContain(role);
    // A window-close item must not take Cmd/Ctrl+W (Close Tab's).
    for (const item of items.filter((i) => i.role === 'close')) {
      expect(item.accelerator).toBeDefined();
      expect(item.accelerator).not.toBe('CmdOrCtrl+W');
    }
    const accelerators = items.map((item) => item.accelerator).filter((a): a is string => typeof a === 'string');
    expect(new Set(accelerators).size).toBe(accelerators.length);
    // Nothing reloads or inspects the chrome page itself.
    for (const role of ['reload', 'forceReload', 'toggleDevTools'] as const) expect(roles).not.toContain(role);
  });

  test('install-app-menu-sets-application-menu', async () => {
    const { Menu } = await import('electron');
    installAppMenu(fakeCommands());
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    expect(Menu.getApplicationMenu()).not.toBeNull();
  });
});
