import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type {
  BrowserWindowConstructorOptions,
  DevicePermissionHandlerHandlerDetails,
  HandlerDetails,
  CallbackResponse,
  OnBeforeRequestListenerDetails,
  OnHeadersReceivedListenerDetails,
  HeadersReceivedResponse,
  WebRequestFilter,
  WebPreferences,
  WindowOpenHandlerResponse,
} from 'electron';

/**
 * Minimal Node-side stand-in for the `electron` module, for unit tests that run under Vitest
 * (not Electron). Records BrowserWindow constructor options so tests can assert on them.
 * `getLastWebPreferences()` just echoes the constructor options, so effective prefs are asserted
 * against real Electron in the Playwright e2e suite (Task 4).
 *
 * WebContents and `app` are real EventEmitters (as in Electron), so tests drive them with `emit`;
 * Session handlers are stored as-is so tests can invoke exactly what the code registered.
 *
 * Usage: `vi.mock('electron', async () => (await import('../../test/electron-fake')).electronFake());`
 */
export class FakeWebContents extends EventEmitter {
  static instances: FakeWebContents[] = [];

  windowOpenHandler: ((details: HandlerDetails) => WindowOpenHandlerResponse) | undefined;
  setWindowOpenHandler = vi.fn((handler: (details: HandlerDetails) => WindowOpenHandlerResponse) => {
    this.windowOpenHandler = handler;
  });
  readonly getLastWebPreferences: () => WebPreferences;

  constructor(webPreferences: WebPreferences = {}) {
    super();
    this.getLastWebPreferences = () => ({ ...webPreferences });
    FakeWebContents.instances.push(this);
  }

  /**
   * Simulates a renderer-initiated navigation as Electron 45 emits it: `will-frame-navigate` for any
   * frame (details object only), then — main frame only, and only if not prevented —
   * `will-navigate` (details plus the deprecated positional args). Returns whether it was prevented.
   */
  simulateNavigation(url: string, { isMainFrame = true }: { isMainFrame?: boolean } = {}): boolean {
    const frameDetails = navigationDetails(url, isMainFrame);
    this.emit('will-frame-navigate', frameDetails);
    if (frameDetails.defaultPrevented || !isMainFrame) return frameDetails.defaultPrevented;
    const details = navigationDetails(url, isMainFrame);
    this.emit('will-navigate', details, url, false, isMainFrame, 1, 1);
    return details.defaultPrevented;
  }

  /** Simulates a server redirect (`will-redirect`, any frame). Returns whether it was prevented. */
  simulateRedirect(url: string, { isMainFrame = true }: { isMainFrame?: boolean } = {}): boolean {
    const details = navigationDetails(url, isMainFrame);
    this.emit('will-redirect', details, url, false, isMainFrame, 1, 1);
    return details.defaultPrevented;
  }
}

function navigationDetails(url: string, isMainFrame: boolean) {
  return fakeEvent({ url, isMainFrame, isSameDocument: false, frame: null, initiator: null });
}

export class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  static getAllWindows = () => [...FakeBrowserWindow.instances];

  readonly options: BrowserWindowConstructorOptions;
  readonly webContents: FakeWebContents;
  loadURL = vi.fn(async (_url: string) => {});
  loadFile = vi.fn(async (_path: string) => {});
  on = vi.fn();
  once = vi.fn();

  constructor(options: BrowserWindowConstructorOptions = {}) {
    this.options = options;
    this.webContents = new FakeWebContents(options.webPreferences);
    FakeBrowserWindow.instances.push(this);
  }
}

type PermissionRequestHandler = (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void;
type PermissionCheckHandler = (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean;
type DevicePermissionHandler = (details: DevicePermissionHandlerHandlerDetails) => boolean;
type HeadersReceivedListener = (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void;
type BeforeRequestListener = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void;

export class FakeSession {
  permissionRequestHandler: PermissionRequestHandler | null | undefined;
  permissionCheckHandler: PermissionCheckHandler | null | undefined;
  devicePermissionHandler: DevicePermissionHandler | null | undefined;
  headersReceivedListener: HeadersReceivedListener | null | undefined;
  beforeRequest: { filter: WebRequestFilter; listener: BeforeRequestListener } | null | undefined;

  setPermissionRequestHandler = vi.fn((handler: PermissionRequestHandler | null) => {
    this.permissionRequestHandler = handler;
  });
  setPermissionCheckHandler = vi.fn((handler: PermissionCheckHandler | null) => {
    this.permissionCheckHandler = handler;
  });
  setDevicePermissionHandler = vi.fn((handler: DevicePermissionHandler | null) => {
    this.devicePermissionHandler = handler;
  });
  // Like Electron, a session holds one listener per webRequest event; registering again replaces it.
  readonly webRequest = {
    onHeadersReceived: vi.fn((listener: HeadersReceivedListener | null) => {
      this.headersReceivedListener = listener;
    }),
    onBeforeRequest: vi.fn((filter: WebRequestFilter, listener: BeforeRequestListener | null) => {
      this.beforeRequest = listener ? { filter, listener } : null;
    }),
  };
}

/** An Electron-style event object for listener tests: records `preventDefault()`. */
export function fakeEvent<T extends object>(fields: T = {} as T): T & { preventDefault: () => void; defaultPrevented: boolean } {
  const event = {
    ...fields,
    defaultPrevented: false,
    preventDefault: vi.fn(() => {
      event.defaultPrevented = true;
    }),
  };
  return event;
}

export function electronFake() {
  FakeBrowserWindow.instances = [];
  FakeWebContents.instances = [];
  const app = Object.assign(new EventEmitter(), {
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    enableSandbox: vi.fn(),
    isPackaged: false,
  });
  const shell = { openExternal: vi.fn(async (_url: string) => {}) };
  const session = { defaultSession: new FakeSession() };
  const protocol = { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() };
  const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
  const electron = { app, BrowserWindow: FakeBrowserWindow, shell, session, protocol, ipcMain };
  return { ...electron, default: electron };
}
