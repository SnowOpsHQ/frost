// Spec: specs/browser.spec.ts (TAB_SHORTCUT_COUNT), specs/page-commands.spec.ts
// Acceptance: specs/tabs.feature.md (Menu), specs/page-commands.feature.md (Menu)
import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { TAB_SHORTCUT_COUNT } from '@app/specs/browser.spec';
import { appMenuTemplate, installAppMenu, type AppMenuCommands } from '../menu';

vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

function fakeCommands() {
  return {
    newTab: vi.fn(),
    closeActiveTab: vi.fn(),
    focusAddressBar: vi.fn(),
    activateTabAt: vi.fn(),
    activateLastTab: vi.fn(),
    activateNextTab: vi.fn(),
    activatePreviousTab: vi.fn(),
    runPageCommand: vi.fn(),
    clearBrowsingData: vi.fn(),
  } satisfies AppMenuCommands;
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
  test.each(PLATFORMS)('clear-browsing-data-menu-item (%s)', (platform) => {
    const commands = fakeCommands();
    const template = appMenuTemplate(commands, platform);
    const item = itemById(template, CLEAR_BROWSING_DATA.menuItemId);
    expect(item.label).toBe(CLEAR_BROWSING_DATA.menuLabel);
    expect(item.label).toBe('Clear Browsing Data\u2026');
    expect(item.accelerator).toBeUndefined();
    // In the File menu, or the app menu on macOS (which keeps its standard items).
    const host = template.find((menu) => Array.isArray(menu.submenu) && menu.submenu.includes(item))!;
    if (platform === 'darwin') {
      expect(host.role).toBe('appMenu');
      expect((host.submenu as MenuItemConstructorOptions[]).map((entry) => entry.role).filter(Boolean)).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
    } else {
      expect(host.label).toBe('File');
    }
    expect(allItems(template).filter((entry) => entry.id === CLEAR_BROWSING_DATA.menuItemId)).toHaveLength(1);
    click(item);
    expect(commands.clearBrowsingData).toHaveBeenCalledOnce();
  });

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

    // Next / previous tab: Ctrl+Tab everywhere (hidden on macOS, where Cmd+Shift+] / [ are shown).
    const cycle: [id: string, accelerator: string, visible: boolean, fn: 'activateNextTab' | 'activatePreviousTab'][] =
      platform === 'darwin'
        ? [
            ['next-tab', 'Cmd+Shift+]', true, 'activateNextTab'],
            ['previous-tab', 'Cmd+Shift+[', true, 'activatePreviousTab'],
            ['next-tab-ctrl', 'Ctrl+Tab', false, 'activateNextTab'],
            ['previous-tab-ctrl', 'Ctrl+Shift+Tab', false, 'activatePreviousTab'],
          ]
        : [
            ['next-tab', 'Ctrl+Tab', true, 'activateNextTab'],
            ['previous-tab', 'Ctrl+Shift+Tab', true, 'activatePreviousTab'],
          ];
    for (const [id, accelerator, visible, fn] of cycle) {
      const item = itemById(template, id);
      expect(item.accelerator, id).toBe(accelerator);
      expect(item.visible ?? true, id).toBe(visible);
      if (!visible) expect(item.acceleratorWorksWhenHidden ?? true, id).toBe(true);
      commands[fn].mockClear();
      click(item);
      expect(commands[fn], id).toHaveBeenCalledTimes(1);
    }
  });

  test.each(PLATFORMS)('menu-window-and-quit-items (%s)', (platform) => {
    const items = allItems(appMenuTemplate(fakeCommands(), platform));
    const close = items.filter((item) => item.role === 'close');
    expect(close).toHaveLength(1);
    expect(close[0]!.accelerator).toBe('CmdOrCtrl+Shift+W');
    const quit = items.filter((item) => item.role === 'quit');
    if (platform === 'darwin') {
      // The app menu carries Quit, on the role's own Cmd+Q.
      expect(quit).toHaveLength(1);
      expect(quit[0]!.accelerator).toBeUndefined();
      const appMenu = items.find((item) => item.role === 'appMenu');
      expect((appMenu?.submenu as MenuItemConstructorOptions[]).includes(quit[0]!)).toBe(true);
    } else {
      expect(quit).toHaveLength(1);
      expect(quit[0]!.accelerator).toBe('Ctrl+Shift+Q');
    }
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

  test.each(PLATFORMS)('menu-page-commands (%s)', (platform) => {
    const mac = platform === 'darwin';
    const commands = fakeCommands();
    const template = appMenuTemplate(commands, platform);
    // [id, accelerator, visible, command]
    const items: [string, string, boolean, string][] = [
      ['reload', 'CmdOrCtrl+R', true, 'reload'],
      ['reload-f5', 'F5', false, 'reload'],
      ['hard-reload', 'CmdOrCtrl+Shift+R', true, 'hard-reload'],
      ['stop', 'Escape', true, 'stop'],
      ['zoom-in', 'CmdOrCtrl+=', true, 'zoom-in'],
      ['zoom-in-plus', 'CmdOrCtrl+Plus', false, 'zoom-in'],
      ['zoom-in-keypad', 'CmdOrCtrl+numadd', false, 'zoom-in'],
      ['zoom-out', 'CmdOrCtrl+-', true, 'zoom-out'],
      ['zoom-out-keypad', 'CmdOrCtrl+numsub', false, 'zoom-out'],
      ['zoom-reset', 'CmdOrCtrl+0', true, 'zoom-reset'],
      ['zoom-reset-keypad', 'CmdOrCtrl+num0', false, 'zoom-reset'],
      ['back', mac ? 'Cmd+[' : 'Alt+Left', true, 'back'],
      ['forward', mac ? 'Cmd+]' : 'Alt+Right', true, 'forward'],
      ...(mac
        ? ([
            ['back-arrow', 'Cmd+Left', false, 'back'],
            ['forward-arrow', 'Cmd+Right', false, 'forward'],
          ] as [string, string, boolean, string][])
        : []),
    ];
    for (const [id, accelerator, visible, command] of items) {
      const item = itemById(template, id);
      expect(item.accelerator, id).toBe(accelerator);
      expect(item.visible ?? true, id).toBe(visible);
      if (!visible) expect(item.acceleratorWorksWhenHidden ?? true, id).toBe(true);
      expect(item.role, id).toBeUndefined();
      commands.runPageCommand.mockClear();
      click(item);
      expect(commands.runPageCommand, id).toHaveBeenCalledExactlyOnceWith(command);
    }
    // Esc is shown on Stop but never registered (the chrome and the page keep their own Esc).
    expect(itemById(template, 'stop').registerAccelerator).toBe(false);
    for (const item of allItems(template)) {
      if (item.id !== 'stop') expect(item.registerAccelerator ?? true, item.id ?? item.label).toBe(true);
    }
    expect(allItems(template).some((item) => item.id === 'back-arrow')).toBe(mac);
    const view = template.find((item) => item.label === 'View');
    const history = template.find((item) => item.label === 'History');
    expect(allItems(view?.submenu as MenuItemConstructorOptions[]).map((item) => item.id).filter(Boolean)).toEqual(expect.arrayContaining(['reload', 'hard-reload', 'stop', 'zoom-in', 'zoom-out', 'zoom-reset']));
    expect(allItems(history?.submenu as MenuItemConstructorOptions[]).map((item) => item.id).filter(Boolean)).toEqual(expect.arrayContaining(['back', 'forward']));
  });

  test('install-app-menu-sets-application-menu', async () => {
    const { Menu } = await import('electron');
    installAppMenu(fakeCommands());
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    expect(Menu.getApplicationMenu()).not.toBeNull();
  });
});
