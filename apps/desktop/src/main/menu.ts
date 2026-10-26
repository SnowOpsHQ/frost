import { Menu, type MenuItemConstructorOptions } from 'electron';
import { TAB_SHORTCUT_COUNT } from '@app/specs/browser.spec';
import type { BrowserController } from './browser/controller';

// The application menu (spec `tabs.feature.md`, Menu). Tab shortcuts are menu accelerators handled
// here in main: a focused page view (a separate WebContents) would swallow key handlers in the
// chrome renderer. No default role menus are used, since they bring their own accelerators (the
// window menu's close is Cmd/Ctrl+W, Close Tab's here) and items that reload or inspect the chrome
// page itself.

/** The controller calls the menu makes. */
export type TabCommands = Pick<BrowserController, 'newTab' | 'closeActiveTab' | 'focusAddressBar' | 'activateTabAt' | 'activateLastTab'>;

/** The menu template for `platform` (pure; `installAppMenu` builds and installs it). */
export function appMenuTemplate(commands: TabCommands, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const selectTab: MenuItemConstructorOptions[] = [];
  for (let n = 1; n < TAB_SHORTCUT_COUNT; n++) {
    selectTab.push({ id: `select-tab-${n}`, label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => void commands.activateTabAt(n - 1) });
  }

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { id: 'new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => void commands.newTab() },
      { id: 'focus-address-bar', label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => commands.focusAddressBar() },
      { type: 'separator' },
      { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => void commands.closeActiveTab() },
      // Cmd/Ctrl+W belongs to Close Tab; closing the window takes Shift as well.
      ...(mac
        ? [{ role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' } satisfies MenuItemConstructorOptions]
        : [{ type: 'separator' } satisfies MenuItemConstructorOptions, { role: 'quit' } satisfies MenuItemConstructorOptions]),
    ],
  };

  // The standard editing roles: on macOS the address bar's clipboard shortcuts work only through them.
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } satisfies MenuItemConstructorOptions] : []),
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' },
    ],
  };

  const tab: MenuItemConstructorOptions = {
    label: 'Tab',
    submenu: [
      ...selectTab,
      { id: 'select-last-tab', label: 'Last Tab', accelerator: `CmdOrCtrl+${TAB_SHORTCUT_COUNT}`, click: () => void commands.activateLastTab() },
    ],
  };

  if (!mac) return [file, edit, tab];
  return [
    { role: 'appMenu' },
    file,
    edit,
    tab,
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
}

/** Builds the template for this platform and installs it as the application menu. */
export function installAppMenu(commands: TabCommands): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(commands)));
}
