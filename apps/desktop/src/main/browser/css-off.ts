import { TAB_OVERRIDES_WORLD_ID } from '@app/specs/render-profile.spec';

// CSS off, a tab override (spec `render-profile.feature.md`, Page writes and Tab overrides; Phase 11
// Task 6, Decision 8). The one emulation that writes to the page: a self-contained script run in
// `TAB_OVERRIDES_WORLD_ID`, in the tab's **top frame** only, sets `disabled` on the document's
// stylesheets and adopted sheets, and keeps doing so for sheets that appear later (a
// `MutationObserver`, a capturing `load` listener for sheets that finish loading, a periodic sweep
// for adopted sheets) until it is turned off, which re-enables exactly the sheets it disabled. It
// adds no element or attribute. Inline `style` attributes, shadow roots' and frames' styles stay.
// Isolated worlds run under JavaScript off, so it works there too. Its state lives on the world's own
// global (invisible to the page). The page can observe the `disabled` flags.

/** Where the script keeps its state on the world's global. */
export const CSS_OFF_STATE_KEY = '__frostCssOff';

/** How often the script looks for adopted sheets the page set (no event tells it). */
export const CSS_OFF_SWEEP_MS = 1_000;

interface Sheet {
  disabled: boolean;
}

/** The parts of a document the script uses (a DOM `Document`; a fake in tests). */
export interface CssOffDocument {
  readonly styleSheets: ArrayLike<unknown> & Iterable<unknown>;
  readonly adoptedStyleSheets?: ArrayLike<unknown> & Iterable<unknown>;
  readonly defaultView: unknown;
  addEventListener(type: string, listener: (event: { target: unknown }) => void, capture: boolean): void;
  removeEventListener(type: string, listener: (event: { target: unknown }) => void, capture: boolean): void;
}

/**
 * The page side (serialised whole: it uses nothing outside its own body). `off`: disable every sheet
 * and watch for new ones (idempotent on one document); else re-enable the sheets it disabled and stop
 * watching. Answers how many sheets it holds disabled (`off`) or re-enabled (not `off`).
 */
export function cssOffPage(document: CssOffDocument, store: Record<string, unknown>, key: string, off: boolean, sweepMs: number): number {
  interface State {
    readonly held: Sheet[];
    readonly stop: () => void;
  }
  const isSheet = (value: unknown): value is Sheet => typeof value === 'object' && value !== null && 'disabled' in value;
  const existing = store[key] as State | undefined;
  if (!off) {
    if (!existing) return 0;
    existing.stop();
    delete store[key];
    let count = 0;
    for (const sheet of existing.held) {
      try {
        sheet.disabled = false;
        count += 1;
      } catch {
        // A sheet that went away with its element.
      }
    }
    return count;
  }
  const state: State = existing ?? { held: [], stop: () => undefined };
  const disable = (value: unknown): void => {
    if (!isSheet(value) || value.disabled) return;
    try {
      value.disabled = true;
      if (state.held.indexOf(value) < 0) state.held.push(value);
    } catch {
      // A sheet the engine will not change.
    }
  };
  const sweep = (): void => {
    for (const sheet of Array.from(document.styleSheets)) disable(sheet);
    const adopted = document.adoptedStyleSheets;
    if (adopted) for (const sheet of Array.from(adopted)) disable(sheet);
  };
  if (!existing) {
    const view = document.defaultView as {
      MutationObserver?: new (callback: () => void) => { observe(target: unknown, options: object): void; disconnect(): void };
      setInterval?: (fn: () => void, ms: number) => unknown;
      clearInterval?: (id: unknown) => void;
    } | null;
    const Observer = view?.MutationObserver;
    const observer = Observer ? new Observer(sweep) : null;
    observer?.observe(document, { childList: true, subtree: true });
    const onLoad = (event: { target: unknown }): void => {
      const target = event.target as { sheet?: unknown } | null;
      if (target && typeof target === 'object') disable(target.sheet);
      sweep();
    };
    document.addEventListener('load', onLoad, true);
    const timer = view?.setInterval ? view.setInterval(sweep, sweepMs) : null;
    store[key] = {
      held: state.held,
      stop: () => {
        observer?.disconnect();
        document.removeEventListener('load', onLoad, true);
        if (timer !== null) view?.clearInterval?.(timer);
      },
    } satisfies State;
  }
  sweep();
  return state.held.length;
}

/** The script that turns CSS off (`off`) or back on in a document, run in `TAB_OVERRIDES_WORLD_ID`. */
export function cssOffScript(off: boolean): string {
  return `(${cssOffPage.toString()})(document, globalThis, ${JSON.stringify(CSS_OFF_STATE_KEY)}, ${off ? 'true' : 'false'}, ${CSS_OFF_SWEEP_MS})`;
}

/** What `runCssOff` needs of a tab's WebContents (its top frame). */
export interface CssOffTarget {
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[]): Promise<unknown>;
}

/**
 * Runs the script in the tab's top frame (`TAB_OVERRIDES_WORLD_ID`); answers whether the page answered
 * a count (the page can answer anything). Never rejects or throws.
 */
export async function runCssOff(target: CssOffTarget, off: boolean): Promise<boolean> {
  try {
    const answer = await target.executeJavaScriptInIsolatedWorld(TAB_OVERRIDES_WORLD_ID, [{ code: cssOffScript(off) }]);
    return typeof answer === 'number' && Number.isSafeInteger(answer) && answer >= 0;
  } catch {
    return false;
  }
}
