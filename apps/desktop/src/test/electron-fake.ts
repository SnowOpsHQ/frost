import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type {
  BrowserWindowConstructorOptions,
  WebContentsViewConstructorOptions,
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
  /** The WebContents' session, as `contents.session` (undefined unless a test gives one). */
  readonly session: FakeSession | undefined;

  constructor(webPreferences: WebPreferences = {}, session?: FakeSession) {
    super();
    this.getLastWebPreferences = () => ({ ...webPreferences });
    this.session = session;
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

/** `WebContentsView`: records its constructor options; its WebContents is on the partition's session. */
export class FakeWebContentsView {
  static instances: FakeWebContentsView[] = [];

  readonly options: WebContentsViewConstructorOptions;
  readonly webContents: FakeWebContents;
  setBounds = vi.fn();
  setVisible = vi.fn();
  setBackgroundColor = vi.fn();

  constructor(options: WebContentsViewConstructorOptions = {}) {
    this.options = options;
    const partition = options.webPreferences?.partition;
    this.webContents = new FakeWebContents(options.webPreferences, partition === undefined ? undefined : fromPartition(partition));
    FakeWebContentsView.instances.push(this);
  }
}

type PermissionRequestHandler = (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void;
type PermissionCheckHandler = (webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean;
type DevicePermissionHandler = (details: DevicePermissionHandlerHandlerDetails) => boolean;
type HeadersReceivedListener = (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void;
type BeforeRequestListener = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void;

/** A session: an EventEmitter (as in Electron, e.g. `will-download`) that stores its handlers as-is. */
export class FakeSession extends EventEmitter {
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
  /** `session.protocol.handle` registrations, by scheme. */
  readonly protocolHandlers = new Map<string, (request: Request) => Response | Promise<Response>>();
  readonly protocol = {
    handle: vi.fn((scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
      this.protocolHandlers.set(scheme, handler);
    }),
  };
  /** Clear Browsing Data (`clear-browsing-data.ts`). */
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
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

const partitions = new Map<string, FakeSession>();

/** `session.fromPartition`: one FakeSession per partition name, for the life of the fake. */
export function fromPartition(partition: string): FakeSession {
  let found = partitions.get(partition);
  if (!found) {
    found = new FakeSession();
    partitions.set(partition, found);
  }
  return found;
}

export function electronFake() {
  FakeBrowserWindow.instances = [];
  FakeWebContents.instances = [];
  FakeWebContentsView.instances = [];
  partitions.clear();
  const app = Object.assign(new EventEmitter(), {
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    enableSandbox: vi.fn(),
    isPackaged: false,
  });
  const shell = { openExternal: vi.fn(async (_url: string) => {}) };
  const session = { defaultSession: new FakeSession(), fromPartition: vi.fn(fromPartition) };
  const protocol = { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() };
  const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
  // `Menu`: a built menu is just its template; the application menu is remembered.
  let applicationMenu: { template: unknown } | null = null;
  const Menu = {
    buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    setApplicationMenu: vi.fn((menu: { template: unknown } | null) => {
      applicationMenu = menu;
    }),
    getApplicationMenu: vi.fn(() => applicationMenu),
  };
  // `dialog.showMessageBox`: answers Cancel (button 1) unless a test says otherwise.
  const dialog = { showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1, checkboxChecked: false })) };
  const electron = { app, BrowserWindow: FakeBrowserWindow, WebContentsView: FakeWebContentsView, Menu, shell, session, protocol, ipcMain, dialog };
  return { ...electron, default: electron };
}
