// Plain fakes of a tab view, its WebContents and the app window, for the browser controller's
// unit tests (`controller.test.ts`, `session.test.ts`). Tests set the fields, then emit the
// Electron events that report them.
import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { fakeEvent } from './electron-fake';

/** A tab's WebContents: tests set the fields, then emit the Electron event that reports them. */
export class FakeTabContents extends EventEmitter {
  url = '';
  title = '';
  loading = false;
  back = false;
  forward = false;
  // Like Electron, the URL changes only when a navigation commits (tests emit `did-navigate`).
  loadURL = vi.fn(async (_url: string) => {});
  getURL = () => this.url;
  getTitle = () => this.title;
  isLoading = () => this.loading;
  reload = vi.fn();
  reloadIgnoringCache = vi.fn();
  stop = vi.fn();
  /** Like Chromium, the zoom factor (per host there: tests set it on each tab of a host). */
  zoomFactor = 1;
  getZoomFactor = () => this.zoomFactor;
  setZoomFactor = vi.fn((factor: number) => {
    this.zoomFactor = factor;
  });
  focus = vi.fn();
  /** Whether the page has keyboard focus (the command palette records it: `command-palette.spec.ts`). */
  focused = false;
  isFocused = () => this.focused;
  executeJavaScriptInIsolatedWorld = vi.fn(async (_worldId: number, _scripts: { code: string }[]) => undefined);
  destroyed = false;
  /** Like Electron's `webContents.close()` (no beforeunload wait): the WebContents is destroyed. */
  close = vi.fn(() => {
    if (!this.destroyed) this.destroy();
  });
  isDestroyed = () => this.destroyed;
  /** What Electron does when the page calls `window.close()`: the WebContents is destroyed. */
  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
  readonly navigationHistory = {
    canGoBack: () => this.back,
    canGoForward: () => this.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
}

export class FakeTabView {
  /** The view's WebContents, kept for tests after it is destroyed. */
  readonly contents = new FakeTabContents();
  /** Like Electron: a view's `webContents` is gone once it is destroyed (already in `destroyed` listeners). */
  get webContents(): FakeTabContents {
    return (this.contents.destroyed ? undefined : this.contents) as FakeTabContents;
  }
  setBounds = vi.fn();
  setVisible = vi.fn();
}

export class FakeHostWindow extends EventEmitter {
  size: [number, number] = [1280, 800];
  title = '';
  /** Like Electron's `View`: tracks its children (adding a child again moves it to the top). */
  readonly contentView = {
    children: [] as unknown[],
    addChildView: vi.fn((child: unknown) => {
      this.contentView.children = [...this.contentView.children.filter((c) => c !== child), child];
    }),
    removeChildView: vi.fn((child: unknown) => {
      this.contentView.children = this.contentView.children.filter((c) => c !== child);
    }),
  };
  /** The chrome's own WebContents. */
  readonly webContents = Object.assign(new EventEmitter(), { focus: vi.fn() });
  getContentSize = () => [...this.size];
  setTitle = vi.fn((title: string) => {
    this.title = title;
  });
  /** OS fullscreen, as Electron sets it when a page enters HTML fullscreen. */
  fullScreen = false;
  isFullScreen = () => this.fullScreen;
  setFullScreen = vi.fn((flag: boolean) => {
    this.fullScreen = flag;
  });
  isDestroyed = () => false;
}

/** Navigates and commits `url` with `title` as Electron reports it. */
export function commit(contents: FakeTabContents, url: string, title: string, { back = false, forward = false } = {}) {
  contents.loading = true;
  contents.emit('did-start-loading');
  contents.url = url;
  contents.back = back;
  contents.forward = forward;
  contents.emit('did-navigate', fakeEvent(), url, 200, 'OK');
  contents.title = title;
  contents.emit('page-title-updated', fakeEvent(), title, false);
  contents.loading = false;
  contents.emit('did-stop-loading');
}
