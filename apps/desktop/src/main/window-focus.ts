import { BrowserWindow } from 'electron';

/**
 * Brings app window `windowId` to the front (restored if minimized); nothing if it is gone. Used
 * when a sign-in finished in the system browser: the account's (`account/main.ts`) and the ChatGPT
 * plan's (`agent/wire.ts`).
 */
export function focusWindow(windowId: number): void {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}
