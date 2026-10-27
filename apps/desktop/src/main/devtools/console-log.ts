import { CONSOLE_LEVELS, CONSOLE_LIMITS, type ConsoleEntry, type ConsoleLevel } from '@app/specs/devtools.spec';
import { cut } from './network-log';

// The devtools drawer's console (spec `devtools.spec.ts`, `CONSOLE_LIMITS`; acceptance
// `devtools.feature.md`, Console): a tab's `console-message` events for its current document.
// Identical messages (level, text, source, line) are one entry with a count; at most `maxEntries`
// distinct entries (new ones past it are counted, not kept); text and source cut to their caps. The
// chrome renders every field as inert text.

/** What a `console-message` event carries (Electron's `WebContentsConsoleMessageEventParams`). */
export interface ConsoleMessage {
  readonly level?: unknown;
  readonly message?: unknown;
  readonly sourceId?: unknown;
  readonly lineNumber?: unknown;
}

const LEVELS: ReadonlySet<string> = new Set(CONSOLE_LEVELS);

/** Electron's level (a name; older releases a number 0…3) as the drawer's. */
export function consoleLevelOf(level: unknown): ConsoleLevel {
  if (typeof level === 'string' && LEVELS.has(level)) return level as ConsoleLevel;
  if (typeof level === 'number' && Number.isInteger(level) && level >= 0 && level < CONSOLE_LEVELS.length) return CONSOLE_LEVELS[level]!;
  return 'info';
}

type Mutable = { -readonly [K in keyof ConsoleEntry]: ConsoleEntry[K] };

interface TabConsole {
  readonly byKey: Map<string, Mutable>;
  total: number;
  dropped: number;
}

export interface ConsoleLog {
  add(contentsId: number, message: ConsoleMessage, now?: number): void;
  /** A cross-document main-frame navigation started: the tab's console starts over. */
  reset(contentsId: number): void;
  forget(contentsId: number): void;
  /** The tab's console (in first-seen order), `null` for a tab that logged nothing. */
  snapshot(contentsId: number): { readonly entries: ConsoleEntry[]; readonly total: number; readonly dropped: number } | null;
  clear(): void;
}

export function createConsoleLog(options: { readonly changed?: (contentsId: number) => void; readonly maxTabs?: number } = {}): ConsoleLog {
  const tabs = new Map<number, TabConsole>();
  const maxTabs = options.maxTabs ?? 16;
  let nextKey = 1;

  const tabOf = (id: number): TabConsole => {
    let tab = tabs.get(id);
    if (tab) tabs.delete(id);
    else tab = { byKey: new Map(), total: 0, dropped: 0 };
    tabs.set(id, tab);
    while (tabs.size > maxTabs) tabs.delete(tabs.keys().next().value!);
    return tab;
  };

  return {
    add(contentsId, message, now = Date.now()) {
      const tab = tabOf(contentsId);
      const level = consoleLevelOf(message.level);
      const rawText = typeof message.message === 'string' ? message.message : String(message.message ?? '');
      const text = cut(rawText, CONSOLE_LIMITS.maxMessageChars);
      const source = cut(typeof message.sourceId === 'string' ? message.sourceId : '', CONSOLE_LIMITS.maxSourceChars);
      const line = typeof message.lineNumber === 'number' && Number.isInteger(message.lineNumber) && message.lineNumber >= 0 ? message.lineNumber : 0;
      const identity = `${level}\u0000${source}\u0000${line}\u0000${text}`;
      tab.total += 1;
      const known = tab.byKey.get(identity);
      if (known) {
        known.count += 1;
        known.lastAt = now;
      } else if (tab.byKey.size >= CONSOLE_LIMITS.maxEntries) {
        tab.dropped += 1;
      } else {
        tab.byKey.set(identity, { key: nextKey++, level, message: text, truncated: text.length < rawText.length, source, line, count: 1, firstAt: now, lastAt: now });
      }
      options.changed?.(contentsId);
    },

    reset(contentsId) {
      if (!tabs.has(contentsId)) return;
      tabs.set(contentsId, { byKey: new Map(), total: 0, dropped: 0 });
      options.changed?.(contentsId);
    },

    forget(contentsId) {
      tabs.delete(contentsId);
    },

    snapshot(contentsId) {
      const tab = tabs.get(contentsId);
      if (!tab) return null;
      return { entries: [...tab.byKey.values()].map((e) => ({ ...e })), total: tab.total, dropped: tab.dropped };
    },

    clear() {
      tabs.clear();
    },
  };
}
