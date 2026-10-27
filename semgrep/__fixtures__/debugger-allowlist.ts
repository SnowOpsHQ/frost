import { BrowserWindow, webContents, type WebContents } from 'electron';

declare const contents: WebContents;
const win = BrowserWindow.getAllWindows()[0]!;

// ruleid: debugger-outside-allowlisted-modules
contents.debugger.attach('1.3');
// ruleid: debugger-outside-allowlisted-modules
void contents.debugger.sendCommand('Runtime.evaluate', { expression: '1' });
// ruleid: debugger-outside-allowlisted-modules
win.webContents.debugger.detach();
// ruleid: debugger-outside-allowlisted-modules
webContents.fromId(1)?.debugger.on('message', () => undefined);
// ruleid: debugger-outside-allowlisted-modules
const alias = contents.debugger;
// ruleid: debugger-outside-allowlisted-modules
const viaIndex = contents['debugger'];
// ruleid: debugger-outside-allowlisted-modules
const { debugger: destructured } = contents;
// ruleid: debugger-outside-allowlisted-modules
function attachTo({ debugger: dbg }: WebContents): void {
  dbg.attach();
}
// ruleid: debugger-outside-allowlisted-modules
const arrow = ({ debugger: dbg }: WebContents) => dbg.isAttached();

// ok: debugger-outside-allowlisted-modules
const tools = contents.isDevToolsOpened();
// ok: debugger-outside-allowlisted-modules
const debuggerLabel = 'debugger';
// ok: debugger-outside-allowlisted-modules
const isAttached = (value: { attached: boolean }) => value.attached;

export { alias, arrow, attachTo, debuggerLabel, destructured, isAttached, tools, viaIndex };
