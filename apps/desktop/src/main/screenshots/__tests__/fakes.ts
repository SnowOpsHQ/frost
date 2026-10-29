import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSessionStore, type SessionStore } from '@app/db';
import type { AuditRenderProfile, RenderProfile } from '@app/specs/render-profile.spec';
import { cancelAreaScript, measureScript, restoreScroll, scrollAndSettle, selectAreaScript, type PageMeasure } from '../page-script';
import type { CapturedImage, ScreenshotTarget } from '../capture';
import type { Bitmap, ScreenshotImaging } from '../imaging';
import { createScreenshotsService, type MainScreenshotsService, type ScreenshotsServiceDeps } from '../service';
import { createScreenshotFiles, type ScreenshotFiles } from '../store';

// Screenshot fixtures: a tab's WebContents that answers the screenshot scripts like a page would,
// and captures a document whose every pixel row says which document row it is.

/** A BGRA bitmap `width` wide whose row r is pixel-coded with document row `r + offset`: (row & 255, row >> 8, 9, 255). */
export function documentRows(width: number, height: number, offset: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let r = 0; r < height; r++) {
    const row = r + offset;
    for (let c = 0; c < width; c++) out.set([row & 255, (row >> 8) & 255, 9, 255], (r * width + c) * 4);
  }
  return out;
}

/** The document row a composed bitmap shows at pixel (x, y). */
export const rowAt = (bitmap: Buffer, width: number, x: number, y: number): number => bitmap[(y * width + x) * 4]! + bitmap[(y * width + x) * 4 + 1]! * 256;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** What a script is, by the function it serialises (`page-script.ts`), and its JSON arguments. */
function scriptOf(code: string): { kind: 'measure' | 'scroll' | 'restore' | 'select' | 'cancel' | 'other'; args: Record<string, number> } {
  if (code === measureScript()) return { kind: 'measure', args: {} };
  if (code === selectAreaScript()) return { kind: 'select', args: {} };
  if (code === cancelAreaScript()) return { kind: 'cancel', args: {} };
  const args = /, (\{[^}]*\})\)$/.exec(code)?.[1];
  const parsed = args ? (JSON.parse(args) as Record<string, number>) : {};
  if (code.includes(`function ${restoreScroll.name}(`)) return { kind: 'restore', args: parsed };
  if (code.includes(`function ${scrollAndSettle.name}(`)) return { kind: 'scroll', args: parsed };
  return { kind: 'other', args: {} };
}

export interface FakePage {
  url: string;
  scrollHeight: number;
  innerWidth: number;
  innerHeight: number;
  clientWidth: number;
  clientHeight: number;
  devicePixelRatio: number;
  /** View pixels per CSS px (device emulation can make it differ from `devicePixelRatio`). */
  scale: number;
}

/** A tab's WebContents: scripts answered as the page would, captures of the document at its scroll position. */
export class FakeTab extends EventEmitter implements ScreenshotTarget {
  page: FakePage;
  scroll = { x: 0, y: 0 };
  destroyed = false;
  focused = 0;
  readonly scripts: { world: number; kind: string; args: Record<string, number> }[] = [];
  /** The pending area selection's answer (resolved by the test, or `null` by the cancel script). */
  selection: Deferred<unknown> | null = null;
  /** Called before each capture (a test can stall or fail it). */
  beforeCapture: (() => Promise<void> | void) | null = null;
  /** Answers instead of the page (a test's hostile or failing page). */
  override: ((kind: string) => unknown) | null = null;
  /** Clamps scrolls like a page that will not move past `maxScroll` (`null`: the document's bottom). */
  stuckAt: number | null = null;
  captures = 0;

  constructor(page: Partial<FakePage> = {}) {
    super();
    this.page = { url: 'https://example.com/page', scrollHeight: 250, innerWidth: 115, innerHeight: 80, clientWidth: 100, clientHeight: 80, devicePixelRatio: 2, scale: 2, ...page };
  }

  getURL(): string {
    return this.page.url;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  focus(): void {
    this.focused += 1;
  }

  async executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<unknown> {
    const { kind, args } = scriptOf(scripts[0]!.code);
    this.scripts.push({ world, kind, args });
    if (this.override) {
      const answer = this.override(kind);
      if (answer !== undefined) return answer instanceof Error ? Promise.reject(answer) : answer;
    }
    const { page } = this;
    switch (kind) {
      case 'measure': {
        const measure: PageMeasure = { url: page.url, scrollHeight: page.scrollHeight, innerWidth: page.innerWidth, innerHeight: page.innerHeight, clientWidth: page.clientWidth, clientHeight: page.clientHeight, scrollX: this.scroll.x, scrollY: this.scroll.y, devicePixelRatio: page.devicePixelRatio };
        return measure;
      }
      case 'scroll':
      case 'restore': {
        const max = this.stuckAt ?? Math.max(0, page.scrollHeight - page.clientHeight);
        // As a browser does, the position snaps to whole device pixels.
        const y = Math.max(0, Math.min(max, args['y'] ?? 0));
        this.scroll = { x: args['x'] ?? 0, y: Math.round(y * page.scale) / page.scale };
        return { ...this.scroll };
      }
      case 'select':
        this.selection = deferred<unknown>();
        return this.selection.promise;
      case 'cancel': {
        const pending = this.selection;
        this.selection = null;
        pending?.resolve(null);
        return pending !== null;
      }
      default:
        return undefined;
    }
  }

  async capturePage(): Promise<CapturedImage> {
    this.captures += 1;
    await this.beforeCapture?.();
    const width = Math.round(this.page.innerWidth * this.page.scale);
    const height = Math.round(this.page.innerHeight * this.page.scale);
    const bitmap = documentRows(width, height, Math.round(this.scroll.y * this.page.scale));
    // A horizontal scrollbar under the page (`clientHeight` below `innerHeight`): its rows are not the document's.
    const client = Math.round(this.page.clientHeight * this.page.scale);
    for (let r = client; r < height; r++) bitmap.fill(255, r * width * 4, (r + 1) * width * 4);
    return { isEmpty: () => false, getScaleFactors: () => [1], getSize: () => ({ width, height }), toBitmap: () => Buffer.from(bitmap) };
  }
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Imaging without Electron: a "PNG" that names its size and the bitmap's hash; renders and copies recorded. */
export function fakeImaging(): ScreenshotImaging & { copied: Buffer[]; encoded: Bitmap[]; renders: string[] } {
  const copied: Buffer[] = [];
  const encoded: Bitmap[] = [];
  const renders: string[] = [];
  return {
    copied,
    encoded,
    renders,
    thumbnail: (bitmap) => Buffer.from(`thumb:PNG ${bitmap.width}x${bitmap.height}`),
    encodePng: (bitmap) => {
      encoded.push(bitmap);
      return Buffer.from(`PNG ${bitmap.width}x${bitmap.height} ${sha(bitmap.bitmap)}`);
    },
    render: (png, size, maxBytes) => {
      renders.push(size);
      const data = Buffer.from(`${size}:${png.toString()}`);
      return png.subarray(0, 4).toString() === 'PNG ' && data.length <= maxBytes ? { type: size === 'thumb' ? 'image/png' : 'image/jpeg', data } : null;
    },
    copy: async (png) => {
      if (png.subarray(0, 4).toString() !== 'PNG ') return false;
      copied.push(png);
      return true;
    },
  };
}

// ---- A service over a real session store and file store, with fake tabs ---------------------------

export interface ServiceSetup {
  readonly service: MainScreenshotsService;
  readonly opened: SessionStore;
  /** A second, read-only connection to look at the rows. */
  readonly raw: DatabaseSync;
  readonly userData: string;
  readonly files: ScreenshotFiles;
  readonly imaging: ReturnType<typeof fakeImaging>;
  readonly tabs: Map<number, FakeTab>;
  readonly state: { active: number | null; profiles: Map<number, RenderProfile | AuditRenderProfile | null> };
  readonly logs: string[];
  readonly revealed: string[];
  readonly cleanup: () => Promise<void>;
}

/** Tabs 1 and 2 open (1 active) on web pages, a real session store and file store in a fresh profile. */
export function serviceSetup(deps: Partial<ScreenshotsServiceDeps> = {}): ServiceSetup {
  const userData = mkdtempSync(path.join(tmpdir(), 'frost-shots-service-'));
  const opened = openSessionStore({ dir: userData });
  const raw = new DatabaseSync(opened.file, { readOnly: true });
  const files = createScreenshotFiles(userData);
  const imaging = fakeImaging();
  const tabs = new Map<number, FakeTab>([
    [1, new FakeTab()],
    [2, new FakeTab({ url: 'https://example.com/other' })],
  ]);
  const state = { active: 1 as number | null, profiles: new Map<number, RenderProfile | AuditRenderProfile | null>() };
  const logs: string[] = [];
  const revealed: string[] = [];
  let clock = 1_700_000_000_000;
  const service = createScreenshotsService({
    store: opened.changeIntel,
    files,
    imaging,
    tabs: {
      activeTabId: () => state.active,
      contentsOf: (tabId) => {
        const tab = tabs.get(tabId);
        return tab && !tab.destroyed ? tab : null;
      },
      // A bare profile is a whole one (an `active` profile the page loaded under).
      renderProfileOf: (tabId) => {
        const profile = state.profiles.get(tabId) ?? null;
        return profile === null ? null : 'partial' in profile ? profile : { profile, partial: false };
      },
    },
    reveal: (file) => revealed.push(file),
    now: () => (clock += 1_000),
    log: (line) => logs.push(line),
    activePollMs: 10,
    ...deps,
  });
  const cleanup = async (): Promise<void> => {
    raw.close();
    // Closed before the directory goes: Windows refuses to delete an open file.
    await opened.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { service, opened, raw, userData, files, imaging, tabs, state, logs, revealed, cleanup };
}

/** Resolves once `check` holds (polling), or fails after `ms`. */
export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
