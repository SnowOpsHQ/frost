import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { BROWSE_PARTITION, NEW_TAB_LABEL } from '@app/specs/browser.spec';

/** A modifier for `press`: `mod` is Cmd on macOS and Ctrl elsewhere. */
export type KeyModifier = 'mod' | 'control' | 'shift' | 'alt';

/**
 * The e2e helpers the suites share, bound to a suite's current app and chrome page (getters, as
 * suites relaunch). Everything acts through main (`app.evaluate`) or the chrome page; nothing here
 * is a production test hook.
 */
export function chromeHelpers(getApp: () => ElectronApplication, getPage: () => Page) {
  const app = (): ElectronApplication => getApp();
  const page = (): Page => getPage();

  /** Every live browse-session WebContents (the tabs' pages), as main sees them. */
  const browseContents = (): Promise<{ id: number; url: string }[]> =>
    app().evaluate(({ session, webContents }, partition) => {
      const browse = session.fromPartition(partition);
      return webContents
        .getAllWebContents()
        .filter((c) => !c.isDestroyed() && c.session === browse)
        .map((c) => ({ id: c.id, url: c.getURL() }));
    }, BROWSE_PARTITION);

  /** The WebContents id showing `url`, once exactly one does. */
  const contentsIdAt = async (url: string): Promise<number> => {
    await expect.poll(async () => (await browseContents()).filter((c) => c.url === url).length).toBe(1);
    return (await browseContents()).find((c) => c.url === url)!.id;
  };

  /** WebContents ids of the views attached to the app window's contentView (all visible ones). */
  const attachedViewIds = (): Promise<number[]> =>
    app().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) => (child as Electron.WebContentsView).webContents.id),
    );

  /** Clicks an application-menu item in main, as its accelerator would. */
  const menu = async (id: string): Promise<void> => {
    await app().evaluate(({ Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (!item) throw new Error(`no menu item ${id}`);
      item.click();
    }, id);
  };

  /** Runs `script` in a tab (`webContents.executeJavaScript`, which waits for a loading page); resolves its value. */
  const run = (id: number, script: string): Promise<unknown> =>
    app().evaluate(({ webContents }, { id, script }) => webContents.fromId(id)!.executeJavaScript(script) as Promise<unknown>, { id, script });

  /**
   * Runs `script` in a tab's main frame, or in its first subframe whose URL starts with
   * `framePrefix` (`WebFrameMain.executeJavaScript`, which does not wait for a load); resolves its
   * (awaited) value.
   */
  const runInFrame = (id: number, script: string, framePrefix?: string): Promise<unknown> =>
    app().evaluate(
      ({ webContents }, { id, script, framePrefix }) => {
        const main = webContents.fromId(id)!.mainFrame;
        const frame = framePrefix === undefined ? main : main.frames.find((f) => f.url.startsWith(framePrefix));
        if (!frame) throw new Error(`no frame at ${framePrefix}`);
        return frame.executeJavaScript(script) as Promise<unknown>;
      },
      { id, script, framePrefix },
    );

  const urlOf = (id: number): Promise<string> => app().evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), id);

  /** A real click (trusted `input-event`s, so a user gesture) at the centre of `selector` in a tab. */
  const realClick = async (id: number, selector: string, button: 'left' | 'right' = 'left'): Promise<void> => {
    const [x, y] = (await run(
      id,
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`,
    )) as [number, number];
    await app().evaluate(
      ({ webContents }, { id, x, y, button }) => {
        const contents = webContents.fromId(id)!;
        contents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
      },
      { id, x, y, button },
    );
  };

  /** Sends a real key press (down + up) to a tab's or the chrome's WebContents; it passes through `before-input-event`. */
  const press = async (target: number | 'chrome', keyCode: string, modifiers: KeyModifier[] = []): Promise<void> => {
    await app().evaluate(
      ({ BrowserWindow, webContents }, { target, keyCode, modifiers }) => {
        const contents = target === 'chrome' ? BrowserWindow.getAllWindows()[0]!.webContents : webContents.fromId(target)!;
        const mods = modifiers.map((m) => (m === 'mod' ? (process.platform === 'darwin' ? 'meta' : 'control') : m));
        contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods });
        contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods });
      },
      { target, keyCode, modifiers },
    );
  };

  const strip = () => page().getByTestId('tab');
  const activeTab = () => page().locator('[data-testid="tab"][aria-selected="true"]');
  const address = () => page().getByTestId('address');

  /** Types `input` into the address bar and presses Enter. */
  const go = async (input: string): Promise<void> => {
    await address().click();
    await address().fill(input);
    await address().press('Enter');
  };

  /**
   * A barrier: once this returns, the chrome has rendered a browser state main took after
   * everything that happened before the call (it asks main to focus the address bar, which bumps the
   * state's version, and waits for the chrome to do it).
   */
  const chromeCaughtUp = async (): Promise<void> => {
    await page().evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await menu('focus-address-bar');
    await expect(address()).toBeFocused();
  };

  /** Closes every tab (the last close leaves one fresh empty tab) and waits until no page is left. */
  const closeAllTabs = async (): Promise<void> => {
    const count = await strip().count();
    for (let i = 0; i < count; i++) await menu('close-tab');
    await expect(strip()).toHaveCount(1);
    await expect(activeTab()).toHaveAttribute('title', NEW_TAB_LABEL);
    await expect.poll(browseContents).toEqual([]);
  };

  return { browseContents, contentsIdAt, attachedViewIds, menu, run, runInFrame, urlOf, realClick, press, strip, activeTab, address, go, chromeCaughtUp, closeAllTabs };
}
