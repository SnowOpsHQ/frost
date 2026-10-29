import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { PageCommand } from '@app/specs/page-commands.spec';
import { CLEAR_BROWSING_DATA } from '@app/specs/browser-session-db.spec';
import { TAB_SHORTCUT_COUNT } from '@app/specs/browser.spec';
import { SIDEBAR_TOGGLE_MENU_ID } from '@app/specs/seo-sidebar.spec';
import { COMMAND_PALETTE_MENU_ID, COMMAND_PALETTE_MENU_LABEL } from '@app/specs/command-palette.spec';
import { DEVTOOLS_MENU_ACCELERATOR, DEVTOOLS_MENU_ID, DEVTOOLS_MENU_LABEL } from '@app/specs/devtools.spec';
import { HISTORY_MENU_LABEL, POLISH_MENU_IDS } from '@app/specs/browser-polish.spec';
import { SETTINGS_MENU } from '@app/specs/account-settings.spec';
import type { BrowserController } from './browser/controller';

// The application menu (spec `tabs.feature.md`, Menu). Tab shortcuts are menu accelerators handled
// here in main (a focused page view would swallow key handlers in the chrome renderer); the
// controller also takes them in `before-input-event`, so a page cannot cancel them first, and
// consumes them there, so an accelerator never runs a second time. No default role menus are used,
// since they bring their own accelerators (the window menu's close is Cmd/Ctrl+W, Close Tab's here)
// and items that reload or inspect the chrome page itself. The View and History items (spec
// `page-commands.feature.md`) act on the active tab's page, never on the chrome.

/** The controller calls the menu makes. */
export type TabCommands = Pick<
  BrowserController,
  'newTab' | 'closeActiveTab' | 'focusAddressBar' | 'activateTabAt' | 'activateLastTab' | 'activateNextTab' | 'activatePreviousTab' | 'runPageCommand' | 'toggleSidebar' | 'openCommandPalette' | 'toggleDevtools'
>;

/** Everything the menu runs: the tab commands and Clear Browsing Data… (`clear-browsing-data.ts`). */
export interface AppMenuCommands extends TabCommands {
  clearBrowsingData(): void;
  // Browser polish (`browser-polish.feature.md`); optional so other fakes need not grow.
  readonly find?: Pick<BrowserController['find'], 'open'>;
  stepFind?(forward: boolean): unknown;
  reopenClosedTab?(): unknown;
  showHistory?(): void;
  // The Settings view (`account-settings.feature.md`), in the window the menu acted on; optional so other fakes need not grow.
  showSettings?(windowId?: number): void;
}

/** The menu items browser polish adds (`browser-polish.spec.ts`, `POLISH_MENU_IDS`): File, Edit and History. */
function polishItems(commands: AppMenuCommands) {
  const step = (forward: boolean) => () => void commands.stepFind?.(forward);
  return {
    file: [{ id: POLISH_MENU_IDS.reopen, label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => void commands.reopenClosedTab?.() }],
    edit: [
      { type: 'separator' },
      { id: POLISH_MENU_IDS.find, label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => commands.find?.open() },
      { id: POLISH_MENU_IDS.findNext, label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: step(true) },
      { id: POLISH_MENU_IDS.findPrevious, label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: step(false) },
    ],
    // Mod+Y is an accelerator only (not reserved): a page's text field keeps Ctrl+Y (redo) first.
    history: [{ type: 'separator' }, { id: POLISH_MENU_IDS.history, label: HISTORY_MENU_LABEL, accelerator: 'CmdOrCtrl+Y', click: () => commands.showHistory?.() }],
  } satisfies Record<string, MenuItemConstructorOptions[]>;
}

/** The menu template for `platform` (pure; `installAppMenu` builds and installs it). */
export function appMenuTemplate(commands: AppMenuCommands, platform: NodeJS.Platform = process.platform): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const polish = polishItems(commands);
  // Settings… (`account-settings.feature.md`): the macOS app menu, elsewhere the end of Edit.
  const settings: MenuItemConstructorOptions = { id: SETTINGS_MENU.id, label: SETTINGS_MENU.label, accelerator: SETTINGS_MENU.accelerator, click: (_item, win) => commands.showSettings?.(win?.id) };
  const selectTab: MenuItemConstructorOptions[] = [];
  for (let n = 1; n < TAB_SHORTCUT_COUNT; n++) {
    selectTab.push({ id: `select-tab-${n}`, label: `Tab ${n}`, accelerator: `CmdOrCtrl+${n}`, click: () => void commands.activateTabAt(n - 1) });
  }

  // Clear Browsing Data… (spec `browser-session-db.feature.md`): no accelerator, it asks first.
  const clearBrowsingData: MenuItemConstructorOptions = {
    id: CLEAR_BROWSING_DATA.menuItemId,
    label: CLEAR_BROWSING_DATA.menuLabel,
    click: () => commands.clearBrowsingData(),
  };

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { id: 'new-tab', label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => void commands.newTab() },
      ...polish.file,
      { id: 'focus-address-bar', label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => commands.focusAddressBar() },
      { type: 'separator' },
      { id: 'close-tab', label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => void commands.closeActiveTab() },
      // Cmd/Ctrl+W belongs to Close Tab; closing the window takes Shift as well.
      { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
      // Clear Browsing Data… is in the app menu on macOS. Quit: the app menu's Cmd+Q on macOS;
      // Ctrl+Shift+Q elsewhere (Linux/Windows convention).
      ...(mac
        ? []
        : [
            { type: 'separator' } satisfies MenuItemConstructorOptions,
            clearBrowsingData,
            { type: 'separator' } satisfies MenuItemConstructorOptions,
            { role: 'quit', accelerator: 'Ctrl+Shift+Q' } satisfies MenuItemConstructorOptions,
          ]),
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
      ...polish.edit,
      ...(mac ? [] : [{ type: 'separator' } satisfies MenuItemConstructorOptions, settings]),
    ],
  };

  // Next / previous tab: Ctrl+Tab everywhere; macOS shows Cmd+Shift+] / [ and keeps the Ctrl+Tab
  // items hidden (their accelerators still work there: `acceleratorWorksWhenHidden`).
  const next = () => void commands.activateNextTab();
  const previous = () => void commands.activatePreviousTab();
  const cycle: MenuItemConstructorOptions[] = mac
    ? [
        { id: 'next-tab', label: 'Next Tab', accelerator: 'Cmd+Shift+]', click: next },
        { id: 'previous-tab', label: 'Previous Tab', accelerator: 'Cmd+Shift+[', click: previous },
        { id: 'next-tab-ctrl', label: 'Next Tab', accelerator: 'Ctrl+Tab', visible: false, acceleratorWorksWhenHidden: true, click: next },
        { id: 'previous-tab-ctrl', label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', visible: false, acceleratorWorksWhenHidden: true, click: previous },
      ]
    : [
        { id: 'next-tab', label: 'Next Tab', accelerator: 'Ctrl+Tab', click: next },
        { id: 'previous-tab', label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: previous },
      ];

  // Page commands (`page-commands.feature.md`). Hidden alternates keep their accelerators
  // (`acceleratorWorksWhenHidden`); Stop shows Esc without registering it, so Esc in the chrome
  // (the address bar, the prompt bar) and in pages keeps its own meaning (a tab's Esc stops a
  // load from `before-input-event`).
  const page = (command: PageCommand) => () => commands.runPageCommand(command);
  const hidden = { visible: false, acceleratorWorksWhenHidden: true } as const;
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { id: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: page('reload') },
      { id: 'reload-f5', label: 'Reload', accelerator: 'F5', ...hidden, click: page('reload') },
      { id: 'hard-reload', label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: page('hard-reload') },
      { id: 'stop', label: 'Stop', accelerator: 'Escape', registerAccelerator: false, click: page('stop') },
      { type: 'separator' },
      { id: 'zoom-in', label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: page('zoom-in') },
      { id: 'zoom-in-plus', label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', ...hidden, click: page('zoom-in') },
      { id: 'zoom-in-keypad', label: 'Zoom In', accelerator: 'CmdOrCtrl+numadd', ...hidden, click: page('zoom-in') },
      { id: 'zoom-out', label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: page('zoom-out') },
      { id: 'zoom-out-keypad', label: 'Zoom Out', accelerator: 'CmdOrCtrl+numsub', ...hidden, click: page('zoom-out') },
      { id: 'zoom-reset', label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: page('zoom-reset') },
      { id: 'zoom-reset-keypad', label: 'Actual Size', accelerator: 'CmdOrCtrl+num0', ...hidden, click: page('zoom-reset') },
      { type: 'separator' },
      // The SEO sidebar (spec `seo-sidebar.feature.md`, Toggle): the chrome owns open / closed.
      { id: SIDEBAR_TOGGLE_MENU_ID, label: 'SEO Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: () => commands.toggleSidebar() },
      // The command palette (spec `command-palette.feature.md`): Mod+K is also reserved in `before-input-event`.
      { id: COMMAND_PALETTE_MENU_ID, label: COMMAND_PALETTE_MENU_LABEL, accelerator: 'CmdOrCtrl+K', click: () => commands.openCommandPalette() },
      // The SEO devtools drawer (spec `devtools.feature.md`): Mod+Shift+D is also reserved in `before-input-event`.
      { id: DEVTOOLS_MENU_ID, label: DEVTOOLS_MENU_LABEL, accelerator: DEVTOOLS_MENU_ACCELERATOR, click: () => commands.toggleDevtools() },
    ],
  };
  // Back / Forward: Cmd+[ / Cmd+] on macOS (Cmd+Left / Cmd+Right hidden: not reserved, so a text
  // field in the page keeps them), Alt+Left / Alt+Right elsewhere.
  const history: MenuItemConstructorOptions = {
    label: 'History',
    submenu: mac
      ? [
          { id: 'back', label: 'Back', accelerator: 'Cmd+[', click: page('back') },
          { id: 'forward', label: 'Forward', accelerator: 'Cmd+]', click: page('forward') },
          { id: 'back-arrow', label: 'Back', accelerator: 'Cmd+Left', ...hidden, click: page('back') },
          { id: 'forward-arrow', label: 'Forward', accelerator: 'Cmd+Right', ...hidden, click: page('forward') },
          ...polish.history,
        ]
      : [
          { id: 'back', label: 'Back', accelerator: 'Alt+Left', click: page('back') },
          { id: 'forward', label: 'Forward', accelerator: 'Alt+Right', click: page('forward') },
          ...polish.history,
        ],
  };

  const tab: MenuItemConstructorOptions = {
    label: 'Tab',
    submenu: [
      ...cycle,
      { type: 'separator' },
      ...selectTab,
      { id: 'select-last-tab', label: 'Last Tab', accelerator: `CmdOrCtrl+${TAB_SHORTCUT_COUNT}`, click: () => void commands.activateLastTab() },
    ],
  };

  if (!mac) return [file, edit, view, history, tab];
  // The app menu written out (the role's own submenu has no place for Clear Browsing Data…).
  const appMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      clearBrowsingData,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
  return [
    appMenu,
    file,
    edit,
    view,
    history,
    tab,
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ];
}

/** Builds the template for this platform and installs it as the application menu. */
export function installAppMenu(commands: AppMenuCommands): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(commands)));
}

/**
 * Pops up the page context menu for a tab's right-click (`page-commands.feature.md`): built from
 * `template` (`contextMenuTemplate`) on the app window.
 */
export function popupContextMenu(template: MenuItemConstructorOptions[], window: Electron.BaseWindow): void {
  if (template.length === 0) return;
  Menu.buildFromTemplate(template).popup({ window });
}
