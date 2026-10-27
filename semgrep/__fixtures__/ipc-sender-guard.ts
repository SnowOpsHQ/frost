import electron, { ipcMain, ipcMain as aliasedIpcMain, webContents, BrowserWindow } from 'electron';
import type { IpcMain, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { attachIpcHandler } from '@app/ipc-contract/main';

declare const win: BrowserWindow;
declare const handler: (...args: unknown[]) => unknown;
declare const goodRouterForTransport: never, policy: never, fromWebContents: never;

// ruleid: ipc-handler-outside-transport
ipcMain.handle('x', handler);
// ruleid: ipc-handler-outside-transport
ipcMain.on('x', handler);
// ruleid: ipc-handler-outside-transport
ipcMain.once('x', handler);
// ruleid: ipc-handler-outside-transport
ipcMain.handleOnce('x', handler);
// ruleid: ipc-handler-outside-transport
ipcMain.addListener('x', handler);
// ruleid: ipc-handler-outside-transport
electron.ipcMain.handle('x', handler);
// ruleid: ipc-handler-outside-transport
aliasedIpcMain.handle('x', handler);
// ruleid: ipc-handler-outside-transport
win.webContents.ipc.handle('x', handler);
// ruleid: ipc-handler-outside-transport
win.webContents.mainFrame.ipc.on('x', handler);

const m = ipcMain;
// ruleid: ipc-handler-outside-transport
m.handle('x', handler);

const { ipcMain: destructured } = electron;
// ruleid: ipc-handler-outside-transport
destructured.on('x', handler);

// ok: ipc-handler-outside-transport
ipcMain.removeHandler('x');
// ok: ipc-handler-outside-transport
win.webContents.on('did-finish-load', handler);

const { ipc } = win.webContents;
// ruleid: ipc-handler-outside-transport
ipc.handle('x', handler);

// Injected IpcMain: a registration on a parameter typed IpcMain / WebContents.
export function registerInjected(m: IpcMain, contents: WebContents, frame: WebFrameMain): void {
  // ruleid: ipc-handler-outside-transport
  m.handle('x', handler);
  // ruleid: ipc-handler-outside-transport
  contents.ipc.on('x', handler);
  // ruleid: ipc-handler-outside-transport
  frame.ipc.handle('x', handler);
}
export function onEvent(event: IpcMainInvokeEvent): void {
  // ruleid: ipc-handler-outside-transport
  event.sender.ipc.on('x', handler);
}
// ruleid: ipc-handler-outside-transport
webContents.fromId(1)?.ipc.handle('x', handler);
export function registerDestructured({ ipcMain: injected }: { ipcMain: IpcMain }): void {
  // ruleid: ipc-handler-outside-transport
  injected.handle('x', handler);
}
export const registerArrow = ({ ipcMain: injected }: { ipcMain: IpcMain }): void => {
  // ruleid: ipc-handler-outside-transport
  injected.on('x', handler);
};
app.on('web-contents-created', (_event, contents) => {
  // ruleid: ipc-handler-outside-transport
  contents.ipc.on('x', handler);
});
const aliasedContents = win.webContents;
// ruleid: ipc-handler-outside-transport
aliasedContents.ipc.handle('x', handler);

// Not IPC: the other names of a destructuring that takes ipcMain, an unrelated `ipc` property.
const { ipcMain: unusedIpcMain, app } = require('electron');
// ok: ipc-handler-outside-transport
app.on('ready', handler);
declare const services: { ipc: NodeJS.EventEmitter };
// ok: ipc-handler-outside-transport
services.ipc.on('x', handler);

// ---------------------------------------------------------------------------------------------
// ipc-main-escapes
declare function registerAll(...args: unknown[]): void;
// ruleid: ipc-main-escapes
registerAll(ipcMain);
// ruleid: ipc-main-escapes
registerAll(handler, electron.ipcMain);
// ruleid: ipc-main-escapes
registerAll({ ipcMain });
// ruleid: ipc-main-escapes
registerAll({ main: ipcMain, handler });
// ruleid: ipc-main-escapes
const deps = { ipcMain, handler };
// ok: ipc-main-escapes
attachIpcHandler({ router: goodRouterForTransport, policy, ipcMain, fromWebContents });
// ok: ipc-main-escapes
ipcMain.removeHandler('x');

// ---------------------------------------------------------------------------------------------
// trpc-procedure-without-enforce-sender
// ok: trpc-procedure-without-enforce-sender
import { enforceSender, publicProcedure, router } from './trpc';
import { z } from 'zod';
declare const otherMiddleware: Parameters<typeof publicProcedure.use>[0];

export const goodRouter = router({
  // ok: trpc-procedure-without-enforce-sender
  ping: publicProcedure.use(enforceSender).query(() => 'pong' as const),
  // ok: trpc-procedure-without-enforce-sender
  echo: publicProcedure.use(enforceSender).input(z.string()).query(({ input }) => input),
  // ok: trpc-procedure-without-enforce-sender
  save: publicProcedure.use(enforceSender).use(otherMiddleware).input(z.string()).mutation(() => true),
});

export const badRouter = router({
  // ruleid: trpc-procedure-without-enforce-sender
  ping: publicProcedure.query(() => 'pong' as const),
  // ruleid: trpc-procedure-without-enforce-sender
  echo: publicProcedure.input(z.string()).use(enforceSender).query(({ input }) => input),
  // ruleid: trpc-procedure-without-enforce-sender
  save: publicProcedure.use(otherMiddleware).use(enforceSender).mutation(() => true),
  // ruleid: trpc-procedure-without-enforce-sender
  watch: publicProcedure.subscription(async function* () {}),
});

// ruleid: trpc-procedure-without-enforce-sender
const base = publicProcedure;
export const aliasedRouter = router({ ping: base.query(() => 'pong' as const) });

// ruleid: trpc-procedure-without-enforce-sender
import { publicProcedure as pp } from './trpc';
import * as trpcModule from './trpc';
export const namespacedRouter = router({
  // ok: trpc-procedure-without-enforce-sender
  ping: trpcModule.publicProcedure.use(trpcModule.enforceSender).query(() => 'pong' as const),
  // ruleid: trpc-procedure-without-enforce-sender
  bad: trpcModule.publicProcedure.query(() => 'pong' as const),
});

// The unguarded base must not leave the package either.
// ruleid: trpc-procedure-without-enforce-sender
export { publicProcedure } from './trpc';

// ---------------------------------------------------------------------------------------------
// trpc-builder-outside-trpc-module
// ruleid: trpc-builder-outside-trpc-module
import { initTRPC } from '@trpc/server';
// ruleid: trpc-builder-outside-trpc-module
import { initTRPC as init } from '@trpc/server';
// ruleid: trpc-builder-outside-trpc-module
const t = initTRPC.create();
// ruleid: trpc-builder-outside-trpc-module
export const rogue = t.router({ ping: t.procedure.query(() => 'pong') });
// ruleid: trpc-builder-outside-trpc-module
export const rogueGuarded = t.procedure.use(enforceSender).query(() => 'pong');
declare const operation: { procedure: string };
// ok: trpc-builder-outside-trpc-module
const procedureName = operation.procedure;

// ---------------------------------------------------------------------------------------------
// renderer-bridge-outside-preload
// ruleid: renderer-bridge-outside-preload
import { contextBridge, ipcRenderer } from 'electron';
// ruleid: renderer-bridge-outside-preload
contextBridge.exposeInMainWorld('ipc', ipcRenderer);
// ruleid: renderer-bridge-outside-preload
electron.ipcRenderer.send('x');
// ruleid: renderer-bridge-outside-preload
const { contextBridge: cb } = electron;
// ok: renderer-bridge-outside-preload
const label = 'ipcRenderer';
