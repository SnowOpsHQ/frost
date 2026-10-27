import electron, { BrowserView, BrowserWindow, BrowserWindow as Window, WebContentsView } from 'electron';

const prefs = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

// ruleid: webcontents-outside-factory
const win = new BrowserWindow({ webPreferences: prefs });
// ruleid: webcontents-outside-factory
const view = new WebContentsView({ webPreferences: prefs });
// ruleid: webcontents-outside-factory
const legacyView = new BrowserView({ webPreferences: prefs });
// ruleid: webcontents-outside-factory
const qualified = new electron.BrowserWindow();
// ruleid: webcontents-outside-factory
const qualifiedView = new electron.WebContentsView();
// ruleid: webcontents-outside-factory
const aliased = new Window();
// ruleid: webcontents-outside-factory
class TabView extends WebContentsView {}

// ok: webcontents-outside-factory
const existing = BrowserWindow.fromWebContents(win.webContents);
// ok: webcontents-outside-factory
const all = BrowserWindow.getAllWindows();
// ok: webcontents-outside-factory
win.contentView.addChildView(view);

export { aliased, all, existing, legacyView, qualified, qualifiedView, TabView };
