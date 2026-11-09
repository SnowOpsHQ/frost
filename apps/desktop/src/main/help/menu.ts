import type { MenuItemConstructorOptions } from 'electron';
import { HELP_MENU, shortcutToAccelerator, type HelpLink, type HelpMenuItem } from '@app/specs/help.spec';

// The Help menu (Phase 11 Task 11, Decision 14; acceptance `help.feature.md`, Menu): `HELP_MENU`'s
// items in order, a separator between groups, last in the menu bar with the `help` role. Each item
// only calls a command; main's commands (`help/main.ts`) open the sheets in the window the menu acted
// on and the fixed pages in the system browser (a menu click is a user gesture). Task 12 adds its
// action here, beside the others.

/** What the Help menu runs; optional so other fakes need not grow. */
export interface HelpMenuCommands {
  /** The keyboard shortcuts screen, in window `windowId` (the menu's; else the focused one). */
  showShortcuts?(windowId?: number): void;
  /** What's New, in window `windowId`. */
  showWhatsNew?(windowId?: number): void;
  /** A `HELP_URLS` page in the system browser. */
  openHelpLink?(link: HelpLink): void;
}

function itemFor(item: HelpMenuItem, commands: HelpMenuCommands): MenuItemConstructorOptions {
  const base: MenuItemConstructorOptions = { id: item.id, label: item.label, ...(item.shortcut === undefined ? {} : { accelerator: shortcutToAccelerator(item.shortcut) }) };
  switch (item.action) {
    case 'shortcuts':
      return { ...base, click: (_item, win) => commands.showShortcuts?.(win?.id) };
    case 'whats-new':
      return { ...base, click: (_item, win) => commands.showWhatsNew?.(win?.id) };
    case 'link': {
      const link = item.link;
      return { ...base, click: () => (link === undefined ? undefined : commands.openHelpLink?.(link)) };
    }
  }
}

/** The Help menu for the application menu template. */
export function helpMenu(commands: HelpMenuCommands): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [];
  HELP_MENU.items.forEach((item, i) => {
    if (i > 0 && HELP_MENU.items[i - 1]!.group !== item.group) submenu.push({ type: 'separator' });
    submenu.push(itemFor(item, commands));
  });
  return { label: HELP_MENU.label, role: HELP_MENU.role, submenu };
}
