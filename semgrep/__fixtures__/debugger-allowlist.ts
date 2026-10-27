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
// ruleid: debugger-outside-allowlisted-modules
const viaReflect = Reflect.get(contents, 'debugger');
// ruleid: debugger-outside-allowlisted-modules
const viaReflectDescriptor = Reflect.getOwnPropertyDescriptor(contents, "debugger");
// ruleid: debugger-outside-allowlisted-modules
const viaDescriptor = Object.getOwnPropertyDescriptor(contents, 'debugger');
let assigned: unknown;
// ruleid: debugger-outside-allowlisted-modules
({ debugger: assigned } = contents);
// ruleid: debugger-outside-allowlisted-modules
const untypedArrow = ({ debugger: dbg }) => dbg;
// ruleid: debugger-outside-allowlisted-modules
function untypedFunction({ debugger: dbg }) {
  return dbg;
}

// ok: debugger-outside-allowlisted-modules
const tools = contents.isDevToolsOpened();
// ok: debugger-outside-allowlisted-modules
const viaReflectSession = Reflect.get(contents, 'session');
// ok: debugger-outside-allowlisted-modules
const sessionDescriptor = Object.getOwnPropertyDescriptor(contents, 'session');
// ok: debugger-outside-allowlisted-modules
const debuggerLabel = 'debugger';
// ok: debugger-outside-allowlisted-modules
const isAttached = (value: { attached: boolean }) => value.attached;

export { alias, arrow, assigned, attachTo, debuggerLabel, destructured, isAttached, sessionDescriptor, tools, untypedArrow, untypedFunction, viaDescriptor, viaIndex, viaReflect, viaReflectDescriptor, viaReflectSession };
