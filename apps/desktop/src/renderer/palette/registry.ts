import type { SeoAudit, SeoAuditResponse } from '@app/seo-core';
// Type-only from browser.spec (its Zod schemas must stay out of this bundle: strict Trusted Types).
import type { BrowserState, TabState } from '@app/specs/browser.spec';
import { PALETTE_ACTION_ID_MAX, PALETTE_ACTION_ID_PATTERN, PALETTE_GROUPS, type PaletteGroupId } from '@app/specs/command-palette.spec';
import type { SeoPanelId } from '@app/specs/seo-sidebar.spec';

// The command palette's action registry (spec `command-palette.spec.ts`, Registration API;
// acceptance `command-palette.feature.md`, Registry). Pure: no React, no IPC. Features register
// their actions here with one call (`registerPaletteActions`), at module load; the palette asks the
// registry for the actions available in the current context each time it renders its list.

/** Glyphs the palette draws for an action (`palette/icons.tsx`); without one, its group's. */
export const PALETTE_ICON_NAMES = [
  'panel',
  'panel-overview',
  'panel-on-page',
  'panel-content',
  'render-profile',
  'panel-links',
  'panel-images',
  'panel-social',
  'panel-schema',
  'panel-indexability',
  'panel-speed',
  'panel-compliance',
  'panel-javascript',
  'panel-serp',
  'panel-visibility',
  'panel-search-console',
  'sidebar',
  'highlight',
  'audit',
  'accessibility',
  'copy',
  'code',
  'external',
  'robot',
  'sitemap',
  'reload',
  'stop',
  'back',
  'forward',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'tab-new',
  'tab-close',
  'tab-switch',
  'clear',
  'panel-changes',
  'panel-inspector',
] as const;
export type PaletteIconName = (typeof PALETTE_ICON_NAMES)[number];

/** A shortcut in the spec notation (`Mod+Shift+R`), or one per platform. */
export type PaletteShortcut = string | { readonly mac: string; readonly other: string };

/** Chrome-side commands handlers may use (the chrome owns the sidebar's state). */
export interface PaletteChrome {
  /** Opens the SEO sidebar on `panel`; `focus` moves keyboard focus to that panel's rail item. */
  openPanel(panel: SeoPanelId, options?: { readonly focus?: boolean }): void;
  setSidebarOpen(open: boolean): void;
}

/** What predicates and handlers see: the browser state, the active tab, its shown audit, the sidebar. */
export interface PaletteContext {
  readonly state: BrowserState | null;
  /** The active tab (`undefined` before the first state). */
  readonly tab: TabState | undefined;
  /** The active tab's audit as the sidebar shows it (`null`: an empty tab, or none yet). */
  readonly audit: SeoAuditResponse | null;
  readonly sidebarOpen: boolean;
  readonly chrome: PaletteChrome;
}

/** A request to open the SEO sidebar on a panel (`PaletteChrome.openPanel`); `seq` makes each one new. */
export interface PanelJump {
  readonly panel: SeoPanelId;
  readonly focus: boolean;
  readonly seq: number;
}

/**
 * A question the palette asks, inline, before running an action (an "Open in" tool's first use of a
 * host): `message`, an optional `note`, and the button that runs it. `accept` is called when the
 * user confirms (the action remembers the answer there); going back runs nothing.
 */
export interface PaletteConfirm {
  readonly message: string;
  readonly note?: string | null;
  readonly confirmLabel: string;
  readonly accept: () => void;
}

/** A handler's answer: a short status line (frost's own words) to show after the palette closed, or nothing. */
export type PaletteOutcome = string | null | undefined | void;

export interface PaletteAction {
  /** Unique and stable (recent actions are stored by id): `PALETTE_ACTION_ID_PATTERN`. */
  readonly id: string;
  /** frost's own words, never page text. */
  readonly label: string;
  readonly group: PaletteGroupId;
  /** More words the search matches (ranked below a label match). */
  readonly keywords?: readonly string[];
  readonly icon?: PaletteIconName;
  readonly shortcut?: PaletteShortcut;
  /** A second line (a host, a value preview): rendered as inert, bidi-isolated text. */
  readonly detail?: (ctx: PaletteContext) => string | null;
  /**
   * `restore` (the default): closing the palette puts focus back where it was before the handler
   * runs. `handler`: the handler moves focus itself (a new tab, a panel jump), so nothing is restored.
   */
  readonly focus?: 'restore' | 'handler';
  /** A question to ask first, or `null` to run at once (see `PaletteConfirm`). */
  readonly confirm?: (ctx: PaletteContext) => PaletteConfirm | null;
  /** Whether it is offered now; without one, always. A predicate that throws leaves it out. */
  readonly available?: (ctx: PaletteContext) => boolean;
  readonly run: (ctx: PaletteContext) => PaletteOutcome | Promise<PaletteOutcome>;
}

/** What `register` takes: an action, or a function answering the actions for the current context. */
export type PaletteSource = PaletteAction | ((ctx: PaletteContext) => readonly PaletteAction[]);

export interface PaletteRegistry {
  /** Registers `sources` (in order); answers a function that unregisters exactly them. Throws on a bad or duplicate static action. */
  register(...sources: PaletteSource[]): () => void;
  /** The actions available in `ctx`, in registration order (dynamic sources expanded in place). */
  resolve(ctx: PaletteContext): PaletteAction[];
  /** The ids of every registered static action. */
  ids(): string[];
}

const GROUP_IDS: ReadonlySet<string> = new Set(PALETTE_GROUPS.map((group) => group.id));

/** Why `action` is not a well-formed action, or `null`. */
function problem(action: PaletteAction): string | null {
  if (typeof action !== 'object' || action === null) return 'not an action';
  if (typeof action.id !== 'string' || action.id.length > PALETTE_ACTION_ID_MAX || !PALETTE_ACTION_ID_PATTERN.test(action.id)) return `bad id ${JSON.stringify(action.id)}`;
  if (typeof action.label !== 'string' || action.label.trim() === '') return `${action.id}: empty label`;
  if (!GROUP_IDS.has(action.group)) return `${action.id}: unknown group ${JSON.stringify(action.group)}`;
  if (typeof action.run !== 'function') return `${action.id}: no handler`;
  return null;
}

/** Whether `action` is offered in `ctx` (a throwing predicate: no). */
function isAvailable(action: PaletteAction, ctx: PaletteContext): boolean {
  if (!action.available) return true;
  try {
    return action.available(ctx) === true;
  } catch {
    return false;
  }
}

export function createPaletteRegistry(): PaletteRegistry {
  // Each registration keeps its own entry, so unregistering removes exactly what it added.
  const entries: { readonly source: PaletteSource }[] = [];

  const staticIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const { source } of entries) if (typeof source !== 'function') ids.add(source.id);
    return ids;
  };

  return {
    register(...sources) {
      const taken = staticIds();
      for (const source of sources) {
        if (typeof source === 'function') continue;
        const bad = problem(source);
        if (bad !== null) throw new Error(`command palette: ${bad}`);
        if (taken.has(source.id)) throw new Error(`command palette: ${source.id} is already registered`);
        taken.add(source.id);
      }
      const added = sources.map((source) => ({ source }));
      entries.push(...added);
      return () => {
        for (const entry of added) {
          const at = entries.indexOf(entry);
          if (at >= 0) entries.splice(at, 1);
        }
      };
    },

    resolve(ctx) {
      const seen = staticIds();
      const out: PaletteAction[] = [];
      for (const { source } of entries) {
        if (typeof source !== 'function') {
          if (isAvailable(source, ctx)) out.push(source);
          continue;
        }
        let produced: readonly PaletteAction[];
        try {
          produced = source(ctx);
        } catch {
          continue;
        }
        if (!Array.isArray(produced)) continue;
        for (const action of produced) {
          // A dynamic action never takes an id another action has, and a malformed one is dropped.
          if (problem(action) !== null || seen.has(action.id)) continue;
          seen.add(action.id);
          if (isAvailable(action, ctx)) out.push(action);
        }
      }
      return out;
    },

    ids: () => [...staticIds()],
  };
}

/** The app's one registry: the palette lists what is registered here. */
export const paletteRegistry: PaletteRegistry = createPaletteRegistry();

/**
 * Registers actions with the palette (see `command-palette.spec.ts`, Registration API): call it once
 * at module load in the feature's own file. Answers a function that unregisters them.
 */
export function registerPaletteActions(...sources: PaletteSource[]): () => void {
  return paletteRegistry.register(...sources);
}

/** The ready audit in `ctx`, or `null`. */
export function readyAudit(ctx: PaletteContext): SeoAudit | null {
  return ctx.audit?.status === 'ready' ? ctx.audit.audit : null;
}
